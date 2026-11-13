#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod asr;
mod assistant_engine;
mod dingtalk_ws;
mod feishu_ws;
mod gateway;
mod platform_bridge;
mod platform_recovery;
mod platform_supervisor;
mod wecom_ws;

use assistant_engine::{AssistantRequest, AssistantResponse, AssistantRuntime};
use chrono::Local;
use gateway::GatewayRuntime;
use mihome_core::automation::{Automation, AutomationStore};
use mihome_core::camera::{self, CameraDevice, CameraDiagnostics, CameraStream, Go2Rtc};
use mihome_core::logging::{self as app_log, Level};
use mihome_core::remote_stream::RemoteStream;
use mihome_core::{
    account_storage_key, auth, AccountBook, AccountSummary, AsrProvider, AuthStart, ConnectionMode,
    IntegrationStore, MiCloud, PendingLogin, PlatformKind, QuickPrefs, QuickPrefsStore, SpecBatch,
    SpecRegistry,
};
use platform_bridge::PlatformEventDedup;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State};
use tokio::sync::{Mutex, RwLock};

const CAMERA_CACHE_TTL: Duration = Duration::from_secs(15);

struct AppState {
    pending: Mutex<Option<PendingLogin>>,
    accounts: Mutex<AccountBook>,
    // Login, logout and account switch take the write side. Camera starts and
    // automation runs only need the account to stay put, so they share the
    // read side; a Mutex here serialized every remote grid tile behind the
    // slowest relay handshake and delayed scheduled scenes behind it.
    account_lifecycle: RwLock<()>,
    account_epoch: AtomicU64,
    login_epoch: AtomicU64,
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
    integrations: Mutex<IntegrationStore>,
    quick_prefs: Mutex<QuickPrefsStore>,
    assistant_runtime: Mutex<AssistantRuntime>,
    platform_events: Mutex<PlatformEventDedup>,
    gateway: Mutex<GatewayRuntime>,
    feishu_ws: Mutex<feishu_ws::FeishuRuntime>,
    wecom_ws: Mutex<wecom_ws::WecomRuntime>,
    dingtalk_ws: Mutex<dingtalk_ws::DingtalkRuntime>,
    specs: SpecRegistry,
    // 点击菜单栏图标时，面板会先收到失焦事件再收到点击事件。这个计数器让
    // 迟到的隐藏任务失效，避免“点一下图标先关再开”的闪烁。
    quick_hide_token: AtomicU64,
    // 面板最近一次弹出的时刻。松开鼠标时系统会把焦点交还给之前的应用，触发
    // 一次失焦；这是打开面板的必然过程，开头的几百毫秒内不据此收起面板。
    quick_shown_at: Mutex<Option<Instant>>,
    started: Instant,
}

