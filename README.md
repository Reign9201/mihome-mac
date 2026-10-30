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
- 控制灯光、插座、空调、窗帘、门锁等常见设备
- 执行米家手动场景，保存并运行本地定时自动化
- 通过 go2rtc 查看同一局域网内的摄像头画面
- 通过 Rust 实现的 CS2 relay + MISS 通道进行远程取流
- 支持监控宫格、画面控制、云台控制和事件回放界面
- 提供明暗主题、强调色、命令面板和菜单栏速控界面
- 附带可离线打开、无需真实账号的交互原型

![监控页](docs/assets/shot-camera.jpg)

## 当前状态

桌面端已经可以完成扫码登录、家庭与设备读取、常用属性读写、手动场景和摄像头取流。远程摄像头通道已在 Mac 与摄像头不同网段的条件下验证，但设备型号、固件和账号权限仍会影响可用功能。

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
- go2rtc（运行和打包时作为 Tauri 资源加载，首次构建前需要准备）

先准备 go2rtc。Apple Silicon 使用 `arm64`，Intel Mac 把 `ARCH` 改为 `amd64`：

```bash
git clone https://github.com/Reign9201/mihome-mac.git
cd mihome-mac
ARCH=arm64
curl -L -o /tmp/go2rtc.zip \
  "https://github.com/AlexxIT/go2rtc/releases/download/v1.9.15/go2rtc_mac_${ARCH}.zip"
unzip -o /tmp/go2rtc.zip -d helpers/go2rtc
chmod +x helpers/go2rtc/go2rtc
```

从源码运行：

```bash
cd desktop/src-tauri
cargo run
```

首次启动时，应用会请求二维码，使用米家 App 扫码即可进入设备列表。

构建 DMG：

```bash
npm --prefix desktop ci
npm --prefix desktop run build
```

构建产物位于 `desktop/src-tauri/target/release/bundle/`。本地构建默认未签名、未公证。

## 项目结构

```text
mihome-mac/
├── core/                         Rust 协议层：登录、签名、设备、场景、摄像头
├── desktop/
│   ├── ui/                       桌面界面，纯 HTML/CSS/JavaScript
│   └── src-tauri/                Tauri 2 壳与 IPC 命令
├── prototype/                    可离线运行的交互原型
├── helpers/go2rtc/               go2rtc 接入说明与 MIT 许可证
├── benchmarks/                   协议解析与设备网格性能基准
├── docs/                         产品、架构、摄像头与实现文档
├── LICENSE                       GPL-3.0 许可证
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
cargo test --manifest-path core/Cargo.toml
cargo check --manifest-path desktop/src-tauri/Cargo.toml
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

## 免责声明

本项目是非官方开源项目，不提供任何担保。使用非官方接口可能导致账号风控、设备状态异常或服务不可用。请遵守小米的服务条款和设备使用说明，并自行保护登录凭据与设备访问权限。

Copyright (C) 2026 XuYanjun and contributors.
