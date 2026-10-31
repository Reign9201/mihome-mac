# MiHome Mac Desktop

macOS 桌面端：Tauri 2 壳加载 `desktop/ui/`，Rust 侧通过 `core/` 提供扫码登录、家庭与设备列表、属性读写、场景执行、定时自动化和摄像头取流。

## 运行

```bash
npm --prefix desktop ci
npm --prefix desktop run dev
```

需要 Node.js、Rust 1.90 以上与 Xcode Command Line Tools。界面通过官方 `@tauri-apps/api` 的本地桥接调用 IPC，不启用 Tauri 全局 API。首次启动会向小米申请二维码，用米家 App 扫码后进入设备列表。完整的环境准备、go2rtc 配置与打包步骤见根目录 [README](../README.md)。

## 目录

```text
core/                 Rust 协议层
desktop/ui/           静态界面与生成的 Tauri API 桥
desktop/src-tauri/    Tauri 2 壳与 IPC 命令
desktop/package.json  @tauri-apps/cli（打包用）
```

## 当前状态

- 已实现：扫码登录、Keychain 凭据保存、家庭与设备读取、MIoT-Spec 属性控制、手动场景、本地与远程摄像头取流。
- 已通过自动化验证：Rust 单元测试、Clippy、前端静态检查、前端测试、依赖审计，以及基于 Mock Tauri API 的界面回归。
- 尚未完成真实环境验证：小米账号登录、真实设备控制，以及局域网/跨网段摄像头兼容性矩阵。
- 摄像头：局域网通道需要 go2rtc 且与摄像头同网；远程通道以 CS2 机型为主。
- 待完善：菜单栏常驻、更多设备型号与摄像头固件适配。

## 检查

```bash
npm run check
npm test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```
