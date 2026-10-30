use mihome_core::auth::Session;
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let Some(session) = Session::restore().expect("session") else { return; };
    let did = "936988263";
    for (siid,aiid,params,label) in [
        (7u32,1u32,serde_json::json!([]),"wake_up"),
        (7,3,serde_json::json!(["测试"]),"play_text"),
        (7,4,serde_json::json!(["打开徐君临的电视", true]),"execute_text_directive"),
        (7,5,serde_json::json!([]),"play_music"),
    ] {
        let r = session.request("/miotspec/action", serde_json::json!({"params":[{"did":did,"siid":siid,"aiid":aiid,"in":params}]})).await;
        println!("{label}: {:?}", r);
    }
}
