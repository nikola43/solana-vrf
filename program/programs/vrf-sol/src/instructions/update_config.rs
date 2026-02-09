use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::state::CoordinatorConfig;

/// Accounts required to update the coordinator configuration.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    /// Current admin; must sign.
    pub admin: Signer<'info>,

    /// Coordinator configuration PDA to update.
    #[account(
        mut,
        seeds = [b"coordinator-config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ VrfError::Unauthorized,
    )]
    pub config: Account<'info, CoordinatorConfig>,
}

/// Update one or more coordinator configuration fields.
pub fn handler(
    ctx: Context<UpdateConfig>,
    new_authority: Option<Pubkey>,
    new_fee_per_word: Option<u64>,
    new_max_num_words: Option<u32>,
    new_admin: Option<Pubkey>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(authority) = new_authority {
        require!(
            authority != Pubkey::default(),
            VrfError::ZeroAddressNotAllowed
        );
        config.authority = authority;
    }
    if let Some(fee) = new_fee_per_word {
        config.fee_per_word = fee;
    }
    if let Some(max_words) = new_max_num_words {
        config.max_num_words = max_words;
    }
    if let Some(admin) = new_admin {
        require!(
            admin != Pubkey::default(),
            VrfError::ZeroAddressNotAllowed
        );
        config.admin = admin;
    }

    Ok(())
}
