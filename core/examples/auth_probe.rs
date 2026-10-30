#[tokio::main(flavor = "current_thread")]
async fn main() {
    match mihome_core::auth::start_login().await {
        Ok((_pending, start)) => {
            println!("qr_svg_bytes={} expires_in={}", start.qr_svg.len(), start.expires_in);
            println!("svg_head={}", &start.qr_svg[..start.qr_svg.len().min(80)]);
        }
        Err(error) => {
            eprintln!("auth_start_failed: {error}");
            std::process::exit(1);
        }
    }
}
