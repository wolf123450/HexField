//! Session tokens issued by `/auth/verify` and checked by `/ws` and the
//! authenticated REST routes.
//!
//! Format: `base64url(payload) "." base64url(mac)`, where `payload` is the
//! JSON `{"sub": <user_id>, "exp": <unix seconds>}` and `mac` is
//! HMAC-SHA256 over the encoded payload string with the server's session
//! secret. The MAC check is constant-time (`Mac::verify_slice`).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    BadSignature,
    Expired,
}

fn mac_for(secret: &[u8], encoded_payload: &str) -> HmacSha256 {
    // HMAC accepts keys of any length, so this cannot fail.
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(encoded_payload.as_bytes());
    mac
}

/// Issue a token for `user_id` that expires at `expiry` (unix seconds).
pub fn issue(secret: &[u8], user_id: &str, expiry: u64) -> String {
    let claims = Claims { sub: user_id.to_string(), exp: expiry };
    let payload = serde_json::to_vec(&claims).unwrap_or_default();
    let encoded = URL_SAFE_NO_PAD.encode(payload);
    let tag = mac_for(secret, &encoded).finalize().into_bytes();
    format!("{encoded}.{}", URL_SAFE_NO_PAD.encode(tag))
}

/// Verify `token` at time `now` (unix seconds). Returns the user ID.
pub fn verify(secret: &[u8], token: &str, now: u64) -> Result<String, TokenError> {
    let (encoded, tag_b64) = token.split_once('.').ok_or(TokenError::Malformed)?;
    let tag = URL_SAFE_NO_PAD.decode(tag_b64).map_err(|_| TokenError::Malformed)?;
    mac_for(secret, encoded)
        .verify_slice(&tag)
        .map_err(|_| TokenError::BadSignature)?;
    let payload = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| TokenError::Malformed)?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| TokenError::Malformed)?;
    if claims.sub.is_empty() {
        return Err(TokenError::Malformed);
    }
    if now >= claims.exp {
        return Err(TokenError::Expired);
    }
    Ok(claims.sub)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret-0123456789abcdef0123";
    const NOW: u64 = 1_800_000_000;

    #[test]
    fn valid_token_round_trips() {
        let t = issue(SECRET, "alice", NOW + 60);
        assert_eq!(verify(SECRET, &t, NOW), Ok("alice".to_string()));
    }

    #[test]
    fn expired_token_is_rejected() {
        let t = issue(SECRET, "alice", NOW + 60);
        assert_eq!(verify(SECRET, &t, NOW + 60), Err(TokenError::Expired));
        assert_eq!(verify(SECRET, &t, NOW + 3600), Err(TokenError::Expired));
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let t = issue(SECRET, "alice", NOW + 60);
        let (_, tag) = t.split_once('.').unwrap();
        let forged = URL_SAFE_NO_PAD.encode(br#"{"sub":"mallory","exp":1900000000}"#);
        assert_eq!(verify(SECRET, &format!("{forged}.{tag}"), NOW), Err(TokenError::BadSignature));
    }

    #[test]
    fn tampered_mac_is_rejected() {
        let t = issue(SECRET, "alice", NOW + 60);
        let (payload, tag) = t.split_once('.').unwrap();
        let mut bytes = URL_SAFE_NO_PAD.decode(tag).unwrap();
        bytes[0] ^= 0x01;
        let bad = format!("{payload}.{}", URL_SAFE_NO_PAD.encode(bytes));
        assert_eq!(verify(SECRET, &bad, NOW), Err(TokenError::BadSignature));
        // Truncated MAC must fail too, not match a prefix.
        let short = format!("{payload}.{}", &tag[..8]);
        assert_eq!(verify(SECRET, &short, NOW), Err(TokenError::BadSignature));
    }

    #[test]
    fn wrong_secret_is_rejected() {
        let t = issue(SECRET, "alice", NOW + 60);
        assert_eq!(verify(b"another-secret", &t, NOW), Err(TokenError::BadSignature));
    }

    #[test]
    fn malformed_tokens_are_rejected() {
        assert_eq!(verify(SECRET, "", NOW), Err(TokenError::Malformed));
        assert_eq!(verify(SECRET, "no-dot-here", NOW), Err(TokenError::Malformed));
        assert_eq!(verify(SECRET, "abc.!!!", NOW), Err(TokenError::Malformed));
        // A bare user ID (the old "token") must not work.
        assert_eq!(verify(SECRET, "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", NOW), Err(TokenError::Malformed));
        // Correct MAC over a payload that is not valid claims JSON.
        let encoded = URL_SAFE_NO_PAD.encode(b"not json");
        let tag = URL_SAFE_NO_PAD.encode(mac_for(SECRET, &encoded).finalize().into_bytes());
        assert_eq!(verify(SECRET, &format!("{encoded}.{tag}"), NOW), Err(TokenError::Malformed));
    }
}
