use mihome_core::auth::Session;
use mihome_core::remote_stream::RemoteStream;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn main() -> anyhow::Result<()> {
    let session = Session::restore()?.ok_or_else(|| anyhow::anyhow!("没有登录会话"))?;
    let cameras = [("039a01", "1053392676", 1u8), ("069a01", "1178828157", 2u8)];
    let (tx, rx) = mpsc::channel();
    for (name, did, quality) in cameras {
        let session = session.clone();
        let tx = tx.clone();
        thread::spawn(move || {
            let start = Instant::now();
            let result = RemoteStream::start(session, did, quality);
            match result {
                Ok(stream) => {
                    let url = stream.url();
                    let _ = tx.send(format!("READY {} {:.2}s {}", name, start.elapsed().as_secs_f64(), url));
                    for i in 0..6 {
                        thread::sleep(Duration::from_secs(10));
                        let _ = tx.send(format!("FRAMES {} #{} {}", name, i + 1, stream.frames()));
                    }
                    let _ = tx.send(format!("DONE {} {}", name, stream.frames()));
                }
                Err(e) => { let _ = tx.send(format!("ERROR {} {:#}", name, e)); }
            }
        });
    }
    drop(tx);
    let deadline = Instant::now() + Duration::from_secs(100);
    for msg in rx {
        println!("{}", msg);
        if Instant::now() > deadline { break; }
    }
    Ok(())
}
