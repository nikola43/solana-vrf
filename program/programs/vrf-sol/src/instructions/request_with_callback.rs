use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::VrfError;
use crate::events::RandomnessRequested;
use crate::state::{RandomnessRequest, VrfConfiguration};

/// Accounts required to create a new randomness request with a callback program.
///
/// Identical to [`RequestRandomness`] but stores the `callback_program` pubkey
/// on the request PDA so the oracle can CPI into it after fulfillment.
#[derive(Accounts)]
pub struct RequestRandomnessWithCallback<'info> {
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

    /// The program to CPI into after fulfillment.
    /// CHECK: Stored as-is; validated during fulfillment.
    pub callback_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Create a new randomness request with a callback program.
///
/// Same as `request_randomness` but stores `callback_program` on the request
/// PDA. After the oracle fulfills this request, it will CPI into the callback
/// program with the instruction `vrf_callback(request_id, randomness)`.
///
/// The callback program must implement a `vrf_callback` instruction that accepts:
/// - `request_id: u64`
/// - `randomness: [u8; 32]`
pub fn handler(ctx: Context<RequestRandomnessWithCallback>, seed: [u8; 32]) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let request_id = config.request_counter;

    require!(
        ctx.accounts.callback_program.key() != Pubkey::default(),
        VrfError::ZeroAddressNotAllowed
    );

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
    request.callback_program = ctx.accounts.callback_program.key();
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
