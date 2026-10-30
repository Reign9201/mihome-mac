# 用 Rust 做底座：Tauri v2 方案

日期：2026-10-30 · 状态：M1 协议层、M2 摄像头取流层、M3 手动场景/定时自动化已接，DMG 已出包但未公证

## 结论

Rust 可以作为 MiHome Mac 的底座，但要先区分两件事：业务核心用 Rust，窗口和 UI 不一定用 Rust。

Montage 的 Mac 端有两套实现：

- `mac/`：Electron 39，universal DMG 约 194 MB。
- `tauri/`：Tauri v2 壳 + Rust 后端 + React/Vite 前端，DMG 4.6 MB，`.app` 9.5 MB。

`tauri/` 不是纯 Rust UI。Rust 负责本地 axum 服务、协议、加密和文件访问；窗口、HTML 页面、CSS 仍由 WKWebView 渲染。它的价值是去掉 Node 运行时和 Chromium，体积从 194 MB 降到 4.6 MB。

## 三个选项

| 方案 | 组成 | 优点 | 代价 |
| --- | --- | --- | --- |
| Tauri + Rust | Tauri 2 壳 + Rust 服务 + TypeScript/Vite 前端 | 复用现有原型；体积 5–15 MB；以后可跨平台 | WKWebView 内存和长列表性能不如原生；需要前端构建链 |
| SwiftUI + Rust core | SwiftUI 壳 + UniFFI 调 Rust 静态库 | macOS 原生控件、内存最低、菜单和窗口行为最稳 | 两套语言；原型要重写；开发周期更长 |
| 纯 SwiftUI | 全部 Swift | 活动部件最少，启动和内存最好 | 放弃 Rust 复用，也不能跨平台 |

推荐 v1 用第一行：Tauri 2 + Rust core + 现有前端。原因是原型已经能跑，协议和摄像头都需要大量 Rust 侧 I/O；先用 Tauri 缩短到可运行版本的时间。

如果性能验收发现 WKWebView 无法满足内存预算，保留 Rust core，把壳换成 SwiftUI。core 不依赖 Tauri，换壳不重写协议层。

## 内存要先量，不能假设

本机启动 `/Applications/诺影集.app`（Montage 的 Tauri 版）后，主进程 RSS 约 78 MB；WebKit 的 WebContent 约 65 MB，GPU 约 43 MB，Networking 约 25 MB。按 RSS 相加约 210 MB。RSS 会把共享内存重复计算，这个数字只能当上限参考，但足以说明：Tauri 体积小，不等于内存一定低于 200 MB。

MiHome 的负载还多两项：120 台设备的状态列表，以及 1–4 路摄像头的视频解码。视频必须走 WebKit 硬件解码；长列表必须做虚拟滚动，不能一次创建 120 个复杂 DOM。

## 架构

```text
MiHomeMac/
  core/                 Rust：登录、签名、云端、局域网、设备模型、存储
  desktop/              Tauri 2 壳：窗口、菜单、单实例、更新
  desktop/ui/           M1 实机界面；后续迁移完整页面
  helpers/go2rtc/       MIT 许可的摄像头取流 helper，按需启动
```

Rust core 的边界：

- `auth`：二维码登录、passToken/serviceToken、Keychain 写入。
- `cloud`：HTTP/2、签名、20 个属性一批读写、请求优先级。
- `lan`：UDP 54321、AES 加解密、token 和 localip 缓存、云端回退。
- `device`：MIoT 规格解析、能力模型、乐观状态和版本号。
- `store`：SQLite WAL、设备快照、场景、自动化、指标。
- `camera`：go2rtc 子进程、HLS 地址、进程健康检查。

Tauri 壳只做窗口、菜单、单实例、自动更新和 IPC。业务逻辑不写在 `#[tauri::command]` 里，命令层只做参数校验和调用 core。

## 性能门禁

M0 和 M1 之间先做一组可重复的测量，不达标就换壳或改实现：

