> 2026-10-30 追加：应实现要求，底座改为 Rust core + Tauri 2 壳；本文的 SwiftUI 结论保留作对照，当前方案见 [05-rust-base.md](05-rust-base.md)。

# 技术栈与实施

本文回答三个问题：用什么写、为什么、六周怎么排。结论先行：**Swift 6.2 + SwiftUI + 原生协议层 + GRDB + Network.framework，第一版不引入 Rust，不走 Mac App Store。**

## 一、约束

| 约束 | 内容 | 影响 |
|---|---|---|
| 平台 | macOS 14 及以上，Apple Silicon 与 Intel | 可用 `@Observable`、Swift Charts、MenuBarExtra |
| 团队 | 1–2 名开发，无专职设计 | 优先选系统控件与成熟库，减少自写基础组件 |
| 周期 | 6 周出可分发测试版 | 第一版包含摄像头实时查看；砍掉扫地机地图、固件升级、云端录像 |
| 性能 | 14 台设备空闲内存低于 200 MB，单路 1080p 硬解额外低于 100 MB，本地开关 p95 低于 80 ms | 排除 Electron 与重型 WebView |
| 安全 | Token 只进 Keychain，日志不含凭据 | 需要原生 Keychain 与统一日志脱敏 |
| 分发 | 签名 DMG，Sparkle 更新 | 不做 App Store 首发 |
| 合规 | 不复制 GPL 代码，不冒充小米官方 | 协议层按公开协议重写，产品改名 |

## 二、候选方案

### 2.1 评分

权重按本项目的重要程度设定，满分 100。

| 方案 | 原生体验 25 | 性能内存 20 | 开发速度 20 | 维护成本 15 | 库与工具 10 | 分发体积 10 | 合计 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Swift 6.2 + SwiftUI | 5 | 5 | 4 | 4 | 4 | 5 | **91** |
| Rust + Tauri 2 | 3 | 4 | 3 | 3 | 4 | 4 | **68** |
| Dart + Flutter 3 | 3 | 4 | 4 | 3 | 3 | 3 | **68** |
| TypeScript + Electron | 2 | 2 | 5 | 4 | 5 | 1 | **62** |
| Python + PySide6 | 3 | 3 | 5 | 2 | 3 | 2 | **63** |

评分不是语言优劣，是本项目条件下的取舍。下面逐项说明。

### 2.2 Swift + SwiftUI

**优势**

- 窗口、菜单栏、工具栏、焦点、快捷键、触控板手势、VoiceOver、深浅色、系统材质都是原生行为，不需要模拟。
- 内存与启动开销最低。本机微基准里 Swift 协议进程峰值 14.9 MB，Node 64.9 MB，差距主要来自运行时。
- `async/await`、`actor`、`TaskGroup` 足够表达登录单飞、批量请求、轮询取消与写入合并。
- Keychain、Network.framework、CryptoKit、CommonCrypto、OSLog、Swift Charts、WidgetKit 都是系统自带，减少第三方依赖。
- 签名、公证、Sparkle 更新都有成熟流程。

**代价**

- 只能跑 macOS，未来做 Windows 要重写界面。
- SwiftUI 在 macOS 上的列表性能与细节控制不如 AppKit；设备很多时要用 `NSTableView` 包一层。
- `JSONDecoder` 解码 1.7 MB 要 23.77 ms，比 Rust 慢；常规 160 KB 约 2–3 ms，可以接受。
- RC4 与 AES-CBC 在 CryptoKit 里没有直接接口，需要自己写 RC4，AES-CBC 走 CommonCrypto。

**结论**：主方案。

### 2.3 Rust + Tauri 2

**优势**

- Rust 核心解码 1.7 MB 只要 1.70 ms，峰值内存 3.9 MB。
- 核心可以跨 macOS、Windows、Linux 复用，未来做 Windows 版不用重写协议。
- Tauri 的安装包比 Electron 小，系统 WebView 复用减少一部分内存。
- Rust 的类型系统和错误处理适合写协议解析。

