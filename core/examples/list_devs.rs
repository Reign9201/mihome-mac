use mihome_core::auth::Session;
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let Some(session) = Session::restore().expect("session") else {
        return;
    };
    let v = session
        .request(
            "/home/device_list",
            serde_json::json!({"params":{"home_id":0,"start_did":"","limit":200}}),
        )
        .await
        .expect("list");
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
}
