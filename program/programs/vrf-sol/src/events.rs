use anchor_lang::prelude::*;

/// Emitted when a new randomness request is created.
///
/// The off-chain oracle backend subscribes to these events via WebSocket log
/// monitoring and triggers fulfillment automatically.
#[event]
pub struct RandomnessRequested {
    pub request_id: u64,
    pub requester: Pubkey,
    pub seed: [u8; 32],
    pub request_slot: u64,
}

/// Emitted when the oracle fulfills a request with a VRF output.
#[event]
pub struct RandomnessFulfilled {
    pub request_id: u64,
    pub randomness: [u8; 32],
}

/// Emitted when the original requester consumes the fulfilled randomness.
#[event]
pub struct RandomnessConsumed {
    pub request_id: u64,
    pub requester: Pubkey,
}

/// Emitted when a consumed request account is closed and rent reclaimed.
#[event]
pub struct RequestClosed {
    pub request_id: u64,
    pub requester: Pubkey,
}
