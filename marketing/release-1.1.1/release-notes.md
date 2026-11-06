## MiHome Mac 1.1.1

1.1.1 把摄像头所需的转码器直接放入安装包。普通用户不再需要安装
Homebrew、系统 FFmpeg 或额外 helper，扫码登录后即可使用已有功能。

### 更新内容

- arm64 与 x64 安装包分别内置对应架构的 go2rtc 和 FFmpeg 8.1.3。
- FFmpeg 使用最小静态构建，只保留 H.264/HEVC/Opus 解码，
  x264/VideoToolbox/Opus/PCM A-law 编码，RTSP/SDP 和摄像头链路使用的滤镜。
- 运行时优先使用应用包内的 FFmpeg；`MIHOME_FFMPEG` 仍可用于开发调试覆盖。
- 随包提供 FFmpeg、x264、Opus 和 go2rtc 的许可证与第三方声明。

### 验证结果

- UI 回归连续 10 轮：3952 项检查、620 张截图，0 failure、0 runtime error。
- x64 DMG 在 Intel macOS 15.7.9 上完成 10/10 轮全新隔离安装：版本、
  扫码二维码、内置 FFmpeg 编码器、RTSP muxer、系统库依赖、日志和退出清理
  全部通过。
- arm64 DMG 在 GitHub Actions 原生 arm64 macOS 26.6.2 runner 上完成
  10/10 轮同样的隔离安装回归：
  [运行记录 42211577756](https://github.com/Reign9201/mihome-mac/actions/runs/42211577756)。
- Rust core 75/75、桌面测试 38/38、静态检查和 npm audit 全部通过。

### 下载

- `MiHome-Mac-1.1.1-arm64.dmg` - Apple Silicon
- `MiHome-Mac-1.1.1-x64.dmg` - Intel
- 每个 DMG 都附带同名 `.sha256` 文件。

安装包使用 ad-hoc 签名，未经过 Apple 公证。首次打开如被 Gatekeeper 拦截，
请在访达中右键应用并选择“打开”。

完整测试范围和校验值见
[1.1.1 发布记录](https://github.com/Reign9201/mihome-mac/blob/main/docs/11-release-1.1.1.md)。

### 已知边界

- 摄像头首帧、延迟和稳定性仍受局域网、固件、relay 和网络质量影响。
- 隔离安装验证覆盖启动、扫码二维码和内置转码器完整性；真实账号、真实摄像头
  和全部设备型号兼容性仍需在更多环境中持续验证。
