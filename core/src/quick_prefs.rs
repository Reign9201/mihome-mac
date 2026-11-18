use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 菜单栏速控面板要显示哪些设备、哪些场景。
///
/// 面板位置只有几个格子，米家账号下的设备和场景通常远多于格子。存的是用户挑过的
/// 顺序列表：设备按 did、场景按 scene id，顺序就是面板里的显示顺序。列表为空表示
/// 用户没挑过，面板按自己的默认规则选（在线、可开关的设备优先）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuickPrefs {
    #[serde(default)]
    pub devices: Vec<String>,
    #[serde(default)]
    pub scenes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct FileData {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    prefs: QuickPrefs,
}

const STORE_VERSION: u32 = 1;

pub struct QuickPrefsStore {
    path: PathBuf,
    prefs: QuickPrefs,
    load_error: Option<String>,
}

impl QuickPrefsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        match load_file(&path) {
            Ok(prefs) => Self {
                path,
                prefs,
                load_error: None,
            },
            Err(error) => Self {
                path,
                prefs: QuickPrefs::default(),
                load_error: Some(error.to_string()),
            },
        }
    }

    pub fn prefs(&self) -> &QuickPrefs {
        &self.prefs
    }

    pub fn load_error(&self) -> Option<&str> {
        self.load_error.as_deref()
    }

    /// 保存面板配置。传入的列表会去空、去重并保序。
    pub fn save(&mut self, prefs: QuickPrefs) -> Result<QuickPrefs> {
        let next = QuickPrefs {
            devices: normalize_ids(prefs.devices),
            scenes: normalize_ids(prefs.scenes),
        };
        let previous = std::mem::replace(&mut self.prefs, next);
        if let Err(error) = self.write() {
            self.prefs = previous;
            return Err(error);
        }
        Ok(self.prefs.clone())
    }

    fn write(&self) -> Result<()> {
        if let Some(error) = &self.load_error {
            return Err(anyhow!("面板配置加载失败，已拒绝覆盖：{error}"));
        }
        let data = serde_json::to_vec_pretty(&FileData {
            version: STORE_VERSION,
            prefs: self.prefs.clone(),
        })?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建目录失败：{}", parent.display()))?;
        }
        let temp = self.path.with_extension("json.tmp");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .with_context(|| format!("创建临时文件失败：{}", temp.display()))?;
        file.write_all(&data)
            .with_context(|| format!("写入失败：{}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("同步失败：{}", temp.display()))?;
        fs::rename(&temp, &self.path)
            .with_context(|| format!("替换失败：{}", self.path.display()))?;
        Ok(())
    }
}

fn normalize_ids(ids: Vec<String>) -> Vec<String> {
    let mut output: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim().to_string();
        if id.is_empty() || output.iter().any(|item| item == &id) {
            continue;
        }
        output.push(id);
    }
    output
}

fn load_file(path: &Path) -> Result<QuickPrefs> {
    if !path.exists() {
        return Ok(QuickPrefs::default());
    }
    let bytes = fs::read(path).with_context(|| format!("读取面板配置失败：{}", path.display()))?;
    if bytes.is_empty() {
        return Err(anyhow!("面板配置文件为空"));
    }
    let data: FileData = serde_json::from_slice(&bytes).context("面板配置文件格式错误")?;
    if data.version != STORE_VERSION {
        return Err(anyhow!("不支持的面板配置版本：{}", data.version));
    }
    Ok(QuickPrefs {
        devices: normalize_ids(data.prefs.devices),
        scenes: normalize_ids(data.prefs.scenes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mihome-quick-prefs-{tag}-{}-{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("quick.json")
    }

    #[test]
    fn saves_and_reloads_selection() {
        let path = temp_path("roundtrip");
        let mut store = QuickPrefsStore::new(&path);
        let saved = store
            .save(QuickPrefs {
                devices: vec![" did-1 ".into(), "did-2".into(), "did-1".into()],
                scenes: vec!["scene-1".into()],
            })
            .unwrap();
        assert_eq!(saved.devices, vec!["did-1".to_string(), "did-2".into()]);
        let reloaded = QuickPrefsStore::new(&path);
        assert_eq!(reloaded.prefs(), &saved);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn missing_file_means_empty_selection() {
        let path = temp_path("missing");
        let store = QuickPrefsStore::new(&path);
        assert_eq!(store.prefs(), &QuickPrefs::default());
        assert!(store.load_error().is_none());
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn corrupt_file_is_not_overwritten() {
        let path = temp_path("corrupt");
        fs::write(&path, b"{broken").unwrap();
        let mut store = QuickPrefsStore::new(&path);
        assert!(store.load_error().is_some());
        assert!(store.save(QuickPrefs::default()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn failed_save_restores_previous_selection() {
        let path = temp_path("rollback");
        let mut store = QuickPrefsStore::new(&path);
        store
            .save(QuickPrefs {
                devices: vec!["did-1".into()],
                scenes: Vec::new(),
            })
            .unwrap();
        let blocked = path.parent().unwrap().join("blocked");
        fs::create_dir_all(&blocked).unwrap();
        store.path = blocked;
        assert!(store
            .save(QuickPrefs {
                devices: vec!["did-2".into()],
                scenes: Vec::new(),
            })
            .is_err());
        assert_eq!(store.prefs().devices, vec!["did-1".to_string()]);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
