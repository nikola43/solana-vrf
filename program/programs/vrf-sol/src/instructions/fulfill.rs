use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as sysvar_instructions;

use crate::ed25519::verify_ed25519_instruction;
use crate::errors::VrfError;
use crate::events::RandomnessFulfilled;
use crate::state::{RandomnessRequest, VrfConfiguration};

/// Accounts required to fulfill a pending randomness request.
///
/// The transaction **must** include a native Ed25519 signature-verify
/// instruction at index 0 that proves the `authority` signed the message
/// `request_id (8 LE) || randomness (32)`. This is validated on-chain by
/// inspecting the Instructions sysvar.
#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct FulfillRandomness<'info> {
    /// Oracle authority that signs fulfillment proofs. Must match `config.authority`.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// VRF configuration PDA (read-only; used to verify authority).
    #[account(
        seeds = [b"vrf-config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ VrfError::Unauthorized,
    )]
    pub config: Account<'info, VrfConfiguration>,

    /// The request PDA to fulfill. Must be in `Pending` status.
    #[account(
        mut,
        seeds = [b"request", request_id.to_le_bytes().as_ref()],
        bump = request.bump,
        constraint = request.status == RandomnessRequest::STATUS_PENDING @ VrfError::RequestNotPending,
    )]
    pub request: Account<'info, RandomnessRequest>,

    /// Native Instructions sysvar used to introspect the Ed25519 instruction.
    /// CHECK: Validated by the address constraint.
    #[account(address = sysvar_instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

/// Fulfill a pending randomness request.
///
/// 1. Verifies the Ed25519 signature proof in the preceding instruction.
/// 2. Writes the randomness output and fulfillment slot to the request PDA.
/// 3. Transitions status from `Pending` to `Fulfilled`.
/// 4. Emits [`RandomnessFulfilled`].
pub fn handler(
    ctx: Context<FulfillRandomness>,
    request_id: u64,
    randomness: [u8; 32],
) -> Result<()> {
    verify_ed25519_instruction(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.config.authority,
        request_id,
        &randomness,
    )?;

    let request = &mut ctx.accounts.request;
    request.randomness = randomness;
    request.status = RandomnessRequest::STATUS_FULFILLED;
    request.fulfilled_slot = Clock::get()?.slot;

    emit!(RandomnessFulfilled {
        request_id,
        randomness,
    });

    Ok(())
}
