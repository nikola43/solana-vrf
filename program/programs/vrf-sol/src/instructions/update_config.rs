use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::state::VrfConfiguration;

/// Accounts required to update the VRF configuration.
///
/// Only the current `admin` may invoke this instruction.
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    /// Current admin; must sign.
    pub admin: Signer<'info>,

    /// VRF configuration PDA to update.
    #[account(
        mut,
        seeds = [b"vrf-config"],
        bump = config.bump,
        constraint = config.admin == admin.key() @ VrfError::Unauthorized,
    )]
    pub config: Account<'info, VrfConfiguration>,
}

/// Update one or more VRF configuration fields.
///
/// Each parameter is optional — only `Some` values are applied. Zero-address
/// values are rejected for `authority`, `treasury`, and `admin` to prevent
/// accidental lockout.
pub fn handler(
    ctx: Context<UpdateConfig>,
    new_authority: Option<Pubkey>,
    new_fee: Option<u64>,
    new_treasury: Option<Pubkey>,
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
    if let Some(fee) = new_fee {
        config.fee = fee;
    }
    if let Some(treasury) = new_treasury {
        require!(
            treasury != Pubkey::default(),
            VrfError::ZeroAddressNotAllowed
        );
        config.treasury = treasury;
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
