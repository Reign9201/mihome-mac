# MiHome Mac

一个面向 macOS 的开源、非官方米家桌面客户端。项目使用 Rust 构建本地核心，以 Tauri 2 提供桌面窗口，支持扫码登录、家庭与设备管理、设备控制、场景执行、定时自动化以及摄像头查看。

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS-black)
![Rust](https://img.shields.io/badge/Rust-1.90%2B-orange)
![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)

> 本项目与小米公司没有隶属或官方关联。项目使用非公开、非官方接口，接口和协议可能随服务端更新而变化，请自行评估使用风险。

![总览](docs/assets/shot-overview.jpg)

## 功能

- 使用米家 App 扫码登录，无需在应用中保存账号密码
- 读取家庭、房间和设备列表，展示设备在线状态与连接方式
- 按 MIoT-Spec 动态生成设备能力，只向规格声明可写的属性发送控制
- 执行米家手动场景，保存并运行本地定时自动化
- 查看同一局域网内的摄像头画面，优先使用低延迟实时传输
- 不在同一局域网时，可通过应用内置的远程连接查看画面
- 远程画面支持音频监听，声音开关不会重建已建立的视频通道
- 播放失败时自动切换兼容模式，减少黑屏和长时间等待
- 远程宫格逐路出画，较快的摄像头不再等待较慢的一路
- 支持监控宫格、画面控制、云台控制和单步云台操作
- 设备卡片提供常用指标、开关和快捷控制，摄像头设置按型号中文化
- 内置独立诊断日志，可导出脱敏汇总并定位取流失败
- 附带可离线打开、无需真实账号的交互原型

![监控页](docs/assets/shot-camera.jpg)

## 当前状态

桌面端已经实现扫码登录、家庭与设备读取、常用属性读写、手动场景和摄像头取流链路。当前仓库的自动化测试、静态检查和离线交互回归已经通过；不同设备型号、固件和网络环境仍需要在真实环境中逐步建立兼容性清单。

登录凭据只保存在当前用户目录下的本地会话文件中，目录权限 `0700`、文件权限 `0600`。未提供 Developer ID 的构建使用 ad-hoc 签名；若改用系统 Keychain，每次升级二进制都可能触发钥匙串授权，因此当前默认不调用 Keychain。这个方案能避免启动弹窗，但不能防御同一 macOS 账号下的恶意进程；正式签名的发行版应改用 Keychain 或更严格的系统凭据保护。设备控制能力来自 `miot-spec.org`，没有公开规格的设备默认不开放写入。

局域网摄像头要求 Mac 与摄像头处于同一网段；远程连接目前只覆盖已适配的小米摄像头，云台控制需要按型号验证。本地画面默认启动 ffmpeg，将摄像头视频转成低延迟 H.264 WebRTC，避开部分 WebKit/VideoToolbox 组合的 HEVC 解码停滞；摄像头原始编码只在没有可用 ffmpeg，或显式设置 `MIHOME_LOCAL_PREFER_NATIVE=1` / `MIHOME_LOCAL_TRANSPORT=native` 时作为视频源。默认 H.264 播放失败不会自动切回 HEVC，而是走 H.264 MSE，再按 HLS 兼容回退；原始流仍用于独立音频音轨。网络传输和摄像头转发无法做到绝对零延迟，项目目标是稳定在约 1 秒级并自动追赶延迟。关闭主窗口后应用会驻留菜单栏，本地定时自动化继续运行；需要完全退出时使用菜单栏的“退出 MiHome Mac”。不同型号的可写属性和支持范围请看 [产品设计](docs/02-product-design.md) 与 [摄像头通道设计](docs/06-camera-product-channel.md)。

2026-11-01 已完成真实摄像头验证：本地 H.264 WebRTC 首帧约 1.3–4 秒（本次单次实测约 3.9 秒），摄像头 3 连续 4.5 分钟、摄像头 2 重新建链后均保持水印延迟 0–1 秒；WebRTC 抖动约 0.02–0.07 秒，无丢包。远程画面继续优先使用 WebRTC，本次单路低延迟中继从启动到就绪约 1.9–2.0 秒，两路宫格较慢一路约 4.0 秒，MSE 回退首包约 62 毫秒。本地和远程声音均使用独立 WebRTC 音轨，避免音频缓冲拖慢视频；远程 ffmpeg 缺少 libopus 时会回退到 PCMA。远程首次连接受候选节点和 relay 状态影响，常见约 2–16 秒，也出现过约 30 秒的长尾，稳定出画后水印延迟约为 1 秒级。该结果来自当前源码和真实设备，不代表所有网络环境都能达到相同表现。

本地视频默认启动 H.264 转码流；原生流保留为显式回退模式和独立音频源。需要排查兼容性时可用以下环境变量：

```bash
# 只使用摄像头原始编码，不启动 ffmpeg
MIHOME_LOCAL_CODEC=direct npm --prefix desktop run dev

# 临时切回原生 HEVC 优先，H.264 作为回退
MIHOME_LOCAL_PREFER_NATIVE=1 npm --prefix desktop run dev

# 临时切回高清子码流
MIHOME_LOCAL_SUBTYPE=hd npm --prefix desktop run dev

# 临时使用 VideoToolbox 硬件编码器对比性能
MIHOME_LOCAL_ENCODER=videotoolbox npm --prefix desktop run dev
```

## 诊断日志

应用默认把诊断日志写入 `~/Library/Logs/MiHome/`，按天和 2 MB 轮转，保留 7 天；未捕获崩溃会另行写入 `crash-*.txt`。点击界面右上角“诊断日志”会生成一份脱敏汇总到 `~/Downloads/`，并在访达中定位该文件。

需要更详细的内置取流和远程握手日志时，从终端启动开发版：

```bash
MIHOME_LOG_LEVEL=debug npm --prefix desktop run dev
```

可用 `MIHOME_LOG_DIR=/path/to/logs` 修改日志目录，用 `MIHOME_DIAGNOSTICS_DIR=/path/to/export` 修改导出目录。日志模块不依赖 Tauri，接入方式和轮转边界见 [诊断日志设计](docs/07-diagnostic-log.md)。

## 快速开始

### 交互原型

原型不连接真实账号，不会请求小米服务，打开即可体验主要界面与交互：

```bash
git clone https://github.com/Reign9201/mihome-mac.git
cd mihome-mac
open prototype/index.html
```

也可以启动本地静态服务：

```bash
cd prototype
python3 -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899
```

### 桌面应用

环境要求：

- macOS 13 或更高版本
- Rust 1.90 或更高版本
- Xcode Command Line Tools
- Node.js 20 或更高版本（仅构建安装包时需要）
- ffmpeg（本地和远程摄像头的低延迟 H.264 转码需要）
- go2rtc（随应用一起运行和分发，首次构建前需要准备）

先准备 go2rtc。脚本会按当前架构下载固定版本并校验 SHA256：

```bash
git clone https://github.com/Reign9201/mihome-mac.git
cd mihome-mac
./helpers/go2rtc/fetch.sh
```

从源码运行：

```bash
npm --prefix desktop ci
npm --prefix desktop run dev
```

首次启动时，应用会请求二维码，使用米家 App 扫码即可进入设备列表。

构建 DMG：

```bash
./scripts/build-macos.sh arm64   # Apple Silicon
./scripts/build-macos.sh x64     # Intel
```

单架构包只内置对应架构的 go2rtc，体积明显更小。需要同时兼容 Intel 和 Apple Silicon 时，也可以构建 universal 单包：

```bash
./scripts/build-macos.sh universal
```

universal 会同时包含两套主程序和两套 go2rtc，体积约为单架构包的两倍。产物会复制到 `dist/macos/` 并生成 SHA256 文件。构建完成后可检查 DMG 结构、架构和资源：

```bash
./scripts/verify-macos-bundle.sh dist/macos/MiHome-Mac-0.1.0-universal.dmg universal
```

当前单架构 DMG 约 10 MB 量级。主程序经过符号裁剪，最大的固定开销是必须随应用分发的 go2rtc；它未压缩约 21 MB，DMG 压缩后占比仍然最高。仅通过更换压缩格式无法把包含 go2rtc 的安装包压到 5 MB。

生成 DMG 不要求 Apple 证书。没有 Developer ID Application 证书时，构建脚本会使用 ad-hoc 签名，让 macOS 本地网络权限和成品包内测正常工作；Gatekeeper 跨设备放行仍要求 Developer ID 签名与 Apple 公证。ad-hoc DMG 可以生成、挂载和本地测试，但下载到其他 Mac 后仍会被 Gatekeeper 拒绝。CI 和本地默认构建都不包含 Developer ID 证书。

仓库还提供 `.github/workflows/macos-dmg.yml`，可在 GitHub Actions 中手动运行，或在推送 `v*` 标签时分别生成 arm64、x64 ad-hoc 签名 DMG 构建产物。

## 项目结构

```text
mihome-mac/
├── core/                         Rust 协议层：登录、签名、设备、场景、摄像头、日志
├── desktop/
│   ├── ui/                       桌面界面，纯 HTML/CSS/JavaScript
│   └── src-tauri/                Tauri 2 壳与 IPC 命令
├── prototype/                    可离线运行的交互原型
├── scripts/                      macOS 多架构构建与 DMG 验证脚本
├── helpers/go2rtc/               go2rtc 接入说明与 MIT 许可证
├── benchmarks/                   协议解析与设备网格性能基准
├── docs/                         产品、架构、摄像头与实现文档
├── LICENSE                       GPL-3.0 许可证
├── THIRD_PARTY_NOTICES.md        上游项目与第三方许可证说明
└── README.md
```

## 技术栈

| 模块 | 技术 |
|---|---|
| 协议核心 | Rust、tokio、reqwest、serde |
| 桌面应用 | Tauri 2、WebView |
| 界面 | 原生 HTML、CSS、JavaScript |
| 本地摄像头 | go2rtc（独立子进程）、x264 H.264 WebRTC、原生视频显式回退与独立音频 |
| 远程摄像头 | Rust 远程连接、ffmpeg、内置 go2rtc |
| 性能验证 | Rust、Swift、Node.js、Python 基准脚本 |

## 参与贡献

欢迎通过 Issue 报告兼容性问题，或提交 Pull Request 改进设备适配、界面和文档。

提交前建议至少运行：

```bash
cargo fmt --manifest-path core/Cargo.toml -- --check
cargo clippy --manifest-path core/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path core/Cargo.toml
cargo check --manifest-path desktop/src-tauri/Cargo.toml
npm --prefix desktop run check
npm --prefix desktop test
```

请勿提交登录凭据、Cookie、设备 Token、完整云端响应或包含个人设备信息的日志。

## 参考项目与致谢

本项目建立在以下开源项目和社区工作的基础上：

| 项目 | 用途 | 许可证 | 使用方式 |
|---|---|---|---|
| [Do1e/mijia-api](https://github.com/Do1e/mijia-api) | 扫码登录、请求签名、云端接口与设备模型 | GPL-3.0-or-later | 协议实现的重要参考，部分逻辑改写为 Rust |
| [huanyuejue/MiHome-Windows](https://github.com/huanyuejue/MiHome-Windows) | 桌面端功能组织、交互与设备控制流程 | GPL-3.0-or-later | 功能与设计参考，macOS 界面重新实现 |
| [AlexxIT/go2rtc](https://github.com/AlexxIT/go2rtc) | 局域网摄像头取流 | MIT | 作为独立助手程序使用 |
| [FFmpeg](https://ffmpeg.org/) | 本地/远程摄像头低延迟 H.264 转码与 RTSP 发布 | LGPL-2.1-or-later 或 GPL（取决于构建选项） | 运行时外部依赖，不随安装包分发 |
| [Squachen/micloud](https://github.com/Squachen/micloud) | 小米云登录与 RC4 签名算法的早期实现 | MIT | 通过 mijia-api 间接参考 |
| [XiaoMi/ha_xiaomi_home](https://github.com/XiaoMi/ha_xiaomi_home) | 局域网与消息协议事实核对 | 小米自定义许可证 | 仅作协议研究，不复制、不打包其代码 |
| [eugeneRover/micam](https://github.com/eugeneRover/micam) | CS2 远程取流可行性验证 | 仓库未声明许可证 | 仅作独立验证，不复制、不打包其代码 |

`ha_xiaomi_home` 的许可证仅允许在 Home Assistant 内进行非商业使用，因此本项目不包含它的代码。`micam` 未声明开源许可证，因此本项目只参考其验证结论，不包含其源码或二进制文件。

## 开源许可证

本项目使用 [GNU General Public License v3.0 or later](LICENSE)（GPL-3.0-or-later）发布。

由于项目包含参考并改写自 GPL-3.0 项目的协议实现，整体项目采用 GPL-3.0-or-later，以符合上游许可证的要求。你可以按照 GPL 的条款使用、修改和分发本项目；分发修改后的版本时，需要同时提供对应的完整源代码。

`helpers/go2rtc/` 中的 go2rtc 助手仍按 MIT 许可证发布，其版权声明和许可证副本保留在 [helpers/go2rtc/LICENSE](helpers/go2rtc/LICENSE)。Rust、Node.js 和其他第三方依赖分别遵循各自声明的许可证。

上游项目的版权归属、许可证和代码使用方式汇总在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，该文件与 GPL 许可证副本也会随 macOS 安装包分发。

## 免责声明

本项目是非官方开源项目，不提供任何担保。使用非官方接口可能导致账号风控、设备状态异常或服务不可用。请遵守小米的服务条款和设备使用说明，并自行保护登录凭据与设备访问权限。

Copyright (C) 2026 XuYanjun and contributors.
