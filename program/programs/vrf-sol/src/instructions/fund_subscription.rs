use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::events::SubscriptionFunded;
use crate::state::Subscription;

/// Accounts required to fund a subscription with SOL.
#[derive(Accounts)]
#[instruction(subscription_id: u64)]
pub struct FundSubscription<'info> {
    /// The account funding the subscription; pays the SOL.
    #[account(mut)]
    pub funder: Signer<'info>,

    /// The subscription PDA to fund.
    #[account(
        mut,
        seeds = [b"subscription", subscription_id.to_le_bytes().as_ref()],
        bump = subscription.bump,
    )]
    pub subscription: Account<'info, Subscription>,

    pub system_program: Program<'info, System>,
}

/// Transfer SOL from funder to subscription, incrementing the balance.
pub fn handler(ctx: Context<FundSubscription>, _subscription_id: u64, amount: u64) -> Result<()> {
    let subscription = &mut ctx.accounts.subscription;
    let old_balance = subscription.balance;

    // Transfer SOL from funder to subscription PDA
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: subscription.to_account_info(),
            },
        ),
        amount,
    )?;

    subscription.balance = subscription.balance.checked_add(amount).unwrap();

    emit!(SubscriptionFunded {
        subscription_id: subscription.id,
        old_balance,
        new_balance: subscription.balance,
    });

    Ok(())
}
