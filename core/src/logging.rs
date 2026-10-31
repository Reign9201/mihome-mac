//! Small, Tauri-independent application log used by the desktop shell and core.
//!
//! Entries are written asynchronously to daily, size-rotated files. Panics are
//! written synchronously by the crashing thread before the previous hook runs.
//! The module deliberately has no UI or Tauri dependency so it can be reused.

use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use std::backtrace::Backtrace;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::panic::{self, PanicHookInfo};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_KEEP_DAYS: usize = 7;
pub const DEFAULT_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 12 * 1024 * 1024;
const MAX_PENDING: usize = 1024;
const MAX_LINE_CHARS: usize = 4_000;
const KEEP_CRASHES: usize = 10;
const EXPORT_BUDGET_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

impl Level {
    fn letter(self) -> char {
        match self {
            Self::Debug => 'D',
            Self::Info => 'I',
            Self::Warn => 'W',
            Self::Error => 'E',
        }
    }
}

struct Entry {
    at: DateTime<Local>,
    level: Level,
    tag: String,
    message: String,
}

struct Logger {
    directory: PathBuf,
    sender: mpsc::SyncSender<Entry>,
    pending: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();
static MIN_LEVEL: AtomicU8 = AtomicU8::new(1);

/// Installs the process-wide logger under `~/Library/Logs/MiHome`.
pub fn install_default() -> Result<PathBuf> {
    install(default_directory())
}

/// Installs the process-wide logger. Calling this more than once is harmless.
pub fn install(directory: PathBuf) -> Result<PathBuf> {
    if let Some(logger) = LOGGER.get() {
        return Ok(logger.directory.clone());
    }
    create_private_directory(&directory)?;
    let files = LogFiles::new(directory.clone(), DEFAULT_KEEP_DAYS, DEFAULT_FILE_BYTES);
    files.prune_on_day_change(Local::now());

    let minimum = requested_level();
    MIN_LEVEL.store(level_number(minimum), Ordering::Relaxed);
    let (sender, receiver) = mpsc::sync_channel::<Entry>(MAX_PENDING);
    let pending = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicUsize::new(0));
    let worker_pending = Arc::clone(&pending);
    let worker_dropped = Arc::clone(&dropped);
    thread::Builder::new()
        .name("app-log".to_string())
        .spawn(move || {
            while let Ok(entry) = receiver.recv() {
                let skipped = worker_dropped.swap(0, Ordering::Relaxed);
                if skipped > 0 {
                    files.write_at(
                        Level::Warn,
                        "AppLog",
                        &format!("丢弃了 {skipped} 条写入过快的日志"),
                        Local::now(),
                    );
                }
                files.write_at(entry.level, &entry.tag, &entry.message, entry.at);
                worker_pending.fetch_sub(1, Ordering::Relaxed);
            }
        })
        .context("启动日志写入线程失败")?;

    let logger = Logger {
        directory: directory.clone(),
        sender,
        pending,
        dropped,
    };
    if LOGGER.set(logger).is_err() {
        return Ok(directory);
    }
    install_panic_hook(directory.clone());
    info(
        "App",
        format!(
            "日志系统启动；目录={}；级别={:?}",
            directory.display(),
            minimum
        ),
    );
    Ok(directory)
}

pub fn directory() -> PathBuf {
    LOGGER
        .get()
        .map(|logger| logger.directory.clone())
        .unwrap_or_else(default_directory)
}

pub fn debug(tag: &str, message: impl fmt::Display) {
    write(Level::Debug, tag, &message.to_string());
}

pub fn info(tag: &str, message: impl fmt::Display) {
    write(Level::Info, tag, &message.to_string());
}

pub fn warn(tag: &str, message: impl fmt::Display) {
    write(Level::Warn, tag, &message.to_string());
}

pub fn error(tag: &str, message: impl fmt::Display) {
    write(Level::Error, tag, &message.to_string());
}

