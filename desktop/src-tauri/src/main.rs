#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::Local;
use mihome_core::automation::{Automation, AutomationStore};
use mihome_core::camera::{self, CameraDevice, CameraDiagnostics, CameraStream, Go2Rtc};
use mihome_core::logging::{self as app_log, Level};
use mihome_core::remote_stream::RemoteStream;
use mihome_core::{auth, AuthStart, MiCloud, PendingLogin, SpecBatch, SpecRegistry};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State};
use tokio::sync::Mutex;

const CAMERA_CACHE_TTL: Duration = Duration::from_secs(15);

struct AppState {
    pending: Mutex<Option<PendingLogin>>,
    cloud: Mutex<Option<MiCloud>>,
    session_error: Mutex<Option<String>>,
    camera: Mutex<Option<Go2Rtc>>,
    remote_cameras: Mutex<HashMap<String, Arc<RemoteStream>>>,
    remote_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    camera_cache: Mutex<Option<(Instant, Vec<CameraDevice>)>>,
    camera_lifecycle: Mutex<()>,
    local_camera_epoch: AtomicU64,
    remote_camera_epoch: AtomicU64,
    camera_stop_request: AtomicU64,
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
            Ok(Some(session)) => {
                app_log::info(
                    "Auth",
                    format!(
                        "已恢复登录凭据：user={}",
                        app_log::mask_id(&session.user_id)
                    ),
                );
                (Some(MiCloud::new(session)), None)
            }
            Ok(None) => (None, None),
            Err(error) => {
                app_log::error("Auth", format!("恢复登录凭据失败：{error:#}"));
                (None, Some(error.to_string()))
            }
        };
        Self {
            pending: Mutex::new(None),
            cloud: Mutex::new(cloud),
            session_error: Mutex::new(session_error),
            camera: Mutex::new(None),
            remote_cameras: Mutex::new(HashMap::new()),
            remote_locks: Mutex::new(HashMap::new()),
            camera_cache: Mutex::new(None),
            camera_lifecycle: Mutex::new(()),
            local_camera_epoch: AtomicU64::new(0),
            remote_camera_epoch: AtomicU64::new(0),
            camera_stop_request: AtomicU64::new(0),
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
    app_log::info("Auth", "开始二维码登录");
    let (pending, start) = auth::start_login().await.map_err(|error| {
        app_log::error("Auth", format!("申请登录二维码失败：{error:#}"));
        error_text(error)
    })?;
    *state.pending.lock().await = Some(pending);
    app_log::info("Auth", "登录二维码已生成");
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
            let save_warning = session.save().err().map(|error| {
                app_log::error("Auth", format!("登录成功，但保存凭据失败：{error:#}"));
                format!("登录成功，但保存凭据失败：{error}")
            });
            app_log::info(
                "Auth",
                format!("扫码登录成功：user={}", app_log::mask_id(&user_id)),
            );
            *state.cloud.lock().await = Some(MiCloud::new(session));
            *state.session_error.lock().await = None;
            *state.camera_cache.lock().await = None;
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
        Err(error) => {
            app_log::error("Auth", format!("轮询扫码登录失败：{error:#}"));
            Ok(AuthPoll {
                status: "error",
                user_id: None,
                message: Some(error.to_string()),
            })
        }
    }
}

#[tauri::command]
async fn auth_logout(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    app_log::info("Auth", "用户退出登录");
    *state.pending.lock().await = None;
    *state.cloud.lock().await = None;
    *state.session_error.lock().await = None;
    *state.camera_cache.lock().await = None;
    stop_all_cameras(&state).await;
    auth::Session::clear_saved().map_err(error_text)
}

