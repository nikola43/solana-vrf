use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::state::CoordinatorConfig;

/// Accounts required to initialize the coordinator configuration singleton.
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The initial admin who pays for account creation.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The oracle's Ed25519 public key that will sign VRF fulfillments.
    /// CHECK: Stored as configuration; validated to be non-zero.
    pub authority: UncheckedAccount<'info>,

    /// Singleton configuration PDA. Seeds: `["coordinator-config"]`.
    #[account(
        init,
        payer = admin,
        space = 8 + CoordinatorConfig::INIT_SPACE,
        seeds = [b"coordinator-config"],
        bump,
    )]
    pub config: Account<'info, CoordinatorConfig>,

    pub system_program: Program<'info, System>,
}

/// Initialize the coordinator configuration.
pub fn handler(ctx: Context<Initialize>, fee_per_word: u64, max_num_words: u32) -> Result<()> {
    require!(
        ctx.accounts.authority.key() != Pubkey::default(),
        VrfError::ZeroAddressNotAllowed
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.authority = ctx.accounts.authority.key();
    config.fee_per_word = fee_per_word;
    config.max_num_words = max_num_words;
    config.request_counter = 0;
    config.subscription_counter = 0;
    config.bump = ctx.bumps.config;
    Ok(())
}
