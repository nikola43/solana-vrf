use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::VrfError;
use crate::events::RandomnessRequested;
use crate::state::{RandomnessRequest, VrfConfiguration};

/// Accounts required to create a new randomness request.
///
/// The request PDA is derived from the current `request_counter` value,
/// guaranteeing uniqueness. The counter is incremented atomically after
/// the PDA is initialized.
#[derive(Accounts)]
pub struct RequestRandomness<'info> {
    /// The account requesting randomness; pays the fee and rent.
    #[account(mut)]
    pub requester: Signer<'info>,

    /// VRF configuration PDA (mutated to increment `request_counter`).
    #[account(
        mut,
        seeds = [b"vrf-config"],
        bump = config.bump,
    )]
    pub config: Account<'info, VrfConfiguration>,

    /// New request PDA. Seeds: `["request", counter.to_le_bytes()]`.
    #[account(
        init,
        payer = requester,
        space = 8 + RandomnessRequest::INIT_SPACE,
        seeds = [b"request", config.request_counter.to_le_bytes().as_ref()],
        bump,
    )]
    pub request: Account<'info, RandomnessRequest>,

    /// Fee recipient; must match `config.treasury`.
    /// CHECK: Validated by the constraint below.
    #[account(
        mut,
        constraint = treasury.key() == config.treasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Create a new randomness request.
///
/// 1. Transfers `config.fee` lamports from `requester` to `treasury` (skipped if fee is zero).
/// 2. Initializes the request PDA with status `Pending`.
/// 3. Increments `config.request_counter`.
/// 4. Emits [`RandomnessRequested`] for the off-chain oracle.
pub fn handler(ctx: Context<RequestRandomness>, seed: [u8; 32]) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let request_id = config.request_counter;

    if config.fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.requester.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            config.fee,
        )?;
    }

    let request = &mut ctx.accounts.request;
    request.request_id = request_id;
    request.requester = ctx.accounts.requester.key();
    request.seed = seed;
    request.request_slot = Clock::get()?.slot;
    request.callback_program = Pubkey::default();
    request.status = RandomnessRequest::STATUS_PENDING;
    request.randomness = [0u8; 32];
    request.fulfilled_slot = 0;
    request.bump = ctx.bumps.request;

    config.request_counter = config
        .request_counter
        .checked_add(1)
        .ok_or(VrfError::CounterOverflow)?;

    emit!(RandomnessRequested {
        request_id,
        requester: request.requester,
        seed,
        request_slot: request.request_slot,
    });

    Ok(())
}
