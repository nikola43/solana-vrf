use anchor_lang::prelude::*;

declare_id!("7Q5b9aimnHmR8ooooRqxgfYfnLmPi6qrVR9GrJ1b6fDp");

/// Game configuration storing the coordinator program and subscription.
///
/// Seeds: `["game-config"]`
#[account]
#[derive(InitSpace)]
pub struct GameConfig {
    /// The VRF coordinator program ID.
    pub coordinator_program: Pubkey,
    /// The subscription ID used for VRF requests.
    pub subscription_id: u64,
    /// Admin who can update the configuration.
    pub admin: Pubkey,
    /// PDA bump seed.
    pub bump: u8,
}

/// A dice roll that is backed by VRF randomness.
///
/// Seeds: `["dice-result", player, request_id.to_le_bytes()]`
///
/// The `result` field is `0` while the roll is pending (waiting for VRF
/// fulfillment callback) and `1..=6` once settled.
#[account]
#[derive(InitSpace)]
pub struct DiceRoll {
    /// The player who requested the roll.
    pub player: Pubkey,
    /// The VRF request ID associated with this roll.
    pub vrf_request_id: u64,
    /// Dice outcome: 0 = pending, 1-6 = settled face value.
    pub result: u8,
    /// PDA bump seed.
    pub bump: u8,
}

/// Error codes for the roll-dice program.
#[error_code]
pub enum RollDiceError {
    /// The caller is not the coordinator-config PDA signer.
    #[msg("Invalid coordinator signer")]
    InvalidCoordinator,
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

/// On-chain dice game powered by the VRF coordinator.
///
/// Demonstrates the Chainlink VRF v2-style consumer pattern:
///
/// 1. **Initialize** — store coordinator program and subscription ID.
/// 2. **Request** — `request_roll` CPIs into `vrf_sol::request_random_words`.
/// 3. **Callback** — `fulfill_random_words` is called by the coordinator via CPI
///    with the random words. The dice result is derived from the first word.
#[program]
pub mod roll_dice {
    use super::*;

    /// Initialize the game configuration.
    pub fn initialize(
        ctx: Context<InitializeGame>,
        coordinator_program: Pubkey,
        subscription_id: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.game_config;
        config.coordinator_program = coordinator_program;
        config.subscription_id = subscription_id;
        config.admin = ctx.accounts.admin.key();
        config.bump = ctx.bumps.game_config;
        Ok(())
    }

    /// Request a dice roll by CPI-ing into the VRF coordinator.
    pub fn request_roll(ctx: Context<RequestRoll>, seed: [u8; 32]) -> Result<()> {
        let vrf_config = &ctx.accounts.vrf_config;
        let request_id = vrf_config.request_counter;

        // CPI into vrf_sol::request_random_words
        let cpi_accounts = vrf_sol::cpi::accounts::RequestRandomWords {
            requester: ctx.accounts.player.to_account_info(),
            config: ctx.accounts.vrf_config.to_account_info(),
            subscription: ctx.accounts.subscription.to_account_info(),
            consumer_registration: ctx.accounts.consumer_registration.to_account_info(),
            consumer_program: ctx.accounts.this_program.to_account_info(),
            request: ctx.accounts.vrf_request.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.vrf_program.to_account_info(), cpi_accounts);
        vrf_sol::cpi::request_random_words(
            cpi_ctx,
            1,    // num_words
            seed,
            200_000, // callback_compute_limit
        )?;

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

    /// Callback from the VRF coordinator with random words.
    ///
    /// The coordinator-config PDA signs this CPI. We verify the signer
    /// matches the expected coordinator-config PDA derived from our stored
    /// coordinator_program.
    pub fn fulfill_random_words(
        ctx: Context<FulfillRandomWords>,
        request_id: u64,
        random_words: Vec<[u8; 32]>,
    ) -> Result<()> {
        // Verify the coordinator signer is the expected coordinator-config PDA
        let game_config = &ctx.accounts.game_config;
        let (expected_coordinator_pda, _) = Pubkey::find_program_address(
            &[b"coordinator-config"],
            &game_config.coordinator_program,
        );
        require!(
            ctx.accounts.coordinator_config.key() == expected_coordinator_pda,
            RollDiceError::InvalidCoordinator
        );

        // Derive dice value from first random word
        let first_word = &random_words[0];
        let random_value = u64::from_le_bytes(first_word[0..8].try_into().unwrap());
        let dice_value = (random_value % 6 + 1) as u8;

        let dice = &mut ctx.accounts.dice_roll;
        require!(dice.result == 0, RollDiceError::AlreadySettled);
        dice.result = dice_value;

        emit!(DiceRollSettled {
            player: dice.player,
            vrf_request_id: request_id,
            result: dice_value,
        });

        msg!("Dice rolled: {} (request_id={})", dice_value, request_id);
        Ok(())
    }
}

/// Accounts for [`roll_dice::initialize`].
#[derive(Accounts)]
pub struct InitializeGame<'info> {
    /// The admin who pays for and controls the game config.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Game configuration PDA.
    #[account(
        init,
        payer = admin,
        space = 8 + GameConfig::INIT_SPACE,
        seeds = [b"game-config"],
        bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    pub system_program: Program<'info, System>,
}

/// Accounts for [`roll_dice::request_roll`].
#[derive(Accounts)]
pub struct RequestRoll<'info> {
    /// The player requesting the roll; pays for accounts and the VRF fee.
    #[account(mut)]
    pub player: Signer<'info>,