**代价**

- 界面仍是 WebView，复杂列表、菜单栏、窗口材质、触控板手势要大量 JS 与 Rust 桥接。
- 需要同时维护 Rust、TypeScript、CSS 三套技能；1–2 人团队的成本明显上升。
- macOS 菜单栏、小组件、App Intents 仍要写 Swift 或 Objective-C，无法只靠 Tauri。
- UDP 局域网、Keychain、公证、崩溃符号化都要额外适配。
- Tauri 的 WebView 在 macOS 上是 WKWebView，内存不如原生可控；120 台设备的列表仍要做虚拟滚动。

**结论**：如果第一版就确定要做 Windows 版，Rust 核心值得考虑；只做 macOS 时，收益小于成本。放到第二阶段。

### 2.4 Flutter

**优势**

- 一套代码覆盖 macOS、Windows、移动端。
- 自绘 UI，视觉一致，动画能力强。
- 开发速度快，热重载适合快速试界面。

**代价**

- macOS 桌面插件质量参差，菜单栏、窗口管理、Keychain、局域网 UDP 需要自己写平台通道。
- 自绘控件不继承系统行为，右键菜单、焦点环、输入法、VoiceOver 要逐项补。
- 包体积与内存高于原生，启动时间也更长。
- 团队如果没有 Dart 经验，学习成本与 Swift 接近。

**结论**：适合跨平台产品，不适合本项目的第一版。

### 2.5 Electron

**优势**

- 前端库与工具最多，界面开发最快。
- 跨平台成熟，调试工具完善。
- 可以直接复用 Web 原型。

**代价**

- 安装包 100 MB 起，空闲内存通常 300 MB 以上，与 180 MB 的目标冲突。
- 菜单栏、窗口材质、触控板手势、Keychain 需要原生插件。
- 长时间常驻的能耗与内存增长要额外治理。
- 安全面更大：Node 集成、渲染进程、远程内容、自动更新都要加固。

**结论**：适合内容型桌面应用，不适合常驻的轻量控制端。

### 2.6 Python + PySide6

**优势**

- `mijia-api` 与 `MiHome-Windows` 都是 Python，可以直接参考实现。
- 开发速度快，脚本与调试方便。
- 跨平台。

**代价**

- GPL 代码不能直接用于闭源分发，优势被许可证抵消。
- 打包体积大，启动慢，内存高于原生。
- `asyncio` 与 Qt 事件循环整合复杂；Windows 版用单线程队列规避，Mac 版不应重复。
- 代码签名、公证、自动更新都要额外工程。

**结论**：适合内部工具与验证脚本，不作为产品客户端。

## 三、推荐栈

### 3.1 总表

