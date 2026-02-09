use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::compressed_state::CompressedRandomnessRequest;
use crate::errors::VrfError;
use crate::events::CompressedRandomnessRequested;
use crate::light_cpi::{
    invoke_light_system_program, CompressedAccountData, InvokeCpiInstructionData,
    NewAddressParamsPacked, OutputCompressedAccount, OutputCompressedAccountWithPackedContext,
    ValidityProof,
};
use crate::state::VrfConfiguration;

/// Accounts for creating a compressed randomness request.
///
/// Uses the same `VrfConfiguration` PDA for counter/fee management as regular
/// requests. The actual compressed account is created via CPI to the Light
/// System Program using `remaining_accounts`.
#[derive(Accounts)]
pub struct RequestRandomnessCompressed<'info> {
    /// The account requesting randomness; pays the fee and transaction cost.
    #[account(mut)]
    pub requester: Signer<'info>,

    /// VRF configuration PDA (mutated to increment `request_counter`).
    #[account(
        mut,
        seeds = [b"vrf-config"],
        bump = config.bump,
    )]
    pub config: Account<'info, VrfConfiguration>,

    /// Fee recipient; must match `config.treasury`.
    /// CHECK: Validated by the constraint below.
    #[account(
        mut,
        constraint = treasury.key() == config.treasury,
    )]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: Light Protocol system accounts + tree accounts
    // (packed by the client using @lightprotocol/stateless.js)
}

/// Create a compressed randomness request.
///
/// 1. Transfers `config.fee` lamports from `requester` to `treasury`.
/// 2. Creates a compressed account via CPI to the Light System Program.
/// 3. Increments `config.request_counter`.
/// 4. Emits [`CompressedRandomnessRequested`].
///
/// ## Arguments
/// - `seed` — 32-byte user-provided entropy
/// - `proof` — ZK validity proof from the Photon indexer
/// - `address_tree_info` — Address tree params for the new compressed account
/// - `output_state_tree_index` — Index of the output state tree in remaining_accounts
/// - `data_hash` — Poseidon hash of the compressed account data (computed client-side)
/// - `address` — Derived compressed account address (computed client-side)
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, RequestRandomnessCompressed<'info>>,
    seed: [u8; 32],
    proof: ValidityProof,
    new_address_params: NewAddressParamsPacked,
    output_state_tree_index: u8,
    data_hash: [u8; 32],
    address: [u8; 32],
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let request_id = config.request_counter;

    // Charge the fee
    if config.fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.requester.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            ),
            config.fee,
        )?;
    }

    // Build the compressed account data
    let compressed_request = CompressedRandomnessRequest {
        request_id,
        requester: ctx.accounts.requester.key(),
        seed,
        request_slot: Clock::get()?.slot,
        status: CompressedRandomnessRequest::STATUS_PENDING,
        randomness: [0u8; 32],
    };

    let mut serialized_data = Vec::new();
    compressed_request.serialize(&mut serialized_data)?;

    let output_account = OutputCompressedAccountWithPackedContext {
        compressed_account: OutputCompressedAccount {
            owner: crate::ID,
            lamports: 0,
            data: Some(CompressedAccountData {
                discriminator: CompressedRandomnessRequest::LIGHT_DISCRIMINATOR,
                data: serialized_data,
                data_hash,
            }),
            address: Some(address),
        },
        merkle_tree_index: output_state_tree_index,
    };

    // CPI authority PDA bump
    let (_, cpi_authority_bump) = Pubkey::find_program_address(
        &[b"cpi_authority"],
        &crate::ID,
    );

    // Invoke the Light System Program to create the compressed account
    invoke_light_system_program(
        &crate::ID,
        &ctx.accounts.requester.to_account_info(),
        cpi_authority_bump,
        ctx.remaining_accounts,
        InvokeCpiInstructionData {
            proof: Some(proof),
            input_compressed_accounts: vec![],
            output_compressed_accounts: vec![output_account],
            new_address_params: vec![new_address_params],
            relay_fee: None,
            compress_or_decompress_lamports: None,
            is_compress: false,
            signer_seeds: vec![],
            cpi_context: None,
        },
    )?;

    // Increment the counter
    config.request_counter = config
        .request_counter
        .checked_add(1)
        .ok_or(VrfError::CounterOverflow)?;

    emit!(CompressedRandomnessRequested {
        request_id,
        requester: ctx.accounts.requester.key(),
        seed,
        request_slot: compressed_request.request_slot,
    });

    Ok(())
}
