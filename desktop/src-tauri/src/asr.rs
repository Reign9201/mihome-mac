use anyhow::{anyhow, Context, Result};
use mihome_core::{AsrConfig, AsrProvider};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const MAX_AUDIO_BYTES: usize = 20 * 1024 * 1024;
const LOCAL_TIMEOUT: Duration = Duration::from_secs(90);
const CLOUD_TIMEOUT: Duration = Duration::from_secs(60);
const SMART_HOME_PROMPT: &str = "以下是普通话智能家居控制指令。常用设备和说法：客厅灯、卧室灯、台灯、空调、风扇、窗帘、客厅、卧室、主卧、次卧、打开、关闭、调到、温度、亮度。示例：打开客厅灯。关闭卧室灯。把主卧空调调到26度。客厅温度多少。";

pub(crate) async fn transcribe(
    config: &AsrConfig,
    audio: Vec<u8>,
    extension: &str,
) -> Result<String> {
    if audio.is_empty() {
        return Err(anyhow!("收到的语音文件为空"));
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(anyhow!("语音文件超过 20 MB，已拒绝处理"));
    }
    let temp = TempAudio::create(&audio, extension)?;
    let wav = transcode_to_wav(&temp.path).await?;
    let text = match config.provider {
        AsrProvider::WhisperCpp => transcribe_whisper_cpp(config, &wav.path).await,
        AsrProvider::Apple => transcribe_apple(&wav.path).await,
        AsrProvider::OpenaiCompatible => transcribe_openai(config, &wav.path).await,
    }?;
    let text = clean_transcript(&text);
    if text.is_empty() {
        return Err(anyhow!("没有识别到语音内容，请靠近麦克风后重试"));
    }
    Ok(text)
}

pub(crate) async fn test_connection(config: &AsrConfig) -> Result<String> {
    match config.provider {
        AsrProvider::WhisperCpp => test_whisper_cpp(config).await,
        AsrProvider::Apple => {
            let status = apple_authorization_status();
            if status == "authorized" {
                Ok("macOS 本地语音识别已授权。".to_string())
            } else {
                Err(anyhow!(
                    "macOS 语音识别权限状态：{status}。请到“系统设置 → 隐私与安全性 → 语音识别”允许 MiHome Mac。"
                ))
            }
        }
        AsrProvider::OpenaiCompatible => test_openai(config).await,
    }
}

async fn transcribe_whisper_cpp(config: &AsrConfig, wav: &Path) -> Result<String> {
    let command = resolve_command(&config.command)?;
    let model = resolve_model_path(&config.model_path)?;
    let output_prefix = std::env::temp_dir().join(format!(
        "mihome-asr-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let language = whisper_language(&config.language);
    let mut process = Command::new(&command);
    process
        .arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(wav)
        .arg("-l")
        .arg(language)
        .arg("-otxt")
        .arg("-of")
        .arg(&output_prefix)
        .arg("-nt")
        .arg("-np")
        .arg("-ng")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(prompt) = transcription_prompt(language) {
        process.arg("--prompt").arg(prompt);
    }
    let output = tokio::time::timeout(LOCAL_TIMEOUT, process.output())
        .await
        .map_err(|_| anyhow!("Whisper.cpp 识别超时"))?
        .context("启动 Whisper.cpp 失败")?;
    let text_path = output_prefix.with_extension("txt");
    let text = std::fs::read_to_string(&text_path).unwrap_or_default();
    let _ = std::fs::remove_file(&text_path);
    if !output.status.success() && text.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "Whisper.cpp 识别失败：{}",
            stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("进程异常退出")
                .trim()
        ));
    }
    if !text.trim().is_empty() {
        return Ok(text);
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn test_whisper_cpp(config: &AsrConfig) -> Result<String> {
    let command = resolve_command(&config.command)?;
    let model = resolve_model_path(&config.model_path)?;
    let metadata = std::fs::metadata(&model).context("读取 Whisper 模型文件失败")?;
    if metadata.len() < 1024 * 1024 {
        return Err(anyhow!("Whisper 模型文件异常：{}", model.display()));
    }
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        Command::new(&command)
            .arg("--help")
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| anyhow!("Whisper.cpp 命令响应超时"))?
    .context("启动 Whisper.cpp 失败")?;
    if !output.status.success() {
        return Err(anyhow!("Whisper.cpp 命令不可用"));
    }
    Ok(format!(
        "Whisper.cpp 可用：{}；模型 {}",
        command.display(),
        model.display()
    ))
}

