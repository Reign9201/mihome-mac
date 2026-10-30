#[tokio::main(flavor = "current_thread")]
async fn main() {
    let Some(session) = mihome_core::auth::Session::restore().expect("session") else { eprintln!("no session"); return; };
    let did = "mitv.bbcb5425dd534ae38f388aeb4dbe9baa:2553049e381b42f3bd366a9ae9113bf8";
    let variants = [
        ("no-in", serde_json::json!({"params":[{"did":did,"siid":2,"aiid":1}]})),
        ("value-empty", serde_json::json!({"params":[{"did":did,"siid":2,"aiid":1,"value":[]}]})),
        ("in-empty", serde_json::json!({"params":[{"did":did,"siid":2,"aiid":1,"in":[]}]})),
    ];
    for (name, payload) in variants {
        match session.request("/miotspec/action", payload).await {
            Ok(v) => println!("{name}: OK {v:?}"),
            Err(e) => println!("{name}: ERR {e}"),
        }
    }
}