| 层 | 选择 | 版本 | 理由 |
|---|---|---|---|
| 语言 | Swift | 6.2 | 原生并发、类型安全、与系统框架一致 |
| UI | SwiftUI + 少量 AppKit | macOS 14+ | 声明式界面，复杂列表用 `NSTableView` 包一层 |
| 并发 | Swift Concurrency | 内置 | `actor`、`TaskGroup`、`AsyncStream` |
| HTTP | URLSession | 内置 | HTTP/2、连接复用、取消、代理配置 |
| UDP | Network.framework | 内置 | `NWConnection`、`NWListener`、路径监控 |
| JSON | Codable + JSONDecoder | 内置 | 结构稳定；大响应可换 `JSONSerialization` 流式读取 |
| 加密 | CryptoKit + CommonCrypto + 自写 RC4 | 内置 | SHA256/SHA1/MD5、AES-CBC、RC4 |
| 凭据 | Security.framework / Keychain | 内置 | 系统凭据存储，支持访问控制 |
| 数据库 | GRDB | 7.x | SQLite 封装，迁移、事务、观察查询 |
| 图表 | Swift Charts | macOS 13+ | 原生图表，支持可访问性 |
| 日志 | OSLog + Signposts | 内置 | 分类、隐私标记、Instruments 联动 |
| 菜单栏 | MenuBarExtra + NSStatusItem 兜底 | 内置 | 常驻入口与自定义浮层 |
| 小组件 | WidgetKit | 内置 | 时间线读取 App Group 数据 |
| 快捷指令 | App Intents | 内置 | 系统级动作 |
| 视频取流 | go2rtc helper | 1.9.15 | MIT，局域网 CS2/TUTK，输出 HLS/WebRTC |
| 视频播放 | AVPlayer + VideoToolbox | 内置 | HLS 硬解；WebRTC 后续用 WKWebView |
| 更新 | Sparkle 2 | 2.x | EdDSA 签名、增量更新、成熟 |
| 测试 | Swift Testing + XCTest + XCUITest | 内置 | 单元、集成、界面测试 |
| 格式化 | swift-format + SwiftLint | 最新 | 统一风格，CI 阻断 |
| 构建 | Xcode 26 + xcodebuild | 26.x | 签名、归档、公证 |
| CI | GitHub Actions macOS runner 或 Xcode Cloud | — | 构建、测试、产物归档 |

### 3.2 为什么不用第三方网络库

`URLSession` 已经覆盖：

- HTTP/2 与连接复用。
- 请求取消与超时。
- 代理与系统网络配置。
- 后台会话（macOS 不需要）。
- 证书校验与 ATS。

米家接口是普通 HTTPS 表单请求，没有 WebSocket、gRPC 或复杂重试需求。引入 Alamofire 只会多一层依赖。

### 3.3 加密实现

| 算法 | 用途 | 实现 |
|---|---|---|
| SHA-256 | `signed_nonce` | CryptoKit `SHA256` |
| SHA-1 | 请求签名、UDP 校验 | CryptoKit `Insecure.SHA1` |
| MD5 | `rc4_hash__`、UDP 头部 | CryptoKit `Insecure.MD5` |
| RC4 | 请求参数加密 | 自写约 60 行，配单元测试向量 |
| AES-128-CBC | 局域网负载 | CommonCrypto `CCCrypt`，PKCS#7 |
| Base64 | 签名输入 | Foundation `Data.base64EncodedString()` |

RC4 已经不安全，但这里是协议兼容，不是用来保护新数据。实现时注意：

- 密钥流不能复用。每次请求重新生成 nonce 与密钥。
- 不要把 RC4 输出写日志。
- 自写实现要有已知向量测试，覆盖空输入、1 字节、1 KiB、非 16 字节整块。

### 3.4 数据库

GRDB 负责：

- 迁移：`v1_initial`、`v2_add_metrics`，每次迁移单独测试。
- 事务：设备列表整批替换在一个事务里完成，避免半更新。
- 观察：设备行用 `ValueObservation` 驱动，UI 不手动刷新。
- 并发：`DatabasePool` 读写分离；写队列串行。

不建议 Core Data：规格 JSON 与 `device_state` 的批量 upsert 用 SQL 更直接，迁移与调试也更透明。

### 3.5 依赖清单

第一版只允许这些第三方依赖：

| 依赖 | 用途 | 许可证 |
|---|---|---|
| GRDB | SQLite | MIT |
| Sparkle | 自动更新 | MIT |
| swift-format | 格式化 | Apache-2.0 |
| SwiftLint | 静态检查 | MIT |
| go2rtc | 摄像头取流 helper，随 App 打包，不单独安装 | MIT |

其他能力用系统框架。每增加一个依赖，要在 PR 里写用途、许可证、维护状态和替代方案。

### 3.6 摄像头取流

摄像头不放进主工程的 Swift 协议层，单独做一个本机 helper 边界：