#[tauri::command]
async fn auth_resume(state: State<'_, Arc<AppState>>) -> Result<Option<String>, String> {
    let cloud = state.cloud.lock().await.clone();
    let Some(cloud) = cloud else {
        if let Some(error) = state.session_error.lock().await.clone() {
            app_log::warn("Auth", format!("无法恢复登录：{error}"));
            return Err(format!("恢复登录凭据失败：{error}"));
        }
        app_log::info("Auth", "当前没有已保存的登录状态");
        return Ok(None);
    };
    app_log::info(
        "Auth",
        format!("登录状态可用：user={}", app_log::mask_id(cloud.user_id())),
    );
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
    let homes = cloud.homes().await.map_err(|error| {
        app_log::error("Cloud", format!("读取家庭列表失败：{error:#}"));
        error_text(error)
    })?;
    app_log::info("Cloud", format!("已读取 {} 个家庭", homes.len()));
    Ok(homes)
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
    let devices = cloud.devices(home_id.as_deref()).await.map_err(|error| {
        app_log::error("Cloud", format!("读取设备列表失败：{error:#}"));
        error_text(error)
    })?;
    app_log::info("Cloud", format!("已读取 {} 台设备", devices.len()));
    Ok(devices)
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
    app_log::info("App", format!("界面已就绪：elapsed={elapsed}ms"));
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
    app_log::info(
        "Automation",
        format!(
            "检查定时任务 {} -> {}：{} 项到期",
            since.format("%Y-%m-%d %H:%M:%S"),
            now.format("%Y-%m-%d %H:%M:%S"),
            due.len()
        ),
    );
    for item in due {
        let cloud = state.cloud.lock().await.clone();
        if let Some(cloud) = cloud {
            match cloud
                .run_scene(&item.automation.scene_id, &item.automation.home_id)
                .await
            {
                Ok(_) => {
                    app_log::info(
                        "Automation",
                        format!(
                            "定时任务 {} 执行成功",
                            app_log::mask_id(&item.automation.id)
                        ),
                    );
                    if let Err(error) = state
                        .automations
                        .lock()
                        .await
                        .mark_run_for(&item.automation.id, item.scheduled_for)
                    {
                        app_log::error(
                            "Automation",
                            format!(
                                "定时任务 {} 已执行，但状态保存失败：{error:#}",
                                app_log::mask_id(&item.automation.id)
                            ),
                        );
                    }
                }
                Err(error) => {
                    app_log::error(
                        "Automation",
                        format!(
                            "定时任务 {} 执行失败：{error:#}",
                            app_log::mask_id(&item.automation.id)
                        ),
                    );
                }
            }
        }
    }
}

async fn cached_cameras_for(
    state: &Arc<AppState>,
    dids: &[String],
) -> Result<Vec<CameraDevice>, String> {
    let cached = {
        let cache = state.camera_cache.lock().await;
        cache.as_ref().and_then(|(fetched_at, cameras)| {
            if fetched_at.elapsed() >= CAMERA_CACHE_TTL
                || !dids
                    .iter()
                    .all(|did| cameras.iter().any(|camera| &camera.did == did))
            {
                return None;
            }
            Some(
                cameras
                    .iter()
                    .filter(|camera| dids.iter().any(|did| did == &camera.did))
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        })
    };
    if let Some(cameras) = cached {
        app_log::info(
            "Camera",
            format!("使用摄像头元数据缓存：{} 路", cameras.len()),
        );
        return Ok(cameras);
    }

    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    let cameras = cloud.cameras().await.map_err(|error| {
        app_log::error("Camera", format!("读取摄像头列表失败：{error:#}"));
        error_text(error)
    })?;
    *state.camera_cache.lock().await = Some((Instant::now(), cameras.clone()));
    Ok(cameras
        .into_iter()
        .filter(|camera| dids.iter().any(|did| did == &camera.did))
        .collect())
}

#[tauri::command]
async fn list_cameras(state: State<'_, Arc<AppState>>) -> Result<Vec<CameraDevice>, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    let cameras = cloud.cameras().await.map_err(|error| {
        app_log::error("Camera", format!("读取摄像头列表失败：{error:#}"));
        error_text(error)
    })?;
    *state.camera_cache.lock().await = Some((Instant::now(), cameras.clone()));
    app_log::info(
        "Camera",
        format!(
            "已读取 {} 台摄像头：{}",
            cameras.len(),
            cameras
                .iter()
                .map(|camera| format!(
                    "{} did={} model={} ip={} online={}",
                    camera.name,
                    app_log::mask_id(&camera.did),
                    camera.model,
                    camera.ip.as_deref().unwrap_or("无"),
                    camera.online
                ))
                .collect::<Vec<_>>()
                .join("；")
        ),
    );
    Ok(cameras)
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
        state
            .remote_locks
            .lock()
            .await
            .retain(|_, lock| Arc::strong_count(lock) > 1);
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

