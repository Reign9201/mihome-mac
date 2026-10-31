#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::Local;
use mihome_core::automation::{Automation, AutomationStore};
use mihome_core::camera::{self, CameraDevice, CameraStream, Go2Rtc};
use mihome_core::remote_stream::RemoteStream;
use mihome_core::{auth, AuthStart, MiCloud, PendingLogin, SpecBatch, SpecRegistry};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Manager, State};
use tokio::sync::Mutex;

struct AppState {
    pending: Mutex<Option<PendingLogin>>,
    cloud: Mutex<Option<MiCloud>>,
    session_error: Mutex<Option<String>>,
    camera: Mutex<Option<Go2Rtc>>,
    remote_cameras: Mutex<HashMap<String, Arc<RemoteStream>>>,
    remote_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    camera_lifecycle: Mutex<()>,
    local_camera_epoch: AtomicU64,
    remote_camera_epoch: AtomicU64,
    remote_camera_stops: Mutex<HashMap<String, u64>>,
    automations: Mutex<AutomationStore>,
    automation_tick: Mutex<chrono::DateTime<Local>>,
    specs: SpecRegistry,
    started: Instant,
}

fn automation_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/MiHome/automations.json")
}

impl Default for AppState {
    fn default() -> Self {
        let (cloud, session_error) = match auth::Session::restore() {
            Ok(Some(session)) => (Some(MiCloud::new(session)), None),
            Ok(None) => (None, None),
            Err(error) => (None, Some(error.to_string())),
        };
        Self {
            pending: Mutex::new(None),
            cloud: Mutex::new(cloud),
            session_error: Mutex::new(session_error),
            camera: Mutex::new(None),
            remote_cameras: Mutex::new(HashMap::new()),
            remote_locks: Mutex::new(HashMap::new()),
            camera_lifecycle: Mutex::new(()),
            local_camera_epoch: AtomicU64::new(0),
            remote_camera_epoch: AtomicU64::new(0),
            remote_camera_stops: Mutex::new(HashMap::new()),
            automations: Mutex::new(AutomationStore::new(automation_path())),
            automation_tick: Mutex::new(Local::now() - chrono::Duration::minutes(2)),
            specs: SpecRegistry::default(),
            started: Instant::now(),
        }
    }
}

