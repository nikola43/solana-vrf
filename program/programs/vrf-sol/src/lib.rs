use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("A4pDDsKvtX2U3jyEURVSoH15Mx4JcgUiSqCKxqWE3N48");

/// Solana VRF (Verifiable Random Function) oracle program.
///
/// Provides on-chain verifiable randomness through an Ed25519-based VRF scheme.
/// An off-chain oracle watches for [`RandomnessRequested`] events, computes
/// HMAC-SHA256 randomness keyed by a secret, signs the output with its Ed25519
/// authority key, and submits a fulfillment transaction that the program
/// cryptographically verifies on-chain via the native Ed25519 precompile.
///
/// ## Request lifecycle
///
/// 1. **Request** — any account calls `request_randomness` with a user seed;
///    a PDA is created with status `Pending` and a fee is transferred.
/// 2. **Fulfill** — the oracle submits `fulfill_randomness` with the VRF output
///    and an Ed25519 signature proof; status transitions to `Fulfilled`.
/// 3. **Consume** — the original requester calls `consume_randomness` to mark
///    the output as read; status transitions to `Consumed`.
/// 4. **Close** — the requester calls `close_request` to reclaim rent.
#[program]
pub mod vrf_sol {
    use super::*;

    /// Create the singleton VRF configuration PDA.
    ///
    /// Must be called exactly once. Sets the admin, authority, treasury, and fee.
    pub fn initialize(ctx: Context<Initialize>, fee: u64) -> Result<()> {
        instructions::initialize::handler(ctx, fee)
    }

    /// Submit a new randomness request.
    ///
    /// Creates a request PDA, charges the fee, and emits [`RandomnessRequested`].
    pub fn request_randomness(ctx: Context<RequestRandomness>, seed: [u8; 32]) -> Result<()> {
        instructions::request::handler(ctx, seed)
    }

    /// Fulfill a pending request with a VRF output and Ed25519 proof.
    ///
    /// Only callable by the configured `authority`. Requires a preceding Ed25519
    /// signature-verify instruction in the same transaction.
    pub fn fulfill_randomness(
        ctx: Context<FulfillRandomness>,
        request_id: u64,
        randomness: [u8; 32],
    ) -> Result<()> {
        instructions::fulfill::handler(ctx, request_id, randomness)
    }

    /// Mark a fulfilled request as consumed by the original requester.
    ///
    /// Only the account that created the request may consume it.
    pub fn consume_randomness(ctx: Context<ConsumeRandomness>, request_id: u64) -> Result<()> {
        instructions::consume::handler(ctx, request_id)
    }

    /// Update the VRF configuration (admin-only).
    ///
    /// All parameters are optional; only provided fields are updated.
    /// Zero-address values are rejected.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_authority: Option<Pubkey>,
        new_fee: Option<u64>,
        new_treasury: Option<Pubkey>,
        new_admin: Option<Pubkey>,
    ) -> Result<()> {
        instructions::update_config::handler(ctx, new_authority, new_fee, new_treasury, new_admin)
    }

    /// Close a consumed request account and return rent to the requester.
    ///
    /// Only callable after the request has been consumed (status = 2).
    pub fn close_request(ctx: Context<CloseRequest>, request_id: u64) -> Result<()> {
        instructions::close_request::handler(ctx, request_id)
    }

    /// Submit a new randomness request with a callback program.
    ///
    /// Same as `request_randomness` but stores a callback program on the request.
    /// After fulfillment, the oracle can CPI into the callback program with the
    /// randomness output and auto-transition to Consumed status.
    pub fn request_randomness_with_callback(
        ctx: Context<RequestRandomnessWithCallback>,
        seed: [u8; 32],
    ) -> Result<()> {
        instructions::request_with_callback::handler(ctx, seed)
    }
}