async fn prune_remote_lock(state: &Arc<AppState>, did: &str) {
    let mut locks = state.remote_locks.lock().await;
    if locks
        .get(did)
        .is_some_and(|lock| Arc::strong_count(lock) == 1)
    {
        locks.remove(did);
    }
}

#[tauri::command]
async fn camera_start(
    state: State<'_, Arc<AppState>>,
    dids: Vec<String>,
) -> Result<Vec<CameraStream>, String> {
    app_log::info(
        "Camera",
        format!(
            "请求本地画面：{} 路 {}",
            dids.len(),
            dids.iter()
                .map(|did| app_log::mask_id(did))
                .collect::<Vec<_>>()
                .join(",")
        ),
    );
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
    let selected = cached_cameras_for(&state, &dids).await?;
    if selected.is_empty() {
        app_log::warn("Camera", "请求的摄像头未出现在账号设备列表中");
        return Err("没有选中的摄像头".to_string());
    }
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    let binary = camera::find_binary().map_err(error_text)?;
    let user_id = cloud.user_id().to_string();
    let pass_token = cloud.pass_token().to_string();
    let selected_for_worker = selected.clone();
    let (runtime, streams) = tauri::async_runtime::spawn_blocking(move || {
        let runtime =
            Go2Rtc::start_for_cameras(&binary, &selected_for_worker, &user_id, &pass_token)?;
        let streams: Vec<CameraStream> = selected_for_worker
            .iter()
            .map(|camera| CameraStream {
                id: camera.did.clone(),
                url: runtime.stream_url_for_did(&camera.did),
                webrtc_url: Some(runtime.webrtc_url_for_did(&camera.did)),
                host: camera.ip.clone().unwrap_or_default(),
                prefer_mse: true,
            })
            .collect();
        Ok::<_, anyhow::Error>((runtime, streams))
    })
    .await
    .map_err(error_text)?
    .map_err(|error| {
        app_log::error("Camera", format!("本地取流启动失败：{error:#}"));
        error_text(error)
    })?;
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
        app_log::warn("Camera", "本地取流启动在完成前已被新请求取消");
        return Err("摄像头启动已取消".to_string());
    }
    if let Some(previous) = previous {
        drop_off_runtime(previous).await;
    }
    app_log::info(
        "Camera",
        format!(
            "本地画面地址已生成：{} 路；{}",
            streams.len(),
            streams
                .iter()
                .map(|stream| format!("did={} host={}", app_log::mask_id(&stream.id), stream.host))
                .collect::<Vec<_>>()
                .join("；")
        ),
    );
    Ok(streams)
}

#[tauri::command]
async fn camera_diagnostics(state: State<'_, Arc<AppState>>) -> Result<CameraDiagnostics, String> {
    let mut camera = state.camera.lock().await;
    camera
        .as_mut()
        .map(Go2Rtc::diagnostics)
        .ok_or_else(|| "本地取流服务未启动".to_string())
}

