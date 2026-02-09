use anchor_lang::prelude::*;

/// Compressed randomness request stored via ZK Compression (Light Protocol).
///
/// Unlike the regular [`RandomnessRequest`] PDA, this state is stored in a
/// compressed Merkle tree, eliminating rent costs entirely. The tradeoff is
/// a simplified lifecycle: Pending → Fulfilled (terminal). No consume/close
/// steps are needed since there is no account to reclaim rent from.
///
/// Layout (Borsh-serialized, 113 bytes):
/// ```text
/// request_id      (8)  — unique ID from VrfConfiguration counter
/// requester       (32) — account that created the request
/// seed            (32) — user-provided entropy
/// request_slot    (8)  — slot at creation time
/// status          (1)  — 0=Pending, 1=Fulfilled (terminal)
/// randomness      (32) — VRF output (zeroed until fulfilled)
/// ```
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct CompressedRandomnessRequest {
    pub request_id: u64,
    pub requester: Pubkey,
    pub seed: [u8; 32],
    pub request_slot: u64,
    pub status: u8,
    pub randomness: [u8; 32],
}

impl CompressedRandomnessRequest {
    pub const STATUS_PENDING: u8 = 0;
    pub const STATUS_FULFILLED: u8 = 1;

    /// Borsh-serialized size of this struct.
    pub const SERIALIZED_SIZE: usize = 8 + 32 + 32 + 8 + 1 + 32; // 113 bytes

    /// Light Protocol discriminator: SHA256("CompressedRandomnessRequest")[..8]
    pub const LIGHT_DISCRIMINATOR: [u8; 8] = {
        // Pre-computed at compile time. Equivalent to:
        // sha2::Sha256::digest(b"CompressedRandomnessRequest")[..8]
        // We compute this in the SDK/backend and verify they match.
        //
        // Computed via: require('crypto').createHash('sha256')
        //   .update('CompressedRandomnessRequest').digest().slice(0, 8)
        // = [149, 31, 244, 154, 189, 164, 84, 79]
        [149, 31, 244, 154, 189, 164, 84, 79]
    };
}

/// Packed metadata for a compressed account input (passed as instruction data).
///
/// The client reads this from the Photon indexer and passes it so the program
/// can verify the account's current state against the Merkle tree.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CompressedAccountMeta {
    /// Merkle tree index in remaining_accounts.
    pub merkle_tree_index: u8,
    /// Leaf index in the Merkle tree.
    pub leaf_index: u32,
    /// Queue index in remaining_accounts (for nullifier queue).
    pub queue_index: u8,
    /// Hash of the current compressed account state.
    pub hash: [u8; 32],
}
