use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Datelike, Local, NaiveTime, Timelike};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 本地定时自动化：到点执行一个米家手动场景。
///
/// 数据只存在本机，不依赖小米的智能场景接口。触发精度受 30 秒轮询限制。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    pub name: String,
    /// 24 小时制 HH:MM。
    pub time: String,
    /// ISO 星期：1=周一，7=周日。
    pub days: Vec<u8>,
    pub scene_id: String,
    pub home_id: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub last_run: Option<String>,
}

fn default_enabled() -> bool {
    true
}

impl Automation {
    pub fn new(name: String, time: String, days: Vec<u8>, scene_id: String, home_id: String) -> Self {
        Self {
            id: String::new(),
            name,
            time,
            days,
            scene_id,
            home_id,
            enabled: true,
            last_run: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct FileData {
    #[serde(default)]
    items: Vec<Automation>,
}

pub struct AutomationStore {
    path: PathBuf,
    items: Vec<Automation>,
}

impl AutomationStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let items = load_file(&path).unwrap_or_default();
        Self { path, items }
    }

    pub fn all(&self) -> Vec<Automation> {
        let mut items = self.items.clone();
        items.sort_by(|a, b| a.time.cmp(&b.time));
        items
    }

    pub fn upsert(&mut self, mut item: Automation) -> Result<Vec<Automation>> {
        validate(&item)?;
        if item.id.trim().is_empty() {
            item.id = format!("a{}", chrono::Local::now().timestamp_millis());
        }
        if let Some(existing) = self.items.iter_mut().find(|entry| entry.id == item.id) {
            *existing = item;
        } else {
            self.items.push(item);
        }
        self.save()?;
        Ok(self.all())
    }

    pub fn remove(&mut self, id: &str) -> Result<Vec<Automation>> {
        self.items.retain(|item| item.id != id);
        self.save()?;
        Ok(self.all())
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<Vec<Automation>> {
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.enabled = enabled;
            self.save()?;
        }
        Ok(self.all())
    }

    /// 取出当前时间窗口内该执行的自动化。窗口 2 分钟，避免 30 秒轮询漏掉。
    pub fn due_now(&self) -> Vec<Automation> {
        self.due_at(Local::now())
    }

    pub fn due_at(&self, now: DateTime<Local>) -> Vec<Automation> {
        let today = now.format("%Y-%m-%d").to_string();
        let weekday = now.weekday().number_from_monday() as u8;
        self.items
            .iter()
            .filter(|item| {
                if !item.enabled || !item.days.contains(&weekday) {
                    return false;
                }
                if item.last_run.as_deref() == Some(today.as_str()) {
                    return false;
                }
                let Ok(target) = NaiveTime::parse_from_str(&item.time, "%H:%M") else {
                    return false;
                };
                let target_minutes = target.hour() * 60 + target.minute();
                let now_minutes = now.hour() * 60 + now.minute();
                now_minutes >= target_minutes && now_minutes - target_minutes <= 2
            })
            .cloned()
            .collect()
    }

    pub fn mark_run(&mut self, id: &str) -> Result<()> {
        let today = Local::now().format("%Y-%m-%d").to_string();
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.last_run = Some(today);
            self.save()?;
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        let data = serde_json::to_vec_pretty(&FileData {
            items: self.items.clone(),
        })?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("创建目录失败：{}", parent.display()))?;
        }
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, data).with_context(|| format!("写入失败：{}", temp.display()))?;
        fs::rename(&temp, &self.path)
            .with_context(|| format!("替换失败：{}", self.path.display()))?;
        Ok(())
    }
}

fn load_file(path: &Path) -> Result<Vec<Automation>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read(path).with_context(|| format!("读取失败：{}", path.display()))?;
    if data.is_empty() {
        return Ok(Vec::new());
    }
    if let Ok(file) = serde_json::from_slice::<FileData>(&data) {
        return Ok(file.items);
    }
    Ok(serde_json::from_slice::<Vec<Automation>>(&data).unwrap_or_default())
}

fn validate(item: &Automation) -> Result<()> {
    if item.name.trim().is_empty() {
        return Err(anyhow!("自动化名称不能为空"));
    }
    if item.scene_id.trim().is_empty() {
        return Err(anyhow!("请选择一个场景"));
    }
    if item.home_id.trim().is_empty() {
        return Err(anyhow!("缺少家庭"));
    }
    NaiveTime::parse_from_str(&item.time, "%H:%M")
        .map_err(|_| anyhow!("时间必须是 HH:MM"))?;
    if item.days.is_empty() || item.days.iter().any(|day| !(1..=7).contains(day)) {
        return Err(anyhow!("至少选择一个星期，范围 1–7"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Automation {
        Automation::new(
            "早上开灯".into(),
            "07:30".into(),
            vec![1, 2, 3, 4, 5],
            "scene-1".into(),
            "home-1".into(),
        )
    }

    #[test]
    fn validates_time_and_days() {
        let mut item = sample();
        assert!(validate(&item).is_ok());
        item.time = "25:00".into();
        assert!(validate(&item).is_err());
        item.time = "07:30".into();
        item.days.clear();
        assert!(validate(&item).is_err());
    }

    #[test]
    fn fires_in_window_once_per_day() {
        use chrono::TimeZone;
        let dir = std::env::temp_dir().join(format!("mihome-automation-due-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("automations.json");
        let mut store = AutomationStore::new(&path);
        let items = store.upsert(sample()).unwrap();
        let now = Local.with_ymd_and_hms(2026, 10, 30, 7, 30, 0).single().unwrap();
        assert_eq!(store.due_at(now).len(), 1);
        assert!(store.due_at(now + chrono::Duration::minutes(3)).is_empty());
        store.mark_run(&items[0].id).unwrap();
        assert!(store.due_at(now).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn roundtrips_store() {
        let dir = std::env::temp_dir().join(format!("mihome-automation-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("automations.json");
        let mut store = AutomationStore::new(&path);
        let items = store.upsert(sample()).unwrap();
        assert_eq!(items.len(), 1);
        store.mark_run(&items[0].id).unwrap();
        let again = AutomationStore::new(&path);
        assert_eq!(again.all().len(), 1);
        assert!(again.all()[0].last_run.is_some());
        let _ = fs::remove_dir_all(&dir);
    }
}
