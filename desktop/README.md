# MiHome Mac Desktop

macOS 桌面端：Tauri 2 壳加载 `desktop/ui/`，Rust 侧通过 `core/` 提供扫码登录、家庭与设备列表、属性读写、场景执行、定时自动化和摄像头取流。

## 运行

```bash
cd desktop/src-tauri
cargo run
```

需要 Rust 1.90 以上与 Xcode Command Line Tools。首次启动会向小米申请二维码，用米家 App 扫码后进入设备列表。完整的环境准备、go2rtc 配置与打包步骤见根目录 [README](../README.md)。

## 目录

```text
core/                 Rust 协议层
desktop/ui/           M1 实机界面（无构建步骤）
desktop/src-tauri/    Tauri 2 壳与 IPC 命令
desktop/package.json  @tauri-apps/cli（打包用）
```

## 当前状态

- 已验证：扫码登录、家庭与设备读取、常用属性读写、手动场景、本地与远程摄像头取流。
- 摄像头：局域网通道需要 go2rtc 且与摄像头同网；远程通道以 CS2 机型为主。
- 待完善：菜单栏常驻、Keychain 持久化、更多设备型号适配。
