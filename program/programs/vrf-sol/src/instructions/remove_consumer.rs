use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::events::ConsumerRemoved;
use crate::state::{ConsumerRegistration, Subscription};

/// Accounts required to remove a consumer program from a subscription.
#[derive(Accounts)]
#[instruction(subscription_id: u64)]
pub struct RemoveConsumer<'info> {
    /// The subscription owner; receives rent from closed registration account.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The subscription to remove the consumer from.
    #[account(
        mut,
        seeds = [b"subscription", subscription_id.to_le_bytes().as_ref()],
        bump = subscription.bump,
        constraint = subscription.owner == owner.key() @ VrfError::Unauthorized,
    )]
    pub subscription: Account<'info, Subscription>,

    /// The consumer program to deregister.
    /// CHECK: Used only for PDA derivation.
    pub consumer_program: UncheckedAccount<'info>,

    /// Consumer registration PDA to close.
    #[account(
        mut,
        seeds = [b"consumer", subscription_id.to_le_bytes().as_ref(), consumer_program.key().as_ref()],
        bump = consumer_registration.bump,
        close = owner,
    )]
    pub consumer_registration: Account<'info, ConsumerRegistration>,
}

/// Remove a consumer program from a subscription.
pub fn handler(ctx: Context<RemoveConsumer>, subscription_id: u64) -> Result<()> {
    let consumer_program = ctx.accounts.consumer_program.key();

    let subscription = &mut ctx.accounts.subscription;
    subscription.consumer_count = subscription.consumer_count.saturating_sub(1);

    emit!(ConsumerRemoved {
        subscription_id,
        consumer_program,
    });

    Ok(())
}
