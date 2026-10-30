//! X25519 + HSalsa20 + ChaCha20 primitives for Xiaomi's MISS session.
//!
//! MISS follows NaCl's `crypto_box_beforenm`: the X25519 result is fed through
//! HSalsa20 with a 16-byte zero nonce. Used directly, X25519 output produces a key
//! that fails silently when media is decrypted.

use anyhow::{anyhow, Result};
use chacha20::cipher::{KeyIvInit, StreamCipher};
use chacha20::ChaCha20;
use rand::rngs::OsRng;
use x25519_dalek::{PublicKey, StaticSecret};

const SIGMA: [u32; 4] = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

pub struct KeyPair {
    pub public_hex: String,
    pub private: [u8; 32],
}

impl KeyPair {
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        Self {
            public_hex: hex::encode(public.as_bytes()),
            private: secret.to_bytes(),
        }
    }

    pub fn shared_secret(&self, peer_public_hex: &str) -> Result<[u8; 32]> {
        let bytes =
            hex::decode(peer_public_hex.trim()).map_err(|_| anyhow!("摄像头公钥不是合法 hex"))?;
        if bytes.len() != 32 {
            return Err(anyhow!("摄像头公钥应为 32 字节，实际 {}", bytes.len()));
        }
        let mut peer = [0u8; 32];
        peer.copy_from_slice(&bytes);
        let secret = StaticSecret::from(self.private);
        let shared = secret.diffie_hellman(&PublicKey::from(peer));
        Ok(*shared.as_bytes())
    }

    pub fn session_key(&self, peer_public_hex: &str) -> Result<[u8; 32]> {
        let shared = self.shared_secret(peer_public_hex)?;
        Ok(hsalsa20_core(&shared, &[0u8; 16]))
    }
}

/// ChaCha20 decryption with MISS's 8-byte nonce prefix.
pub fn decrypt(key: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>> {
    if payload.len() < 8 {
        return Err(anyhow!("MISS 负载不足 8 字节"));
    }
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&payload[..8]);
    let mut data = payload[8..].to_vec();
    let mut cipher = ChaCha20::new(key.into(), &nonce.into());
    cipher.apply_keystream(&mut data);
    Ok(data)
}

/// ChaCha20 encryption with a random 8-byte nonce prefix.
pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    use rand::RngCore;
    let mut tail = [0u8; 8];
    OsRng.fill_bytes(&mut tail);
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&tail);
    let mut data = plaintext.to_vec();
    let mut cipher = ChaCha20::new(key.into(), &nonce.into());
    cipher.apply_keystream(&mut data);
    let mut out = Vec::with_capacity(8 + data.len());
    out.extend_from_slice(&tail);
    out.extend_from_slice(&data);
    out
}

/// HSalsa20 core: Salsa20 without feed-forward, returning words 0,5,10,15,6,7,8,9.
pub fn hsalsa20_core(key: &[u8; 32], input: &[u8; 16]) -> [u8; 32] {
    let mut x = [0u32; 16];
    x[0] = SIGMA[0];
    x[5] = SIGMA[1];
    x[10] = SIGMA[2];
    x[15] = SIGMA[3];
    x[1] = le32(key, 0);
    x[2] = le32(key, 4);
    x[3] = le32(key, 8);
    x[4] = le32(key, 12);
    x[11] = le32(key, 16);
    x[12] = le32(key, 20);
    x[13] = le32(key, 24);
    x[14] = le32(key, 28);
    x[6] = le32(input, 0);
    x[7] = le32(input, 4);
    x[8] = le32(input, 8);
    x[9] = le32(input, 12);

    for _ in 0..10 {
        x[4] ^= x[0].wrapping_add(x[12]).rotate_left(7);
        x[8] ^= x[4].wrapping_add(x[0]).rotate_left(9);
        x[12] ^= x[8].wrapping_add(x[4]).rotate_left(13);
        x[0] ^= x[12].wrapping_add(x[8]).rotate_left(18);

        x[9] ^= x[5].wrapping_add(x[1]).rotate_left(7);
        x[13] ^= x[9].wrapping_add(x[5]).rotate_left(9);
        x[1] ^= x[13].wrapping_add(x[9]).rotate_left(13);
        x[5] ^= x[1].wrapping_add(x[13]).rotate_left(18);

        x[14] ^= x[10].wrapping_add(x[6]).rotate_left(7);
        x[2] ^= x[14].wrapping_add(x[10]).rotate_left(9);
        x[6] ^= x[2].wrapping_add(x[14]).rotate_left(13);
        x[10] ^= x[6].wrapping_add(x[2]).rotate_left(18);

        x[3] ^= x[15].wrapping_add(x[11]).rotate_left(7);
        x[7] ^= x[3].wrapping_add(x[15]).rotate_left(9);
        x[11] ^= x[7].wrapping_add(x[3]).rotate_left(13);
        x[15] ^= x[11].wrapping_add(x[7]).rotate_left(18);

        x[1] ^= x[0].wrapping_add(x[3]).rotate_left(7);
        x[2] ^= x[1].wrapping_add(x[0]).rotate_left(9);
        x[3] ^= x[2].wrapping_add(x[1]).rotate_left(13);
        x[0] ^= x[3].wrapping_add(x[2]).rotate_left(18);

        x[6] ^= x[5].wrapping_add(x[4]).rotate_left(7);
        x[7] ^= x[6].wrapping_add(x[5]).rotate_left(9);
        x[4] ^= x[7].wrapping_add(x[6]).rotate_left(13);
        x[5] ^= x[4].wrapping_add(x[7]).rotate_left(18);

        x[11] ^= x[10].wrapping_add(x[9]).rotate_left(7);
        x[8] ^= x[11].wrapping_add(x[10]).rotate_left(9);
        x[9] ^= x[8].wrapping_add(x[11]).rotate_left(13);
        x[10] ^= x[9].wrapping_add(x[8]).rotate_left(18);

        x[12] ^= x[15].wrapping_add(x[14]).rotate_left(7);
        x[13] ^= x[12].wrapping_add(x[15]).rotate_left(9);
        x[14] ^= x[13].wrapping_add(x[12]).rotate_left(13);
        x[15] ^= x[14].wrapping_add(x[13]).rotate_left(18);
    }

    let mut out = [0u8; 32];
    for (i, word) in [x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]]
        .into_iter()
        .enumerate()
    {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    out
}

fn le32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsalsa20_matches_nacl_vector() {
        let shared =
            hex::decode("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
                .unwrap();
        let mut key = [0u8; 32];
        key.copy_from_slice(&shared);
        assert_eq!(
            hex::encode(hsalsa20_core(&key, &[0u8; 16])),
            "1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389"
        );
    }

    #[test]
    fn session_key_matches_nacl_beforenm() {
        let pair = KeyPair {
            public_hex: String::new(),
            private: hex::decode(
                "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
            )
            .unwrap()
            .try_into()
            .unwrap(),
        };
        let key = pair
            .session_key("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
            .unwrap();
        assert_eq!(
            hex::encode(key),
            "1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389"
        );
    }

    #[test]
    fn chacha_round_trip() {
        let key = [7u8; 32];
        let plaintext = b"{\"videoquality\":2,\"enableaudio\":1}";
        let encrypted = encrypt(&key, plaintext);
        assert_eq!(encrypted.len(), plaintext.len() + 8);
        assert_eq!(decrypt(&key, &encrypted).unwrap(), plaintext);
    }
}
