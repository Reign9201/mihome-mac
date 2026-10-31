use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Datelike, Local, NaiveTime};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
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

#[derive(Debug, Clone)]
pub struct DueAutomation {
    pub automation: Automation,
    pub scheduled_for: DateTime<Local>,
}

fn default_enabled() -> bool {
    true
}

impl Automation {
    pub fn new(
        name: String,
        time: String,
        days: Vec<u8>,
        scene_id: String,
        home_id: String,
    ) -> Self {
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
    load_error: Option<String>,
}

impl AutomationStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        match load_file(&path) {
            Ok(items) => Self {
                path,
                items,
                load_error: None,
            },
            Err(error) => Self {
                path,
                items: Vec::new(),
                load_error: Some(error.to_string()),
            },
        }
    }

    pub fn all(&self) -> Vec<Automation> {
        let mut items = self.items.clone();
        items.sort_by(|a, b| a.time.cmp(&b.time));
        items
    }

    pub fn load_error(&self) -> Option<&str> {
        self.load_error.as_deref()
    }

    pub fn upsert(&mut self, mut item: Automation) -> Result<Vec<Automation>> {
        validate(&item)?;
        if item.id.trim().is_empty() {
            item.id = format!("a{}", chrono::Local::now().timestamp_millis());
        }
        let mut next = self.items.clone();
        if let Some(existing) = next.iter_mut().find(|entry| entry.id == item.id) {
            *existing = item;
        } else {
            next.push(item);
        }
        self.commit(next)
    }

    pub fn remove(&mut self, id: &str) -> Result<Vec<Automation>> {
        let mut next = self.items.clone();
        next.retain(|item| item.id != id);
        self.commit(next)
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<Vec<Automation>> {
        let mut next = self.items.clone();
        if let Some(item) = next.iter_mut().find(|item| item.id == id) {
            item.enabled = enabled;
        } else {
            return Ok(self.all());
        }
        self.commit(next)
    }

    /// 取出最近 2 分钟内应执行的自动化，兼容旧的调用方。
    pub fn due_now(&self) -> Vec<Automation> {
        let now = Local::now();
        self.due_between(now - chrono::Duration::minutes(2), now)
    }

    pub fn due_at(&self, now: DateTime<Local>) -> Vec<Automation> {
        self.due_between(now - chrono::Duration::minutes(2), now)
    }

    /// 只触发上次轮询之后到期的任务。Mac 睡眠数小时后唤醒时，也会补执行一次。
    pub fn due_between(&self, since: DateTime<Local>, now: DateTime<Local>) -> Vec<Automation> {
        self.due_between_entries(since, now)
            .into_iter()
            .map(|entry| entry.automation)
            .collect()
    }

    /// 与 [`Self::due_between`] 相同，同时返回实际应执行的日期，供跨午夜补执行时记录。
    pub fn due_between_entries(
        &self,
        since: DateTime<Local>,
        now: DateTime<Local>,
    ) -> Vec<DueAutomation> {
        if now <= since {
            return Vec::new();
        }
        let first_day = since.date_naive();
        let last_day = now.date_naive();
        self.items
            .iter()
            .filter_map(|item| {
                if !item.enabled {
                    return None;
                }
                let Ok(target) = NaiveTime::parse_from_str(&item.time, "%H:%M") else {
                    return None;
                };
                let mut day = last_day;
                let mut scheduled_for = None;
                for _ in 0..14 {
                    let weekday = day.weekday().number_from_monday() as u8;
                    if item.days.contains(&weekday) {
                        if let Some(candidate) = day
                            .and_time(target)
                            .and_local_timezone(Local)
                            .single()
                            .or_else(|| day.and_time(target).and_local_timezone(Local).earliest())
                        {
                            if candidate >= since && candidate <= now {
                                scheduled_for = Some(candidate);
                                break;
                            }
                        }
                    }
                    if day == first_day {
                        break;
                    }
                    let Some(previous) = day.pred_opt() else {
                        break;
                    };
                    day = previous;
                }
                let scheduled_for = scheduled_for?;
                let marker = scheduled_for.format("%Y-%m-%d").to_string();
                if item.last_run.as_deref() == Some(marker.as_str()) {
                    return None;
                }
                Some(DueAutomation {
                    automation: item.clone(),
                    scheduled_for,
                })
            })
            .collect()
    }

    pub fn mark_run(&mut self, id: &str) -> Result<()> {
        self.mark_run_at(id, Local::now())
    }

    pub fn mark_run_at(&mut self, id: &str, now: DateTime<Local>) -> Result<()> {
        self.mark_run_for(id, now)
    }

    pub fn mark_run_for(&mut self, id: &str, scheduled_for: DateTime<Local>) -> Result<()> {
        let scheduled_day = scheduled_for.format("%Y-%m-%d").to_string();
        let mut next = self.items.clone();
        if let Some(item) = next.iter_mut().find(|item| item.id == id) {
            item.last_run = Some(scheduled_day);
            self.commit(next)?;
        }
        Ok(())
    }

    fn commit(&mut self, items: Vec<Automation>) -> Result<Vec<Automation>> {
        let previous = std::mem::replace(&mut self.items, items);
        if let Err(error) = self.save() {
            self.items = previous;
            return Err(error);
        }
        Ok(self.all())
    }

    fn save(&self) -> Result<()> {
        if let Some(error) = &self.load_error {
            return Err(anyhow!("自动化数据加载失败，已拒绝覆盖：{error}"));
        }
        let data = serde_json::to_vec_pretty(&FileData {
            items: self.items.clone(),
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .with_context(|| format!("设置文件权限失败：{}", temp.display()))?;
        }
        file.write_all(&data)
            .with_context(|| format!("写入失败：{}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("同步失败：{}", temp.display()))?;
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
        return Err(anyhow!("自动化文件为空：{}", path.display()));
    }
    if let Ok(file) = serde_json::from_slice::<FileData>(&data) {
        return Ok(file.items);
    }
    serde_json::from_slice::<Vec<Automation>>(&data)
        .with_context(|| format!("自动化文件格式错误：{}", path.display()))
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
    NaiveTime::parse_from_str(&item.time, "%H:%M").map_err(|_| anyhow!("时间必须是 HH:MM"))?;
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
        let dir =
            std::env::temp_dir().join(format!("mihome-automation-due-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("automations.json");
        let mut store = AutomationStore::new(&path);
        let items = store.upsert(sample()).unwrap();
        let now = Local
            .with_ymd_and_hms(2026, 10, 30, 7, 30, 0)
            .single()
            .unwrap();
        assert_eq!(store.due_at(now).len(), 1);
        assert!(store.due_at(now + chrono::Duration::minutes(3)).is_empty());
        store.mark_run_at(&items[0].id, now).unwrap();
        assert!(store.due_at(now).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn roundtrips_store() {
        let dir =
            std::env::temp_dir().join(format!("mihome-automation-test-{}", std::process::id()));
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

    #[test]
    fn catches_up_after_sleep_gap() {
        use chrono::TimeZone;
        let dir = std::env::temp_dir().join(format!(
            "mihome-automation-sleep-{}-{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        let path = dir.join("automations.json");
        let mut store = AutomationStore::new(&path);
        store.upsert(sample()).unwrap();
        let since = Local
            .with_ymd_and_hms(2026, 10, 30, 6, 0, 0)
            .single()
            .unwrap();
        let now = Local
            .with_ymd_and_hms(2026, 10, 30, 10, 0, 0)
            .single()
            .unwrap();
        assert_eq!(store.due_between(since, now).len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cross_midnight_catch_up_does_not_skip_same_day_run() {
        use chrono::TimeZone;
        let dir = std::env::temp_dir().join(format!(
            "mihome-automation-midnight-{}-{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        let path = dir.join("automations.json");
        let mut store = AutomationStore::new(&path);
        let items = store
            .upsert(Automation::new(
                "周末晚".into(),
                "23:00".into(),
                vec![5, 6],
                "scene-1".into(),
                "home-1".into(),
            ))
            .unwrap();
        let since = Local
            .with_ymd_and_hms(2026, 10, 30, 22, 0, 0)
            .single()
            .unwrap();
        let now = Local
            .with_ymd_and_hms(2026, 10, 31, 1, 0, 0)
            .single()
            .unwrap();
        let due = store.due_between_entries(since, now);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].scheduled_for.date_naive().to_string(), "2026-10-30");
        store
            .mark_run_for(&items[0].id, due[0].scheduled_for)
            .unwrap();
        let same_day = Local
            .with_ymd_and_hms(2026, 10, 31, 23, 0, 0)
            .single()
            .unwrap();
        assert_eq!(store.due_at(same_day).len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_store_is_not_overwritten() {
        let dir = std::env::temp_dir().join(format!(
            "mihome-automation-corrupt-{}-{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("automations.json");
        fs::write(&path, b"{broken").unwrap();
        let mut store = AutomationStore::new(&path);
        assert!(store.load_error().is_some());
        assert!(store.upsert(sample()).is_err());
        assert!(store.all().is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_save_rolls_back_in_memory_state() {
        let dir = std::env::temp_dir().join(format!(
            "mihome-automation-rollback-{}-{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        let path = dir.join("automations.json");
        let mut store = AutomationStore::new(&path);
        let items = store.upsert(sample()).unwrap();
        let blocked = dir.join("blocked");
        fs::create_dir_all(&blocked).unwrap();
        store.path = blocked;
        assert!(store.set_enabled(&items[0].id, false).is_err());
        assert!(store.all()[0].enabled);
        let _ = fs::remove_dir_all(&dir);
    }
}