- helper 用 go2rtc 1.9.15 的 macOS 单架构或 universal 二进制，作为 Tauri sidecar 随 App 打包到 `Contents/MacOS/go2rtc`。
- App 启动时拉起，监听 `127.0.0.1` 的随机端口；退出、切换账号、空闲回收时结束进程。
- 扫码拿到的 `userID` 与 `passToken` 通过临时配置交给 helper，不写用户目录、不写日志。
- 播放优先 AVPlayer + HLS；低延迟模式用 WKWebView 承载 WebRTC。视频解码走 VideoToolbox。
- helper 只负责协议与转封装，不参与 UI、不做云存储、不监听局域网网卡。
- 许可证是 MIT，分发时保留版权声明。MiBeeNvr 是 AGPL-3.0，不采用；micam 依赖 Java 运行时，包体过大，不采用。

这条边界的代价是多一个进程和约 7–15 MB 安装体积；收益是摄像头崩溃不会拖垮主 App，且不必把 P2P 协议塞进 Swift 代码。若后续要换实现，App 侧只依赖“本地 HLS 地址”和“启动/停止”两个接口。

远程查看不在第一版：go2rtc 要求摄像头与 Mac 在同一局域网。Mac 不在家时只能依赖用户已有的 WireGuard、Tailscale 等家庭 VPN，App 不内置穿透服务，也不把“云端转发”写成已实现能力。

## 四、基准与解读

### 4.1 测试条件

- 机器：Apple M4 / 32 GB / macOS 26.6.2。
- 数据：120 台设备 × 40 条属性，1,743.9 KiB。
- JSON 每轮 30 次取中位数；AES 每轮 3,000 次取中位数。
- 启动时间包含运行时初始化、读取文件、解码一次。

### 4.2 结果

| 运行时 | 启动中位 (ms) | 最快 (ms) | JSON 解码 (ms) | AES-128-CBC 1 KiB (µs) | 峰值内存 (MB) |
|---|---:|---:|---:|---:|---:|
| Swift 6.2 | 25.9 | 24.9 | 23.77 | 0.37 | 14.9 |
| Rust 1.86 | 3.8 | 3.6 | 1.70 | 3.29 | 3.9 |
| Node 24 | 36.1 | 35.8 | 3.73 | 7.80 | 64.9 |
| Python 3.9 | 32.1 | 31.3 | 10.19 | 7.44 | 23.3 |

### 4.3 怎么读

- **Swift 的 23.77 ms 是最坏情况。** 1.7 MB 是 120 台设备各 40 条属性的极端数据；11 台控制设备的常规响应约 160 KB，解码 2–3 ms。
- **Rust 的 1.70 ms 不代表整体快 14 倍。** 它证明 Rust 适合做协议核心，但 UI 仍要原生，跨语言调用的复杂度会吃掉这部分收益。
- **AES 这一列不能当吞吐。** 每次新建 cipher 上下文，包含密钥扩展；Rust 在这个口径下慢，是因为实现方式不同。局域网包很小，单次加解密对总延迟的影响远小于网络往返。
- **Node 的 64.9 MB 只是空进程。** Electron 加上 Chromium、渲染进程与业务代码，实际常驻通常 300 MB 以上。
- **这组数据不是 GUI 启动时间。** SwiftUI 窗口、字体、图片和系统框架另算；产品目标见 `02-product-design.md`。

结论：协议层选 Swift 足够；Rust 只在确定做跨平台核心时引入。

## 五、工程结构