async fn transcribe_openai(config: &AsrConfig, wav: &Path) -> Result<String> {
    let bytes = std::fs::read(wav).context("读取待识别音频失败")?;
    let endpoint = transcription_endpoint(&config.base_url)?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("speech.wav")
        .mime_str("audio/wav")?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", config.model.clone());
    let language = whisper_language(&config.language);
    if !language.is_empty() {
        form = form.text("language", language.to_string());
    }
    if let Some(prompt) = transcription_prompt(language) {
        form = form.text("prompt", prompt.to_string());
    }
    let response = tokio::time::timeout(
        CLOUD_TIMEOUT,
        reqwest::Client::new()
            .post(endpoint)
            .bearer_auth(config.api_key.trim())
            .multipart(form)
            .send(),
    )
    .await
    .map_err(|_| anyhow!("云端语音识别请求超时"))?
    .context("请求云端语音识别失败")?;
    parse_transcription_response(response).await
}

async fn test_openai(config: &AsrConfig) -> Result<String> {
    let wav = silence_wav(1.0);
    let endpoint = transcription_endpoint(&config.base_url)?;
    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("silence.wav")
        .mime_str("audio/wav")?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", config.model.clone());
    let response = tokio::time::timeout(
        CLOUD_TIMEOUT,
        reqwest::Client::new()
            .post(endpoint)
            .bearer_auth(config.api_key.trim())
            .multipart(form)
            .send(),
    )
    .await
    .map_err(|_| anyhow!("云端语音识别测试超时"))?
    .context("请求云端语音识别失败")?;
    parse_transcription_response(response).await?;
    Ok(format!("云端语音识别可用：{}", config.model))
}

async fn parse_transcription_response(response: reqwest::Response) -> Result<String> {
    let status = response.status();
    let body = response.text().await.context("读取语音识别响应失败")?;
    if !status.is_success() {
        return Err(anyhow!(
            "语音识别接口返回 {}：{}",
            status.as_u16(),
            body.chars().take(500).collect::<String>()
        ));
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(text) = value.get("text").and_then(serde_json::Value::as_str) {
            return Ok(text.to_string());
        }
    }
    Ok(body)
}

fn transcription_endpoint(base_url: &str) -> Result<String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(anyhow!("语音识别接口地址为空"));
    }
    if base.ends_with("/audio/transcriptions") {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/audio/transcriptions"))
    }
}

async fn transcode_to_wav(source: &Path) -> Result<TempAudio> {
    let ffmpeg = mihome_core::media::find_ffmpeg().context("没有找到内置 ffmpeg")?;
    let target = std::env::temp_dir().join(format!(
        "mihome-asr-{}-{}.wav",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(ffmpeg)
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-y")
            .arg("-i")
            .arg(source)
            .arg("-ac")
            .arg("1")
            .arg("-ar")
            .arg("16000")
            .arg("-c:a")
            .arg("pcm_s16le")
            .arg(&target)
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| anyhow!("语音格式转换超时"))?
    .context("启动音频转换失败")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "语音格式转换失败：{}",
            stderr
                .lines()
                .rev()
                .find(|line| !line.trim().is_empty())
                .unwrap_or("ffmpeg 异常退出")
                .trim()
        ));
    }
    Ok(TempAudio { path: target })
}

fn resolve_command(command: &str) -> Result<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return Err(anyhow!("Whisper.cpp 命令未配置"));
    }
    let direct = PathBuf::from(command);
    if direct.is_absolute() && direct.is_file() {
        return Ok(direct);
    }
    let mut candidates = vec![
        command.to_string(),
        "/usr/local/bin/whisper-cli".to_string(),
        "/opt/homebrew/bin/whisper-cli".to_string(),
        "/usr/local/bin/whisper-cpp".to_string(),
        "/opt/homebrew/bin/whisper-cpp".to_string(),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(
            PathBuf::from(home)
                .join("Library/Application Support/MiHome/tools/whisper-cli")
                .display()
                .to_string(),
        );
    }
    for candidate in candidates {
        let path = PathBuf::from(&candidate);
        if path.is_absolute() && path.is_file() {
            return Ok(path);
        }
        if !candidate.contains('/') {
            if let Some(found) = find_in_path(&candidate) {
                return Ok(found);
            }
        }
    }
    Err(anyhow!(
        "没有找到 Whisper.cpp 命令。请先安装 whisper.cpp，或在语音设置中填写 whisper-cli 路径"
    ))
}