pub fn write(level: Level, tag: &str, message: &str) {
    let minimum = match MIN_LEVEL.load(Ordering::Relaxed) {
        0 => Level::Debug,
        2 => Level::Warn,
        3 => Level::Error,
        _ => Level::Info,
    };
    if level < minimum {
        return;
    }
    let tag = clean_tag(tag);
    let message = redact(message);
    eprintln!("{level:?}/{tag}: {message}");
    let Some(logger) = LOGGER.get() else {
        return;
    };
    if logger.pending.fetch_add(1, Ordering::Relaxed) >= MAX_PENDING {
        logger.pending.fetch_sub(1, Ordering::Relaxed);
        logger.dropped.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let entry = Entry {
        at: Local::now(),
        level,
        tag,
        message,
    };
    if let Err(mpsc::TrySendError::Full(entry) | mpsc::TrySendError::Disconnected(entry)) =
        logger.sender.try_send(entry)
    {
        logger.pending.fetch_sub(1, Ordering::Relaxed);
        logger.dropped.fetch_add(1, Ordering::Relaxed);
        let _ = entry;
    }
}

/// Returns the current log and crash files, oldest first.
pub fn files() -> Vec<PathBuf> {
    LogFiles::new(directory(), DEFAULT_KEEP_DAYS, DEFAULT_FILE_BYTES).files()
}

/// Waits briefly for queued entries to reach disk before an export is read.
pub fn flush(timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if LOGGER
            .get()
            .is_none_or(|logger| logger.pending.load(Ordering::Relaxed) == 0)
        {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Keeps enough of an identifier to correlate events without logging the full value.
pub fn mask_id(value: &str) -> String {
    let value = value.trim();
    if value.chars().count() <= 4 {
        return "****".to_string();
    }
    let suffix: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("****{suffix}")
}

/// Builds one text file suitable for attaching to a bug report and returns its path.
pub fn export_diagnostics(app_name: &str, version: &str) -> Result<PathBuf> {
    flush(Duration::from_secs(2));
    let directory = directory();
    create_private_directory(&directory)?;
    let output_dir = diagnostics_directory(&directory);
    create_private_directory(&output_dir)?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S-%3f");
    let path = output_dir.join(format!("MiHome-Diagnostics-{stamp}.txt"));
    let mut output = private_file(&path)?;

    writeln!(
        output,
        "{app_name} {version}  {} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )?;
    writeln!(
        output,
        "生成时间 {}",
        Local::now().format("%Y-%m-%d %H:%M:%S")
    )?;
    writeln!(output, "日志目录 {}", directory.display())?;
    writeln!(output, "日志级别 {:?}", requested_level())?;

    let all = files();
    let crashes: Vec<_> = all
        .iter()
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("crash-"))
        })
        .collect();
    writeln!(output, "\n==== 崩溃记录（{}）====", crashes.len())?;
    for path in crashes {
        write_file_section(&mut output, path)?;
    }

    let logs: Vec<_> = all
        .iter()
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("log-"))
        })
        .collect();
    let mut selected = Vec::new();
    let mut bytes = 0_u64;
    for path in logs.iter().rev() {
        let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        if bytes + size > EXPORT_BUDGET_BYTES {
            break;
        }
        bytes += size;
        selected.push(*path);
    }
    selected.reverse();
    writeln!(
        output,
        "\n==== 应用日志（{}/{} 个文件）====",
        selected.len(),
        logs.len()
    )?;
    for path in &selected {
        write_file_section(&mut output, path)?;
    }
    if logs.len() > selected.len() {
        writeln!(output, "（更早的日志文件因体积未包含）")?;
    }
    output.flush()?;
    Ok(path)
}

pub fn redact(input: &str) -> String {
    let clipped: String = input.chars().take(MAX_LINE_CHARS).collect();
    let mut text = redact_xiaomi_uri(&clipped);
    text = redact_quoted_assignments(&text);
    text = redact_assignments(&text);
    redact_prefixed_secrets(&text)
}

fn write_file_section(output: &mut File, path: &Path) -> Result<()> {
    writeln!(
        output,
        "\n---- {} ----",
        path.file_name().unwrap_or_default().to_string_lossy()
    )?;
    let mut file = File::open(path)?;
    let mut buffer = [0_u8; 16 * 1024];
    let mut last_byte = None;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        last_byte = buffer.get(read - 1).copied();
    }
    if last_byte != Some(b'\n') {
        writeln!(output)?;
    }
    Ok(())
}

fn default_directory() -> PathBuf {
    if let Some(path) = std::env::var_os("MIHOME_LOG_DIR") {
        return PathBuf::from(path);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Logs/MiHome")
}

fn diagnostics_directory(log_directory: &Path) -> PathBuf {
    if let Some(path) = std::env::var_os("MIHOME_DIAGNOSTICS_DIR") {
        return PathBuf::from(path);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Downloads"))
        .unwrap_or_else(|| log_directory.to_path_buf())
}

fn requested_level() -> Level {
    match std::env::var("MIHOME_LOG_LEVEL")
        .unwrap_or_else(|_| "info".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "debug" | "trace" => Level::Debug,
        "warn" | "warning" => Level::Warn,
        "error" => Level::Error,
        _ => Level::Info,
    }
}

fn level_number(level: Level) -> u8 {
    match level {
        Level::Debug => 0,
        Level::Info => 1,
        Level::Warn => 2,
        Level::Error => 3,
    }
}

fn clean_tag(tag: &str) -> String {
    let tag: String = tag
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "_-.: /".contains(*character))
        .take(48)
        .collect();
    if tag.trim().is_empty() {
        "App".to_string()
    } else {
        tag.trim().to_string()
    }
}

fn install_panic_hook(directory: PathBuf) {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let files = LogFiles::new(directory.clone(), DEFAULT_KEEP_DAYS, DEFAULT_FILE_BYTES);
        let _ = files.crash(info);
        previous(info);
    }));
}

