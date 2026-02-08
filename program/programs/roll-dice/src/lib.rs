use anchor_lang::prelude::*;

declare_id!("7Q5b9aimnHmR8ooooRqxgfYfnLmPi6qrVR9GrJ1b6fDp");

/// A dice roll that is backed by VRF randomness.
///
/// Seeds: `["dice-roll", player, request_id.to_le_bytes()]`
///
/// The `result` field is `0` while the roll is pending (waiting for VRF
/// fulfillment) and `1..=6` once settled.
#[account]
#[derive(InitSpace)]
pub struct DiceRoll {
    /// The player who requested the roll.
    pub player: Pubkey,
    /// The VRF request ID associated with this roll.
    pub vrf_request_id: u64,
    /// Dice outcome: 0 = pending, 1-6 = settled face value.
    pub result: u8,
    /// PDA bump seed cached for efficient re-derivation.
    pub bump: u8,
}

/// Error codes for the roll-dice program.
#[error_code]
pub enum RollDiceError {
    /// The provided treasury account does not match the VRF config's treasury.
    #[msg("Treasury does not match VRF config")]
    TreasuryMismatch,
    /// Attempted to settle before the VRF oracle fulfilled the request.
    #[msg("VRF request has not been fulfilled")]
    VrfRequestNotFulfilled,
    /// Attempted to settle a roll that already has a non-zero result.
    #[msg("Dice roll has already been settled")]
    AlreadySettled,
}

/// Emitted when a player requests a new dice roll.
#[event]
pub struct DiceRollRequested {
    pub player: Pubkey,
    pub vrf_request_id: u64,
}

/// Emitted when a dice roll is settled with a final result.
#[event]
pub struct DiceRollSettled {
    pub player: Pubkey,
    pub vrf_request_id: u64,
    pub result: u8,
}

/// On-chain dice game powered by the VRF oracle.
///
/// Demonstrates how a consumer program integrates with the VRF system:
///
/// 1. **Request** — `request_roll` CPIs into `vrf_sol::request_randomness`.
/// 2. **Wait** — the off-chain oracle fulfills the VRF request automatically.
/// 3. **Settle** — `settle_roll` reads the randomness, CPIs `consume_randomness`,
///    and computes a fair dice result (1-6) from the first 8 bytes of output.
#[program]
pub mod roll_dice {
    use super::*;

    /// Request a dice roll by CPI-ing into the VRF program.
    ///
    /// Creates a `DiceRoll` PDA and a corresponding VRF randomness request.
    /// The dice roll remains pending until [`settle_roll`] is called after
    /// the oracle has fulfilled the VRF request.
    pub fn request_roll(ctx: Context<RequestRoll>, seed: [u8; 32]) -> Result<()> {
        let vrf_config = &ctx.accounts.vrf_config;
        let request_id = vrf_config.request_counter;

        // CPI into vrf_sol::request_randomness
        let cpi_accounts = vrf_sol::cpi::accounts::RequestRandomness {
            requester: ctx.accounts.player.to_account_info(),
            config: ctx.accounts.vrf_config.to_account_info(),
            request: ctx.accounts.vrf_request.to_account_info(),
            treasury: ctx.accounts.treasury.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.vrf_program.to_account_info(), cpi_accounts);
        vrf_sol::cpi::request_randomness(cpi_ctx, seed)?;

        let dice = &mut ctx.accounts.dice_roll;
        dice.player = ctx.accounts.player.key();
        dice.vrf_request_id = request_id;
        dice.result = 0;
        dice.bump = ctx.bumps.dice_roll;

        emit!(DiceRollRequested {
            player: ctx.accounts.player.key(),
            vrf_request_id: request_id,
        });

        msg!("Dice roll requested, vrf_request_id={}", request_id);
        Ok(())
    }

