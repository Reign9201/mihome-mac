# MiHome Mac

一个面向 macOS 的开源、非官方米家桌面客户端。项目使用 Rust 构建协议核心，以 Tauri 2 提供桌面壳，支持扫码登录、家庭与设备管理、设备控制、场景执行、定时自动化以及摄像头查看。

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
- 通过 go2rtc 查看同一局域网内的摄像头画面
- 通过 Rust 实现的 CS2 relay + MISS 通道进行远程取流
- 支持监控宫格、画面控制、云台控制和单步云台操作
- 提供明暗主题、强调色、命令面板和菜单栏速控界面
- 附带可离线打开、无需真实账号的交互原型

![监控页](docs/assets/shot-camera.jpg)

## 当前状态

桌面端已经实现扫码登录、家庭与设备读取、常用属性读写、手动场景和摄像头取流链路。当前仓库的自动化测试、静态检查和离线交互回归已经通过；真实小米账号、不同设备型号与固件、局域网及跨网段摄像头仍需要在实际环境中建立兼容性矩阵后确认。

登录凭据保存在 macOS Keychain；旧版明文 `session.json` 会在首次恢复登录时自动迁移并删除。设备控制能力来自 `miot-spec.org`，没有公开规格的设备默认不开放写入。

局域网摄像头要求 Mac 与摄像头处于同一网段；远程取流目前以 CS2 机型为主，云台控制需要按型号验证。菜单栏常驻功能尚未完成。不同型号的可写属性和支持范围请看 [产品设计](docs/02-product-design.md) 与 [摄像头通道设计](docs/06-camera-product-channel.md)。

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
- ffmpeg（远程摄像头取流需要）
- go2rtc（运行和打包时作为 Tauri sidecar 加载，首次构建前需要准备）

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
./scripts/build-macos.sh universal
```

也可以使用 `arm64` 或 `x64` 构建单架构包。产物会复制到 `dist/macos/` 并生成 SHA256 文件。构建完成后可检查 DMG 结构、架构和资源：

```bash
./scripts/verify-macos-bundle.sh dist/macos/MiHome-Mac-0.1.0-universal.dmg universal
```

生成 DMG 不要求 Apple 证书；Gatekeeper 放行才要求 Developer ID 签名与公证。与 Electron Builder 项目相同，未签名 DMG 可以生成、挂载和本地测试，但下载到其他 Mac 后会被 Gatekeeper 拒绝。CI 和本地默认构建都不包含签名证书。

仓库还提供 `.github/workflows/macos-dmg.yml`，可在 GitHub Actions 中手动运行，或在推送 `v*` 标签时生成未签名 universal DMG 构建产物。

## 项目结构

```text
mihome-mac/
├── core/                         Rust 协议层：登录、签名、设备、场景、摄像头
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
| 本地摄像头 | go2rtc（独立子进程） |
| 远程摄像头 | Rust CS2 relay、MISS、ffmpeg |
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