fn resolve_model_path(configured: &str) -> Result<PathBuf> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Ok(path);
        }
        return Err(anyhow!("Whisper 模型文件不存在：{}", path.display()));
    }
    let root = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/MiHome/models");
    for name in [
        "ggml-small-q5_1.bin",
        "ggml-small.bin",
        "ggml-base.bin",
        "ggml-medium-q5_0.bin",
    ] {
        let path = root.join(name);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(anyhow!(
        "没有找到 Whisper 模型。请把模型放到 {}",
        root.display()
    ))
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|root| root.join(name))
        .find(|candidate| candidate.is_file())
}

fn whisper_language(language: &str) -> &str {
    match language.trim().to_ascii_lowercase().as_str() {
        value if value.starts_with("zh") => "zh",
        value if value.starts_with("en") => "en",
        value if value.starts_with("ja") => "ja",
        value if value.starts_with("ko") => "ko",
        "auto" | "" => "auto",
        _ => "auto",
    }
}

fn transcription_prompt(language: &str) -> Option<&'static str> {
    (language == "zh").then_some(SMART_HOME_PROMPT)
}

fn clean_transcript(text: &str) -> String {
    let text = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch: char| ch == '"' || ch.is_whitespace())
        .trim_end_matches(|ch: char| {
            matches!(
                ch,
                '，' | ',' | '。' | '.' | '！' | '!' | '？' | '?' | '；' | ';'
            )
        })
        .chars()
        .take(500)
        .collect::<String>();
    normalize_smart_home_transcript(&text)
}

fn normalize_smart_home_transcript(text: &str) -> String {
    [
        ("關閉", "关闭"),
        ("关閉", "关闭"),
        ("關闭", "关闭"),
        ("打開", "打开"),
        ("臥室", "卧室"),
        ("握著", "卧室"),
        ("握室", "卧室"),
        ("客廳", "客厅"),
        ("空調", "空调"),
        ("窗簾", "窗帘"),
        ("風扇", "风扇"),
        ("檯燈", "台灯"),
        ("臺燈", "台灯"),
        ("燈", "灯"),
    ]
    .into_iter()
    .fold(text.to_string(), |value, (from, to)| {
        value.replace(from, to)
    })
}

fn silence_wav(seconds: f32) -> Vec<u8> {
    let sample_rate = 16_000_u32;
    let channels = 1_u16;
    let bits = 16_u16;
    let samples = (sample_rate as f32 * seconds) as u32;
    let data_len = samples * channels as u32 * (bits / 8) as u32;
    let mut wav = Vec::with_capacity((44 + data_len) as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * channels as u32 * (bits / 8) as u32).to_le_bytes());
    wav.extend_from_slice(&(channels * (bits / 8)).to_le_bytes());
    wav.extend_from_slice(&bits.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.resize(44 + data_len as usize, 0);
    wav
}

struct TempAudio {
    path: PathBuf,
}

impl TempAudio {
    fn create(bytes: &[u8], extension: &str) -> Result<Self> {
        let extension = extension
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(8)
            .collect::<String>();
        let extension = if extension.is_empty() {
            "bin".to_string()
        } else {
            extension
        };
        let path = std::env::temp_dir().join(format!(
            "mihome-asr-input-{}-{}.{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            extension
        ));
        std::fs::write(&path, bytes).context("写入临时语音文件失败")?;
        Ok(Self { path })
    }
}

impl Drop for TempAudio {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(target_os = "macos")]
fn apple_authorization_status() -> &'static str {
    use objc2_speech::{SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus};
    match unsafe { SFSpeechRecognizer::authorizationStatus() } {
        SFSpeechRecognizerAuthorizationStatus::Authorized => "authorized",
        SFSpeechRecognizerAuthorizationStatus::Denied => "denied",
        SFSpeechRecognizerAuthorizationStatus::Restricted => "restricted",
        _ => "not_determined",
    }
}

#[cfg(not(target_os = "macos"))]
fn apple_authorization_status() -> &'static str {
    "unsupported"
}

#[cfg(target_os = "macos")]
async fn transcribe_apple(wav: &Path) -> Result<String> {
    let path = wav.to_path_buf();
    tokio::task::spawn_blocking(move || transcribe_apple_blocking(&path))
        .await
        .context("macOS 语音识别任务失败")?
}

#[cfg(not(target_os = "macos"))]
async fn transcribe_apple(_wav: &Path) -> Result<String> {
    Err(anyhow!("当前系统不支持 macOS 语音识别"))
}

