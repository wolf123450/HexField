//! Session tokens issued by `/auth/verify` and checked by `/ws` and the
//! authenticated REST routes.
//!
//! Format: `base64url(payload) "." base64url(mac)`, where `payload` is the
//! JSON `{"sub": <user_id>, "exp": <unix seconds>}` and `mac` is
//! HMAC-SHA256 over the encoded payload string with the server's session
//! secret. The MAC check is constant-time (`Mac::verify_slice`).
//!
//! Login challenges (`/auth/challenge`) use the same format with claims
//! `{"sub", "nonce", "exp"}`, but their MAC input starts with a context
//! prefix. A challenge can therefore never pass as a session token, and the
//! reverse. The server keeps no per-user challenge state, so one caller
//! cannot replace another user's pending challenge.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// MAC context for session tokens: none, for compatibility with tokens
/// issued before challenges existed. The encoded payload is base64url, so it
/// can never start with `CHALLENGE_CONTEXT` (which contains a NUL byte).
const SESSION_CONTEXT: &[u8] = b"";
const CHALLENGE_CONTEXT: &[u8] = b"hexfield-challenge-v1\0";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Claims {
    sub: String,
    exp: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChallengeClaims {
    sub: String,
    nonce: String,
    exp: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    BadSignature,
    Expired,
}

/// A verified session token.
#[derive(Debug, PartialEq, Eq)]
pub struct Session {
    pub user_id: String,
    /// Expiry, unix seconds.
    pub exp: u64,
}

/// A verified login challenge. `nonce` is unique per challenge and is used
/// to make each challenge single-use.
#[derive(Debug, PartialEq, Eq)]
pub struct Challenge {
    pub user_id: String,
    pub nonce: String,
    pub exp: u64,
}

fn mac_for(secret: &[u8], context: &[u8], encoded_payload: &str) -> HmacSha256 {
    // HMAC accepts keys of any length, so this cannot fail.
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(context);
    mac.update(encoded_payload.as_bytes());
    mac
}

fn sign<T: Serialize>(secret: &[u8], context: &[u8], claims: &T) -> String {
    let payload = serde_json::to_vec(claims).unwrap_or_default();
    let encoded = URL_SAFE_NO_PAD.encode(payload);
    let tag = mac_for(secret, context, &encoded).finalize().into_bytes();
    format!("{encoded}.{}", URL_SAFE_NO_PAD.encode(tag))
}

fn open<T: DeserializeOwned>(secret: &[u8], context: &[u8], token: &str) -> Result<T, TokenError> {
    let (encoded, tag_b64) = token.split_once('.').ok_or(TokenError::Malformed)?;
    let tag = URL_SAFE_NO_PAD.decode(tag_b64).map_err(|_| TokenError::Malformed)?;
    mac_for(secret, context, encoded)
        .verify_slice(&tag)
        .map_err(|_| TokenError::BadSignature)?;
    let payload = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| TokenError::Malformed)?;
    serde_json::from_slice(&payload).map_err(|_| TokenError::Malformed)
}

/// Issue a token for `user_id` that expires at `expiry` (unix seconds).
pub fn issue(secret: &[u8], user_id: &str, expiry: u64) -> String {
    sign(secret, SESSION_CONTEXT, &Claims { sub: user_id.to_string(), exp: expiry })
}

/// Verify `token` at time `now` (unix seconds). Returns the user ID.
pub fn verify(secret: &[u8], token: &str, now: u64) -> Result<String, TokenError> {
    verify_session(secret, token, now).map(|s| s.user_id)
}

/// Verify `token` at time `now` (unix seconds). Returns the user ID and expiry.
pub fn verify_session(secret: &[u8], token: &str, now: u64) -> Result<Session, TokenError> {
    let claims: Claims = open(secret, SESSION_CONTEXT, token)?;
    if claims.sub.is_empty() {
        return Err(TokenError::Malformed);
    }
    if now >= claims.exp {
        return Err(TokenError::Expired);
    }
    Ok(Session { user_id: claims.sub, exp: claims.exp })
}

