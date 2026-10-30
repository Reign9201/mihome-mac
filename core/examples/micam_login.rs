//! One-off helper: QR login, write ~/.micam/credentials.json for micam.
use anyhow::{bail, Context, Result};
use mihome_core::auth::{poll_login, start_login_for};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::time::{Duration, Instant};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let (pending, start) = start_login_for("xiaomiio").await.context("start QR login")?;
    fs::write("/tmp/micam-qr.svg", &start.qr_svg).context("write QR")?;
    std::process::Command::new("open")
        .arg("/tmp/micam-qr.svg")
        .status()
        .context("open QR")?;
    println!("二维码已打开，请用米家 App 扫码；有效期 {} 秒", start.expires_in);

    let deadline = Instant::now() + Duration::from_secs(start.expires_in);
    while Instant::now() < deadline {
        if let Some(session) = poll_login(&pending).await.context("poll login")? {
            let home = std::env::var("HOME").context("HOME")?;
            let dir = std::path::Path::new(&home).join(".micam");
            fs::create_dir_all(&dir)?;
            let path = dir.join("credentials.json");
            let body = serde_json::json!({
                "user": session.user_id,
                "region": "cn",
                "deviceId": session.device_id,
                "userId": session.user_id,
                "ssecurity": session.ssecurity,
                "serviceToken": session.service_token,
                "passToken": session.pass_token
            });
            let text = serde_json::to_string_pretty(&body)?;
            let mut file = OpenOptions::new().create(true).truncate(true).write(true).mode(0o600).open(&path)?;
            file.write_all(text.as_bytes())?;
            println!("已写入 {}（user_id={}）", path.display(), session.user_id);
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    bail!("二维码过期，未完成登录")
}