/// 把速控窗口改造成菜单栏浮层的形态。这几步缺一不可，都是照 AgentQuotaBar 的
/// NSPanel 配置来的：
///
/// * 窗口类换成 `NSPanel`：Tauri 建的是普通 `NSWindow`，普通窗口所在的 Space 由
///   系统锁死，设了 canJoinAllSpaces 也进不了别的应用正在全屏的那个 Space，表现为
///   「点了图标没反应」。实测只有 NSPanel 能跨进去。
/// * 样式位加 `nonactivatingPanel`：面板弹出时不激活整个应用，否则会把用户从全屏
///   应用里拽出来。
/// * `canJoinAllSpaces | fullScreenAuxiliary`：跟随当前 Space，并且允许盖在全屏
///   应用上面。
/// * 层级提到 statusBar：全屏内容是 normal 层，statusBar 才能压住它。
///
/// 面板显示用 orderFrontRegardless，不调用 makeKeyAndOrderFront 加激活应用那一套，
/// 那条路径会把窗口带回原来的 Space。代价是窗口拿不到键盘焦点，页面里的点击靠
/// accept_first_mouse 接收第一下——所以速控窗口只能在这里用构建器创建，
/// tauri.conf.json 里的窗口声明没有这一项。
fn create_quick_panel(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let builder =
        tauri::WebviewWindowBuilder::new(app, "quick", tauri::WebviewUrl::App("quick.html".into()))
            .title("米家速控")
            .inner_size(320.0, 420.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .visible(false)
            .focused(false)
            .shadow(false)
            .skip_taskbar(true);
    // 非激活面板没拿到键盘焦点，第一下点击也要交给页面，否则用户得点两次开关。
    #[cfg(target_os = "macos")]
    let builder = builder.accept_first_mouse(true);
    builder.build()
}

/// 面板弹出用 orderFrontRegardless、收起用 orderOut。这一对不经过激活应用，
/// 窗口会留在用户当前所在的 Space 上；Tauri 的 show/hide 走的是
/// makeKeyAndOrderFront/orderOut，前者会把窗口带回原来的 Space。
#[cfg(target_os = "macos")]
fn set_quick_panel_visible(quick: &tauri::WebviewWindow, visible: bool) {
    use objc2_app_kit::NSWindow;

    let Ok(ns_window) = quick.ns_window() else {
        app_log::warn("App", "拿不到速控窗口的 NSWindow，改用默认显示方式");
        let _ = if visible { quick.show() } else { quick.hide() };
        return;
    };
    // SAFETY: ns_window 返回的是 Tauri 自己创建的窗口指针，且这里运行在主线程。
    let window = unsafe { &*(ns_window as *const NSWindow) };
    if visible {
        window.orderFrontRegardless();
    } else {
        window.orderOut(None);
    }
}

/// 把速控窗口改造成菜单栏浮层的形态。这几步缺一不可，都是照 AgentQuotaBar 的
/// NSPanel 配置来的：
///
/// * 窗口类换成 `NSPanel`：Tauri 建的是普通 `NSWindow`，普通窗口所在的 Space 由
///   系统锁死，设了 canJoinAllSpaces 也进不了别的应用正在全屏的那个 Space，表现为
///   「点了图标没反应」。实测只有 NSPanel 能跨进去。
/// * 样式位加 `nonactivatingPanel`：面板弹出时不激活整个应用，否则会把用户从全屏
///   应用里拽出来。
/// * `canJoinAllSpaces | fullScreenAuxiliary`：跟随当前 Space，并且允许盖在全屏
///   应用上面。
/// * 层级提到 statusBar：全屏内容是 normal 层，statusBar 才能压住它。
#[cfg(target_os = "macos")]
fn configure_quick_panel_space(quick: &tauri::WebviewWindow) {
    use objc2_app_kit::{
        NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask,
    };

    let Ok(ns_window) = quick.ns_window() else {
        app_log::warn("App", "拿不到速控窗口的 NSWindow，全屏下可能无法显示面板");
        return;
    };
    // SAFETY: ns_window 返回的是 Tauri 自己创建的窗口指针，且这里运行在主线程。
    // 换类之前确认过 NSPanel 与 NSWindow 的实例大小一致（都是 520 字节）。
    unsafe {
        use objc2::runtime::AnyObject;
        use objc2::ClassType;
        let object = &*(ns_window as *const AnyObject);
        let panel_class = objc2_app_kit::NSPanel::class();
        if object.class() != panel_class {
            AnyObject::set_class(object, panel_class);
        }
        let window = &*(ns_window as *const NSWindow);
        window.setStyleMask(window.styleMask() | NSWindowStyleMask::NonactivatingPanel);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
        window.setLevel(NSStatusWindowLevel);
        window.setHidesOnDeactivate(false);
    }
}

/// 速控面板的显示状态。托盘点击、外部点击、页面里的关闭按钮都改这一个值，
/// 不需要每次去问 WebView 窗口现在是不是可见。
static QUICK_VISIBLE: AtomicBool = AtomicBool::new(false);

/// 上一帧鼠标是不是按着的。用来把连续多帧的「按着」识别成一次按下。
static QUICK_MOUSE_DOWN: AtomicBool = AtomicBool::new(false);

/// 面板最近一次弹出的时刻（进程启动后的毫秒数）。点菜单栏图标那一下本身也是
/// 一次鼠标按下，弹出后要忽略紧随其后的这一帧，否则面板刚开就被自己关掉。
static QUICK_SHOWN_MS: AtomicU64 = AtomicU64::new(0);
static QUICK_CLOCK: OnceLock<Instant> = OnceLock::new();

/// 忽略弹出后这段时间内读到的按下。
const QUICK_OUTSIDE_GRACE_MS: u64 = 250;

/// 待确认的「点外部收起」时刻。点菜单栏图标收起面板时，轮询和托盘点击回调都会
/// 看到这一次按下：轮询先判定「点在面板外」把面板收起来，紧接着托盘回调发现面板
/// 已收起，于是又把它打开，表现是点图标关不掉面板。所以轮询读到面板外的按下时
/// 不立刻收起，先记下时刻，等一小段时间再确认：这期间托盘回调已经关掉了面板就
/// 不再重复处理，没关掉才由轮询收起。0 表示当前没有待确认的收起。
static QUICK_PENDING_HIDE_MS: AtomicU64 = AtomicU64::new(0);

/// 读到面板外的按下后，等这么久再确认收起。实测同一击里托盘回调在 3 毫秒内就会
/// 执行，100 毫秒留足余量；这点延迟用户看不出来。
const QUICK_HIDE_CONFIRM_MS: u64 = 100;

fn quick_now_ms() -> u64 {
    QUICK_CLOCK.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// 轮询定时器的句柄。定时器一旦被释放就停止触发，所以它要活到进程结束。
static QUICK_POLL_TIMER: OnceLock<usize> = OnceLock::new();

/// 点面板外任何位置都收起面板。
///
/// 判定方式是每 30ms 读一次 `NSEvent.pressedMouseButtons`：从「没按」变成「按着」
/// 的那一帧记一次按下，读到的鼠标位置不在面板矩形里就收起。面板内部还是外部，
/// 只比一个矩形，面板里的开关照常工作。
///
/// 不用 `NSEvent.addGlobalMonitorForEvents`：那个接口从 macOS 10.15 起要系统
/// 「辅助功能」授权，没授权时照样返回句柄、但事件永远不投递，表现就是点了外面
/// 没反应。实测 `pressedMouseButtons` 不需要任何授权。
///
/// 也不靠「窗口失焦」：面板是 `nonactivatingPanel`，弹出时不激活本应用，用户去点
/// 别的应用时本应用本来就没焦点，收不到失焦事件。
#[cfg(target_os = "macos")]
fn install_quick_outside_poll(app: &tauri::AppHandle) {
    use objc2::rc::Retained;
    use objc2_foundation::{NSRunLoop, NSRunLoopCommonModes, NSTimer};

    let handle = app.clone();
    let block = block2::RcBlock::new(move |_timer: std::ptr::NonNull<NSTimer>| {
        poll_quick_outside_press(&handle);
    });
    // SAFETY: 定时器只在主线程创建并挂到主 RunLoop，块里只读事件状态和窗口矩形。
    let timer = unsafe { NSTimer::timerWithTimeInterval_repeats_block(0.03, true, &block) };
    unsafe { NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
    let _ = QUICK_POLL_TIMER.set(Retained::into_raw(timer) as usize);
}

#[cfg(target_os = "macos")]
fn poll_quick_outside_press(app: &tauri::AppHandle) {
    use objc2_app_kit::{NSEvent, NSWindow};

    // 上一轮读到面板外的按下，先看托盘回调有没有把面板关掉，没关掉才由这里收起。
    let pending = QUICK_PENDING_HIDE_MS.load(Ordering::SeqCst);
    if pending != 0 && quick_now_ms().saturating_sub(pending) >= QUICK_HIDE_CONFIRM_MS {
        QUICK_PENDING_HIDE_MS.store(0, Ordering::SeqCst);
        // 面板在这次按下之后重新弹出过（比如刚被托盘回调打开），这次收起作废。
        let shown = QUICK_SHOWN_MS.load(Ordering::SeqCst);
        if QUICK_VISIBLE.load(Ordering::SeqCst) && shown <= pending {
            if let Some(quick) = app.get_webview_window("quick") {
                set_quick_visible(&quick, false);
                app_log::info("App", "点击面板外部，速控面板已收起");
            }
        }
    }

    let pressed = NSEvent::pressedMouseButtons() != 0;
    let was_pressed = QUICK_MOUSE_DOWN.swap(pressed, Ordering::SeqCst);
    if !pressed || was_pressed || !QUICK_VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    if quick_now_ms().saturating_sub(QUICK_SHOWN_MS.load(Ordering::SeqCst)) < QUICK_OUTSIDE_GRACE_MS
    {
        return;
    }
    let Some(quick) = app.get_webview_window("quick") else {
        return;
    };
    let Ok(ns_window) = quick.ns_window() else {
        return;
    };
    // SAFETY: ns_window 是 Tauri 自己创建的窗口指针，这里运行在主线程。
    let frame = unsafe { &*(ns_window as *const NSWindow) }.frame();
    let at = NSEvent::mouseLocation();
    let inside = at.x >= frame.origin.x
        && at.x <= frame.origin.x + frame.size.width
        && at.y >= frame.origin.y
        && at.y <= frame.origin.y + frame.size.height;
    if inside {
        return;
    }
    // 不在这里立刻收起：这一下可能正是点菜单栏图标，托盘回调马上会处理。
    QUICK_PENDING_HIDE_MS.store(quick_now_ms(), Ordering::SeqCst);
}

fn set_quick_visible(quick: &tauri::WebviewWindow, visible: bool) {
    QUICK_VISIBLE.store(visible, Ordering::SeqCst);
    if visible {
        QUICK_SHOWN_MS.store(quick_now_ms(), Ordering::SeqCst);
        let _ = show_quick_panel(quick);
    } else {
        hide_quick_panel(quick);
    }
}

fn toggle_quick_panel(app: &tauri::AppHandle, rect: tauri::Rect) {
    let Some(quick) = app.get_webview_window("quick") else {
        app_log::warn("App", "速控窗口不存在，无法打开菜单栏面板");
        return;
    };
    let state = app.state::<Arc<AppState>>().inner().clone();
    // 点击菜单栏图标会先让面板失焦；作废这次隐藏任务，改由下面的点击逻辑决定开或关。
    state.quick_hide_token.fetch_add(1, Ordering::SeqCst);
    if QUICK_VISIBLE.load(Ordering::SeqCst) || quick.is_visible().unwrap_or(false) {
        set_quick_visible(&quick, false);
        app_log::info("App", "菜单栏速控面板已关闭");
        return;
    }
    position_quick_panel(&quick, rect);
    set_quick_visible(&quick, true);
    *state.quick_shown_at.blocking_lock() = Some(Instant::now());
    app_log::info("App", "菜单栏速控面板已打开");
}

/// 面板弹出。macOS 上走 orderFrontRegardless，避免激活应用把窗口带回原来的 Space；
/// 其他平台用 Tauri 的 show。
#[cfg(target_os = "macos")]
fn show_quick_panel(quick: &tauri::WebviewWindow) -> tauri::Result<()> {
    set_quick_panel_visible(quick, true);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn show_quick_panel(quick: &tauri::WebviewWindow) -> tauri::Result<()> {
    quick.show()
}

#[cfg(target_os = "macos")]
fn hide_quick_panel(quick: &tauri::WebviewWindow) {
    set_quick_panel_visible(quick, false);
}

#[cfg(not(target_os = "macos"))]
fn hide_quick_panel(quick: &tauri::WebviewWindow) {
    let _ = quick.hide();
}

fn position_quick_panel(quick: &tauri::WebviewWindow, rect: tauri::Rect) {
    let scale = quick.scale_factor().unwrap_or(1.0);
    if scale <= 0.0 {
        return;
    }
    let icon_position = rect.position.to_logical::<f64>(scale);
    let icon_size = rect.size.to_logical::<f64>(scale);
    let window_size = quick
        .outer_size()
        .map(|size| size.to_logical::<f64>(scale))
        .unwrap_or_else(|_| tauri::LogicalSize::new(320.0, 420.0));
    let icon_center = icon_position.x + icon_size.width / 2.0;
    let x = panel_x(
        icon_center,
        window_size.width,
        screen_bounds_around(quick, icon_center),
    );
    let y = icon_position.y + icon_size.height + 6.0;
    if let Err(error) = quick.set_position(tauri::LogicalPosition::new(x, y)) {
        app_log::warn("App", format!("定位菜单栏速控面板失败：{error}"));
    }
}

const QUICK_PANEL_MARGIN: f64 = 8.0;

/// 面板默认与图标水平居中对齐。菜单栏图标都在屏幕右侧，居中会把面板推出屏幕，
/// 所以再按图标所在屏幕的横向范围夹一次，两侧各留 8px。
fn panel_x(icon_center: f64, panel_width: f64, bounds: Option<(f64, f64)>) -> f64 {
    let centered = icon_center - panel_width / 2.0;
    match bounds {
        Some((left, right)) => {
            let min_x = left + QUICK_PANEL_MARGIN;
            let max_x = (right - panel_width - QUICK_PANEL_MARGIN).max(min_x);
            centered.max(min_x).min(max_x)
        }
        None => centered,
    }
}

/// 找到离鼠标点击位置最近的屏幕，返回它的逻辑横坐标范围。
fn screen_bounds_around(quick: &tauri::WebviewWindow, x: f64) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64, f64)> = None;
    for monitor in quick.available_monitors().ok()? {
        let monitor_scale = monitor.scale_factor();
        if monitor_scale <= 0.0 {
            continue;
        }
        let position = monitor.position().to_logical::<f64>(monitor_scale);
        let size = monitor.size().to_logical::<f64>(monitor_scale);
        let left = position.x;
        let right = position.x + size.width;
        let distance = if x < left {
            left - x
        } else if x > right {
            x - right
        } else {
            0.0
        };
        if best.is_none_or(|(_, _, best_distance)| distance < best_distance) {
            best = Some((left, right, distance));
        }
    }
    best.map(|(left, right, _)| (left, right))
}

fn automation_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/MiHome/automations.json")
}

fn automation_path_for(user_id: &str) -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/MiHome/automations")
        .join(format!("{}.json", account_storage_key(user_id)))
}

