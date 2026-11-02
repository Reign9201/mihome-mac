# Changelog

## 1.0.0 - 2026-11-03

首个 GitHub Release 版本。

- 提供 Apple Silicon（arm64）和 Intel（x64）两个独立 DMG
- 内置对应架构的 go2rtc，本地和远程摄像头无需单独安装 helper
- 支持米家扫码登录、家庭与设备管理、设备控制、场景和本地定时自动化
- 支持摄像头 WebRTC 播放、声音独立开关、监控宫格、云台控制和兼容回退
- 提供脱敏诊断日志导出
- 使用 GPL-3.0-or-later 开源，并随安装包分发许可证与第三方声明

发布包当前使用 ad-hoc 签名，未使用 Developer ID 证书，也未经过 Apple 公证。首次打开如被 Gatekeeper 拦截，请在访达中右键应用并选择“打开”。
