use mihome_core::auth::Session;
use mihome_core::MiCloud;
use serde_json::json;
use std::time::Instant;

fn p95(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let i = ((v.len() as f64 * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(v.len() - 1);
    v[i]
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let session = Session::restore()?.ok_or_else(|| anyhow::anyhow!("没有登录会话"))?;
    let cloud = MiCloud::new(session);
    let homes = cloud.homes().await?;
    let devices = cloud.devices(Some(&homes[0].id)).await?;
    let lamp = devices
        .iter()
        .find(|d| d.name.contains("台灯"))
        .or_else(|| devices.iter().find(|d| d.model.contains("light")))
        .ok_or_else(|| anyhow::anyhow!("没有灯"))?;
    println!("DEVICE {} {} {}", lamp.name, lamp.did, lamp.model);
    let mut set_ms = Vec::new();
    for i in 0..12 {
        let value = json!(i % 2 == 0);
        let t = Instant::now();
        cloud.set_prop(&lamp.did, 2, 1, value).await?;
        set_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let mut get_ms = Vec::new();
    for _ in 0..12 {
        let t = Instant::now();
        cloud.get_prop(&lamp.did, 2, 1).await?;
        get_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    println!(
        "SET p50={:.0}ms p95={:.0}ms max={:.0}ms",
        {
            let mut v = set_ms.clone();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v[v.len() / 2]
        },
        p95(set_ms.clone()),
        set_ms.iter().cloned().fold(0.0, f64::max)
    );
    println!(
        "GET p50={:.0}ms p95={:.0}ms max={:.0}ms",
        {
            let mut v = get_ms.clone();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v[v.len() / 2]
        },
        p95(get_ms.clone()),
        get_ms.iter().cloned().fold(0.0, f64::max)
    );
    Ok(())
}
