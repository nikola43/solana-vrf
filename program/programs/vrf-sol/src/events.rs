use anchor_lang::prelude::*;

/// Emitted when a new subscription is created.
#[event]
pub struct SubscriptionCreated {
    pub subscription_id: u64,
    pub owner: Pubkey,
}

/// Emitted when a subscription is funded with SOL.
#[event]
pub struct SubscriptionFunded {
    pub subscription_id: u64,
    pub old_balance: u64,
    pub new_balance: u64,
}

/// Emitted when a subscription is cancelled and balance refunded.
#[event]
pub struct SubscriptionCancelled {
    pub subscription_id: u64,
    pub owner: Pubkey,
    pub refunded_amount: u64,
}

/// Emitted when a consumer program is registered to a subscription.
#[event]
pub struct ConsumerAdded {
    pub subscription_id: u64,
    pub consumer_program: Pubkey,
}

/// Emitted when a consumer program is removed from a subscription.
#[event]
pub struct ConsumerRemoved {
    pub subscription_id: u64,
    pub consumer_program: Pubkey,
}

/// Emitted when a new randomness request is created.
///
/// The off-chain oracle backend subscribes to these events via WebSocket log
/// monitoring and triggers fulfillment automatically.
#[event]
pub struct RandomWordsRequested {
    pub request_id: u64,
    pub subscription_id: u64,
    pub consumer_program: Pubkey,
    pub requester: Pubkey,
    pub num_words: u32,
    pub seed: [u8; 32],
    pub request_slot: u64,
    pub callback_compute_limit: u32,
}

/// Emitted when the oracle fulfills a request and delivers the callback.
#[event]
pub struct RandomWordsFulfilled {
    pub request_id: u64,
    pub randomness: [u8; 32],
    pub consumer_program: Pubkey,
}
