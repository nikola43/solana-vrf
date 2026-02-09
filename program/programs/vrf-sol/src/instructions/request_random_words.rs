use anchor_lang::prelude::*;

use crate::errors::VrfError;
use crate::events::RandomWordsRequested;
use crate::state::{CoordinatorConfig, ConsumerRegistration, RandomnessRequest, Subscription};

/// Accounts required to request random words.
///
/// Called via CPI from a registered consumer program.
#[derive(Accounts)]
pub struct RequestRandomWords<'info> {
    /// The account paying for the request PDA rent (typically the end-user).
    #[account(mut)]
    pub requester: Signer<'info>,

    /// Coordinator configuration PDA (mutated to increment `request_counter`).
    #[account(
        mut,
        seeds = [b"coordinator-config"],
        bump = config.bump,
    )]
    pub config: Account<'info, CoordinatorConfig>,

    /// The subscription funding this request. Balance is deducted.
    #[account(
        mut,
        seeds = [b"subscription", subscription.id.to_le_bytes().as_ref()],
        bump = subscription.bump,
    )]
    pub subscription: Account<'info, Subscription>,

    /// Consumer registration proving the calling program is authorized.
    #[account(
        seeds = [b"consumer", subscription.id.to_le_bytes().as_ref(), consumer_program.key().as_ref()],
        bump = consumer_registration.bump,
    )]
    pub consumer_registration: Account<'info, ConsumerRegistration>,

    /// The consumer program making this CPI call.
    /// CHECK: Validated via consumer_registration PDA derivation.
    pub consumer_program: UncheckedAccount<'info>,

    /// New request PDA. Seeds: `["request", counter.to_le_bytes()]`.
    #[account(
        init,
        payer = requester,
        space = 8 + RandomnessRequest::INIT_SPACE,
        seeds = [b"request", config.request_counter.to_le_bytes().as_ref()],
        bump,
    )]
    pub request: Account<'info, RandomnessRequest>,

    pub system_program: Program<'info, System>,
}

/// Request random words from the VRF oracle.
pub fn handler(
    ctx: Context<RequestRandomWords>,
    num_words: u32,
    seed: [u8; 32],
    callback_compute_limit: u32,
) -> Result<()> {
    let config = &ctx.accounts.config;

    // Validate num_words
    require!(
        num_words > 0 && num_words <= config.max_num_words,
        VrfError::NumWordsTooLarge
    );

    // Calculate fee and check subscription balance
    let total_fee = config
        .fee_per_word
        .checked_mul(num_words as u64)
        .ok_or(VrfError::CounterOverflow)?;

    let subscription = &mut ctx.accounts.subscription;
    require!(
        subscription.balance >= total_fee,
        VrfError::InsufficientSubscriptionBalance
    );

    // Deduct fee from subscription balance
    subscription.balance = subscription
        .balance
        .checked_sub(total_fee)
        .ok_or(VrfError::InsufficientSubscriptionBalance)?;

    subscription.req_count = subscription.req_count.checked_add(1).unwrap();

    // Initialize the request PDA
    let config = &mut ctx.accounts.config;
    let request_id = config.request_counter;

    let request = &mut ctx.accounts.request;
    request.request_id = request_id;
    request.subscription_id = ctx.accounts.subscription.id;
    request.consumer_program = ctx.accounts.consumer_program.key();
    request.requester = ctx.accounts.requester.key();
    request.num_words = num_words;
    request.seed = seed;
    request.request_slot = Clock::get()?.slot;
    request.callback_compute_limit = callback_compute_limit;
    request.status = RandomnessRequest::STATUS_PENDING;
    request.randomness = [0u8; 32];
    request.fulfilled_slot = 0;
    request.bump = ctx.bumps.request;

    config.request_counter = config
        .request_counter
        .checked_add(1)
        .ok_or(VrfError::CounterOverflow)?;

    emit!(RandomWordsRequested {
        request_id,
        subscription_id: request.subscription_id,
        consumer_program: request.consumer_program,
        requester: request.requester,
        num_words,
        seed,
        request_slot: request.request_slot,
        callback_compute_limit,
    });

    Ok(())
}
