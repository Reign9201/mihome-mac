#[tokio::main(flavor = "current_thread")]
async fn main() {
    let Some(session) = mihome_core::auth::Session::restore().expect("session") else {
        eprintln!("no session");
        return;
    };
    let cloud = mihome_core::cloud::MiCloud::new(session);
    let did = "mitv.bbcb5425dd534ae38f388aeb4dbe9baa:2553049e381b42f3bd366a9ae9113bf8";
    let devices = cloud.devices(None).await.expect("devices");
    for d in devices.iter().filter(|d| d.model.contains("tv")) {
        println!("online={} name={} model={}", d.online, d.name, d.model);
    }
    for (siid, aiid) in [(2u32, 1u32), (6, 1)] {
        match cloud
            .call_action(did, siid, aiid, serde_json::json!([]))
            .await
        {
            Ok(v) => println!("action {siid}/{aiid} ok {v:?}"),
            Err(e) => println!("action {siid}/{aiid} err {e}"),
        }
    }
}
