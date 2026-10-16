//! Auth primitives shared by the auth routes and the session extractor.
//!
//! Passwords are Argon2id PHC strings (RFC 9106, m=19456 KiB, t=3, p=1,
//! 32-byte output); sessions are opaque bearer tokens: 32 random bytes
//! hex-encoded, stored only as an HMAC-SHA256 keyed by `SESSION_SECRET`
//! (ADR 2026-10-15, bucket 2). Rotating `SESSION_SECRET` therefore
//! invalidates every active session, which doubles as a global logout.

use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
use argon2::{Algorithm, Argon2, Params, PasswordVerifier, Version};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// Argon2id memory cost in KiB (RFC 9106 second recommendation).
const PASSWORD_MEMORY_COST: u32 = 19_456;
/// Argon2id time cost (iterations).
const PASSWORD_TIME_COST: u32 = 3;
/// Argon2id degree of parallelism.
const PASSWORD_PARALLELISM: u32 = 1;
/// Argon2id output length in bytes.
const PASSWORD_OUTPUT_LEN: usize = 32;

/// Session token length in random bytes (256 bits).
const TOKEN_BYTES: usize = 32;

/// SHA-256 block size in bytes; HMAC pads or hashes keys longer than this.
const HMAC_BLOCK_SIZE: usize = 64;

/// Session lifetime in days; sessions expire and stop resolving after it.
pub const SESSION_TTL_DAYS: i64 = 30;

/// A valid Argon2id PHC string over a throwaway password. Login verifies
/// against it when the email is unknown or the stored hash is NULL, so a
/// miss costs the same Argon2 computation as a real verification and does
/// not leak account existence through timing.
pub const DUMMY_PHC: &str =
    "$argon2id$v=19$m=19456,t=3,p=1$EpBd264ipYm7XOCsFmr0PQ$bZ2BxcJGiNa1ZufD6P75nMtTRlNRHnKXHmtVLZxt4yE";

/// Hash a password into an Argon2id PHC string with a fresh random salt.
pub fn hash_password(password: &str) -> Result<String, argon2::password_hash::Error> {
    let params = Params::new(
        PASSWORD_MEMORY_COST,
        PASSWORD_TIME_COST,
        PASSWORD_PARALLELISM,
        Some(PASSWORD_OUTPUT_LEN),
    )
    .expect("static Argon2id parameters are valid");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = SaltString::generate(&mut OsRng);
    Ok(argon2
        .hash_password(password.as_bytes(), &salt)?
        .to_string())
}

/// Verify a password against a stored PHC string. A malformed hash never
/// authenticates.
pub fn verify_password(password: &str, phc: &str) -> bool {
    match argon2::password_hash::PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// A fresh opaque session token: 32 `OsRng` bytes, hex-encoded (64 chars).
pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    let mut rng = OsRng;
    rng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// The value stored in `sessions.token_hash`: HMAC-SHA256 (RFC 2104) of
/// the raw token keyed by `SESSION_SECRET`, hex-encoded. The raw token
/// never touches the database.
pub fn hash_token(secret: &str, token: &str) -> String {
    hex::encode(hmac_sha256(secret.as_bytes(), token.as_bytes()))
}

/// HMAC-SHA256 (RFC 2104) over SHA-256 (FIPS 180-4). `sha2` ships the
/// hash, not the MAC, so the two-pad construction is spelled out here and
/// fenced by the RFC 4231 vectors in the unit tests below.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    // Keys longer than the block size are replaced by their hash; shorter
    // keys are zero-padded to one block.
    let mut block = [0u8; HMAC_BLOCK_SIZE];
    if key.len() > HMAC_BLOCK_SIZE {
        let digest = Sha256::digest(key);
        block[..digest.len()].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36u8; HMAC_BLOCK_SIZE];
    let mut outer_pad = [0x5cu8; HMAC_BLOCK_SIZE];
    for (inner, byte) in inner_pad.iter_mut().zip(block) {
        *inner ^= byte;
    }
    for (outer, byte) in outer_pad.iter_mut().zip(block) {
        *outer ^= byte;
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::{generate_token, hash_password, hash_token, hmac_sha256, verify_password};
    use super::{DUMMY_PHC, SESSION_TTL_DAYS};
    use argon2::password_hash::PasswordHash;

    fn to_hex(bytes: &[u8]) -> String {
        hex::encode(bytes)
    }

    /// RFC 4231 test vectors 1, 2, and 6: a 20-byte key below the block
    /// size, the short ASCII key "Jefe", and a 131-byte key longer than
    /// the block size (hashed down to one block first).
    #[test]
    fn hmac_sha256_matches_the_rfc_4231_vectors() {
        let cases: [(&[u8], &[u8], &str); 3] = [
            (
                &[0x0b; 20],
                b"Hi There",
                "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
            ),
            (
                b"Jefe",
                b"what do ya want for nothing?",
                "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            ),
            (
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First",
                "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
            ),
        ];
        for (key, message, expected) in cases {
            assert_eq!(to_hex(&hmac_sha256(key, message)), expected);
        }
    }

    #[test]
    fn hash_token_depends_on_both_secret_and_token() {
        let token = generate_token();
        let hashed = hash_token("secret-a-should-differ-from-secret-b-1", &token);
        assert_eq!(
            hashed,
            hash_token("secret-a-should-differ-from-secret-b-1", &token)
        );
        assert_ne!(
            hashed,
            hash_token("secret-b-should-differ-from-secret-a-1", &token)
        );
        assert_ne!(
            hashed,
            hash_token("secret-a-should-differ-from-secret-b-1", &generate_token())
        );
        // 32 bytes of MAC, hex-encoded.
        assert_eq!(hashed.len(), 64);
        assert!(hashed.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn generated_tokens_are_64_hex_chars() {
        let token = generate_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(token, generate_token(), "tokens must be random");
    }

    #[test]
    fn password_hash_round_trips_and_rejects_wrong_passwords() {
        let phc = hash_password("correct horse battery staple").expect("hash");
        assert!(phc.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery staple", &phc));
        assert!(!verify_password("wrong password entirely", &phc));
        assert!(!verify_password(
            "correct horse battery staple",
            "not a phc string"
        ));
    }

    #[test]
    fn dummy_phc_is_a_parseable_argon2id_hash() {
        let parsed = PasswordHash::new(DUMMY_PHC).expect("DUMMY_PHC must parse");
        assert_eq!(parsed.algorithm.as_str(), "argon2id");
        // The dummy password is never a real password, so nothing verifies.
        assert!(!verify_password("anything at all", DUMMY_PHC));
    }

    #[test]
    fn session_ttl_is_thirty_days() {
        assert_eq!(SESSION_TTL_DAYS, 30);
    }
}
