//! Deterministic VRF output computation.
//!
//! Uses HMAC-SHA256 keyed by the oracle's secret to produce a 32-byte
//! pseudo-random output that is deterministic (same inputs = same output)
//! but unpredictable without the secret key.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// Compute the 32-byte VRF output for a given randomness request.
///
/// ```text
/// output = HMAC-SHA256(secret, seed || request_slot_le || request_id_le)
/// ```
///
/// The caller-provided `seed` prevents the oracle from pre-computing outputs.
/// The `request_slot` binds the output to the specific on-chain state at
/// request time, and `request_id` ensures uniqueness across requests.
pub fn compute_randomness(
    hmac_secret: &[u8],
    seed: &[u8; 32],
    request_slot: u64,
    request_id: u64,
) -> [u8; 32] {
    let mut mac =
        HmacSha256::new_from_slice(hmac_secret).expect("HMAC accepts keys of any size");

    mac.update(seed);
    mac.update(&request_slot.to_le_bytes());
    mac.update(&request_id.to_le_bytes());

    let result = mac.finalize();
    let bytes = result.into_bytes();

    let mut output = [0u8; 32];
    output.copy_from_slice(&bytes);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_for_same_inputs() {
        let secret = b"test-secret";
        let seed = [1u8; 32];

        let r1 = compute_randomness(secret, &seed, 100, 0);
        let r2 = compute_randomness(secret, &seed, 100, 0);
        assert_eq!(r1, r2);
    }

    #[test]
    fn different_for_different_slots() {
        let secret = b"test-secret";
        let seed = [1u8; 32];

        let r1 = compute_randomness(secret, &seed, 100, 0);
        let r2 = compute_randomness(secret, &seed, 101, 0);
        assert_ne!(r1, r2);
    }

    #[test]
    fn different_for_different_ids() {
        let secret = b"test-secret";
        let seed = [1u8; 32];

        let r1 = compute_randomness(secret, &seed, 100, 0);
        let r2 = compute_randomness(secret, &seed, 100, 1);
        assert_ne!(r1, r2);
    }
}