fn redact_xiaomi_uri(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find("xiaomi://") {
        output.push_str(&rest[..index]);
        output.push_str("xiaomi://<已隐藏>");
        rest = &rest[index + "xiaomi://".len()..];
        let end = rest
            .find(|character: char| character.is_whitespace() || matches!(character, '"' | '\''))
            .unwrap_or(rest.len());
        rest = &rest[end..];
    }
    output.push_str(rest);
    output
}

fn redact_assignments(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'-' | b'.'))
        {
            index += 1;
        }
        if start == index {
            let character = input[index..].chars().next().unwrap_or_default();
            output.push(character);
            index += character.len_utf8();
            continue;
        }
        let key = &input[start..index];
        let mut cursor = index;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || !matches!(bytes[cursor], b'=' | b':') {
            output.push_str(key);
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let quote = if cursor < bytes.len() && matches!(bytes[cursor], b'"' | b'\'') {
            Some(bytes[cursor])
        } else {
            None
        };
        if quote.is_some() {
            cursor += 1;
        }
        output.push_str(key);
        output.push_str(&input[index..cursor]);
        if !is_sensitive_key(key) {
            index = cursor;
            continue;
        }
        output.push_str("<已隐藏>");
        let until_newline = matches!(
            normalize_key(key).as_str(),
            "authorization" | "cookie" | "set-cookie"
        );
        while cursor < bytes.len() {
            if let Some(quote) = quote {
                if bytes[cursor] == quote {
                    output.push(quote as char);
                    cursor += 1;
                    break;
                }
            } else if bytes[cursor] == b'\n'
                || bytes[cursor] == b'\r'
                || bytes[cursor] == b','
                || (!until_newline
                    && (bytes[cursor].is_ascii_whitespace()
                        || matches!(bytes[cursor], b'&' | b';')))
            {
                break;
            }
            cursor += 1;
        }
        index = cursor;
    }
    output
}