```
MiHomeMac/
├── App/
│   ├── MiHomeMacApp.swift
│   ├── AppEnvironment.swift
│   └── Commands.swift
├── UI/
│   ├── Overview/
│   ├── Devices/
│   ├── Camera/
│   ├── Inspector/
│   ├── Scenes/
│   ├── Automations/
│   ├── Settings/
│   ├── Login/
│   └── Components/
├── Domain/
│   ├── DeviceRegistry.swift
│   ├── Capability.swift
│   ├── CommandService.swift
│   ├── SceneRunner.swift
│   ├── AutomationEngine.swift
│   ├── CameraSession.swift
│   └── Diagnostics.swift
├── Data/
│   ├── Cloud/
│   │   ├── CloudClient.swift
│   │   ├── RequestSigner.swift
│   │   └── CloudModels.swift
│   ├── LAN/
│   │   ├── LANClient.swift
│   │   ├── LANPacket.swift
│   │   └── LANCrypto.swift
│   ├── Auth/
│   │   ├── AuthSession.swift
│   │   └── KeychainStore.swift
│   ├── Spec/
│   │   ├── SpecRepository.swift
│   │   └── SpecModels.swift
│   ├── Camera/
│   │   ├── CameraService.swift
│   │   └── StreamPlayer.swift
│   └── Store/
│       ├── Database.swift
│       ├── Migrations.swift
│       └── SettingsStore.swift
├── Platform/
│   ├── MenuBarPanel.swift
│   ├── WidgetBridge.swift
│   └── LoginItem.swift
├── Resources/
│   ├── Assets.xcassets
│   ├── Localizable.xcstrings
│   └── PrivacyInfo.xcprivacy
└── Tests/
    ├── Unit/
    ├── Integration/
    └── UI/
```

规则：

- `UI` 不 import `Cloud` 或 `LAN`，只依赖 `Domain` 的协议。
- `Data` 的每个客户端实现一个协议，测试用假实现替换。
- `AppEnvironment` 是唯一装配点，禁止在视图里直接创建客户端。
- 每个模块有独立测试 target，协议层测试不启动 UI。

## 六、测试计划

### 6.1 单元测试

| 对象 | 用例 |
|---|---|
| `RequestSigner` | 固定 nonce 与 ssecurity 的签名向量；参数顺序；空参数；中文与特殊字符 |
| `LANCrypto` | RC4 已知向量；AES-CBC 填充；MD5 头部校验；错误 Token |
| `Capability` | 布尔、数值、枚举、只读、范围、步长、无规格 |
| `CommandQueue` | 合并、优先级、取消、版本号、失败回滚 |
| `PollScheduler` | 前后台切换、退避、可见设备过滤、网络断开 |
| `SceneRunner` | 部分失败、重试、并发上限 |
| `AutomationEngine` | 星期计算、时区、夏令时、睡眠错过 |

### 6.2 集成测试

- 用录制的 HTTP 响应做契约测试，响应里的 Token、Cookie、设备 ID 全部替换成假值。
- 用本地 UDP 回环服务模拟设备，验证握手、读写、超时、重放。
- 真实账号测试单独放 `IntegrationReal` target，不进 CI，手动运行。

### 6.3 设备覆盖清单

至少覆盖：

| 品类 | 型号 | 验证点 |
|---|---|---|
| 灯 | Yeelight 吸顶灯、灯带 | 开关、亮度、色温、模式 |
| 空调 | 小米空调伴侣或空调 | 温度、模式、风速、扫风 |
| 窗帘 | 绿米窗帘电机 | 开合百分比、运行状态、方向 |
| 净化器 | 智米净化器 | 开关、模式、PM2.5、滤芯 |
| 插座 | 绿米插座 | 开关、功率、电量 |
| 传感器 | 温湿度计 | 温度、湿度、电量、上报间隔 |
| 扫地机 | 追觅 | 状态、电量、回充 |

每个型号记录固件版本。固件升级后重跑对应用例。

### 6.4 性能测试

- `XCTApplicationLaunchMetric` 测冷启动、热启动。
- `XCTMemoryMetric` 测空闲、120 台设备、连续切换页面。
- `XCTClockMetric` 测房间切换、搜索、检查器打开。
- Signposts 标记登录、设备列表、属性读、属性写、场景执行、局域网握手。
- Instruments 的 Time Profiler、Allocations、Energy Log 各跑一次。
- 24 小时挂机测试：每小时记录内存、CPU、请求数、错误数。

### 6.5 安全测试

