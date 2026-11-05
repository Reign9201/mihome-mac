# MiHome Mac 1.1.1 发布与回归记录

状态：发布验证完成。版本号、CHANGELOG、README 下载入口和内置
FFmpeg 构建链路均已更新到 1.1.1，最终安装包来自 tag 构建
`41940611902`。

## 发布范围

- 随 arm64 与 x64 安装包内置对应架构的最小静态 FFmpeg，普通用户不需要
  Homebrew、系统 PATH 或额外下载即可使用摄像头转码。
- 运行时优先查找应用包内的 `Contents/MacOS/ffmpeg`，其次才检查开发目录、
  Homebrew 和 PATH；`MIHOME_FFMPEG` 可显式覆盖查找结果。
- FFmpeg 仅启用摄像头链路实际使用的 H.264/HEVC/Opus 解码、
  x264/VideoToolbox/Opus/PCM A-law 编码、RTSP/SDP 与
  scale/fps/aresample/format。
- 安装包同时携带 FFmpeg、x264 和 Opus 的许可证文件；构建输入和产物固定
  SHA256，源码版本与构建方法记录在 `helpers/ffmpeg/`。

## 源码验证

执行日期：2026-11-05。

```text
npm run check                 通过
npm test                      38/38 通过
npm audit --audit-level=high  0 vulnerabilities
cargo fmt (core)              通过
cargo clippy (core)           通过
cargo test (core)             75/75 通过
cargo fmt (desktop)           通过
cargo clippy (desktop)        通过
shell syntax                  通过
FFmpeg arm64/x64              SHA256 校验通过
UI_REGRESSION_ROUNDS=10       通过
```

10 轮 UI 回归结果：

```json
{
  "rounds": 10,
  "checks": 3952,
  "screenshots": 620,
  "maxInteractionMs": 33.5,
  "domNodes": 1088,
  "heapMB": 3.82,
  "runtimeErrors": [],
  "failures": []
}
```

截图位于 `desktop/tests/artifacts/`。该回归使用离线 Mock 数据，只验证界面、
交互、布局和状态流，不代表真实账号设备。

## 安装包验证

最终 x64 DMG 在 Intel macOS 上完成 10 轮全新隔离安装与启动。每轮均创建新的
临时 `Applications`、`HOME`、`TMPDIR` 和日志目录，并将 `PATH` 限制为
`/usr/bin:/bin`，确认没有借用本机 Homebrew 或额外 FFmpeg：

```text
轮次  启动耗时  退出方式  FFmpeg   架构    动态依赖    日志  残留进程
1     3507 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
2     3164 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
3     3473 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
4     3187 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
5     3499 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
6     3485 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
7     3485 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
8     3492 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
9     3198 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
10    3158 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
```

每轮均确认：

- 应用版本为 1.1.1，界面加载并成功申请扫码登录二维码。
- 内置 FFmpeg 报告版本 8.1.3，包含 x264、VideoToolbox、Opus 和 PCMA
  编码器，以及 RTSP muxer。
- FFmpeg 动态依赖只包含 `/usr/lib` 和 `/System/Library` 系统库。
- 日志没有 panic、崩溃、权限拒绝或找不到 FFmpeg。
- 发送 SIGTERM 后主程序正常退出，没有残留子进程。

arm64 DMG 因当前测试主机为 Intel，未做实际执行；已完成 `lipo` 架构、
Mach-O 动态依赖、签名、包体资源、许可证和 SHA256 静态校验。x64 与 arm64
均通过 `scripts/verify-macos-bundle.sh`，应用包使用有效的 ad-hoc 签名。

## 发布包

| 产物 | 大小（bytes） | SHA256 |
|---|---:|---|
| `MiHome-Mac-1.1.1-arm64.dmg` | 10,363,638 | `eb07a44164dbf2210fef61b9e7697335a0bc35f6e5f926cd4b0b0413bbb1851f` |
| `MiHome-Mac-1.1.1-x64.dmg` | 12,419,834 | `60442d5065993af8eec0bc36ef20316db36074feaebefa62b53d0ffc933cab08` |

GitHub Release 发布 arm64 与 x64 两个独立安装包，并提供对应 `.sha256`
文件。两个文件均来自 tag `v1.1.1` 对应的 GitHub Actions 构建。

## 已知边界

- 发布包使用 ad-hoc 签名，没有 Developer ID 和 Apple 公证；首次打开仍可能
  需要按 README 的 Gatekeeper 步骤操作。
- 当前测试主机为 Intel，arm64 安装包没有在本机实际执行；发布前已通过架构、
  依赖、资源和签名静态校验。
- 摄像头首帧、延迟和稳定性仍受局域网、固件、relay 与网络质量影响。
- 隔离安装回归验证启动、登录二维码和内置转码器完整性；真实摄像头链路沿用
  1.1.0 的设备验证结果，仍需在更多型号和网络环境中持续建立兼容性清单。
