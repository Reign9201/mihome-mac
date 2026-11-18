//! 远程流长时探针：命令行走 RemoteStream，定期打印帧数、空闲时长和健康原因，
//! 并可按指定时刻注入故障，用来验证掉流能被检出。
//!
//! 示例：
//!   cargo run -p mihome-core --example remote_probe -- --did 039a01... --minutes 20
//!   cargo run -p mihome-core --example remote_probe -- --did 039a01... --minutes 8 --fault kill-ffmpeg:120
//!   cargo run -p mihome-core --example remote_probe -- --did 039a01... --minutes 8 --fault freeze-ffmpeg:120 --fault thaw-ffmpeg:180
//!
//! 注入的动作只有两种来源：给 ffmpeg 子进程发信号，或者不动它。原因是
//! `RemoteStream` 不对外暴露媒体线程的暂停开关，冻结 ffmpeg 进程能得到同样的
//! 现场——进程还在、帧不再出来，正是 `FRAME_IDLE_LIMIT` 要覆盖的那种掉流。

use anyhow::{anyhow, Context, Result};
use mihome_core::auth::Session;
use mihome_core::remote_stream::RemoteStream;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

struct Fault {
    kind: String,
    after: Duration,
    fired: bool,
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let did = value(&args, "--did").ok_or_else(|| anyhow!("缺少 --did"))?;
    let minutes: f64 = value(&args, "--minutes")
        .unwrap_or_else(|| "20".to_string())
        .parse()
        .context("--minutes 不是数字")?;
    let quality: u8 = value(&args, "--quality")
        .unwrap_or_else(|| "2".to_string())
        .parse()
        .context("--quality 不是数字")?;
    let audio = value(&args, "--audio").is_some_and(|flag| flag != "0");
    let mut faults = parse_faults(&args)?;

    let session = Session::restore()?.ok_or_else(|| anyhow!("没有已保存的登录 session"))?;
    println!("[probe] 建立远程通道 did={did} quality={quality} audio={audio}");
    let stream = RemoteStream::start(session, &did, quality, audio)?;
    println!("[probe] 播放地址 {}", stream.url());
    println!("[probe] WebRTC 地址 {}", stream.webrtc_url());

    let started = Instant::now();
    let deadline = started + Duration::from_secs_f64(minutes * 60.0);
    let mut last_report = Instant::now();
    let mut max_idle = Duration::ZERO;
    let mut first_reason: Option<(f64, String)> = None;
    let mut last_frames = stream.frames();

    while Instant::now() < deadline {
        for fault in faults.iter_mut() {
            if fault.fired || started.elapsed() < fault.after {
                continue;
            }
            inject(&fault.kind, &stream)?;
            fault.fired = true;
        }

        let frames = stream.frames();
        let idle = stream.idle();
        max_idle = max_idle.max(idle);
        if frames != last_frames {
            last_frames = frames;
        }
        if let Some(reason) = stream.health_reason() {
            if first_reason.is_none() {
                first_reason = Some((started.elapsed().as_secs_f64(), reason));
            }
        }
        if last_report.elapsed() >= Duration::from_secs(2) {
            last_report = Instant::now();
            println!(
                "[probe] t={:>7.1}s frames={:<8} idle={:>5.1}s ffmpeg_alive={} ffmpeg={:?} reason={}",
                started.elapsed().as_secs_f64(),
                frames,
                idle.as_secs_f64(),
                !ffmpeg_pids().is_empty(),
                ffmpeg_pids(),
                stream.health_reason().unwrap_or_else(|| "正常".to_string())
            );
        }
        thread::sleep(Duration::from_millis(500));
    }

    println!(
        "[probe] 结束 总帧数={} 最长空闲={:.1}s 首次检出={}",
        stream.frames(),
        max_idle.as_secs_f64(),
        match &first_reason {
            Some((at, reason)) => format!("t={at:.1}s {reason}"),
            None => "未检出异常".to_string(),
        }
    );
    drop(stream);
    thread::sleep(Duration::from_secs(1));
    println!("[probe] 结束后残留 ffmpeg={:?}", ffmpeg_pids());
    Ok(())
}

fn value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|item| item == key)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

/// `--fault 动作:秒数` 可以给多次，按注入时刻先后执行，互不影响。
fn parse_faults(args: &[String]) -> Result<Vec<Fault>> {
    let mut faults = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        if arg != "--fault" {
            continue;
        }
        let spec = args
            .get(index + 1)
            .ok_or_else(|| anyhow!("--fault 缺少取值"))?;
        let (kind, seconds) = spec
            .split_once(':')
            .ok_or_else(|| anyhow!("--fault 格式应为 动作:秒数，收到 {spec}"))?;
        let seconds: f64 = seconds.parse().context("--fault 秒数不是数字")?;
        if !matches!(kind, "kill-ffmpeg" | "freeze-ffmpeg" | "thaw-ffmpeg") {
            return Err(anyhow!(
                "未知故障动作 {kind}，可用：kill-ffmpeg、freeze-ffmpeg、thaw-ffmpeg"
            ));
        }
        faults.push(Fault {
            kind: kind.to_string(),
            after: Duration::from_secs_f64(seconds),
            fired: false,
        });
    }
    faults.sort_by_key(|fault| fault.after);
    Ok(faults)
}

/// ffmpeg 由当前进程直接拉起，按父进程号就能定位；go2rtc 不叫这个名字，不会误伤。
fn ffmpeg_pids() -> Vec<String> {
    let output = Command::new("pgrep")
        .args(["-P", &std::process::id().to_string(), "ffmpeg"])
        .output();
    match output {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .map(|pid| pid.to_string())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn inject(kind: &str, stream: &RemoteStream) -> Result<()> {
    let signal = match kind {
        "kill-ffmpeg" => "-9",
        "freeze-ffmpeg" => "-STOP",
        "thaw-ffmpeg" => "-CONT",
        other => return Err(anyhow!("未知故障动作 {other}")),
    };
    let pids = ffmpeg_pids();
    if pids.is_empty() {
        return Err(anyhow!("找不到 ffmpeg 子进程"));
    }
    for pid in &pids {
        let status = Command::new("kill")
            .args([signal, pid])
            .status()
            .context("执行 kill 失败")?;
        println!("[probe] 故障注入 {kind}: kill {signal} {pid} -> {status}");
    }
    println!(
        "[probe] 注入后 idle={:.1}s reason={}",
        stream.idle().as_secs_f64(),
        stream.health_reason().unwrap_or_else(|| "正常".to_string())
    );
    Ok(())
}