- 日志扫描：导出诊断包，搜索 `token`、`cookie`、`ssecurity`、`passToken`，必须为零。
- Keychain：确认卸载重装后旧凭据不可读；确认其他应用无法读取。
- 崩溃报告：确认不包含请求体与响应体。
- 依赖审计：`swift package show-dependencies`，检查许可证与已知漏洞。
- 本地 UDP：确认错误 Token 不能解密，重放包被拒绝。

### 6.6 可访问性与本地化

- Accessibility Inspector 检查所有控件标签、角色、值。
- VoiceOver 走一遍登录、总览、检查器、设置。
- 键盘走一遍：Tab 顺序、`⌘K`、`Esc`、方向键调值。
- 英文伪本地化，检查按钮与表头是否截断。
- 深浅色、增强对比度、减少动态效果各截图对比。

## 七、六周计划

### 第 1 周：登录与设备列表

| 任务 | 产出 | 验收 |
|---|---|---|
| 建工程、模块、CI | 可构建的空壳 | `xcodebuild test` 通过 |
| 二维码登录、Cookie、Token 刷新 | `AuthSession` | 真实账号登录成功，重启免登录 |
| Keychain 存储 | `KeychainStore` | 卸载重装后凭据不可读 |
| 请求签名 | `RequestSigner` | 固定向量测试通过 |
| 家庭、房间、设备列表 | `DeviceRegistry` | 与米家 App 数量一致 |
| 规格拉取与缓存 | `SpecRepository` | 同型号只请求一次 |

周末门槛：能看到真实设备列表，杀掉进程重启后仍能看到缓存。

### 第 2 周：属性读写与设备面板

| 任务 | 产出 | 验收 |
|---|---|---|
| 批量属性读 | `CloudClient.readProps` | 11 台控制设备 1 次请求；3 路摄像头单独取流 |
| 属性写 | `CloudClient.writeProp` | 灯、插座、空调可控制 |
| 能力映射 | `Capability` | 布尔、数值、枚举、只读正确 |
| 设备行与检查器 | UI | 五类设备有合适控件 |
| 乐观更新与版本号 | `CommandQueue` | 快速连点不出现状态回跳 |
| 错误分类 | `AppError` | 四类错误文案正确 |

周末门槛：灯、空调、窗帘、净化器、插座五类设备可日常控制。

### 第 3 周：场景、批量与缓存

| 任务 | 产出 | 验收 |
|---|---|---|
| 场景执行 | `SceneRunner` | 逐台结果，失败可重试 |
| 全部设备页 | 表格、搜索、筛选 | 120 台设备 60 fps |
| SQLite 缓存 | `Database` | 冷启动先显示缓存 |
| 轮询调度 | `PollScheduler` | 前后台切换按策略降频 |
| 退避与限流 | 请求策略 | 429 后不雪崩 |
| 全部关闭 | 批量写 | 确认弹窗与结果统计 |
| go2rtc 进程管理 | `CameraService` | 启动、停止、崩溃重启、端口探测 |
| 摄像头登录与首帧 | `CameraSession` | 1 台真实机型在局域网出画面 |

周末门槛：不打开米家 App，只用 Mac 版完成一天的控制；监控页能看 1 路真实画面。

### 第 4 周：局域网

| 任务 | 产出 | 验收 |
|---|---|---|
| `xiaomiio` 登录与设备 Token | `CloudClient.deviceTokens` | 拿到 `token` 与 `localip` |
| UDP 握手 | `LANClient.handshake` | 200 ms 内完成 |
| AES-CBC 与 MD5 | `LANCrypto` | 与设备互通 |
| 局域网读写 | `LANClient` | 开关 p95 低于 80 ms |
| 失败回退 | 路径选择 | 拔网线后自动回云端 |
| mDNS 发现 | `Discovery` | 网络切换后重新发现 |
| 单画面与宫格 | 监控 UI | 3 路画面、画质切换、全屏 |
| 云台、截图、录制、遮蔽 | `CameraControls` | 支持机型逐项通过 |

