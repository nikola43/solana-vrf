use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::events::RequestClosed;
use crate::state::RandomnessRequest;

/// Accounts required to close a consumed request and reclaim rent.
///
/// Only the original requester may close the account, and only after
/// the randomness has been consumed (status = `Consumed`).
#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct CloseRequest<'info> {
    /// The original requester; receives reclaimed rent.
    #[account(mut)]
    pub requester: Signer<'info>,

    /// The consumed request PDA to close. Anchor's `close` directive
    /// zeroes the account data and transfers lamports to `requester`.
    #[account(
        mut,
        seeds = [b"request", request_id.to_le_bytes().as_ref()],
        bump = request.bump,
        constraint = request.requester == requester.key() @ VrfError::Unauthorized,
        constraint = request.status == RandomnessRequest::STATUS_CONSUMED @ VrfError::RequestNotConsumed,
        close = requester,
    )]
    pub request: Account<'info, RandomnessRequest>,
}

/// Close a consumed request account.
///
/// The account's lamports are returned to the requester. Emits [`RequestClosed`].
pub fn handler(ctx: Context<CloseRequest>, request_id: u64) -> Result<()> {
    emit!(RequestClosed {
        request_id,
        requester: ctx.accounts.requester.key(),
    });

    Ok(())
}
