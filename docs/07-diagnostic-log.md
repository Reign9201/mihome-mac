# 诊断日志

日期：2026-10-31

## 目标

系统统一日志会随进程退出、应用重装或用户清空控制台而丢失。`core/src/logging.rs` 因此独立维护一份应用日志，设计边界参考 Montage 的 `library/log`，但按 Rust 和 Tauri 重写，不依赖 Android 或 Tauri 类型。

## 默认行为

- 目录：`~/Library/Logs/MiHome/`
- 运行日志：`log-YYYY-MM-DD.log`
- 单文件：2 MB；当天写满后继续写 `-1`、`-2`、`-3`
- 保留：7 天，日志目录总量上限 12 MB
- 崩溃：崩溃线程同步写入 `crash-<时间>.txt`，最多保留 10 份
- 权限：目录 `0700`，文件 `0600`
- 写入：后台单线程、有界队列；队列写满时计数并丢弃，不影响主流程

所有日志先经过脱敏，再写文件和镜像到终端。`xiaomi://` 地址、token、Cookie、Authorization、签名、公私钥和 `V1:` 令牌不会进入诊断文件。

## 复用

模块只需要 Rust 标准库、`anyhow` 和 `chrono`，不依赖 Tauri：

```rust
use mihome_core::logging;

logging::install_default()?;
logging::info("Camera", "开始本地取流");
logging::warn("Camera", "首帧等待超过 8 秒");
logging::error("Auth", "凭据恢复失败");
```

导出由桌面壳调用：

```rust
let path = logging::export_diagnostics("MiHome Mac", env!("CARGO_PKG_VERSION"))?;
```

导出文件包含应用版本、系统架构、崩溃记录和最近的运行日志。默认写入 `~/Downloads/`，不会自动上送到任何服务器。

## 启用详细日志

默认级别是 `info`。从终端启动时设置：

```bash
MIHOME_LOG_LEVEL=debug npm --prefix desktop run dev
```

可选级别：`debug`、`info`、`warn`、`error`。启动日志会记录实际使用的目录和级别。

## 前端日志

`desktop/ui/diagnostics.js` 捕获脚本异常、未处理的 Promise 拒绝和显式业务事件，通过 `log_frontend` 命令交给同一个写入器。摄像头页面会记录：

- 本地/远程启动和停止
- go2rtc 与 ffmpeg 子进程状态
- 首帧、8 秒/25 秒超时和停滞重连
- 设备设置读取/写入失败

不会记录完整设备响应、登录凭据、Cookie、完整签名 URL 或媒体内容。

## 排查顺序

1. 在应用右上角点击“诊断日志”。
2. 查看导出文件开头的版本、时间和日志级别。
3. 本地摄像头失败时，先搜 `Camera`、`go2rtc` 和 “没有首帧”。
4. 远程摄像头失败时，再搜 `MISS`、`Relay`、`ffmpeg`、`RTSP` 和 `go2rtc`。
5. 崩溃后查看导出文件中的 `crash-*` 段，或直接查看 `~/Library/Logs/MiHome/crash-*.txt`。

若问题出现在启动阶段，可用 `MIHOME_LOG_LEVEL=debug` 从终端启动，终端会同步显示每条已脱敏日志。
