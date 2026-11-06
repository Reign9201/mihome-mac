# MiHome Mac 1.1.1 发布与回归记录

状态：发布验证完成。版本号、CHANGELOG、README 下载入口和内置
FFmpeg 构建链路均已更新到 1.1.1。Release 资产来自 tag `v1.1.1` 对应的
构建 [`41940611902`](https://github.com/Reign9201/mihome-mac/actions/runs/41940611902)；
发布后又对 Release 中的两个 DMG 分别执行了 10 轮隔离安装回归。

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

最终 x64 DMG 在 Intel macOS 15.7.9 上完成 10 轮全新隔离安装与启动。每轮均
创建新的临时 `Applications`、`HOME`、`TMPDIR` 和日志目录，并将 `PATH`
限制为 `/usr/bin:/bin`，确认没有借用本机 Homebrew 或额外 FFmpeg：

```text
轮次  启动耗时  退出方式  FFmpeg   架构    动态依赖    日志  残留进程
1     1151 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
2     1153 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
3     1207 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
4     1440 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
5     1166 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
6     1428 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
7     1396 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
8     1436 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
9     1413 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
10    1451 ms  SIGTERM   8.1.3    x86_64  system-only  ok    clean
```

每轮均确认：

- 应用版本为 1.1.1，界面加载并成功申请扫码登录二维码。
- 内置 FFmpeg 报告版本 8.1.3，包含 x264、VideoToolbox、Opus 和 PCMA
  编码器，以及 RTSP muxer。
- FFmpeg 动态依赖只包含 `/usr/lib` 和 `/System/Library` 系统库。
- 日志没有 panic、崩溃、权限拒绝或找不到 FFmpeg。
- 发送 SIGTERM 后主程序正常退出，没有残留子进程。

arm64 DMG 在 GitHub Actions 的原生 arm64 macOS 26.6.2 runner 上完成同样
的 10 轮全新隔离安装与启动回归。运行记录：
[`42211577756`](https://github.com/Reign9201/mihome-mac/actions/runs/42211577756)。

```text
轮次  启动耗时  退出方式  FFmpeg   架构    动态依赖    日志  残留进程
1     6029 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
2     5435 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
3     5390 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
4     5420 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
5     5095 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
6     4732 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
7     4998 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
8     4808 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
9     5096 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
10    4341 ms  SIGTERM   8.1.3    arm64   system-only  ok    clean
```

两个架构均通过 `scripts/verify-macos-bundle.sh`，应用包使用有效的 ad-hoc
签名。回归证据保存在 `dist/macos-regression/`，包括每轮 `result.json`、
汇总表、包体校验日志和 DMG SHA256。

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
- 摄像头首帧、延迟和稳定性仍受局域网、固件、relay 与网络质量影响。
- 两架构隔离安装回归验证启动、登录二维码和内置转码器完整性，不等同于
  真实账号登录、真实摄像头播放和全部设备型号兼容性；摄像头链路仍需在更多
  型号与网络环境中持续建立兼容性清单。