#[derive(Serialize)]
struct AppMeta {
    name: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct AuthPoll {
    status: &'static str,
    user_id: Option<String>,
    message: Option<String>,
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
fn app_meta() -> AppMeta {
    AppMeta {
        name: "MiHome Mac",
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
async fn auth_start(state: State<'_, Arc<AppState>>) -> Result<AuthStart, String> {
    let (pending, start) = auth::start_login().await.map_err(error_text)?;
    *state.pending.lock().await = Some(pending);
    Ok(start)
}

#[tauri::command]
async fn auth_poll(state: State<'_, Arc<AppState>>) -> Result<AuthPoll, String> {
    let pending = state
        .pending
        .lock()
        .await
        .clone()
        .ok_or_else(|| "没有进行中的登录".to_string())?;
    match auth::poll_login(&pending).await {
        Ok(Some(session)) => {
            let user_id = session.user_id.clone();
            let save_warning = session
                .save()
                .err()
                .map(|error| format!("登录成功，但保存凭据失败：{error}"));
            *state.cloud.lock().await = Some(MiCloud::new(session));
            *state.session_error.lock().await = None;
            *state.pending.lock().await = None;
            Ok(AuthPoll {
                status: "success",
                user_id: Some(user_id),
                message: save_warning,
            })
        }
        Ok(None) => Ok(AuthPoll {
            status: "pending",
            user_id: None,
            message: None,
        }),
        Err(error) => Ok(AuthPoll {
            status: "error",
            user_id: None,
            message: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
async fn auth_logout(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    *state.pending.lock().await = None;
    *state.cloud.lock().await = None;
    *state.session_error.lock().await = None;
    stop_all_cameras(&state).await;
    auth::Session::clear_saved().map_err(error_text)
}

#[tauri::command]
async fn auth_resume(state: State<'_, Arc<AppState>>) -> Result<Option<String>, String> {
    let cloud = state.cloud.lock().await.clone();
    let Some(cloud) = cloud else {
        if let Some(error) = state.session_error.lock().await.clone() {
            return Err(format!("恢复登录凭据失败：{error}"));
        }
        return Ok(None);
    };
    // The UI immediately calls list_homes after resume. Avoid a duplicate cloud
    // request here so startup needs only one family-list round trip.
    Ok(Some(cloud.user_id().to_string()))
}

#[tauri::command]
async fn list_homes(state: State<'_, Arc<AppState>>) -> Result<Vec<mihome_core::Home>, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud.homes().await.map_err(error_text)
}

#[tauri::command]
async fn list_devices(
    state: State<'_, Arc<AppState>>,
    home_id: Option<String>,
) -> Result<Vec<mihome_core::Device>, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud.devices(home_id.as_deref()).await.map_err(error_text)
}

#[tauri::command]
async fn get_device_specs(
    state: State<'_, Arc<AppState>>,
    spec_types: Vec<String>,
) -> Result<SpecBatch, String> {
    if spec_types.len() > 128 {
        return Err("一次最多读取 128 个设备规格".to_string());
    }
    Ok(state.specs.load(&spec_types).await)
}

#[tauri::command]
async fn list_scenes(
    state: State<'_, Arc<AppState>>,
    home_id: String,
) -> Result<Vec<mihome_core::Scene>, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud.scenes(&home_id).await.map_err(error_text)
}

#[tauri::command]
async fn run_scene(
    state: State<'_, Arc<AppState>>,
    scene_id: String,
    home_id: String,
) -> Result<Value, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud
        .run_scene(&scene_id, &home_id)
        .await
        .map_err(error_text)
}

#[tauri::command]
fn ui_ready(state: State<'_, Arc<AppState>>) -> u128 {
    let elapsed = state.started.elapsed().as_millis();
    eprintln!("ui-ready {}ms", elapsed);
    elapsed
}

#[tauri::command]
async fn list_automations(state: State<'_, Arc<AppState>>) -> Result<Vec<Automation>, String> {
    let store = state.automations.lock().await;
    if let Some(error) = store.load_error() {
        return Err(format!("自动化数据加载失败：{error}"));
    }
    Ok(store.all())
}

#[tauri::command]
async fn save_automation(
    state: State<'_, Arc<AppState>>,
    automation: Automation,
) -> Result<Vec<Automation>, String> {
    state
        .automations
        .lock()
        .await
        .upsert(automation)
        .map_err(error_text)
}

#[tauri::command]
async fn delete_automation(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<Automation>, String> {
    state
        .automations
        .lock()
        .await
        .remove(&id)
        .map_err(error_text)
}

#[tauri::command]
async fn toggle_automation(
    state: State<'_, Arc<AppState>>,
    id: String,
    enabled: bool,
) -> Result<Vec<Automation>, String> {
    state
        .automations
        .lock()
        .await
        .set_enabled(&id, enabled)
        .map_err(error_text)
}

async fn run_due_automations(state: &Arc<AppState>) {
    let now = Local::now();
    let (since, due) = {
        let mut tick = state.automation_tick.lock().await;
        let since = *tick;
        *tick = now;
        let due = state
            .automations
            .lock()
            .await
            .due_between_entries(since, now);
        (since, due)
    };
    if due.is_empty() {
        return;
    }
    eprintln!(
        "automation tick {} -> {}: {} due",
        since.format("%Y-%m-%d %H:%M:%S"),
        now.format("%Y-%m-%d %H:%M:%S"),
        due.len()
    );
    for item in due {
        let cloud = state.cloud.lock().await.clone();
        if let Some(cloud) = cloud {
            match cloud
                .run_scene(&item.automation.scene_id, &item.automation.home_id)
                .await
            {
                Ok(_) => {
                    if let Err(error) = state
                        .automations
                        .lock()
                        .await
                        .mark_run_for(&item.automation.id, item.scheduled_for)
                    {
                        eprintln!(
                            "automation {} ran but could not be persisted: {error}",
                            item.automation.id
                        );
                    }
                }
                Err(error) => {
                    eprintln!("automation {} failed: {error}", item.automation.id);
                }
            }
        }
    }
}

#[tauri::command]
async fn list_cameras(state: State<'_, Arc<AppState>>) -> Result<Vec<CameraDevice>, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud.cameras().await.map_err(error_text)
}

async fn drop_off_runtime<T: Send + 'static>(value: T) {
    let _ = tauri::async_runtime::spawn_blocking(move || drop(value)).await;
}

async fn stop_all_cameras(state: &Arc<AppState>) {
    let (local, remote) = {
        let _lifecycle = state.camera_lifecycle.lock().await;
        state.local_camera_epoch.fetch_add(1, Ordering::SeqCst);
        state.remote_camera_epoch.fetch_add(1, Ordering::SeqCst);
        state.remote_camera_stops.lock().await.clear();
        let local = state.camera.lock().await.take();
        let remote = {
            let mut map = state.remote_cameras.lock().await;
            std::mem::take(&mut *map)
        };
        (local, remote)
    };
    drop_off_runtime((local, remote)).await;
}

async fn remote_lock(state: &Arc<AppState>, did: &str) -> Arc<Mutex<()>> {
    state
        .remote_locks
        .lock()
        .await
        .entry(did.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[tauri::command]
async fn camera_start(
    state: State<'_, Arc<AppState>>,
    dids: Vec<String>,
) -> Result<Vec<CameraStream>, String> {
    let (generation, remote) = {
        let _lifecycle = state.camera_lifecycle.lock().await;
        let generation = state.local_camera_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        state.remote_camera_epoch.fetch_add(1, Ordering::SeqCst);
        state.remote_camera_stops.lock().await.clear();
        let remote = {
            let mut map = state.remote_cameras.lock().await;
            std::mem::take(&mut *map)
        };
        (generation, remote)
    };
    if !remote.is_empty() {
        drop_off_runtime(remote).await;
    }
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    let all = cloud.cameras().await.map_err(error_text)?;
    let selected: Vec<CameraDevice> = all
        .into_iter()
        .filter(|camera| dids.iter().any(|did| did == &camera.did))
        .collect();
    if selected.is_empty() {
        return Err("没有选中的摄像头".to_string());
    }
    let binary = camera::find_binary().map_err(error_text)?;
    let user_id = cloud.user_id().to_string();
    let pass_token = cloud.pass_token().to_string();
    let selected_for_worker = selected.clone();
    let (runtime, streams) = tauri::async_runtime::spawn_blocking(move || {
        let runtime =
            Go2Rtc::start_for_cameras(&binary, &selected_for_worker, &user_id, &pass_token)?;
        let streams = selected_for_worker
            .iter()
            .map(|camera| CameraStream {
                id: camera.did.clone(),
                url: runtime.stream_url_for_did(&camera.did),
                host: camera.ip.clone().unwrap_or_default(),
            })
            .collect();
        Ok::<_, anyhow::Error>((runtime, streams))
    })
    .await
    .map_err(error_text)?
    .map_err(error_text)?;
    let mut pending = Some(runtime);
    let mut previous = None;
    let stale = {
        let _lifecycle = state.camera_lifecycle.lock().await;
        if state.local_camera_epoch.load(Ordering::SeqCst) != generation {
            true
        } else {
            match pending.take() {
                Some(runtime) => {
                    previous = state.camera.lock().await.replace(runtime);
                    false
                }
                None => true,
            }
        }
    };
    if stale {
        drop_off_runtime(pending).await;
        return Err("摄像头启动已取消".to_string());
    }
    if let Some(previous) = previous {
        drop_off_runtime(previous).await;
    }
    Ok(streams)
}

#[tauri::command]
async fn camera_remote_start(
    state: State<'_, Arc<AppState>>,
    did: String,
    quality: Option<u8>,
    audio: Option<bool>,
) -> Result<CameraStream, String> {
    let session = state
        .cloud
        .lock()
        .await
        .as_ref()
        .ok_or_else(|| "未登录".to_string())?
        .session()
        .clone();
    let start_lock = remote_lock(&state, &did).await;
    let _start_guard = start_lock.lock().await;
    let existing = {
        let map = state.remote_cameras.lock().await;
        map.get(&did).map(|stream| stream.url())
    };
    if let Some(url) = existing {
        return Ok(CameraStream {
            id: did,
            url,
            host: "CS2 relay".to_string(),
        });
    }
    let (remote_generation, stop_generation, local) = {
        let _lifecycle = state.camera_lifecycle.lock().await;
        let remote_generation = state.remote_camera_epoch.load(Ordering::SeqCst);
        let stop_generation = *state
            .remote_camera_stops
            .lock()
            .await
            .entry(did.clone())
            .or_insert(0);
        // Starting remote video invalidates a local go2rtc process still starting up.
        state.local_camera_epoch.fetch_add(1, Ordering::SeqCst);
        (
            remote_generation,
            stop_generation,
            state.camera.lock().await.take(),
        )
    };
    if local.is_some() {
        drop_off_runtime(local).await;
    }
    let did_for_worker = did.clone();
    let quality = quality.unwrap_or(2);
    let audio = audio.unwrap_or(false);
    let stream = tauri::async_runtime::spawn_blocking(move || {
        RemoteStream::start(session, &did_for_worker, quality, audio)
    })
    .await
    .map_err(error_text)?
    .map_err(error_text)?;
    let mut pending = Some(stream);
    let Some(url) = pending.as_ref().map(RemoteStream::url) else {
        return Err("远程摄像头流已失效".to_string());
    };
    let stale = {
        let _lifecycle = state.camera_lifecycle.lock().await;
        let current_remote = state.remote_camera_epoch.load(Ordering::SeqCst);
        let current_stop = *state
            .remote_camera_stops
            .lock()
            .await
            .get(&did)
            .unwrap_or(&0);
        if current_remote != remote_generation || current_stop != stop_generation {
            true
        } else {
            match pending.take() {
                Some(stream) => {
                    state
                        .remote_cameras
                        .lock()
                        .await
                        .insert(did.clone(), Arc::new(stream));
                    false
                }
                None => true,
            }
        }
    };
    if stale {
        drop_off_runtime(pending).await;
        return Err("远程摄像头启动已取消".to_string());
    }
    Ok(CameraStream {
        id: did,
        url,
        host: "CS2 relay".to_string(),
    })
}

#[tauri::command]
async fn camera_remote_ptz(
    state: State<'_, Arc<AppState>>,
    did: String,
    direction: String,
    speed: u8,
) -> Result<(), String> {
    let stream = state
        .remote_cameras
        .lock()
        .await
        .get(&did)
        .cloned()
        .ok_or_else(|| "远程画面还没有建立".to_string())?;
    stream.ptz(&direction, speed).map_err(error_text)
}

#[tauri::command]
async fn call_action(
    state: State<'_, Arc<AppState>>,
    did: String,
    siid: u32,
    aiid: u32,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud
        .call_action(
            &did,
            siid,
            aiid,
            params.unwrap_or_else(|| serde_json::json!([])),
        )
        .await
        .map_err(error_text)
}

#[tauri::command]
async fn camera_remote_stop(
    state: State<'_, Arc<AppState>>,
    did: Option<String>,
) -> Result<(), String> {
    let streams = {
        let _lifecycle = state.camera_lifecycle.lock().await;
        match did {
            Some(did) => {
                *state
                    .remote_camera_stops
                    .lock()
                    .await
                    .entry(did.clone())
                    .or_insert(0) += 1;
                state
                    .remote_cameras
                    .lock()
                    .await
                    .remove(&did)
                    .into_iter()
                    .collect::<Vec<_>>()
            }
            None => {
                state.remote_camera_epoch.fetch_add(1, Ordering::SeqCst);
                state.remote_camera_stops.lock().await.clear();
                state
                    .remote_cameras
                    .lock()
                    .await
                    .drain()
                    .map(|(_, stream)| stream)
                    .collect::<Vec<_>>()
            }
        }
    };
    drop_off_runtime(streams).await;
    Ok(())
}

#[tauri::command]
async fn camera_stop(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    stop_all_cameras(&state).await;
    Ok(())
}

#[tauri::command]
async fn camera_status(state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    Ok(state.camera.lock().await.is_some() || !state.remote_cameras.lock().await.is_empty())
}

#[tauri::command]
async fn get_property(
    state: State<'_, Arc<AppState>>,
    did: String,
    siid: u32,
    piid: u32,
) -> Result<Value, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud.get_prop(&did, siid, piid).await.map_err(error_text)
}

#[derive(Deserialize)]
struct PropRequest {
    did: String,
    siid: u32,
    piid: u32,
}

#[tauri::command]
async fn get_properties(
    state: State<'_, Arc<AppState>>,
    requests: Vec<PropRequest>,
) -> Result<Value, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    let items: Vec<(String, u32, u32)> = requests
        .into_iter()
        .map(|item| (item.did, item.siid, item.piid))
        .collect();
    cloud.get_props(&items).await.map_err(error_text)
}

#[tauri::command]
async fn set_property(
    state: State<'_, Arc<AppState>>,
    did: String,
    siid: u32,
    piid: u32,
    value: Value,
) -> Result<Value, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud
        .set_prop(&did, siid, piid, value)
        .await
        .map_err(error_text)
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(AppState::default()))
        .setup(|app| {
            let state = app.state::<Arc<AppState>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(30));
                loop {
                    ticker.tick().await;
                    run_due_automations(&state).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_meta,
            auth_start,
            auth_poll,
            auth_logout,
            auth_resume,
            list_homes,
            list_devices,
            get_device_specs,
            list_scenes,
            run_scene,
            ui_ready,
            list_automations,
            save_automation,
            delete_automation,
            toggle_automation,
            list_cameras,
            camera_start,
            camera_remote_start,
            camera_remote_stop,
            camera_remote_ptz,
            call_action,
            camera_stop,
            camera_status,
            get_property,
            get_properties,
            set_property
        ])
        .run(tauri::generate_context!())
        .expect("failed to run MiHome Mac");
}