/// Issue a login challenge for `user_id` with a fresh random nonce.
pub fn issue_challenge(secret: &[u8], user_id: &str, expiry: u64) -> String {
    let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>());
    sign(secret, CHALLENGE_CONTEXT, &ChallengeClaims { sub: user_id.to_string(), nonce, exp: expiry })
}

/// Verify a challenge issued by `issue_challenge` at time `now`.
pub fn verify_challenge(secret: &[u8], challenge: &str, now: u64) -> Result<Challenge, TokenError> {
    let claims: ChallengeClaims = open(secret, CHALLENGE_CONTEXT, challenge)?;
    if claims.sub.is_empty() || claims.nonce.is_empty() {
        return Err(TokenError::Malformed);
    }
    if now >= claims.exp {
        return Err(TokenError::Expired);
    }
    Ok(Challenge { user_id: claims.sub, nonce: claims.nonce, exp: claims.exp })
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
        let tag = URL_SAFE_NO_PAD.encode(mac_for(SECRET, SESSION_CONTEXT, &encoded).finalize().into_bytes());
        assert_eq!(verify(SECRET, &format!("{encoded}.{tag}"), NOW), Err(TokenError::Malformed));
    }

    #[test]
    fn verify_session_returns_expiry() {
        let t = issue(SECRET, "alice", NOW + 60);
        assert_eq!(verify_session(SECRET, &t, NOW), Ok(Session { user_id: "alice".into(), exp: NOW + 60 }));
    }

    #[test]
    fn challenge_round_trips_with_unique_nonces() {
        let a = verify_challenge(SECRET, &issue_challenge(SECRET, "alice", NOW + 300), NOW).unwrap();
        let b = verify_challenge(SECRET, &issue_challenge(SECRET, "alice", NOW + 300), NOW).unwrap();
        assert_eq!(a.user_id, "alice");
        assert_eq!(a.exp, NOW + 300);
        assert_ne!(a.nonce, b.nonce);
    }

    #[test]
    fn expired_challenge_is_rejected() {
        let c = issue_challenge(SECRET, "alice", NOW + 300);
        assert_eq!(verify_challenge(SECRET, &c, NOW + 300), Err(TokenError::Expired));
    }

    #[test]
    fn tampered_challenge_is_rejected() {
        let c = issue_challenge(SECRET, "alice", NOW + 300);
        let (_, tag) = c.split_once('.').unwrap();
        let forged = URL_SAFE_NO_PAD.encode(br#"{"sub":"alice","nonce":"x","exp":1900000000}"#);
        assert_eq!(verify_challenge(SECRET, &format!("{forged}.{tag}"), NOW), Err(TokenError::BadSignature));
        assert_eq!(verify_challenge(b"another-secret", &c, NOW), Err(TokenError::BadSignature));
    }

    #[test]
    fn challenge_and_session_token_are_not_interchangeable() {
        let c = issue_challenge(SECRET, "alice", NOW + 300);
        assert_eq!(verify(SECRET, &c, NOW), Err(TokenError::BadSignature));
        let t = issue(SECRET, "alice", NOW + 300);
        assert_eq!(verify_challenge(SECRET, &t, NOW), Err(TokenError::BadSignature));
    }

    #[test]
    fn session_claims_reject_unknown_fields() {
        // Even with a correct session MAC, extra fields do not parse.
        let encoded = URL_SAFE_NO_PAD.encode(br#"{"sub":"alice","nonce":"x","exp":1900000000}"#);
        let tag = URL_SAFE_NO_PAD.encode(mac_for(SECRET, SESSION_CONTEXT, &encoded).finalize().into_bytes());
        assert_eq!(verify(SECRET, &format!("{encoded}.{tag}"), NOW), Err(TokenError::Malformed));
    }
}