| 指标 | 目标 |
| --- | --- |
| 冷启动到首屏可交互 | < 700 ms |
| 空闲 RSS（无摄像头） | < 200 MB |
| 120 台设备列表滚动 | 60 fps，主线程单次阻塞 < 16 ms |
| 本地开关 p95 | < 80 ms |
| 云端开关 p95 | < 300 ms |
| 单路 1080p 硬解额外内存 | < 100 MB |
| 摄像头首帧（局域网 HLS） | 1–3 s |
| 摄像头首帧（WebRTC） | 300–800 ms |

### 已测结果

2026-10-30 用 DMG 里的 release 包启动到二维码页，分别记录 `ps` RSS 与 `footprint` 物理内存：

- `ps` RSS：主进程 70–110 MB，WebKit GPU 30–43 MB、Networking 12–18 MB、WebContent 38–50 MB，合计约 150–220 MB。RSS 会把共享库和共享内存重复计算，不能用总和判断真实占用。
- `footprint` phys_footprint：主进程 30 MB，WebKit GPU 21 MB、Networking 7 MB、WebContent 26 MB，合计约 84 MB。
- dev 包比 release 高，曾测到主进程 135 MB、RSS 合计 244 MB；开发时不要把 dev 数字当产品指标。

按真实物理内存看，Tauri 壳低于 200 MB 门禁；按 RSS 看会超过。后续验收统一用 `footprint` 的 phys_footprint，RSS 只作上限参考。

冷启动用 release 二进制连续启动 3 次，从进程创建到界面调用 `ui_ready` 命令：378 ms、362 ms、354 ms（首次带缓存预热为 522 ms），低于 700 ms 门禁。真实设备延迟和摄像头首帧仍需账号与设备才能测。

2026-10-30 加入 Rust 远程摄像头和两路宫格后复测：release 冷启动 344 ms、337 ms、331 ms；登录后对卧室台灯连续发 12 次开关，云端 `set_prop` 的 p95 为 143 ms，`get_prop` 的 p95 为 52 ms，低于 300 ms 门禁。两路远程 HLS 同时播放时，按 `footprint` 物理内存统计：App 33 MB、WebKit GPU 22 MB、WebContent 38 MB、两个 ffmpeg 共 11 MB，合计约 104 MB；App 进程 CPU 1%、WebKit GPU 2.3%、ffmpeg 0.2% 和 0.0%。云端开关门禁已过。120 台设备滚动另做合成布局基准：`benchmarks/device-grid-120.html` 在 Playwright 的 Chromium build 1228、1280×900 视口、连续 240 帧滚动下，p50 16.7 ms、p95 18.6 ms、最大 18.7 ms，没有超过 33.3 ms 的帧，没有掉到 30 fps 以下。这个数字只验证 120 张卡片的布局和绘制成本，不是 Tauri WKWebView 真机数字。本地开关 p95、局域网摄像头首帧仍受当前网络条件限制，未验证。

## 开发顺序

M0：Tauri 壳加载现有原型，`app_meta` 命令返回版本；只验证窗口、打包和启动。

M1：Rust 完成二维码登录、设备列表、单台灯的开关和亮度；`desktop/ui` 作为独立的实机界面接入 core 命令，原型继续作为完整设计稿。此阶段不接摄像头。

M2：接 go2rtc，单画面 HLS，再补宫格和事件时间线；摄像头失败不影响设备控制。

M3：场景、自动化、设置、菜单栏面板、打包、公证、自动更新。

## M1 当前实现

`core/` 已有 `auth`、`sign`、`cloud` 三个模块：

- `auth`：申请二维码、长轮询扫码、解析 `userId`/`ssecurity`/`serviceToken`、构造 cookie。
- `sign`：nonce、`signed_nonce`、RC4 加密参数、SHA-1 签名、响应解密与 gzip 回退。
- `cloud`：家庭列表、设备列表分页、`miotspec/prop/get`、`miotspec/prop/set`。

Tauri 命令：`auth_start`、`auth_poll`、`auth_logout`、`list_homes`、`list_devices`、`get_property`、`set_property`。

本机已验证：

- `cargo test` 9 项通过，签名结果与 Python 参考实现逐字节一致。
- `cargo check` 通过，Tauri 窗口启动。
- `auth_start` 真实请求小米账号服务，返回约 23 KB 的 SVG 二维码，`expires_in=300`；桌面界面能渲染该二维码。

