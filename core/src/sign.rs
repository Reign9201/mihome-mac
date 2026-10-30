use base64::{engine::general_purpose::STANDARD as B64, Engine};
use flate2::read::GzDecoder;
use rand::RngCore;
use rc4::{consts::U32, KeyInit, Rc4, StreamCipher};
use sha1::{Digest as Sha1Digest, Sha1};
use sha2::Sha256;
use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};

/// 小米云请求的 RC4 签名参数。顺序必须保持插入顺序。
pub fn generate_enc_params(
    uri: &str,
    method: &str,
    signed_nonce: &str,
    nonce: &str,
    data_json: &str,
    ssecurity: &str,
) -> Vec<(String, String)> {
    let mut params = vec![("data".to_string(), data_json.to_string())];
    let rc4_hash = enc_signature(method, uri, signed_nonce, &params);
    params.push(("rc4_hash__".to_string(), rc4_hash));
    let key = B64.decode(signed_nonce).expect("signed_nonce 必须是 base64");
    let mut out = Vec::with_capacity(params.len());
    for (k, v) in params {
        out.push((k, encrypt_rc4(&key, &v)));
    }
    let signature = enc_signature(method, uri, signed_nonce, &out);
    out.push(("signature".to_string(), signature));
    out.push(("ssecurity".to_string(), ssecurity.to_string()));
    out.push(("_nonce".to_string(), nonce.to_string()));
    out
}

pub fn gen_nonce() -> String {
    let mut random = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut random);
    let minutes = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 60)
        .unwrap_or(0);
    let mut raw = random.to_vec();
    let bytes = minutes.to_be_bytes();
    let start = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len() - 1);
    raw.extend_from_slice(&bytes[start..]);
    B64.encode(raw)
}

pub fn signed_nonce(ssecurity: &str, nonce: &str) -> String {
    let key = B64.decode(ssecurity).expect("ssecurity 必须是 base64");
    let nonce = B64.decode(nonce).expect("nonce 必须是 base64");
    let mut hasher = Sha256::new();
    hasher.update(&key);
    hasher.update(&nonce);
    B64.encode(hasher.finalize())
}

pub fn enc_signature(method: &str, uri: &str, signed_nonce: &str, params: &[(String, String)]) -> String {
    let mut parts = vec![method.to_ascii_uppercase(), uri.to_string()];
    for (k, v) in params {
        parts.push(format!("{k}={v}"));
    }
    parts.push(signed_nonce.to_string());
    let mut hasher = Sha1::new();
    hasher.update(parts.join("&").as_bytes());
    B64.encode(hasher.finalize())
}

pub fn encrypt_rc4(key: &[u8], value: &str) -> String {
    let mut rc4 = Rc4::<U32>::new_from_slice(key).expect("RC4 key");
    let mut skip = [0u8; 1024];
    rc4.apply_keystream(&mut skip);
    let mut buf = value.as_bytes().to_vec();
    rc4.apply_keystream(&mut buf);
    B64.encode(buf)
}

pub fn decrypt_rc4(key: &[u8], value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    let mut rc4 = Rc4::<U32>::new_from_slice(key).expect("RC4 key");
    let mut skip = [0u8; 1024];
    rc4.apply_keystream(&mut skip);
    let mut buf = B64.decode(value)?;
    rc4.apply_keystream(&mut buf);
    Ok(buf)
}

pub fn decode_response(signed_nonce: &str, body: &str) -> Result<String, String> {
    if let Ok(text) = serde_json::from_str::<serde_json::Value>(body) {
        return Ok(text.to_string());
    }
    let key = B64.decode(signed_nonce).map_err(|e| e.to_string())?;
    let raw = decrypt_rc4(&key, body).map_err(|e| e.to_string())?;
    if let Ok(text) = String::from_utf8(raw.clone()) {
        if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
            return Ok(text);
        }
    }
    let mut decoder = GzDecoder::new(raw.as_slice());
    let mut text = String::new();
    decoder.read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(text)
}

pub fn strip_prefix(text: &str) -> &str {
    text.strip_prefix("&&&START&&&").unwrap_or(text)
}

pub fn parse_json(text: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(strip_prefix(text)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_is_base64() {
        let nonce = gen_nonce();
        assert!(B64.decode(nonce).is_ok());
    }

    #[test]
    fn signature_is_stable() {
        let params = vec![("data".to_string(), "{}".to_string())];
        let a = enc_signature("POST", "/x", "sn", &params);
        let b = enc_signature("POST", "/x", "sn", &params);
        assert_eq!(a, b);
    }

    #[test]
    fn matches_python_reference_vector() {
        let ssecurity = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
        let nonce = "Zml4ZWRub25jZTEyMzQ1Ng==";
        let signed = signed_nonce(ssecurity, nonce);
        assert_eq!(signed, "1CChgeupVD4TiArwSDX51cRV7RVY9bWuFk6PNco01Sc=");
        let params = generate_enc_params("/miotspec/prop/get", "POST", &signed, nonce, "{\"x\":1}", ssecurity);
        let got: Vec<(String, String)> = params.into_iter().collect();
        assert_eq!(got[0], ("data".into(), "9KU52is21g==".into()));
        assert_eq!(got[1], ("rc4_hash__".into(), "9tUMsT5f75JRXrDofVBryrCuqioWeyBYPpzGzg==".into()));
        assert_eq!(got[2].0, "signature");
        assert_eq!(got[2].1, "fRXqDc86/9IqUd6/qW4VViW4bu0=");
    }
}
