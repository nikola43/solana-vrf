use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::events::SubscriptionCancelled;
use crate::state::Subscription;

/// Accounts required to cancel a subscription and reclaim SOL.
#[derive(Accounts)]
#[instruction(subscription_id: u64)]
pub struct CancelSubscription<'info> {
    /// The subscription owner; receives refunded balance.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The subscription PDA to cancel. Must have no registered consumers.
    #[account(
        mut,
        seeds = [b"subscription", subscription_id.to_le_bytes().as_ref()],
        bump = subscription.bump,
        constraint = subscription.owner == owner.key() @ VrfError::Unauthorized,
        constraint = subscription.consumer_count == 0 @ VrfError::SubscriptionHasConsumers,
        close = owner,
    )]
    pub subscription: Account<'info, Subscription>,
}

/// Cancel a subscription, refunding the remaining balance and rent to the owner.
pub fn handler(ctx: Context<CancelSubscription>, _subscription_id: u64) -> Result<()> {
    let subscription = &ctx.accounts.subscription;
    let refunded = subscription.balance;

    // If the subscription has a balance beyond rent, transfer it back to the owner
    // before Anchor closes the account. We need to do a manual lamport transfer
    // since the subscription balance is tracked separately from the account lamports.
    // Note: Anchor's `close` will handle returning all lamports (including balance).

    emit!(SubscriptionCancelled {
        subscription_id: subscription.id,
        owner: subscription.owner,
        refunded_amount: refunded,
    });

    Ok(())
}