    /// Game configuration.
    #[account(
        seeds = [b"game-config"],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    /// VRF coordinator config account (read for `request_counter`, mutated by CPI).
    /// CHECK: Validated by the VRF program during CPI.
    #[account(mut)]
    pub vrf_config: Account<'info, vrf_sol::state::CoordinatorConfig>,

    /// Subscription account (balance deducted by CPI).
    /// CHECK: Validated by the VRF program during CPI.
    #[account(mut)]
    pub subscription: Account<'info, vrf_sol::state::Subscription>,

    /// Consumer registration proving this program is authorized.
    /// CHECK: Validated by the VRF program during CPI.
    pub consumer_registration: Account<'info, vrf_sol::state::ConsumerRegistration>,

    /// VRF request account (created by the VRF program CPI).
    /// CHECK: Created and validated by the VRF program during CPI.
    #[account(mut)]
    pub vrf_request: UncheckedAccount<'info>,

    /// This program's ID, passed as consumer_program to the coordinator.
    /// CHECK: Must be this program's ID.
    #[account(address = crate::ID)]
    pub this_program: UncheckedAccount<'info>,

    /// Dice roll PDA. Seeds: `["dice-result", player, counter.to_le_bytes()]`.
    #[account(
        init,
        payer = player,
        space = 8 + DiceRoll::INIT_SPACE,
        seeds = [b"dice-result", player.key().as_ref(), &vrf_config.request_counter.to_le_bytes()],
        bump,
    )]
    pub dice_roll: Account<'info, DiceRoll>,

    pub vrf_program: Program<'info, vrf_sol::program::VrfSol>,
    pub system_program: Program<'info, System>,
}

/// Accounts for [`roll_dice::fulfill_random_words`].
///
/// Called by the VRF coordinator via CPI. The coordinator-config PDA
/// is the signer, proving this callback comes from the real coordinator.
#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct FulfillRandomWords<'info> {
    /// The coordinator-config PDA that signed this CPI.
    pub coordinator_config: Signer<'info>,

    /// Game configuration (to look up coordinator_program for PDA verification).
    #[account(
        seeds = [b"game-config"],
        bump = game_config.bump,
    )]
    pub game_config: Account<'info, GameConfig>,

    /// The dice roll PDA to settle.
    #[account(
        mut,
        seeds = [b"dice-result", dice_roll.player.as_ref(), &request_id.to_le_bytes()],
        bump = dice_roll.bump,
        constraint = dice_roll.vrf_request_id == request_id,
        constraint = dice_roll.result == 0 @ RollDiceError::AlreadySettled,
    )]
    pub dice_roll: Account<'info, DiceRoll>,
}