周末门槛：同一局域网内，灯与插座走本地；关掉路由器外网仍能控制；监控页 3 路画面可切换。

### 第 5 周：常驻能力

| 任务 | 产出 | 验收 |
|---|---|---|
| 菜单栏速控 | `MenuBarPanel` | 6 台设备 + 4 个场景 |
| 小组件 | `WidgetKit` | 小、中、大三尺寸 |
| App Intents | 快捷指令 | 开关设备、执行场景 |
| 本地定时 | `AutomationEngine` | 创建、启停、错过记录 |
| 通知 | `UNUserNotificationCenter` | 失败与 Token 过期提醒 |
| 开机启动 | `SMAppService` | 设置页开关生效 |

周末门槛：合上主窗口后，菜单栏仍可用；定时任务按计划执行。

### 第 6 周：发布准备

| 任务 | 产出 | 验收 |
|---|---|---|
| 性能达标 | 启动、内存、滚动 | 达到预算表 |
| 可访问性 | VoiceOver、键盘、对比度 | 检查清单全过 |
| 本地化 | 中英文 | 无截断 |
| 图标与关于页 | 资源 | 无米家商标 |
| 签名与公证 | DMG | `spctl` 通过 |
| Sparkle | 更新源 | 旧版本能升到新版本 |
| 内测 | 10 名用户 | 一周内无阻断问题 |

周末门槛：签名 DMG 可分发给外部测试者。

## 八、风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 米家接口变更 | 高 | 高 | 协议层隔离；错误码集中；灰度开关；保留旧版本可用路径 |
| 账号被风控 | 中 | 高 | 控制轮询频率；不并发登录；异常时提示用户；不自动重试登录 |
| 设备型号覆盖不足 | 高 | 中 | 规格驱动控件；无规格时明确说明；建立型号反馈入口 |
| 局域网权限被拒 | 中 | 中 | 云端兜底；设置页给系统设置入口；诊断日志记录权限状态 |
| 局域网 Token 失效 | 中 | 中 | 启动与网络切换时刷新；失败后回云端并提示原因 |
| GPL 与商标 | 高 | 高 | 按协议重写；不复制代码与图标；改名；发布前法务审阅 |
| App Store 审核 | 中 | 中 | 首发直接分发；不把上架作为里程碑 |
| Token 泄露 | 低 | 高 | Keychain；日志脱敏；诊断包扫描；最小权限 |
| 性能回退 | 中 | 中 | 预算进 CI；Signposts；每次发版跑基准 |
| 范围蔓延 | 高 | 中 | 第一版只做实时查看，不做云端录像、地图、固件升级；新需求进下一版 |
| 摄像头型号不兼容 | 高 | 高 | 先验证用户手上的机型；未验证型号不显示监控入口；建立支持列表 |
| 测试设备不足 | 中 | 中 | 先买 5 类核心设备；其余靠用户反馈与模拟包 |

## 九、成本

| 项目 | 费用 | 说明 |
|---|---:|---|
| Apple Developer Program | $99/年 | 签名与公证 |
| 域名与更新源 | 约 ¥100/年 | Sparkle appcast 与下载 |
| 第三方库 | 0 | 均为开源许可证 |
| 服务器 | 0 | 第一版不做账号系统与遥测 |
| 测试设备 | ¥2,000–5,000 | 按现有设备补齐 |
| 人力 | 1 人 6 周 / 2 人 4 周 | 不含设计与法务 |

## 十、后续演进

### 10.1 第二阶段

- 局域网属性订阅，减少轮询。
- 多家庭切换与共享设备只读。
- 桌面小组件交互按钮（macOS 14+ 支持）。
- 场景编辑：本地组合场景，不写回米家。
- 读数历史：本地按小时聚合，保留 90 天。

### 10.2 跨平台

如果确定做 Windows：

