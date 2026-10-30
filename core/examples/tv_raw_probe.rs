#[tokio::main(flavor = "current_thread")]
async fn main() {
    let Some(session) = mihome_core::auth::Session::restore().expect("session") else { eprintln!("no session"); return; };
    let v = session.request("/home/device_list", serde_json::json!({
        "params": {"home_id": 0, "start_did": "", "limit": 200}
    })).await.expect("device list");
    // Print every raw TV-ish item with all fields
    let text = serde_json::to_string_pretty(&v).unwrap();
    for chunk in text.split("},{") {
        if chunk.contains("mitv") { println!("{{{}\n}}", chunk); }
    }
}