2026-10-30 实测：App 扫码登录成功，拉取 1 个家庭、13 台设备，全部显示在线，房间归属正确。点击“壁挂灯”后，右侧开关切到“关”再切到“开”，真实设备有响应，用户确认开关正常。

这次实测修了两个解析问题：

- `home_device_list` 的在线字段是 `isOnline`，不是 `is_online`；原实现把所有设备误判为离线。
- 设备本身不带房间字段，改为用 `homelist[].roomlist[].dids` 反查 `did` 对应的房间。

M1 的扫码、家庭列表、设备列表和单设备控制已经用真实账号和真实设备验证。Keychain 持久化、局域网直连和摄像头不在 M1。

## M2 当前实现

`core/src/camera.rs` 已接 go2rtc 子进程：

- `CameraDevice`：从设备列表识别摄像头，读取 `localip`、型号和 channel；没有 `localip` 的摄像头在 UI 里显示不可用。
- `Go2Rtc::start_for_cameras`：为一批摄像头生成只绑定 `127.0.0.1` 的 go2rtc 配置，使用账号的 `userId`/`passToken` 走 `xiaomi://`，同时分配独立的 API、RTSP、WebRTC 端口，避免与本机已有 go2rtc 冲突。
- `Go2Rtc::start_with_source`：用于 HLS 验收的本地测试源，不依赖小米摄像头。
- `stream_url`：返回 HLS 地址 `http://127.0.0.1:<port>/api/stream.m3u8?src=<did>&mp4`。
- 配置写临时文件，权限 0600；`Drop` 时杀子进程并删除配置。

Tauri 命令增加 `list_cameras`、`camera_start(dids)`、`camera_stop`、`camera_status`。桌面 UI 增加“摄像头”页，支持单画面、宫格、刷新和错误提示。

本机已验证：用 ffmpeg `testsrc` 作为 go2rtc 输入，`camera_probe` 拉起子进程后请求 HLS 主播放列表，返回 `200` 和 93 字节的 `#EXTM3U`。这验证了进程管理、端口分配和 HLS 输出。真实摄像头的远程查看已由 Rust 通道完成，详见 `docs/06-camera-product-channel.md`。

2026-10-30 实测：登录后摄像头页能读取 2 台小米摄像头，`/home/device_list` 兜底取到 `localip=192.168.31.186`，go2rtc 子进程启动并生成 `http://127.0.0.1:<port>/api/stream.m3u8?src=1053392676&mp4`。但 Mac 当前在 `10.2.16.106`，与摄像头不在同一网段，`ping 192.168.31.186` 全部超时，HLS 返回空播放列表，页面显示“没有首帧”。这一步验证了 UI、IP 获取、go2rtc 启动和 HLS 请求；真实画面需要 Mac 接到 `192.168.31.0/24` 或家庭 VPN。

## M2 远程 PoC（2026-10-30）

`eugeneRover/micam` 是 Java 21 的 CS2 relay 客户端，支持远程取流，不要求 Mac 与摄像头同网。本次用真实账号和两台摄像头验证：

1. `core/examples/micam_login.rs` 用 `sid=xiaomiio` 发起二维码登录，拿到 `passToken`、`userId`、`deviceId`、`ssecurity`、`serviceToken`，写入 `~/.micam/credentials.json`（`0600`）。
2. `/tmp/emicam/target/micam.jar` 先列出两台在线摄像头：`chuangmi.camera.039a01` 和 `chuangmi.camera.069a01`。
3. `--did 1178828157 --quality 2` 在 Mac 与摄像头不同网段的情况下建立 CS2 relay，输出 `MPEG-TS`；`ffprobe` 读到 `HEVC 2960×1666 20fps`，10 秒抓包 1.2 MB。
4. `--did 1053392676 --quality 1` 同样建立 relay，读到 `HEVC 864×480 20fps`。

结论：

