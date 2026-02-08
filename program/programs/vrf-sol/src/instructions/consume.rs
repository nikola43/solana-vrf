use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::events::RandomnessConsumed;
use crate::state::RandomnessRequest;

/// Accounts required to consume a fulfilled randomness request.
///
/// Only the original requester may consume. The request must be in
/// `Fulfilled` status. After consumption the randomness remains readable
/// on-chain but the status prevents double-consumption.
#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct ConsumeRandomness<'info> {
    /// The original requester who created the request; must sign.
    pub requester: Signer<'info>,

    /// The fulfilled request PDA to consume.
    #[account(
        mut,
        seeds = [b"request", request_id.to_le_bytes().as_ref()],
        bump = request.bump,
        constraint = request.requester == requester.key() @ VrfError::Unauthorized,
        constraint = request.status == RandomnessRequest::STATUS_FULFILLED @ VrfError::RequestNotFulfilled,
    )]
    pub request: Account<'info, RandomnessRequest>,
}

/// Transition a fulfilled request to `Consumed` status.
///
/// This is the acknowledgment step that prevents double-use of the same
/// randomness output. After this call the requester may close the account.
pub fn handler(ctx: Context<ConsumeRandomness>, request_id: u64) -> Result<()> {
    let request = &mut ctx.accounts.request;
    request.status = RandomnessRequest::STATUS_CONSUMED;

    emit!(RandomnessConsumed {
        request_id,
        requester: request.requester,
    });

    Ok(())
}
