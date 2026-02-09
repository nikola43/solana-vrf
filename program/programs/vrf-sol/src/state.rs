use anchor_lang::prelude::*;

/// Global coordinator configuration, stored as a singleton PDA.
///
/// Seeds: `["coordinator-config"]`
///
/// Only the `admin` may update this account via [`update_config`]. The
/// `authority` is the off-chain oracle key that signs fulfillment proofs.
#[account]
#[derive(InitSpace)]
pub struct CoordinatorConfig {
    /// Privileged key that may update this configuration.
    pub admin: Pubkey,
    /// Ed25519 public key of the off-chain oracle that signs VRF proofs.
    pub authority: Pubkey,
    /// Fee (in lamports) charged per random word requested.
    pub fee_per_word: u64,
    /// Maximum number of random words a consumer may request at once.
    pub max_num_words: u32,
    /// Monotonically increasing counter used to derive unique request PDA seeds.
    pub request_counter: u64,
    /// Monotonically increasing counter used to derive unique subscription PDA seeds.
    pub subscription_counter: u64,
    /// PDA bump seed cached for efficient re-derivation.
    pub bump: u8,
}

/// A subscription account that holds a SOL balance for paying VRF fees.
///
/// Seeds: `["subscription", subscription_id.to_le_bytes()]`
///
/// The subscription owner manages consumers and funds. Fees are deducted
/// from the subscription balance at request time.
#[account]
#[derive(InitSpace)]
pub struct Subscription {
    /// Unique subscription identifier.
    pub id: u64,
    /// The account that owns and manages this subscription.
    pub owner: Pubkey,
    /// Current balance in lamports available for VRF fees.
    pub balance: u64,
    /// Total number of VRF requests made through this subscription.
    pub req_count: u64,
    /// Number of consumer programs currently registered.
    pub consumer_count: u32,
    /// PDA bump seed cached for efficient re-derivation.
    pub bump: u8,
}

/// Registration of a consumer program for a specific subscription.
///
/// Seeds: `["consumer", subscription_id.to_le_bytes(), consumer_program_id]`
///
/// Only registered consumers may request random words charged to the subscription.
#[account]
#[derive(InitSpace)]
pub struct ConsumerRegistration {
    /// The subscription this consumer is registered under.
    pub subscription_id: u64,
    /// The program ID of the consumer that may request randomness.
    pub program_id: Pubkey,
    /// Nonce for additional uniqueness / versioning.
    pub nonce: u64,
    /// PDA bump seed cached for efficient re-derivation.
    pub bump: u8,
}

/// Individual randomness request account, one per request.
///
/// Seeds: `["request", request_id.to_le_bytes()]`
///
/// Lifecycle: Pending (0) -> Fulfilled+Callback (coordinator closes the account).
#[account]
#[derive(InitSpace)]
pub struct RandomnessRequest {
    /// Unique identifier derived from `CoordinatorConfig::request_counter` at creation time.
    pub request_id: u64,
    /// The subscription that is paying for this request.
    pub subscription_id: u64,
    /// The consumer program that will receive the callback.
    pub consumer_program: Pubkey,
    /// The account that initiated the request (for rent refund on close).
    pub requester: Pubkey,
    /// Number of random words requested.
    pub num_words: u32,
    /// Caller-provided entropy mixed into the VRF input.
    pub seed: [u8; 32],
    /// Solana slot at which the request was created.
    pub request_slot: u64,
    /// Compute unit limit for the consumer callback CPI.
    pub callback_compute_limit: u32,
    /// Request lifecycle status. See `STATUS_*` constants.
    pub status: u8,
    /// The 32-byte base VRF output written by the oracle during fulfillment.
    pub randomness: [u8; 32],
    /// Solana slot at which the oracle fulfilled this request.
    pub fulfilled_slot: u64,
    /// PDA bump seed cached for efficient re-derivation.
    pub bump: u8,
}

impl RandomnessRequest {
    /// Request created, awaiting oracle fulfillment.
    pub const STATUS_PENDING: u8 = 0;
    /// Oracle has fulfilled and callback has been delivered.
    pub const STATUS_FULFILLED: u8 = 1;
}
