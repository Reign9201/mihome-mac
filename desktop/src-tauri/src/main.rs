#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mihome_core::camera::{self, CameraDevice, CameraStream, Go2Rtc};
use mihome_core::remote_stream::RemoteStream;
use mihome_core::automation::{Automation, AutomationStore};
use mihome_core::{auth, AuthStart, MiCloud, PendingLogin};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Manager, State};
use tokio::sync::Mutex;

struct AppState {
    pending: Mutex<Option<PendingLogin>>,
    cloud: Mutex<Option<MiCloud>>,
    camera: Mutex<Option<Go2Rtc>>,
    remote_cameras: Mutex<HashMap<String, RemoteStream>>,
    automations: Mutex<AutomationStore>,
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
        Self {
            pending: Mutex::new(None),
            cloud: Mutex::new(auth::Session::restore().ok().flatten().map(MiCloud::new)),
            camera: Mutex::new(None),
            remote_cameras: Mutex::new(HashMap::new()),
            automations: Mutex::new(AutomationStore::new(automation_path())),
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
            let _ = session.save();
            *state.cloud.lock().await = Some(MiCloud::new(session));
            *state.pending.lock().await = None;
            Ok(AuthPoll {
                status: "success",
                user_id: Some(user_id),
                message: None,
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
    auth::Session::clear_saved();
    Ok(())
}

#[tauri::command]
async fn auth_resume(state: State<'_, Arc<AppState>>) -> Result<Option<String>, String> {
    let cloud = state.cloud.lock().await.clone();
    let Some(cloud) = cloud else {
        return Ok(None);
    };
    let user_id = cloud.user_id().to_string();
    match cloud.homes().await {
        Ok(_) => Ok(Some(user_id)),
        // 网络抖动或云端临时失败时保留本地会话，避免一次失败就要求重新扫码。
        // 真正的鉴权失效由后续请求的错误提示和用户主动退出处理。
        Err(error) => Err(error_text(error)),
    }
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
    cloud
        .devices(home_id.as_deref())
        .await
        .map_err(error_text)
}

#[tauri::command]
async fn list_scenes(state: State<'_, Arc<AppState>>, home_id: String) -> Result<Vec<mihome_core::Scene>, String> {
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
    cloud.run_scene(&scene_id, &home_id).await.map_err(error_text)
}

#[tauri::command]
fn ui_ready(state: State<'_, Arc<AppState>>) -> u128 {
    let elapsed = state.started.elapsed().as_millis();
    eprintln!("ui-ready {}ms", elapsed);
    elapsed
}

#[tauri::command]
async fn list_automations(state: State<'_, Arc<AppState>>) -> Result<Vec<Automation>, String> {
    Ok(state.automations.lock().await.all())
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
    state.automations.lock().await.remove(&id).map_err(error_text)
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
    let due = state.automations.lock().await.due_now();
    for item in due {
        let cloud = state.cloud.lock().await.clone();
        if let Some(cloud) = cloud {
            if cloud.run_scene(&item.scene_id, &item.home_id).await.is_ok() {
                let _ = state.automations.lock().await.mark_run(&item.id);
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

#[tauri::command]
async fn camera_start(
    state: State<'_, Arc<AppState>>,
    dids: Vec<String>,
) -> Result<Vec<CameraStream>, String> {
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
    let runtime = Go2Rtc::start_for_cameras(&binary, &selected, &user_id, &pass_token)
        .map_err(error_text)?;
    let streams = selected
        .iter()
        .map(|camera| CameraStream {
            id: camera.did.clone(),
            url: runtime.stream_url_for_did(&camera.did),
            host: camera.ip.clone().unwrap_or_default(),
        })
        .collect();
    *state.camera.lock().await = Some(runtime);
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
    // 远程通道允许多路并存；切换本地通道时清掉 go2rtc。
    *state.camera.lock().await = None;
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
    let did_for_worker = did.clone();
    let quality = quality.unwrap_or(2);
    let audio = audio.unwrap_or(false);
    let stream = tauri::async_runtime::spawn_blocking(move || {
        RemoteStream::start(session, &did_for_worker, quality, audio)
    })
    .await
    .map_err(error_text)?
    .map_err(error_text)?;
    let url = stream.url();
    state.remote_cameras.lock().await.insert(did.clone(), stream);
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
    let guard = state.remote_cameras.lock().await;
    let stream = guard
        .get(&did)
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
        .call_action(&did, siid, aiid, params.unwrap_or_else(|| serde_json::json!([])))
        .await
        .map_err(error_text)
}

#[tauri::command]
async fn camera_remote_stop(
    state: State<'_, Arc<AppState>>,
    did: Option<String>,
) -> Result<(), String> {
    let mut map = state.remote_cameras.lock().await;
    if let Some(did) = did {
        map.remove(&did);
    } else {
        map.clear();
    }
    Ok(())
}

#[tauri::command]
async fn camera_stop(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    *state.camera.lock().await = None;
    state.remote_cameras.lock().await.clear();
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
