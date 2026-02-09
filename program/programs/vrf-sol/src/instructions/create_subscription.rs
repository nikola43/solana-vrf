use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::events::SubscriptionCreated;
use crate::state::{CoordinatorConfig, Subscription};

/// Accounts required to create a new subscription.
#[derive(Accounts)]
pub struct CreateSubscription<'info> {
    /// The owner of the new subscription; pays for account creation.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Coordinator configuration PDA (mutated to increment subscription_counter).
    #[account(
        mut,
        seeds = [b"coordinator-config"],
        bump = config.bump,
    )]
    pub config: Account<'info, CoordinatorConfig>,

    /// New subscription PDA.
    #[account(
        init,
        payer = owner,
        space = 8 + Subscription::INIT_SPACE,
        seeds = [b"subscription", config.subscription_counter.to_le_bytes().as_ref()],
        bump,
    )]
    pub subscription: Account<'info, Subscription>,

    pub system_program: Program<'info, System>,
}

/// Create a new subscription.
pub fn handler(ctx: Context<CreateSubscription>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let sub_id = config.subscription_counter;

    let subscription = &mut ctx.accounts.subscription;
    subscription.id = sub_id;
    subscription.owner = ctx.accounts.owner.key();
    subscription.balance = 0;
    subscription.req_count = 0;
    subscription.consumer_count = 0;
    subscription.bump = ctx.bumps.subscription;

    config.subscription_counter = config
        .subscription_counter
        .checked_add(1)
        .ok_or(VrfError::CounterOverflow)?;

    emit!(SubscriptionCreated {
        subscription_id: sub_id,
        owner: subscription.owner,
    });

    Ok(())
}