fn redact_quoted_assignments(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('"') {
        let after_quote = &rest[start + 1..];
        let Some(key_end) = after_quote.find('"') else {
            output.push_str(rest);
            return output;
        };
        let key = &after_quote[..key_end];
        let mut cursor = start + 1 + key_end + 1;
        let bytes = rest.as_bytes();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b':' || !is_sensitive_key(key) {
            output.push_str(&rest[..cursor]);
            rest = &rest[cursor..];
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'"' {
            output.push_str(&rest[..cursor]);
            rest = &rest[cursor..];
            continue;
        }
        cursor += 1;
        let value_start = cursor;
        let mut escaped = false;
        while cursor < bytes.len() {
            if bytes[cursor] == b'"' && !escaped {
                break;
            }
            escaped = bytes[cursor] == b'\\' && !escaped;
            if bytes[cursor] != b'\\' {
                escaped = false;
            }
            cursor += 1;
        }
        if cursor >= bytes.len() {
            output.push_str(&rest[..value_start]);
            output.push_str("<已隐藏>");
            return output;
        }
        output.push_str(&rest[..value_start]);
        output.push_str("<已隐藏>");
        output.push('"');
        cursor += 1;
        rest = &rest[cursor..];
    }
    output.push_str(rest);
    output
}

fn redact_prefixed_secrets(input: &str) -> String {
    input
        .split_inclusive(char::is_whitespace)
        .map(|part| {
            let trimmed = part.trim_end_matches(char::is_whitespace);
            if trimmed.starts_with("V1:") || trimmed.starts_with("MIHOME-TOKEN:") {
                "<已隐藏>"
            } else {
                part
            }
        })
        .collect()
}

fn is_sensitive_key(key: &str) -> bool {
    let key = normalize_key(key);
    key.contains("token")
        || key.contains("secret")
        || key.contains("cookie")
        || key.contains("authorization")
        || key == "sign"
        || key.ends_with("_sign")
        || key == "signature"
        || key == "ssecurity"
        || key == "client_private"
        || key == "client_public"
        || key == "device_public"
        || key == "app_pubkey"
        || key == "public_key"
        || key == "private_key"
}

fn normalize_key(key: &str) -> String {
    key.trim_matches(|character: char| {
        !character.is_ascii_alphanumeric() && !matches!(character, '_' | '-')
    })
    .to_ascii_lowercase()
    .replace('-', "_")
}

#[derive(Clone)]
struct LogFiles {
    directory: PathBuf,
    keep_days: usize,
    max_file_bytes: u64,
    last_pruned_day: Arc<Mutex<Option<String>>>,
}

impl LogFiles {
    fn new(directory: PathBuf, keep_days: usize, max_file_bytes: u64) -> Self {
        Self {
            directory,
            keep_days,
            max_file_bytes,
            last_pruned_day: Arc::new(Mutex::new(None)),
        }
    }

    fn write_at(&self, level: Level, tag: &str, message: &str, at: DateTime<Local>) {
        let _ = self.try_write_at(level, tag, message, at);
    }

    fn try_write_at(
        &self,
        level: Level,
        tag: &str,
        message: &str,
        at: DateTime<Local>,
    ) -> Result<()> {
        let day = at.format("%Y-%m-%d").to_string();
        self.prune_on_day_change(at);
        create_private_directory(&self.directory)?;
        let path = self.part(&day);
        let mut file = private_append(&path)?;
        writeln!(
            file,
            "{} {}/{}: {}",
            at.format("%Y-%m-%d %H:%M:%S%.3f"),
            level.letter(),
            clean_tag(tag),
            redact(message)
        )?;
        Ok(())
    }

    fn crash(&self, info: &PanicHookInfo<'_>) -> Result<PathBuf> {
        create_private_directory(&self.directory)?;
        let now = Local::now();
        let thread = thread::current();
        let thread_name = thread.name().unwrap_or("<未命名线程>");
        let payload = if let Some(message) = info.payload().downcast_ref::<&str>() {
            (*message).to_string()
        } else if let Some(message) = info.payload().downcast_ref::<String>() {
            message.clone()
        } else {
            "未知 panic".to_string()
        };
        let location = info
            .location()
            .map(|location| {
                format!(
                    "{}:{}:{}",
                    location.file(),
                    location.line(),
                    location.column()
                )
            })
            .unwrap_or_else(|| "未知位置".to_string());
        let report = self.directory.join(format!(
            "crash-{}-{:03}.txt",
            now.format("%Y%m%d-%H%M%S"),
            now.timestamp_subsec_millis()
        ));
        let mut file = private_file(&report)?;
        writeln!(
            file,
            "{} 线程 {thread_name}\n{location}\n{}",
            now.format("%Y-%m-%d %H:%M:%S%.3f"),
            redact(&payload)
        )?;
        writeln!(
            file,
            "\n{}",
            redact(&Backtrace::force_capture().to_string())
        )?;
        file.flush()?;
        self.write_at(
            Level::Error,
            "AppLog",
            &format!(
                "崩溃（线程 {thread_name}，详见 {}）",
                report.file_name().unwrap_or_default().to_string_lossy()
            ),
            now,
        );
        self.prune_crashes();
        Ok(report)
    }

    fn files(&self) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return Vec::new();
        };
        let mut files: Vec<_> = entries
            .flatten()
            .filter(|entry| entry.path().is_file())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name().is_some_and(|name| {
                    let name = name.to_string_lossy();
                    name.starts_with("log-") || name.starts_with("crash-")
                })
            })
            .collect();
        files.sort();
        files
    }

    fn prune_on_day_change(&self, now: DateTime<Local>) {
        let day = now.format("%Y-%m-%d").to_string();
        let mut last_day = self
            .last_pruned_day
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if last_day.as_deref() != Some(day.as_str()) {
            self.prune(now);
            *last_day = Some(day);
        }
    }

    fn prune(&self, now: DateTime<Local>) {
        let cutoff = (now - chrono::Duration::days(self.keep_days as i64))
            .format("%Y-%m-%d")
            .to_string();
        let Ok(entries) = fs::read_dir(&self.directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("log-") {
                let day = name
                    .strip_prefix("log-")
                    .and_then(|name| name.get(..10))
                    .unwrap_or("");
                if day < cutoff.as_str() {
                    let _ = fs::remove_file(path);
                }
            }
        }
        let mut logs: Vec<_> = self
            .files()
            .into_iter()
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("log-"))
            })
            .collect();
        let mut total: u64 = logs
            .iter()
            .filter_map(|path| fs::metadata(path).ok())
            .map(|meta| meta.len())
            .sum();
        for path in logs.drain(..) {
            if total <= MAX_TOTAL_BYTES {
                break;
            }
            if let Ok(meta) = fs::metadata(&path) {
                total = total.saturating_sub(meta.len());
            }
            let _ = fs::remove_file(path);
        }
        self.prune_crashes();
    }

    fn prune_crashes(&self) {
        let mut crashes: Vec<_> = self
            .files()
            .into_iter()
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("crash-"))
            })
            .collect();
        crashes.sort();
        while crashes.len() > KEEP_CRASHES {
            if let Some(path) = crashes.first() {
                let _ = fs::remove_file(path);
            }
            crashes.remove(0);
        }
    }

    fn part(&self, day: &str) -> PathBuf {
        let base = self.directory.join(format!("log-{day}.log"));
        if !base.exists() || file_len(&base) < self.max_file_bytes {
            return base;
        }
        for number in 1..=3 {
            let next = self.directory.join(format!("log-{day}-{number}.log"));
            if !next.exists() || file_len(&next) < self.max_file_bytes {
                return next;
            }
        }
        self.directory.join(format!("log-{day}-3.log"))
    }
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn create_private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("创建日志目录失败：{}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .with_context(|| format!("创建日志文件失败：{}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(file)
}

