use anchor_lang::prelude::*;

/// Global VRF service configuration, stored as a singleton PDA.
///
/// Seeds: `["vrf-config"]`
///
/// Only the `admin` may update this account via [`update_config`]. The
/// `authority` is the off-chain oracle key that signs fulfillment proofs.
#[account]
#[derive(InitSpace)]
pub struct VrfConfiguration {
    /// Privileged key that may update this configuration.
    pub admin: Pubkey,
    /// Ed25519 public key of the off-chain oracle that signs VRF proofs.
    pub authority: Pubkey,
    /// Fee (in lamports) charged per randomness request, transferred to `treasury`.
    pub fee: u64,
    /// Monotonically increasing counter used to derive unique request PDA seeds.
    pub request_counter: u64,
    /// Account that receives request fees (typically the oracle operator).
    pub treasury: Pubkey,
    /// PDA bump seed cached for efficient re-derivation.
    pub bump: u8,
}

/// Individual randomness request account, one per request.
///
/// Seeds: `["request", request_id.to_le_bytes()]`
///
/// Lifecycle: Pending (0) -> Fulfilled (1) -> Consumed (2) -> Closed (account deleted).
#[account]
#[derive(InitSpace)]
pub struct RandomnessRequest {
    /// Unique identifier derived from `VrfConfiguration::request_counter` at creation time.
    pub request_id: u64,
    /// The account that created and paid for this request; only this key may consume/close it.
    pub requester: Pubkey,
    /// Caller-provided entropy mixed into the VRF input to prevent oracle pre-computation.
    pub seed: [u8; 32],
    /// Solana slot at which the request was created (included in VRF input for replay protection).
    pub request_slot: u64,
    /// Reserved for future use: program to CPI after fulfillment (currently `Pubkey::default()`).
    pub callback_program: Pubkey,
    /// Request lifecycle status. See `STATUS_*` constants.
    pub status: u8,
    /// The 32-byte VRF output written by the oracle during fulfillment.
    pub randomness: [u8; 32],
    /// Solana slot at which the oracle fulfilled this request.
    pub fulfilled_slot: u64,
    /// PDA bump seed cached for efficient re-derivation.
    pub bump: u8,
}

impl RandomnessRequest {
    /// Request created, awaiting oracle fulfillment.
    pub const STATUS_PENDING: u8 = 0;
    /// Oracle has written the VRF output; ready for the requester to consume.
    pub const STATUS_FULFILLED: u8 = 1;
    /// Requester has consumed the randomness; account eligible for closure.
    pub const STATUS_CONSUMED: u8 = 2;
}
