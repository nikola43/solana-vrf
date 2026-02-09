use anchor_lang::prelude::*;

pub mod compressed_state;
pub mod ed25519;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod light_cpi;
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
///
/// ## ZK Compressed mode
///
/// Alternatively, requests can use ZK Compression (Light Protocol) for zero-rent
/// storage via `request_randomness_compressed` / `fulfill_randomness_compressed`.
/// Compressed requests have a 2-step lifecycle: Pending → Fulfilled (terminal).
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

    // -----------------------------------------------------------------------
    // ZK Compressed instructions (Light Protocol)
    // -----------------------------------------------------------------------

    /// Submit a compressed randomness request (zero rent via ZK Compression).
    ///
    /// Creates a compressed account via CPI to the Light System Program.
    /// The client must provide validity proofs and tree account data in
    /// `remaining_accounts`. Emits [`CompressedRandomnessRequested`].
    pub fn request_randomness_compressed<'info>(
        ctx: Context<'_, '_, '_, 'info, RequestRandomnessCompressed<'info>>,
        seed: [u8; 32],
        proof: light_cpi::ValidityProof,
        new_address_params: light_cpi::NewAddressParamsPacked,
        output_state_tree_index: u8,
        data_hash: [u8; 32],
        address: [u8; 32],
    ) -> Result<()> {
        instructions::request_compressed::handler(
            ctx,
            seed,
            proof,
            new_address_params,
            output_state_tree_index,
            data_hash,
            address,
        )
    }

    /// Fulfill a compressed randomness request.
    ///
    /// Verifies Ed25519 proof, validates compressed account state, and updates
    /// the compressed account via CPI to the Light System Program. The request
    /// transitions directly to `Fulfilled` (terminal — no consume/close needed).
    pub fn fulfill_randomness_compressed<'info>(
        ctx: Context<'_, '_, '_, 'info, FulfillRandomnessCompressed<'info>>,
        request_id: u64,
        randomness: [u8; 32],
        proof: light_cpi::ValidityProof,
        merkle_context: light_cpi::PackedMerkleContext,
        root_index: u16,
        current_request: compressed_state::CompressedRandomnessRequest,
        input_data_hash: [u8; 32],
        address: [u8; 32],
        output_state_tree_index: u8,
        output_data_hash: [u8; 32],
    ) -> Result<()> {
        instructions::fulfill_compressed::handler(
            ctx,
            request_id,
            randomness,
            proof,
            merkle_context,
            root_index,
            current_request,
            input_data_hash,
            address,
            output_state_tree_index,
            output_data_hash,
        )
    }
}