fn private_append(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(path)
        .with_context(|| format!("打开日志文件失败：{}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mihome-log-{name}-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    fn at(value: &str) -> DateTime<Local> {
        DateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S %z")
            .unwrap()
            .with_timezone(&Local)
    }

    #[test]
    fn redacts_known_credentials_without_hiding_normal_errors() {
        let text = redact(
            "GET https://example.test/path?did=7&passToken=secret&sign=abc\n\
             Cookie: a=b\nAuthorization: Bearer hidden\n\
             xiaomi://user:cn@192.168.1.2?sign=abc\nerror=read media: i/o timeout\n\
             {\"client_private\":\"private-value\"}",
        );
        for secret in [
            "passToken=secret",
            "sign=abc",
            "Cookie: a=b",
            "Bearer hidden",
            "xiaomi://user",
            "192.168.1.2",
            "private-value",
        ] {
            assert!(!text.contains(secret), "{secret} still present in {text}");
        }
        assert!(text.contains("did=7"));
        assert!(text.contains("error=read media"));
    }

    #[test]
    fn redaction_handles_values_ending_at_assignment_operator() {
        assert_eq!(redact("token="), "token=<已隐藏>");
        assert_eq!(redact("token: "), "token: <已隐藏>");
        assert_eq!(redact("token=\""), "token=\"<已隐藏>");
    }

    #[test]
    fn redaction_is_idempotent_for_structured_json() {
        let once = redact(r#"{"alive":true,"api_ready":true,"detail":"等待"}"#);
        assert_eq!(redact(&once), once);
        let secret = redact(r#"{"passToken":"secret","alive":true}"#);
        assert!(!secret.contains("secret"));
        assert_eq!(redact(&secret), secret);
    }

    #[test]
    fn writes_rotates_and_prunes_daily_files() {
        let directory = temp_dir("files");
        let files = LogFiles::new(directory.clone(), 1, 80);
        files.write_at(
            Level::Info,
            "Test",
            "first line that is long enough to fill a test file",
            at("2026-10-01 10:00:00 +0800"),
        );
        for index in 0..4 {
            files.write_at(
                Level::Info,
                "Test",
                &format!("line {index} that is also long enough"),
                at("2026-10-01 10:00:01 +0800"),
            );
        }
        let rotated: Vec<_> = files
            .files()
            .into_iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(rotated.iter().any(|name| name == "log-2026-10-01-1.log"));
        files.write_at(
            Level::Info,
            "Test",
            "new day",
            at("2026-10-03 10:00:00 +0800"),
        );
        let names: Vec<_> = files
            .files()
            .into_iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(!names.iter().any(|name| name == "log-2026-10-01.log"));
        assert!(names.iter().any(|name| name == "log-2026-10-03.log"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn panic_report_is_private_and_redacted() {
        let directory = temp_dir("crash");
        create_private_directory(&directory).unwrap();
        let files = LogFiles::new(directory.clone(), DEFAULT_KEEP_DAYS, DEFAULT_FILE_BYTES);
        files
            .try_write_at(Level::Error, "Test", "passToken=secret", Local::now())
            .unwrap();
        let report = files.directory.join("crash-test.txt");
        let mut file = private_file(&report).unwrap();
        writeln!(file, "sign=secret").unwrap();
        file.flush().unwrap();
        assert!(fs::read_to_string(&report).unwrap().contains("sign=secret"));
        assert!(redact(&fs::read_to_string(&report).unwrap()).contains("<已隐藏>"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(files.files().last().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(directory);
    }
}
