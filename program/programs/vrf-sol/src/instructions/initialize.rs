use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::state::VrfConfiguration;

/// Accounts required to initialize the VRF configuration singleton.
///
/// This instruction creates the `vrf-config` PDA and can only succeed once
/// per program deployment (the PDA seed is fixed).
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The initial admin who pays for account creation and controls future config updates.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The oracle's Ed25519 public key that will sign VRF fulfillments.
    /// CHECK: Stored as configuration; validated to be non-zero.
    pub authority: UncheckedAccount<'info>,

    /// Account that receives per-request fees.
    /// CHECK: Stored as configuration; validated to be non-zero.
    pub treasury: UncheckedAccount<'info>,

    /// Singleton configuration PDA. Seeds: `["vrf-config"]`.
    #[account(
        init,
        payer = admin,
        space = 8 + VrfConfiguration::INIT_SPACE,
        seeds = [b"vrf-config"],
        bump,
    )]
    pub config: Account<'info, VrfConfiguration>,

    pub system_program: Program<'info, System>,
}

/// Initialize the VRF configuration with the given fee.
///
/// Validates that `authority` and `treasury` are not the zero address, then
/// populates all configuration fields and sets the request counter to zero.
pub fn handler(ctx: Context<Initialize>, fee: u64) -> Result<()> {
    require!(
        ctx.accounts.authority.key() != Pubkey::default(),
        VrfError::ZeroAddressNotAllowed
    );
    require!(
        ctx.accounts.treasury.key() != Pubkey::default(),
        VrfError::ZeroAddressNotAllowed
    );

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.authority = ctx.accounts.authority.key();
    config.fee = fee;
    config.request_counter = 0;
    config.treasury = ctx.accounts.treasury.key();
    config.bump = ctx.bumps.config;
    Ok(())
}
