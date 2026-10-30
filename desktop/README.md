# MiHome Mac desktop

M1 桌面端：Tauri 2 壳加载 `desktop/ui/`，Rust 侧通过 `core/` 提供扫码登录、家庭列表、设备列表和 MIoT 属性读写。

## 运行

```bash
cd desktop/src-tauri
cargo run
```

需要 Rust 1.90 以上（本机 1.99.1）与 Xcode Command Line Tools。首次启动会向小米申请二维码，用米家 App 扫码后进入设备列表。

## 目录

```text
core/                 Rust 协议层
desktop/ui/           M1 实机界面（无构建步骤）
desktop/src-tauri/    Tauri 2 壳与 IPC 命令
desktop/package.json  @tauri-apps/cli（打包用）
```

## 当前状态

- 已验证：`cargo check`、`cargo test`、Tauri 窗口启动、真实二维码生成与显示。
- 待验证：真实账号扫码后的 token 落地、家庭/设备列表、不同型号的 siid/piid 读写。
- 未实现：Keychain 持久化、局域网直连、摄像头、场景与自动化。