    /// Settle a dice roll after the VRF oracle has fulfilled the randomness.
    ///
    /// Reads the 32-byte randomness output, CPIs `consume_randomness` to mark
    /// it as used, then derives a fair 1-6 result from the first 8 bytes
    /// (u64 modulo 6 — bias is negligible at 2^64 range).
    pub fn settle_roll(ctx: Context<SettleRoll>, request_id: u64) -> Result<()> {
        let vrf_request = &ctx.accounts.vrf_request;
        let randomness = vrf_request.randomness;

        // CPI into vrf_sol::consume_randomness
        let cpi_accounts = vrf_sol::cpi::accounts::ConsumeRandomness {
            requester: ctx.accounts.player.to_account_info(),
            request: ctx.accounts.vrf_request.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.vrf_program.to_account_info(), cpi_accounts);
        vrf_sol::cpi::consume_randomness(cpi_ctx, request_id)?;

        // Derive dice value: interpret first 8 bytes as u64, then map to 1-6
        let random_value = u64::from_le_bytes(randomness[0..8].try_into().unwrap());
        let dice_value = (random_value % 6 + 1) as u8;

        let dice = &mut ctx.accounts.dice_roll;
        dice.result = dice_value;

        emit!(DiceRollSettled {
            player: ctx.accounts.player.key(),
            vrf_request_id: request_id,
            result: dice_value,
        });

        msg!("Dice rolled: {} (request_id={})", dice_value, request_id);
        Ok(())
    }
}

/// Accounts for [`roll_dice::request_roll`].
#[derive(Accounts)]
pub struct RequestRoll<'info> {
    /// The player requesting the roll; pays for accounts and the VRF fee.
    #[account(mut)]
    pub player: Signer<'info>,

    /// VRF config account (read for `request_counter`, mutated by the VRF CPI).
    /// CHECK: Validated by the VRF program during CPI.
    #[account(mut)]
    pub vrf_config: Account<'info, vrf_sol::state::VrfConfiguration>,

    /// VRF request account (created by the VRF program CPI).
    /// CHECK: Created and validated by the VRF program during CPI.
    #[account(mut)]
    pub vrf_request: UncheckedAccount<'info>,

    /// Fee recipient; must match the VRF config's treasury.
    /// CHECK: Validated by the constraint below.
    #[account(
        mut,
        constraint = treasury.key() == vrf_config.treasury @ RollDiceError::TreasuryMismatch,
    )]
    pub treasury: UncheckedAccount<'info>,

    /// Dice roll PDA. Seeds: `["dice-roll", player, counter.to_le_bytes()]`.
    #[account(
        init,
        payer = player,
        space = 8 + DiceRoll::INIT_SPACE,
        seeds = [b"dice-roll", player.key().as_ref(), &vrf_config.request_counter.to_le_bytes()],
        bump,
    )]
    pub dice_roll: Account<'info, DiceRoll>,

    pub vrf_program: Program<'info, vrf_sol::program::VrfSol>,
    pub system_program: Program<'info, System>,
}

/// Accounts for [`roll_dice::settle_roll`].
#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct SettleRoll<'info> {
    /// The player who owns this dice roll; must sign.
    pub player: Signer<'info>,

    /// The fulfilled VRF request to read randomness from and consume.
    /// Must be in `Fulfilled` status (1).
    #[account(
        mut,
        seeds = [b"request", request_id.to_le_bytes().as_ref()],
        bump = vrf_request.bump,
        seeds::program = vrf_program.key(),
        constraint = vrf_request.status == 1 @ RollDiceError::VrfRequestNotFulfilled,
    )]
    pub vrf_request: Account<'info, vrf_sol::state::RandomnessRequest>,

    /// The dice roll PDA to settle. Must belong to `player` and be unsettled (result == 0).
    #[account(
        mut,
        seeds = [b"dice-roll", player.key().as_ref(), &request_id.to_le_bytes()],
        bump = dice_roll.bump,
        constraint = dice_roll.player == player.key(),
        constraint = dice_roll.vrf_request_id == request_id,
        constraint = dice_roll.result == 0 @ RollDiceError::AlreadySettled,
    )]
    pub dice_roll: Account<'info, DiceRoll>,

    pub vrf_program: Program<'info, vrf_sol::program::VrfSol>,
}