#[cfg(target_os = "macos")]
fn transcribe_apple_blocking(wav: &Path) -> Result<String> {
    use block2::RcBlock;
    use objc2::ClassType;
    use objc2_foundation::{NSLocale, NSOperationQueue, NSString, NSURL};
    use objc2_speech::{
        SFSpeechRecognitionResult, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
        SFSpeechURLRecognitionRequest,
    };
    use std::sync::mpsc;

    let (status_tx, status_rx) = mpsc::channel();
    unsafe {
        let status = SFSpeechRecognizer::authorizationStatus();
        if status == SFSpeechRecognizerAuthorizationStatus::NotDetermined {
            let block = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
                let _ = status_tx.send(status);
            });
            SFSpeechRecognizer::requestAuthorization(&block);
            let _ = status_rx.recv_timeout(Duration::from_secs(20));
        }
        let status = SFSpeechRecognizer::authorizationStatus();
        if status != SFSpeechRecognizerAuthorizationStatus::Authorized {
            return Err(anyhow!(
                "macOS 语音识别未授权，请在系统设置中允许 MiHome Mac 使用语音识别"
            ));
        }
        let locale = NSLocale::localeWithLocaleIdentifier(&NSString::from_str("zh-CN"));
        let recognizer = SFSpeechRecognizer::initWithLocale(
            objc2::msg_send![
                objc2::runtime::AnyClass::get(c"SFSpeechRecognizer")
                    .ok_or_else(|| anyhow!("无法加载 macOS 语音识别框架"))?,
                alloc
            ],
            &locale,
        )
        .ok_or_else(|| anyhow!("当前系统不支持中文语音识别"))?;
        if !recognizer.isAvailable() {
            return Err(anyhow!("macOS 语音识别服务当前不可用"));
        }
        let queue = NSOperationQueue::new();
        recognizer.setQueue(&queue);
        let url = NSURL::fileURLWithPath(&NSString::from_str(&wav.to_string_lossy()));
        let request = SFSpeechURLRecognitionRequest::initWithURL(
            objc2::msg_send![
                objc2::runtime::AnyClass::get(c"SFSpeechURLRecognitionRequest")
                    .ok_or_else(|| anyhow!("无法创建语音识别请求"))?,
                alloc
            ],
            &url,
        );
        request.setShouldReportPartialResults(false);
        request.setAddsPunctuation(false);
        if recognizer.supportsOnDeviceRecognition() {
            request.setRequiresOnDeviceRecognition(true);
        }
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(
            move |result: *mut SFSpeechRecognitionResult, error: *mut objc2_foundation::NSError| {
                if !error.is_null() {
                    let _ = tx.send(Err((*error).localizedDescription().to_string()));
                } else if !result.is_null() {
                    let result = &*result;
                    if result.isFinal() {
                        let text = result.bestTranscription().formattedString().to_string();
                        let _ = tx.send(Ok(text));
                    }
                }
            },
        );
        let task = recognizer.recognitionTaskWithRequest_resultHandler(request.as_super(), &block);
        let timeout = Duration::from_secs(40);
        let result = rx.recv_timeout(timeout);
        task.cancel();
        match result {
            Ok(Ok(text)) => Ok(text),
            Ok(Err(error)) => Err(anyhow!("macOS 语音识别失败：{error}")),
            Err(_) => Err(anyhow!("macOS 语音识别超时")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_transcription_endpoint_without_duplication() {
        assert_eq!(
            transcription_endpoint("http://127.0.0.1:9000/v1").unwrap(),
            "http://127.0.0.1:9000/v1/audio/transcriptions"
        );
        assert_eq!(
            transcription_endpoint("http://127.0.0.1:9000/v1/audio/transcriptions").unwrap(),
            "http://127.0.0.1:9000/v1/audio/transcriptions"
        );
    }

    #[test]
    fn maps_language_for_whisper_cpp() {
        assert_eq!(whisper_language("zh-CN"), "zh");
        assert_eq!(whisper_language("en-US"), "en");
        assert_eq!(whisper_language("auto"), "auto");
        assert!(transcription_prompt("zh").is_some());
        assert!(transcription_prompt("en").is_none());
    }

    #[test]
    fn normalizes_common_smart_home_transcription_errors() {
        assert_eq!(clean_transcript("關閉握著燈，"), "关闭卧室灯");
        assert_eq!(clean_transcript("打开客厅灯。"), "打开客厅灯");
    }

    #[test]
    fn creates_valid_silence_wav() {
        let wav = silence_wav(0.1);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert!(wav.len() > 44);
    }
}
