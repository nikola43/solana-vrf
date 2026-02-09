use anchor_lang::prelude::*;

pub mod ed25519;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("A4pDDsKvtX2U3jyEURVSoH15Mx4JcgUiSqCKxqWE3N48");

/// Solana VRF Coordinator (Chainlink VRF v2-style).
///
/// Provides on-chain verifiable randomness through an Ed25519-based VRF scheme
/// with subscription billing and automatic callback delivery.
///
/// ## Architecture
///
/// - **Subscriptions** — hold a SOL balance that pays for VRF requests.
/// - **Consumers** — programs registered to a subscription that can request random words.
/// - **Coordinator** — verifies VRF proofs and CPIs into consumer programs with results.
///
/// ## Request lifecycle
///
/// 1. **Request** — consumer CPIs `request_random_words`; fee deducted from subscription.
/// 2. **Fulfill** — oracle submits `fulfill_random_words` with Ed25519 proof;
///    coordinator expands randomness, CPIs callback into consumer, closes request PDA.
#[program]
pub mod vrf_sol {
    use super::*;

    /// Create the singleton coordinator configuration PDA.
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_per_word: u64,
        max_num_words: u32,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, fee_per_word, max_num_words)
    }

    /// Create a new subscription.
    pub fn create_subscription(ctx: Context<CreateSubscription>) -> Result<()> {
        instructions::create_subscription::handler(ctx)
    }

    /// Fund a subscription with SOL.
    pub fn fund_subscription(
        ctx: Context<FundSubscription>,
        subscription_id: u64,
        amount: u64,
    ) -> Result<()> {
        instructions::fund_subscription::handler(ctx, subscription_id, amount)
    }

    /// Cancel a subscription and refund the remaining balance.
    pub fn cancel_subscription(
        ctx: Context<CancelSubscription>,
        subscription_id: u64,
    ) -> Result<()> {
        instructions::cancel_subscription::handler(ctx, subscription_id)
    }

    /// Register a consumer program to a subscription.
    pub fn add_consumer(ctx: Context<AddConsumer>, subscription_id: u64) -> Result<()> {
        instructions::add_consumer::handler(ctx, subscription_id)
    }

    /// Remove a consumer program from a subscription.
    pub fn remove_consumer(ctx: Context<RemoveConsumer>, subscription_id: u64) -> Result<()> {
        instructions::remove_consumer::handler(ctx, subscription_id)
    }

    /// Request random words (called via CPI from a consumer program).
    pub fn request_random_words(
        ctx: Context<RequestRandomWords>,
        num_words: u32,
        seed: [u8; 32],
        callback_compute_limit: u32,
    ) -> Result<()> {
        instructions::request_random_words::handler(ctx, num_words, seed, callback_compute_limit)
    }

    /// Fulfill a pending request with VRF output, deliver callback, and close request.
    pub fn fulfill_random_words<'info>(
        ctx: Context<'_, '_, '_, 'info, FulfillRandomWords<'info>>,
        request_id: u64,
        randomness: [u8; 32],
    ) -> Result<()> {
        instructions::fulfill_random_words::handler(ctx, request_id, randomness)
    }

    /// Update the coordinator configuration (admin-only).
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_authority: Option<Pubkey>,
        new_fee_per_word: Option<u64>,
        new_max_num_words: Option<u32>,
        new_admin: Option<Pubkey>,
    ) -> Result<()> {
        instructions::update_config::handler(ctx, new_authority, new_fee_per_word, new_max_num_words, new_admin)
    }
}