- 手机米家 App 能远程看，是因为它内置了小米私有 relay 客户端；Mac 端也能通过 CS2 relay 做到，不需要和摄像头同网。
- micam 没有 LICENSE，只有 CS2，单路、无音频/PTZ，依赖 JDK 21；它是验证工具，不能直接打包进 MiHome Mac。
- 产品化路线已选定第二条：把 CS2/MISS 取流按 micam 的协议重写成 Rust；当前已在 App 内出真画面，详见 `docs/06-camera-product-channel.md`。
- App 已接 Rust 远程通道：摄像头行提供“远程”按钮，后端用 Rust 建 CS2 relay、完成 MISS 认证，再把 HEVC 交给 ffmpeg 生成 fMP4 HLS。实测 `chuangmi.camera.039a01` 在 App 内出画，画面带时间水印；首帧约 10–20 秒。
- 摄像头页新增控制面板：云台方向键（按住连发、松开停止）和 14 项属性控制；属性控制走云端 `/miotspec/prop/set`，云台走 Rust 的 0x112 加密命令，尚未用肉眼确认镜头转动。
- `~/.micam/credentials.json` 是早期实验文件，产品通道不读取它；Rust 侧已实现 CS2 + MISS，构建产物不依赖 Java。

## M3 当前实现

手动场景和本机定时自动化已接：

- `MiCloud::scenes(home_id)` 调用 `AppSceneService/GetSimpleSceneList`，返回 `Scene { id, name, home_id, raw }`。
- `MiCloud::run_scene(scene_id, home_id)` 调用 `AppSceneService/NewRunScene`。
- Tauri 命令 `list_scenes`、`run_scene` 已注册，桌面 UI 的“场景”页可以读取并执行米家手动场景。
- 本机定时自动化：`core/src/automation.rs` 保存任务，Tauri 每 30 秒检查一次，到点调用 `run_scene`；任务存在 `~/Library/Application Support/MiHome/automations.json`，只在本机执行，窗口关闭后应用退出就不触发。
- 菜单栏仍未做；按用户要求等全部验证后再研究 MenuBarMijia。

### 打包结果

2026-10-30 用 `npx tauri build` 生成 arm64 DMG：

- `dist/MiHome-Mac-0.1.0-aarch64.dmg`，约 11.7 MiB（内含 go2rtc 助手）。
- `.app` 约 34 MB，ad-hoc 签名，未做 Developer ID 签名与公证；Gatekeeper 在其他 Mac 上会拦截。
- release 启动到二维码页的 `footprint` 物理内存约 84 MB；`ps` RSS 合计约 150–220 MB，RSS 仅作上限参考。

## 风险

- WebKit 的内存和 120 行设备列表是 v1 最大的不确定性，必须先用真实数据做 spike。
- 小米摄像头用 go2rtc 时只在同一局域网内取流；远程路径已由 Rust CS2 relay 实现，但仍是单路、无音频，产品文案不能承诺“任何地方都能看”。
- go2rtc 是独立进程，需要崩溃隔离和端口鉴权；打包时带 MIT 许可证和版本号。
- 小米账号扫码登录、设备 token 和摄像头 passToken 都要走 Keychain，不能写日志或明文配置。
- 设备型号差异大，第一版只承诺已验证的型号；未验证型号使用通用属性面板，不显示摄像头画面。

## 术语说明

**Tauri**：用系统 WebView 承载前端页面的桌面应用框架，Rust 负责窗口和本地能力。
**WKWebView**：macOS 自带的网页渲染组件，Tauri 在 macOS 上使用它。
**Rust core**：不依赖界面的 Rust 业务库，负责协议、数据和设备控制。
**axum**：Rust 的 HTTP 服务库，Montage 用它提供本机接口。
**UniFFI**：把 Rust 库暴露给 Swift/Kotlin 等语言的绑定生成工具。
**go2rtc**：把摄像头 P2P 流转成 HLS/WebRTC 的本地取流程序。
**HLS**：基于 HTTP 的分片视频协议，首帧较慢但兼容性好。
**WebRTC**：浏览器实时音视频协议，延迟低，网络要求高。
**RSS**：进程占用的常驻内存，多个进程相加会重复计算共享内存。