1. 把 `RequestSigner`、`LANCrypto`、`SpecModels`、`Capability` 抽成 Rust crate。
2. 用 UniFFI 生成 Swift 与 Kotlin 绑定。
3. macOS 与 Windows 各自保留原生 UI。
4. 协议核心有独立测试与版本号，UI 只依赖生成的接口。

不要在第一天就做这件事。跨语言边界、构建系统和调试成本会拖慢第一版，而协议层的性能并不是瓶颈。

### 10.3 不做的事

- 不把米家云端接口包装成公开 API 出售。
- 不做账号池、代登录、多租户。
- 不绕过设备固件签名或破解私有协议。
- 不复制米家 App 的图标、文案与界面。

## 十一、决策记录

| 编号 | 决策 | 理由 | 替代方案 |
|---|---|---|---|
| ADR-001 | 用 Swift + SwiftUI 写 macOS 客户端 | 原生体验、内存、系统集成 | Tauri、Flutter、Electron |
| ADR-002 | 第一版只做 macOS | 6 周内做出可用产品 | 同时做 Windows |
| ADR-003 | 协议层用 Swift，不引入 Rust | 数据规模下收益不足 | Rust 核心 + UniFFI |
| ADR-004 | 云端优先实现，局域网第二阶段 | 云端覆盖全部设备，局域网需要额外 Token | 先做局域网 |
| ADR-005 | 直接分发，不上 App Store | GPL、商标、非官方接口的审核风险 | App Store 首发 |
| ADR-006 | SQLite + GRDB | 批量 upsert、迁移、观察查询 | Core Data、Realm |
| ADR-007 | 不做设备状态推送，先轮询 | 云端推送协议未公开，MQTT 风险高 | 自建 MQTT |

## 术语说明

**Swift**：Apple 开发的编译型语言，用于 macOS、iOS 等平台的原生应用。

**SwiftUI**：Apple 的声明式界面框架，用状态描述界面，系统负责渲染。

**AppKit**：macOS 的传统界面框架。SwiftUI 覆盖不到的地方用它补，例如复杂表格与菜单栏自定义面板。

**GRDB**：Swift 的 SQLite 封装库，提供迁移、事务、查询观察。

**URLSession**：Apple 的 HTTP 客户端，支持 HTTP/2、连接复用、取消与代理。

**Network.framework**：Apple 的网络框架，提供 TCP、UDP、TLS 与网络路径监控。

**CryptoKit**：Apple 的加密框架，提供哈希、对称加密、签名等接口。

**CommonCrypto**：Apple 的底层加密库，提供 AES-CBC 等 CryptoKit 未覆盖的算法。

**RC4**：一种流加密算法。米家 HTTP 接口用它加密请求参数，本文只用它做协议兼容。

**AES-128-CBC**：一种分组加密模式，米家局域网 UDP 包用它加密负载。

**Keychain**：macOS 的系统凭据存储，按应用与访问组隔离。

**OSLog**：Apple 的统一日志系统，支持分类、隐私标记与 Instruments 联动。

**Signpost**：OSLog 的性能标记，用来在 Instruments 时间轴上标注阶段耗时。

**GRDB 的 DatabasePool**：GRDB 提供的数据库连接池，允许多个读并发、单写串行。

**UniFFI**：Mozilla 的工具，把 Rust 接口生成 Swift、Kotlin 等语言的绑定。

**Tauri**：用 Rust 做后端、系统 WebView 做界面的桌面应用框架。

**Electron**：用 Chromium 与 Node.js 做桌面应用的框架。

**Flutter**：Google 的跨平台界面框架，自绘控件，支持桌面端。

**PySide6**：Qt 6 的 Python 绑定，用来写桌面界面。

**Sparkle**：macOS 的第三方应用更新框架，支持 EdDSA 签名与增量更新。

**公证（notarization）**：Apple 对分发应用的自动安全检查。通过后才能在没有警告的情况下打开。