fn quick_prefs_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/MiHome/quick.json")
}

fn quick_prefs_path_for(user_id: &str) -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Application Support/MiHome/quick")
        .join(format!("{}.json", account_storage_key(user_id)))
}

/// 面板配置按账号隔离：同一台 Mac 上换账号后不该沿用上一个账号的设备 did。
fn quick_prefs_store_for(user_id: Option<&str>) -> QuickPrefsStore {
    match user_id {
        Some(user_id) => QuickPrefsStore::new(quick_prefs_path_for(user_id)),
        None => QuickPrefsStore::new(quick_prefs_path()),
    }
}

fn automation_store_for(user_id: Option<&str>) -> AutomationStore {
    let Some(user_id) = user_id else {
        return AutomationStore::new(automation_path());
    };
    let path = automation_path_for(user_id);
    let legacy = automation_path();
    if !path.exists() && legacy.exists() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match fs::rename(&legacy, &path) {
            Ok(()) => app_log::info(
                "Automation",
                format!("旧自动化数据已迁移到账号 {}", app_log::mask_id(user_id)),
            ),
            Err(error) => app_log::warn("Automation", format!("旧自动化数据迁移失败：{error}")),
        }
    }
    AutomationStore::new(path)
}

impl Default for AppState {
    fn default() -> Self {
        let (accounts, session_error) = match AccountBook::load() {
            Ok(accounts) => (accounts, None),
            Err(error) => {
                app_log::error("Auth", format!("恢复账号列表失败：{error:#}"));
                (AccountBook::empty(), Some(error.to_string()))
            }
        };
        let active_user_id = accounts.active_user_id().map(str::to_string);
        let cloud = match accounts.active_session() {
            Some(session) => {
                app_log::info(
                    "Auth",
                    format!(
                        "已恢复登录凭据：user={} accounts={}",
                        app_log::mask_id(&session.user_id),
                        accounts.summaries().len()
                    ),
                );
                Some(MiCloud::new(session))
            }
            None => None,
        };
        Self {
            pending: Mutex::new(None),
            accounts: Mutex::new(accounts),
            account_lifecycle: RwLock::new(()),
            account_epoch: AtomicU64::new(0),
            login_epoch: AtomicU64::new(0),
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
            automations: Mutex::new(automation_store_for(active_user_id.as_deref())),
            automation_tick: Mutex::new(Local::now() - chrono::Duration::minutes(2)),
            integrations: Mutex::new(IntegrationStore::load()),
            quick_prefs: Mutex::new(quick_prefs_store_for(active_user_id.as_deref())),
            assistant_runtime: Mutex::new(AssistantRuntime::default()),
            platform_events: Mutex::new(PlatformEventDedup::default()),
            gateway: Mutex::new(GatewayRuntime::default()),
            feishu_ws: Mutex::new(feishu_ws::FeishuRuntime::default()),
            wecom_ws: Mutex::new(wecom_ws::WecomRuntime::default()),
            dingtalk_ws: Mutex::new(dingtalk_ws::DingtalkRuntime::default()),
            specs: SpecRegistry::default(),
            quick_hide_token: AtomicU64::new(0),
            quick_shown_at: Mutex::new(None),
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

#[derive(Serialize)]
struct AuthLogout {
    active_user_id: Option<String>,
    accounts: Vec<AccountSummary>,
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn platform_display_name(platform: PlatformKind) -> &'static str {
    match platform {
        PlatformKind::Feishu => "飞书",
        PlatformKind::Wecom => "企业微信",
        PlatformKind::Dingtalk => "钉钉",
    }
}

fn platform_id_label(platform: PlatformKind) -> &'static str {
    match platform {
        PlatformKind::Feishu => "App ID",
        PlatformKind::Wecom => "Bot ID",
        PlatformKind::Dingtalk => "Client ID",
    }
}

fn platform_secret_label(platform: PlatformKind) -> &'static str {
    match platform {
        PlatformKind::Feishu => "App Secret",
        PlatformKind::Wecom => "Bot Secret",
        PlatformKind::Dingtalk => "Client Secret",
    }
}

async fn install_active_session(
    state: &Arc<AppState>,
    session: auth::Session,
) -> Result<(), String> {
    let user_id = session.user_id.clone();
    stop_all_cameras(state).await;
    *state.cloud.lock().await = Some(MiCloud::new(session));
    *state.camera_cache.lock().await = None;
    let mut pending = state.pending.lock().await;
    state.login_epoch.fetch_add(1, Ordering::SeqCst);
    *pending = None;
    drop(pending);
    *state.session_error.lock().await = None;
    *state.automations.lock().await = automation_store_for(Some(&user_id));
    *state.quick_prefs.lock().await = quick_prefs_store_for(Some(&user_id));
    *state.automation_tick.lock().await = Local::now() - chrono::Duration::minutes(2);
    state.assistant_runtime.lock().await.clear_sensitive_state();
    *state.platform_events.lock().await = PlatformEventDedup::default();
    state.account_epoch.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

async fn clear_active_session(state: &Arc<AppState>) {
    stop_all_cameras(state).await;
    *state.cloud.lock().await = None;
    *state.camera_cache.lock().await = None;
    let mut pending = state.pending.lock().await;
    state.login_epoch.fetch_add(1, Ordering::SeqCst);
    *pending = None;
    drop(pending);
    *state.session_error.lock().await = None;
    *state.automations.lock().await = automation_store_for(None);
    *state.quick_prefs.lock().await = quick_prefs_store_for(None);
    *state.automation_tick.lock().await = Local::now() - chrono::Duration::minutes(2);
    state.assistant_runtime.lock().await.clear_sensitive_state();
    *state.platform_events.lock().await = PlatformEventDedup::default();
    state.account_epoch.fetch_add(1, Ordering::SeqCst);
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
    let login_epoch = state.login_epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let (pending, start) = auth::start_login().await.map_err(|error| {
        app_log::error("Auth", format!("申请登录二维码失败：{error:#}"));
        error_text(error)
    })?;
    let mut pending_slot = state.pending.lock().await;
    if state.login_epoch.load(Ordering::SeqCst) != login_epoch {
        return Err("二维码请求已被新的登录请求替换".to_string());
    }
    *pending_slot = Some(pending);
    drop(pending_slot);
    app_log::info("Auth", "登录二维码已生成");
    Ok(start)
}

#[tauri::command]
async fn auth_poll(state: State<'_, Arc<AppState>>) -> Result<AuthPoll, String> {
    let (pending, login_epoch) = {
        let pending = state.pending.lock().await.clone();
        let login_epoch = state.login_epoch.load(Ordering::SeqCst);
        (pending, login_epoch)
    };
    let pending = pending.ok_or_else(|| "没有进行中的登录".to_string())?;
    match auth::poll_login(&pending).await {
        Ok(Some(session)) => {
            if state.login_epoch.load(Ordering::SeqCst) != login_epoch {
                app_log::info("Auth", "忽略已取消的登录轮询结果");
                return Ok(AuthPoll {
                    status: "error",
                    user_id: None,
                    message: Some("登录已取消，请重新生成二维码".to_string()),
                });
            }
            let user_id = session.user_id.clone();
            let _account_lifecycle = state.account_lifecycle.write().await;
            if state.login_epoch.load(Ordering::SeqCst) != login_epoch {
                app_log::info("Auth", "账号切换期间忽略过期登录结果");
                return Ok(AuthPoll {
                    status: "error",
                    user_id: None,
                    message: Some("登录已取消，请重新生成二维码".to_string()),
                });
            }
            let mut next_book = state.accounts.lock().await.clone();
            next_book.upsert(session.clone(), None).map_err(|error| {
                app_log::error("Auth", format!("登录成功，但保存账号失败：{error:#}"));
                format!("登录成功，但保存账号失败：{error}")
            })?;
            *state.accounts.lock().await = next_book;
            install_active_session(&state, session).await?;
            app_log::info(
                "Auth",
                format!("扫码登录成功：user={}", app_log::mask_id(&user_id)),
            );
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
async fn auth_logout(state: State<'_, Arc<AppState>>) -> Result<AuthLogout, String> {
    let _account_lifecycle = state.account_lifecycle.write().await;
    let current_user_id = state
        .cloud
        .lock()
        .await
        .as_ref()
        .map(|cloud| cloud.user_id().to_string());
    let Some(current_user_id) = current_user_id else {
        let book = state.accounts.lock().await;
        return Ok(AuthLogout {
            active_user_id: book.active_user_id().map(str::to_string),
            accounts: book.summaries(),
        });
    };
    app_log::info(
        "Auth",
        format!(
            "移除当前登录账号：user={}",
            app_log::mask_id(&current_user_id)
        ),
    );
    let mut next_book = state.accounts.lock().await.clone();
    let next_session = next_book.remove(&current_user_id).map_err(error_text)?;
    *state.accounts.lock().await = next_book;
    if let Some(session) = next_session {
        install_active_session(&state, session).await?;
    } else {
        clear_active_session(&state).await;
    }
    let book = state.accounts.lock().await;
    Ok(AuthLogout {
        active_user_id: book.active_user_id().map(str::to_string),
        accounts: book.summaries(),
    })
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
async fn auth_accounts(state: State<'_, Arc<AppState>>) -> Result<Vec<AccountSummary>, String> {
    Ok(state.accounts.lock().await.summaries())
}

#[tauri::command]
async fn auth_switch_account(
    state: State<'_, Arc<AppState>>,
    user_id: String,
) -> Result<String, String> {
    let _account_lifecycle = state.account_lifecycle.write().await;
    let mut next_book = state.accounts.lock().await.clone();
    let session = next_book.switch_to(&user_id).map_err(error_text)?;
    *state.accounts.lock().await = next_book;
    install_active_session(&state, session).await?;
    app_log::info(
        "Auth",
        format!("已切换账号：user={}", app_log::mask_id(&user_id)),
    );
    Ok(user_id)
}

#[tauri::command]
async fn auth_set_account_label(
    state: State<'_, Arc<AppState>>,
    label: String,
) -> Result<(), String> {
    let user_id = state
        .cloud
        .lock()
        .await
        .as_ref()
        .map(|cloud| cloud.user_id().to_string())
        .ok_or_else(|| "未登录".to_string())?;
    let mut next_book = state.accounts.lock().await.clone();
    next_book
        .set_display_name(&user_id, &label)
        .map_err(error_text)?;
    *state.accounts.lock().await = next_book;
    Ok(())
}

#[tauri::command]
async fn auth_cancel(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut pending = state.pending.lock().await;
    state.login_epoch.fetch_add(1, Ordering::SeqCst);
    *pending = None;
    Ok(())
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
fn quick_open_main(app: tauri::AppHandle) {
    if let Some(quick) = app.get_webview_window("quick") {
        set_quick_visible(&quick, false);
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// 面板配置：用户在设置里挑的常用设备和场景，按挑选顺序返回。
#[tauri::command]
async fn quick_prefs(state: State<'_, Arc<AppState>>) -> Result<QuickPrefs, String> {
    let store = state.quick_prefs.lock().await;
    Ok(store.prefs().clone())
}

#[tauri::command]
async fn save_quick_prefs(
    state: State<'_, Arc<AppState>>,
    devices: Vec<String>,
    scenes: Vec<String>,
) -> Result<QuickPrefs, String> {
    let mut store = state.quick_prefs.lock().await;
    store
        .save(QuickPrefs { devices, scenes })
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
    let _account_lifecycle = state.account_lifecycle.read().await;
    let now = Local::now();
    let (since, due, account_epoch) = {
        let account_epoch = state.account_epoch.load(Ordering::SeqCst);
        let mut tick = state.automation_tick.lock().await;
        let since = *tick;
        *tick = now;
        let due = state
            .automations
            .lock()
            .await
            .due_between_entries(since, now);
        (since, due, account_epoch)
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
        if state.account_epoch.load(Ordering::SeqCst) != account_epoch {
            app_log::warn("Automation", "账号已切换，本轮剩余定时任务已取消");
            break;
        }
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
    // The camera page re-reads this list on every visit; with 100+ cameras a
    // per-camera info line would fill the 2 MB log rotation quickly.
    app_log::info(
        "Camera",
        format!(
            "已读取 {} 台摄像头：在线 {}，带局域网地址 {}",
            cameras.len(),
            cameras.iter().filter(|camera| camera.online).count(),
            cameras
                .iter()
                .filter(|camera| camera.online && camera.ip.is_some())
                .count()
        ),
    );
    app_log::debug(
        "Camera",
        format!(
            "摄像头明细：{}",
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
    let _account_lifecycle = state.account_lifecycle.read().await;
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
                webrtc_url: Some(runtime.direct_webrtc_url_for_did(&camera.did)),
                fallback_webrtc_url: runtime.fallback_webrtc_url_for_did(&camera.did),
                audio_webrtc_url: runtime.audio_webrtc_url_for_did(&camera.did),
                mse_webrtc_url: Some(runtime.mse_webrtc_url_for_did(&camera.did)),
                host: camera.ip.clone().unwrap_or_default(),
                // The fixed-rate H.264 stream avoids WebKit's periodic HEVC
                // decoder stalls. Native video is used only when no transcoder
                // is available or MIHOME_LOCAL_PREFER_NATIVE=1 is set; native
                // audio remains on its independent stream in both modes.
                prefer_mse: camera::local_prefers_mse(),
                video_only: true,
                video_codec: runtime.video_codec_for_did(&camera.did),
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
    let _account_lifecycle = state.account_lifecycle.read().await;
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
    let quality = quality.unwrap_or(2);
    let audio = audio.unwrap_or(false);
    let (existing, incompatible) = {
        let mut map = state.remote_cameras.lock().await;
        let compatible = map.get(did).is_some_and(|stream| {
            stream.quality() == quality
                && stream.has_audio() == audio
                && stream.health_reason().is_none()
        });
        if compatible {
            let existing = map
                .get(did)
                .map(|stream| (stream.url(), stream.webrtc_url(), stream.audio_webrtc_url()));
            (existing, None)
        } else {
            if let Some(reason) = map.get(did).and_then(|stream| stream.health_reason()) {
                app_log::warn(
                    "Camera",
                    format!(
                        "远程缓存流已失效，重建：did={} reason={reason}",
                        app_log::mask_id(did)
                    ),
                );
            }
            (None, map.remove(did))
        }
    };
    if let Some(stream) = incompatible {
        app_log::info(
            "Camera",
            format!(
                "远程画面参数已变化，重建缓存：did={} quality={quality} audio={audio}",
                app_log::mask_id(did)
            ),
        );
        drop_off_runtime(stream).await;
    }
    if let Some((url, webrtc_url, audio_webrtc_url)) = existing {
        return Ok(CameraStream {
            id: did.to_string(),
            url,
            webrtc_url: Some(webrtc_url.clone()),
            fallback_webrtc_url: None,
            audio_webrtc_url,
            mse_webrtc_url: Some(webrtc_url),
            host: "CS2 relay".to_string(),
            prefer_mse: false,
            video_only: true,
            video_codec: "h264".to_string(),
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
    let epoch_state = Arc::clone(state);
    let stream = tauri::async_runtime::spawn_blocking(move || {
        // A stop, a local start or another grid page bumps the epoch; give
        // up the relay handshake right away instead of finishing it.
        RemoteStream::start_cancellable(session, &did_for_worker, quality, audio, || {
            epoch_state.remote_camera_epoch.load(Ordering::SeqCst) != remote_generation
        })
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
    let audio_webrtc_url = pending.as_ref().and_then(RemoteStream::audio_webrtc_url);
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
        webrtc_url: Some(webrtc_url.clone()),
        fallback_webrtc_url: None,
        audio_webrtc_url,
        mse_webrtc_url: Some(webrtc_url),
        host: "CS2 relay".to_string(),
        prefer_mse: false,
        video_only: true,
        video_codec: "h264".to_string(),
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
async fn device_statistics(
    state: State<'_, Arc<AppState>>,
    query: mihome_core::StatQuery,
) -> Result<Vec<mihome_core::StatPoint>, String> {
    let cloud = state
        .cloud
        .lock()
        .await
        .clone()
        .ok_or_else(|| "未登录".to_string())?;
    cloud.statistics(&query).await.map_err(error_text)
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
async fn assistant_command(
    state: State<'_, Arc<AppState>>,
    request: AssistantRequest,
) -> Result<AssistantResponse, String> {
    Ok(assistant_engine::handle_request(&state, request).await)
}

#[tauri::command]
async fn assistant_catalog(
    state: State<'_, Arc<AppState>>,
    home_id: Option<String>,
) -> Result<Value, String> {
    assistant_engine::catalog_snapshot(&state, home_id.as_deref())
        .await
        .map_err(error_text)
}

async fn integration_snapshot_value(state: &Arc<AppState>) -> Value {
    let settings = state.integrations.lock().await.snapshot();
    let gateway = gateway::status(state).await;
    let feishu_ws = feishu_ws::status(state).await;
    let wecom_ws = wecom_ws::status(state).await;
    let dingtalk_ws = dingtalk_ws::status(state).await;
    serde_json::json!({
        "settings": settings,
        "gateway": gateway,
        "connections": {
            "feishu_ws": feishu_ws,
            "wecom_ws": wecom_ws,
            "dingtalk_ws": dingtalk_ws,
        },
        "webhook": {
            "feishu_path": "/v1/platform/feishu",
            "wecom_path": "/v1/platform/wecom",
            "dingtalk_mode": "stream",
            "requires_public_tunnel": true,
        },
    })
}

#[tauri::command]
async fn integration_snapshot(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    Ok(integration_snapshot_value(&state).await)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn integration_save_platform(
    state: State<'_, Arc<AppState>>,
    platform: PlatformKind,
    enabled: bool,
    mode: Option<ConnectionMode>,
    app_id: String,
    app_secret: Option<String>,
    verification_token: Option<String>,
    encrypt_key: Option<String>,
) -> Result<Value, String> {
    let effective_mode = {
        let store = state.integrations.lock().await;
        let current = store.settings().platform(platform);
        let effective_mode = mode.unwrap_or_else(|| current.effective_mode(platform));
        if platform == PlatformKind::Wecom && effective_mode == ConnectionMode::Webhook {
            return Err("企业微信当前版本只支持长连接模式，请选择 WebSocket".to_string());
        }
        if platform == PlatformKind::Dingtalk && effective_mode == ConnectionMode::Webhook {
            return Err("钉钉当前版本只支持 Stream 长连接模式，请选择 WebSocket".to_string());
        }
        if enabled {
            let has_app_id = !app_id.trim().is_empty() || !current.app_id.trim().is_empty();
            let has_secret = app_secret
                .as_deref()
                .is_some_and(|secret| !secret.trim().is_empty())
                || !current.app_secret.trim().is_empty();
            let has_webhook_secret = verification_token
                .as_deref()
                .is_some_and(|token| !token.trim().is_empty())
                || !current.verification_token.trim().is_empty();
            if !has_app_id {
                return Err(format!(
                    "启用{}前请填写{}",
                    platform_display_name(platform),
                    platform_id_label(platform)
                ));
            }
            if !has_secret {
                return Err(format!(
                    "启用{}前请填写{}",
                    platform_display_name(platform),
                    platform_secret_label(platform)
                ));
            }
            if effective_mode == ConnectionMode::Webhook && !has_webhook_secret {
                return Err("启用 Webhook 前请填写 Verification Token".to_string());
            }
        }
        effective_mode
    };
    state
        .integrations
        .lock()
        .await
        .save_platform(
            platform,
            enabled,
            mode,
            app_id,
            app_secret,
            verification_token,
            encrypt_key,
        )
        .map_err(error_text)?;
    match platform {
        PlatformKind::Feishu => {
            if enabled && effective_mode == ConnectionMode::Websocket {
                feishu_ws::start(&state).await.map_err(error_text)?;
            } else {
                feishu_ws::stop(&state).await;
            }
        }
        PlatformKind::Wecom => {
            if enabled && effective_mode == ConnectionMode::Websocket {
                wecom_ws::start(&state).await.map_err(error_text)?;
            } else {
                wecom_ws::stop(&state).await;
            }
        }
        PlatformKind::Dingtalk => {
            if enabled && effective_mode == ConnectionMode::Websocket {
                dingtalk_ws::start(&state).await.map_err(error_text)?;
            } else {
                dingtalk_ws::stop(&state).await;
            }
        }
    }
    Ok(integration_snapshot_value(&state).await)
}

#[tauri::command]
async fn integration_reconnect_platform(
    state: State<'_, Arc<AppState>>,
    platform: PlatformKind,
) -> Result<Value, String> {
    let config = state
        .integrations
        .lock()
        .await
        .settings()
        .platform(platform)
        .clone();
    if !config.enabled {
        return Err(format!("{}尚未启用", platform_display_name(platform)));
    }
    if config.effective_mode(platform) != ConnectionMode::Websocket {
        return Err(format!(
            "{}当前不是长连接模式，无法手动重连",
            platform_display_name(platform)
        ));
    }
    app_log::info(
        "Integration",
        format!("用户手动重连{}长连接", platform_display_name(platform)),
    );
    match platform {
        PlatformKind::Feishu => {
            feishu_ws::start(&state).await.map_err(error_text)?;
        }
        PlatformKind::Wecom => {
            wecom_ws::start(&state).await.map_err(error_text)?;
        }
        PlatformKind::Dingtalk => {
            dingtalk_ws::start(&state).await.map_err(error_text)?;
        }
    }
    Ok(integration_snapshot_value(&state).await)
}

#[tauri::command]
async fn integration_save_llm(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<Value, String> {
    if enabled && (base_url.trim().is_empty() || model.trim().is_empty()) {
        return Err("启用大模型前请填写接口地址和模型名称".to_string());
    }
    state
        .integrations
        .lock()
        .await
        .save_llm(enabled, base_url, model, api_key)
        .map_err(error_text)?;
    Ok(integration_snapshot_value(&state).await)
}

#[tauri::command]
async fn integration_generate_pair_code(
    state: State<'_, Arc<AppState>>,
    platform: PlatformKind,
    home_id: Option<String>,
) -> Result<Value, String> {
    let pairing = state
        .integrations
        .lock()
        .await
        .generate_pair_code(platform, home_id)
        .map_err(error_text)?;
    serde_json::to_value(pairing).map_err(error_text)
}

#[tauri::command]
async fn integration_revoke_binding(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Value, String> {
    state
        .integrations
        .lock()
        .await
        .revoke_binding(&id)
        .map_err(error_text)?;
    Ok(integration_snapshot_value(&state).await)
}

#[tauri::command]
async fn integration_reveal_gateway_token(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    Ok(state.integrations.lock().await.gateway_token().to_string())
}

#[tauri::command]
async fn integration_set_gateway(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
    port: u16,
) -> Result<Value, String> {
    state
        .integrations
        .lock()
        .await
        .set_gateway(enabled, port)
        .map_err(error_text)?;
    if enabled {
        gateway::start(&state).await.map_err(error_text)?;
    } else {
        gateway::stop(&state).await;
    }
    Ok(integration_snapshot_value(&state).await)
}

#[tauri::command]
async fn integration_test_feishu(
    state: State<'_, Arc<AppState>>,
    app_id: Option<String>,
    app_secret: Option<String>,
) -> Result<String, String> {
    let config = state.integrations.lock().await.settings().feishu.clone();
    let app_id = app_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.app_id.clone());
    let app_secret = app_secret
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.app_secret.clone());
    gateway::test_feishu_connection(&app_id, &app_secret)
        .await
        .map_err(error_text)?;
    Ok("飞书应用凭据有效，已成功获取 tenant_access_token。".to_string())
}

#[tauri::command]
async fn integration_test_wecom(
    state: State<'_, Arc<AppState>>,
    app_id: Option<String>,
    app_secret: Option<String>,
) -> Result<String, String> {
    let config = state.integrations.lock().await.settings().wecom.clone();
    let app_id = app_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.app_id.clone());
    let app_secret = app_secret
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.app_secret.clone());
    let current = wecom_ws::status(&state).await;
    let testing_saved_credentials =
        app_id.trim() == config.app_id.trim() && app_secret.trim() == config.app_secret.trim();
    if current.running && !testing_saved_credentials {
        return Err("企业微信长连接正在运行。请先关闭启用开关并保存，再测试新凭据".to_string());
    }
    if current.running && testing_saved_credentials {
        return Ok(if current.state == "connected" {
            "企业微信机器人长连接已在线，认证状态正常。".to_string()
        } else {
            format!("企业微信长连接当前状态：{}，请稍候", current.state)
        });
    }
    wecom_ws::test_connection(&app_id, &app_secret)
        .await
        .map_err(error_text)?;
    Ok("企业微信机器人认证成功，长连接可用。".to_string())
}

#[tauri::command]
async fn integration_test_dingtalk(
    state: State<'_, Arc<AppState>>,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<String, String> {
    let config = state.integrations.lock().await.settings().dingtalk.clone();
    let client_id = client_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.app_id.clone());
    let client_secret = client_secret
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.app_secret.clone());
    let current = dingtalk_ws::status(&state).await;
    let testing_saved_credentials = client_id.trim() == config.app_id.trim()
        && client_secret.trim() == config.app_secret.trim();
    if current.running && !testing_saved_credentials {
        return Err("钉钉长连接正在运行。请先关闭启用开关并保存，再测试新凭据".to_string());
    }
    if current.running && testing_saved_credentials {
        return Ok(if current.state == "connected" {
            "钉钉 Stream 长连接已在线，认证状态正常。".to_string()
        } else {
            format!("钉钉 Stream 当前状态：{}，请稍候", current.state)
        });
    }
    dingtalk_ws::test_connection(&client_id, &client_secret)
        .await
        .map_err(error_text)?;
    Ok("钉钉 Client ID / Client Secret 有效，Stream 连接可用。".to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn integration_save_asr(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
    provider: AsrProvider,
    base_url: String,
    model: String,
    api_key: Option<String>,
    language: String,
    command: String,
    model_path: String,
) -> Result<Value, String> {
    state
        .integrations
        .lock()
        .await
        .save_asr(
            enabled, provider, base_url, model, api_key, language, command, model_path,
        )
        .map_err(error_text)?;
    Ok(integration_snapshot_value(&state).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn integration_test_asr(
    state: State<'_, Arc<AppState>>,
    provider: Option<AsrProvider>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    language: Option<String>,
    command: Option<String>,
    model_path: Option<String>,
) -> Result<String, String> {
    let mut config = state.integrations.lock().await.settings().asr.clone();
    if let Some(provider) = provider {
        config.provider = provider;
    }
    if let Some(base_url) = base_url.filter(|value| !value.trim().is_empty()) {
        config.base_url = base_url;
    }
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        config.model = model;
    }
    if let Some(api_key) = api_key.filter(|value| !value.trim().is_empty()) {
        config.api_key = api_key;
    }
    if let Some(language) = language.filter(|value| !value.trim().is_empty()) {
        config.language = language;
    }
    if let Some(command) = command.filter(|value| !value.trim().is_empty()) {
        config.command = command;
    }
    if let Some(model_path) = model_path.filter(|value| !value.trim().is_empty()) {
        config.model_path = model_path;
    }
    asr::test_connection(&config).await.map_err(error_text)
}

#[tauri::command]
async fn integration_test_llm(
    state: State<'_, Arc<AppState>>,
    base_url: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<String, String> {
    let config = state.integrations.lock().await.settings().llm.clone();
    let base_url = base_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(config.base_url);
    let model = model
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(config.model);
    let api_key = api_key
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(config.api_key);
    let parser =
        mihome_core::OpenAiIntentParser::new(&base_url, &model, &api_key).map_err(error_text)?;
    parser.test_connection().await.map_err(error_text)?;
    Ok(format!("模型连接成功：{model}"))
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    if text.is_empty() {
        return Err("没有可复制的内容".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(error_text)?;
        child
            .stdin
            .as_mut()
            .ok_or_else(|| "无法写入剪贴板".to_string())?
            .write_all(text.as_bytes())
            .map_err(error_text)?;
        let status = child.wait().map_err(error_text)?;
        if !status.success() {
            return Err("写入剪贴板失败".to_string());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("当前平台不支持内置剪贴板命令".to_string())
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let allowed = [
        "https://open.feishu.cn/",
        "https://www.feishu.cn/",
        "https://developer.work.weixin.qq.com/",
        "https://work.weixin.qq.com/",
    ];
    if !allowed.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("仅允许打开官方接入文档链接".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&url).spawn().map_err(error_text)?;
    }
    Ok(())
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
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
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
                    // macOS 上按下和松开各触发一次 Click 事件。只在按下时切换，
                    // 否则松开会把刚打开的面板立刻关掉，看起来像闪一下就没了。
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Down,
                        rect,
                        ..
                    } = event
                    {
                        toggle_quick_panel(tray.app_handle(), rect);
                    }
                })
                .build(app)?;
            if let Some(icon) = app.default_window_icon() {
                tray.set_icon(Some(icon.clone()))?;
            }
            match create_quick_panel(app.handle()) {
                Ok(quick) => configure_quick_panel_space(&quick),
                Err(error) => app_log::warn("App", format!("创建菜单栏速控面板失败：{error}")),
            }
            #[cfg(target_os = "macos")]
            install_quick_outside_poll(app.handle());
            let state = app.state::<Arc<AppState>>().inner().clone();
            let gateway_state = state.clone();
            tauri::async_runtime::spawn(async move {
                gateway::autostart(&gateway_state).await;
            });
            let feishu_state = state.clone();
            tauri::async_runtime::spawn(async move {
                feishu_ws::autostart(&feishu_state).await;
            });
            let wecom_state = state.clone();
            tauri::async_runtime::spawn(async move {
                wecom_ws::autostart(&wecom_state).await;
            });
            let dingtalk_state = state.clone();
            tauri::async_runtime::spawn(async move {
                dingtalk_ws::autostart(&dingtalk_state).await;
            });
            let automation_state = state.clone();
            let wake_state = state.clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(30));
                let mut network_recovery = platform_supervisor::NetworkRecovery::default();
                let mut last_wall_second = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                loop {
                    ticker.tick().await;
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let resumed_after_sleep = now.saturating_sub(last_wall_second) >= 90;
                    last_wall_second = now;
                    if resumed_after_sleep {
                        app_log::info("App", "检测到电脑从睡眠恢复，重建全部平台长连接");
                        platform_supervisor::restart_after_resume(&wake_state).await;
                        network_recovery = platform_supervisor::NetworkRecovery::default();
                    }
                    platform_supervisor::probe_and_recover_network(
                        &wake_state,
                        &mut network_recovery,
                    )
                    .await;
                    run_due_automations(&automation_state).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
                if window.label() == "main" {
                    app_log::info("App", "主窗口已隐藏，定时任务继续运行");
                }
            }
            tauri::WindowEvent::Focused(false) if window.label() == "quick" => {
                let app = window.app_handle().clone();
                let state = app.state::<Arc<AppState>>().inner().clone();
                // 面板刚弹出时松开菜单栏图标鼠标键，系统会把焦点交还给之前的
                // 应用，触发一次失焦。这不是用户点走了，开头 450ms 内忽略。
                let just_shown = state
                    .quick_shown_at
                    .blocking_lock()
                    .map(|shown| shown.elapsed() < Duration::from_millis(450))
                    .unwrap_or(false);
                if just_shown {
                    return;
                }
                let token = state.quick_hide_token.fetch_add(1, Ordering::SeqCst) + 1;
                tauri::async_runtime::spawn(async move {
                    // 等一小段时间再隐藏。点击菜单栏图标同样会先触发失焦，
                    // 让点击处理有机会作废这次隐藏并切换面板。
                    tokio::time::sleep(Duration::from_millis(160)).await;
                    if state.quick_hide_token.load(Ordering::SeqCst) == token {
                        if let Some(quick) = app.get_webview_window("quick") {
                            set_quick_visible(&quick, false);
                        }
                    }
                });
            }
            tauri::WindowEvent::Focused(true) if window.label() == "main" => {
                let state = window.app_handle().state::<Arc<AppState>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    platform_supervisor::reconnect_disconnected(&state).await;
                });
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            app_meta,
            auth_start,
            auth_poll,
            auth_logout,
            auth_resume,
            auth_accounts,
            auth_switch_account,
            auth_set_account_label,
            auth_cancel,
            list_homes,
            list_devices,
            get_device_specs,
            list_scenes,
            run_scene,
            quick_open_main,
            quick_prefs,
            save_quick_prefs,
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
            device_statistics,
            camera_stop,
            camera_status,
            get_property,
            get_properties,
            set_property,
            assistant_command,
            assistant_catalog,
            integration_snapshot,
            integration_save_platform,
            integration_reconnect_platform,
            integration_save_llm,
            integration_generate_pair_code,
            integration_revoke_binding,
            integration_reveal_gateway_token,
            integration_set_gateway,
            integration_test_feishu,
            integration_test_wecom,
            integration_test_dingtalk,
            integration_save_asr,
            integration_test_asr,
            integration_test_llm,
            copy_text,
            open_external_url,
            log_frontend,
            log_export
        ])
        .run(tauri::generate_context!())
        .expect("failed to run MiHome Mac");
}

#[cfg(test)]
mod quick_panel_tests {
    use super::panel_x;

    const LEFT: f64 = 0.0;
    const RIGHT: f64 = 1920.0;
    const WIDTH: f64 = 320.0;

    #[test]
    fn centers_under_the_icon_when_there_is_room() {
        assert_eq!(panel_x(800.0, WIDTH, Some((LEFT, RIGHT))), 640.0);
    }

    #[test]
    fn keeps_the_panel_on_screen_for_right_edge_icons() {
        // 图标在 1900，居中会得到 1740，右边缘 2060 超出 1920 的屏幕。
        assert_eq!(panel_x(1900.0, WIDTH, Some((LEFT, RIGHT))), 1592.0);
    }

    #[test]
    fn keeps_the_panel_on_screen_for_left_edge_icons() {
        assert_eq!(panel_x(10.0, WIDTH, Some((LEFT, RIGHT))), 8.0);
    }

    #[test]
    fn uses_the_second_screen_bounds() {
        // 副屏在右侧：逻辑范围 1920..3840，图标在副屏最右端。
        assert_eq!(panel_x(3800.0, WIDTH, Some((1920.0, 3840.0))), 3512.0);
    }

    #[test]
    fn falls_back_to_centering_without_screen_bounds() {
        assert_eq!(panel_x(1200.0, WIDTH, None), 1040.0);
    }

    #[test]
    fn keeps_the_left_edge_when_the_screen_is_narrower_than_the_panel() {
        // 屏幕比面板窄时不能算出负位置：贴着左侧边距显示，右侧溢出交给系统处理。
        assert_eq!(panel_x(100.0, WIDTH, Some((0.0, 200.0))), 8.0);
    }
}