#[tauri::command]
async fn camera_remote_start(
    state: State<'_, Arc<AppState>>,
    did: String,
    quality: Option<u8>,
    audio: Option<bool>,
) -> Result<CameraStream, String> {
    let state = state.inner().clone();
    let start_lock = remote_lock(&state, &did).await;
    let start_guard = start_lock.lock().await;
    let result = camera_remote_start_locked(&state, &did, quality, audio).await;
    drop(start_guard);
    drop(start_lock);
    prune_remote_lock(&state, &did).await;
    result
}

async fn camera_remote_start_locked(
    state: &Arc<AppState>,
    did: &str,
    quality: Option<u8>,
    audio: Option<bool>,
) -> Result<CameraStream, String> {
    app_log::info(
        "Camera",
        format!(
            "请求远程画面：did={} quality={} audio={}",
            app_log::mask_id(did),
            quality.unwrap_or(2),
            audio.unwrap_or(false)
        ),
    );
    let session = state
        .cloud
        .lock()
        .await
        .as_ref()
        .ok_or_else(|| "未登录".to_string())?
        .session()
        .clone();
    let existing = {
        let map = state.remote_cameras.lock().await;
        map.get(did)
            .map(|stream| (stream.url(), stream.webrtc_url()))
    };
    if let Some((url, webrtc_url)) = existing {
        return Ok(CameraStream {
            id: did.to_string(),
            url,
            webrtc_url: Some(webrtc_url),
            host: "CS2 relay".to_string(),
            prefer_mse: false,
        });
    }
    let (remote_generation, stop_generation, local) = {
        let _lifecycle = state.camera_lifecycle.lock().await;
        let remote_generation = state.remote_camera_epoch.load(Ordering::SeqCst);
        let stop_generation = *state
            .remote_camera_stops
            .lock()
            .await
            .entry(did.to_string())
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
    let did_for_worker = did.to_string();
    let quality = quality.unwrap_or(2);
    let audio = audio.unwrap_or(false);
    let stream = tauri::async_runtime::spawn_blocking(move || {
        RemoteStream::start(session, &did_for_worker, quality, audio)
    })
    .await
    .map_err(error_text)?
    .map_err(|error| {
        app_log::error(
            "Camera",
            format!(
                "远程取流启动失败：did={} error={error:#}",
                app_log::mask_id(did)
            ),
        );
        error_text(error)
    })?;
    let mut pending = Some(stream);
    let Some(url) = pending.as_ref().map(RemoteStream::url) else {
        return Err("远程摄像头流已失效".to_string());
    };
    let webrtc_url = pending
        .as_ref()
        .map(RemoteStream::webrtc_url)
        .ok_or_else(|| "远程低延迟地址已失效".to_string())?;
    let stale = {
        let _lifecycle = state.camera_lifecycle.lock().await;
        let current_remote = state.remote_camera_epoch.load(Ordering::SeqCst);
        let current_stop = *state
            .remote_camera_stops
            .lock()
            .await
            .get(did)
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
                        .insert(did.to_string(), Arc::new(stream));
                    false
                }
                None => true,
            }
        }
    };
    if stale {
        drop_off_runtime(pending).await;
        app_log::warn(
            "Camera",
            format!("远程画面启动已取消：did={}", app_log::mask_id(did)),
        );
        return Err("远程摄像头启动已取消".to_string());
    }
    Ok(CameraStream {
        id: did.to_string(),
        url,
        webrtc_url: Some(webrtc_url),
        host: "CS2 relay".to_string(),
        prefer_mse: false,
    })
}

