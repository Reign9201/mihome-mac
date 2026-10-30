use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use md5::{Digest, Md5};
use serde::Deserialize;
use serde_json::Value;
use std::time::Instant;

type Enc = cbc::Encryptor<Aes128>;
type Dec = cbc::Decryptor<Aes128>;

#[derive(Deserialize)]
struct Payload { homes: Vec<Home> }
#[derive(Deserialize)]
struct Home { devices: Vec<Device> }
#[derive(Deserialize)]
struct Device {
    #[allow(dead_code)] did: String,
    #[allow(dead_code)] name: String,
    #[allow(dead_code)] model: String,
    #[serde(rename = "spec_type")] #[allow(dead_code)] spec_type: String,
    #[serde(rename = "isOnline")] #[allow(dead_code)] is_online: bool,
    #[allow(dead_code)] props: Vec<Prop>,
}
#[derive(Deserialize)]
struct Prop {
    #[allow(dead_code)] iid: i64,
    #[allow(dead_code)] siid: i64,
    #[allow(dead_code)] piid: i64,
    #[allow(dead_code)] value: Value,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("json");
    let path = args.get(2).cloned().unwrap_or("data/home.json".into());
    let iterations: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(30);
    let data = std::fs::read(&path).unwrap();

    match mode {
        "noop" => println!("ok"),
        "startup" | "json" => {
            let loops = if mode == "startup" { 1 } else { iterations };
            let start = Instant::now();
            let mut checksum = 0;
            for _ in 0..loops {
                let payload: Payload = serde_json::from_slice(&data).unwrap();
                checksum = payload.homes.iter().map(|h| h.devices.len()).sum();
            }
            let elapsed = start.elapsed().as_nanos() as u64 / loops as u64;
            println!("devices={} iter={} ns_per_iter={}", checksum, loops, elapsed);
        }
        "crypto" => {
            let token = b"0123456789abcdef0123456789abcdef";
            let key: [u8; 16] = Md5::digest(token).into();
            let mut h = Md5::new();
            h.update(key);
            h.update(token);
            let iv: [u8; 16] = h.finalize().into();
            let plain = vec![0x41u8; 1024];
            let enc = Enc::new(&key.into(), &iv.into()).encrypt_padded_vec_mut::<Pkcs7>(&plain);
            let start = Instant::now();
            let mut total = 0usize;
            for _ in 0..iterations {
                let dec = Dec::new(&key.into(), &iv.into());
                let out = dec.decrypt_padded_vec_mut::<Pkcs7>(&enc).unwrap();
                total += out.len();
            }
            let ns = start.elapsed().as_nanos() as u64 / iterations as u64;
            println!("plain={} iter={} ns_per_iter={}", total / iterations, iterations, ns);
        }
        _ => println!("unknown mode"),
    }
}
