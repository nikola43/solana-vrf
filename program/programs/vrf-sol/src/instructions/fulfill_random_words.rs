use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::sysvar::instructions as sysvar_instructions;
use sha2::{Digest, Sha256};

use crate::ed25519::verify_ed25519_instruction;
use crate::errors::VrfError;
use crate::events::RandomWordsFulfilled;
use crate::state::{CoordinatorConfig, RandomnessRequest};

/// Accounts required to fulfill a pending randomness request.
///
/// The transaction **must** include a native Ed25519 signature-verify
/// instruction at index 0. After verification, the coordinator:
/// 1. Expands randomness into num_words values
/// 2. CPIs into the consumer program's `fulfill_random_words` instruction
/// 3. Closes the request PDA, returning rent to the requester
#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct FulfillRandomWords<'info> {
    /// Oracle authority that signs fulfillment proofs. Must match `config.authority`.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Coordinator configuration PDA (used to verify authority and as CPI signer).
    #[account(
        seeds = [b"coordinator-config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ VrfError::Unauthorized,
    )]
    pub config: Account<'info, CoordinatorConfig>,

    /// The request PDA to fulfill. Must be in `Pending` status.
    #[account(
        mut,
        seeds = [b"request", request_id.to_le_bytes().as_ref()],
        bump = request.bump,
        constraint = request.status == RandomnessRequest::STATUS_PENDING @ VrfError::RequestNotPending,
    )]
    pub request: Account<'info, RandomnessRequest>,

    /// The original requester who receives rent refund when request is closed.
    /// CHECK: Validated by matching request.requester.
    #[account(
        mut,
        constraint = requester.key() == request.requester @ VrfError::Unauthorized,
    )]
    pub requester: UncheckedAccount<'info>,

    /// The consumer program to CPI into for the callback.
    /// CHECK: Validated by matching request.consumer_program.
    #[account(
        constraint = consumer_program.key() == request.consumer_program @ VrfError::InvalidConsumerProgram,
    )]
    pub consumer_program: UncheckedAccount<'info>,

    /// Native Instructions sysvar used to introspect the Ed25519 instruction.
    /// CHECK: Validated by the address constraint.
    #[account(address = sysvar_instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    // remaining_accounts: consumer-specific accounts for the callback CPI
}

/// Expand base randomness into multiple words: `word[i] = SHA256(randomness || i_le_bytes)`.
fn expand_randomness(base_randomness: &[u8; 32], num_words: u32) -> Vec<[u8; 32]> {
    let mut words = Vec::with_capacity(num_words as usize);
    for i in 0..num_words {
        let mut hasher = Sha256::new();
        hasher.update(base_randomness);
        hasher.update(i.to_le_bytes());
        let hash = hasher.finalize();
        let mut word = [0u8; 32];
        word.copy_from_slice(&hash);
        words.push(word);
    }
    words
}

/// Build the `fulfill_random_words` discriminator for the consumer callback.
///
/// Consumer programs must implement: `fulfill_random_words(request_id: u64, random_words: Vec<[u8; 32]>)`
fn consumer_callback_discriminator() -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(b"global:fulfill_random_words");
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Fulfill a pending randomness request with callback delivery.
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, FulfillRandomWords<'info>>,
    request_id: u64,
    randomness: [u8; 32],
) -> Result<()> {
    // 1. Verify Ed25519 signature proof
    verify_ed25519_instruction(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.config.authority,
        request_id,
        &randomness,
    )?;

    let request = &ctx.accounts.request;
    let num_words = request.num_words;

    // 2. Expand base randomness into num_words values
    let random_words = expand_randomness(&randomness, num_words);

    // 3. Update request state
    let request = &mut ctx.accounts.request;
    request.randomness = randomness;
    request.status = RandomnessRequest::STATUS_FULFILLED;
    request.fulfilled_slot = Clock::get()?.slot;

    // 4. CPI into consumer program's fulfill_random_words instruction
    // The coordinator-config PDA signs the CPI so the consumer can verify the caller.
    let config_bump = ctx.accounts.config.bump;
    let signer_seeds: &[&[u8]] = &[b"coordinator-config", &[config_bump]];

    // Build callback instruction data: discriminator + request_id + random_words (borsh-encoded Vec)
    let mut callback_data = Vec::new();
    callback_data.extend_from_slice(&consumer_callback_discriminator());
    callback_data.extend_from_slice(&request_id.to_le_bytes());
    // Borsh Vec encoding: length as u32 LE, then each [u8; 32] element
    callback_data.extend_from_slice(&num_words.to_le_bytes());
    for word in &random_words {
        callback_data.extend_from_slice(word);
    }

    // Build account metas for the consumer callback.
    // The first account is always the coordinator-config PDA as signer.
    // Remaining accounts are passed through from the transaction's remaining_accounts.
    let mut callback_accounts = Vec::with_capacity(1 + ctx.remaining_accounts.len());
    callback_accounts.push(AccountMeta::new_readonly(
        ctx.accounts.config.key(),
        true, // signer (PDA signs via invoke_signed)
    ));
    for account in ctx.remaining_accounts {
        if account.is_writable {
            callback_accounts.push(AccountMeta::new(*account.key, account.is_signer));
        } else {
            callback_accounts.push(AccountMeta::new_readonly(*account.key, account.is_signer));
        }
    }

    let callback_ix = Instruction {
        program_id: ctx.accounts.consumer_program.key(),
        accounts: callback_accounts,
        data: callback_data,
    };

    // Collect all account infos needed for the CPI
    let mut cpi_account_infos = Vec::with_capacity(2 + ctx.remaining_accounts.len());
    cpi_account_infos.push(ctx.accounts.config.to_account_info());
    for account in ctx.remaining_accounts {
        cpi_account_infos.push(account.to_account_info());
    }

    invoke_signed(&callback_ix, &cpi_account_infos, &[signer_seeds])
        .map_err(|_| error!(VrfError::CallbackFailed))?;

    // 5. Close request PDA, return rent to requester
    let request_account_info = ctx.accounts.request.to_account_info();
    let requester_account_info = ctx.accounts.requester.to_account_info();

    // Transfer all lamports from request to requester
    let request_lamports = request_account_info.lamports();
    **request_account_info.try_borrow_mut_lamports()? = 0;
    **requester_account_info.try_borrow_mut_lamports()? = requester_account_info
        .lamports()
        .checked_add(request_lamports)
        .unwrap();

    // Zero out account data to mark as closed
    request_account_info.assign(&anchor_lang::solana_program::system_program::ID);
    let mut data = request_account_info.try_borrow_mut_data()?;
    for byte in data.iter_mut() {
        *byte = 0;
    }

    // 6. Emit event
    emit!(RandomWordsFulfilled {
        request_id,
        randomness,
        consumer_program: ctx.accounts.consumer_program.key(),
    });

    Ok(())
}