#[tauri::command]
async fn camera_remote_ptz(
    state: State<'_, Arc<AppState>>,
    did: String,
    direction: String,
) -> Result<(), String> {
    app_log::info(
        "Camera",
        format!(
            "云台命令：did={} direction={direction}",
            app_log::mask_id(&did)
        ),
    );
    let stream = state
        .remote_cameras
        .lock()
        .await
        .get(&did)
        .cloned()
        .ok_or_else(|| "远程画面还没有建立".to_string())?;
    stream.ptz(&direction).map_err(|error| {
        app_log::error(
            "Camera",
            format!(
                "云台命令失败：did={} direction={direction} error={error:#}",
                app_log::mask_id(&did)
            ),
        );
        error_text(error)
    })
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
    app_log::info(
        "Camera",
        match did.as_deref() {
            Some(did) => format!("停止远程画面：did={}", app_log::mask_id(did)),
            None => "停止全部远程画面".to_string(),
        },
    );
    let stopped_did = did.clone();
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
    if let Some(did) = stopped_did.as_deref() {
        prune_remote_lock(&state, did).await;
    }
    Ok(())
}

#[tauri::command]
async fn camera_stop(
    state: State<'_, Arc<AppState>>,
    request_id: Option<u64>,
) -> Result<(), String> {
    if let Some(request_id) = request_id {
        let previous = state
            .camera_stop_request
            .fetch_max(request_id, Ordering::SeqCst);
        if request_id <= previous {
            app_log::debug(
                "Camera",
                format!("忽略重复的停止请求：request={request_id} latest={previous}"),
            );
            return Ok(());
        }
    }
    app_log::info(
        "Camera",
        match request_id {
            Some(request_id) => format!("停止全部摄像头画面：request={request_id}"),
            None => "停止全部摄像头画面".to_string(),
        },
    );
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
    app_log::info(
        "Device",
        format!(
            "设置属性：did={} siid={siid} piid={piid} value={}",
            app_log::mask_id(&did),
            value.to_string().chars().take(80).collect::<String>()
        ),
    );
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud
        .set_prop(&did, siid, piid, value)
        .await
        .map_err(|error| {
            app_log::error(
                "Device",
                format!(
                    "设置属性失败：did={} siid={siid} piid={piid} error={error:#}",
                    app_log::mask_id(&did)
                ),
            );
            error_text(error)
        })
}

#[tauri::command]
fn log_frontend(level: String, tag: Option<String>, message: String) -> Result<(), String> {
    let level = match level.to_ascii_lowercase().as_str() {
        "debug" => Level::Debug,
        "warn" | "warning" => Level::Warn,
        "error" => Level::Error,
        _ => Level::Info,
    };
    app_log::write(level, tag.as_deref().unwrap_or("UI"), &message);
    Ok(())
}

#[tauri::command]
fn log_export() -> Result<String, String> {
    let path =
        app_log::export_diagnostics("MiHome Mac", env!("CARGO_PKG_VERSION")).map_err(|error| {
            app_log::error("Log", format!("导出诊断日志失败：{error:#}"));
            error_text(error)
        })?;
    app_log::info("Log", format!("诊断日志已导出：{}", path.display()));
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(&path).spawn();
    }
    Ok(path.to_string_lossy().to_string())
}

fn main() {
    match app_log::install_default() {
        Ok(path) => app_log::info(
            "App",
            format!(
                "MiHome Mac {} 启动；arch={}；logs={}",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::ARCH,
                path.display()
            ),
        ),
        Err(error) => eprintln!("日志系统初始化失败：{error:#}"),
    }
    tauri::Builder::default()
        .manage(Arc::new(AppState::default()))
        .setup(|app| {
            app_log::info("App", "Tauri 应用初始化");
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 MiHome Mac", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("MiHome Mac")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            if let Some(icon) = app.default_window_icon() {
                tray.set_icon(Some(icon.clone()))?;
            }
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                app_log::info("App", "主窗口已隐藏，定时任务继续运行");
            }
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
            camera_diagnostics,
            camera_remote_start,
            camera_remote_stop,
            camera_remote_ptz,
            call_action,
            camera_stop,
            camera_status,
            get_property,
            get_properties,
            set_property,
            log_frontend,
            log_export
        ])
        .run(tauri::generate_context!())
        .expect("failed to run MiHome Mac");
}
