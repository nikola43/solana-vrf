use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::events::ConsumerAdded;
use crate::state::{ConsumerRegistration, Subscription};

/// Accounts required to register a consumer program to a subscription.
#[derive(Accounts)]
#[instruction(subscription_id: u64)]
pub struct AddConsumer<'info> {
    /// The subscription owner; pays for account creation.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The subscription to add the consumer to.
    #[account(
        mut,
        seeds = [b"subscription", subscription_id.to_le_bytes().as_ref()],
        bump = subscription.bump,
        constraint = subscription.owner == owner.key() @ VrfError::Unauthorized,
    )]
    pub subscription: Account<'info, Subscription>,

    /// The consumer program to register.
    /// CHECK: Stored as-is; this is the program ID of the consumer.
    pub consumer_program: UncheckedAccount<'info>,

    /// Consumer registration PDA.
    #[account(
        init,
        payer = owner,
        space = 8 + ConsumerRegistration::INIT_SPACE,
        seeds = [b"consumer", subscription_id.to_le_bytes().as_ref(), consumer_program.key().as_ref()],
        bump,
    )]
    pub consumer_registration: Account<'info, ConsumerRegistration>,

    pub system_program: Program<'info, System>,
}

/// Register a consumer program for a subscription.
pub fn handler(ctx: Context<AddConsumer>, subscription_id: u64) -> Result<()> {
    let consumer_program = ctx.accounts.consumer_program.key();

    require!(
        consumer_program != Pubkey::default(),
        VrfError::ZeroAddressNotAllowed
    );

    let registration = &mut ctx.accounts.consumer_registration;
    registration.subscription_id = subscription_id;
    registration.program_id = consumer_program;
    registration.nonce = 0;
    registration.bump = ctx.bumps.consumer_registration;

    let subscription = &mut ctx.accounts.subscription;
    subscription.consumer_count = subscription.consumer_count.checked_add(1).unwrap();

    emit!(ConsumerAdded {
        subscription_id,
        consumer_program,
    });

    Ok(())
}
