use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as sysvar_instructions;

use crate::compressed_state::CompressedRandomnessRequest;
use crate::ed25519::verify_ed25519_instruction;
use crate::errors::VrfError;
use crate::events::RandomnessFulfilled;
use crate::light_cpi::{
    invoke_light_system_program, CompressedAccountData, InputCompressedAccountWithMerkleContext,
    InvokeCpiInstructionData, OutputCompressedAccount,
    OutputCompressedAccountWithPackedContext, PackedMerkleContext, ValidityProof,
};
use crate::state::VrfConfiguration;

/// Accounts required to fulfill a compressed randomness request.
///
/// Similar to regular fulfillment but operates on compressed state via
/// the Light System Program CPI. The client passes the current compressed
/// account state and Merkle proof data.
#[derive(Accounts)]
pub struct FulfillRandomnessCompressed<'info> {
    /// Oracle authority that signs fulfillment proofs. Must match `config.authority`.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// VRF configuration PDA (read-only; used to verify authority).
    #[account(
        seeds = [b"vrf-config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ VrfError::Unauthorized,
    )]
    pub config: Account<'info, VrfConfiguration>,

    /// Native Instructions sysvar used to introspect the Ed25519 instruction.
    /// CHECK: Validated by the address constraint.
    #[account(address = sysvar_instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    // remaining_accounts: Light Protocol system accounts + tree accounts
}

/// Fulfill a compressed randomness request.
///
/// 1. Verifies the Ed25519 signature proof (same as regular fulfill).
/// 2. Validates the current compressed account state (passed by client).
/// 3. Updates the compressed account via CPI to the Light System Program:
///    - Nullifies the old state (input)
///    - Creates new state with status=Fulfilled and randomness written (output)
/// 4. Emits [`RandomnessFulfilled`].
///
/// ## Arguments
/// - `request_id` — The request ID being fulfilled
/// - `randomness` — The VRF output
/// - `proof` — ZK validity proof for the current compressed account state
/// - `merkle_context` — Merkle tree position of the current compressed account
/// - `root_index` — Root index for Merkle proof verification
/// - `current_request` — Current compressed account data (from Photon indexer)
/// - `input_data_hash` — Hash of the current compressed account data
/// - `address` — Compressed account address
/// - `output_state_tree_index` — Index of the output state tree in remaining_accounts
/// - `output_data_hash` — Hash of the updated compressed account data (computed client-side)
pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, FulfillRandomnessCompressed<'info>>,
    request_id: u64,
    randomness: [u8; 32],
    proof: ValidityProof,
    merkle_context: PackedMerkleContext,
    root_index: u16,
    current_request: CompressedRandomnessRequest,
    input_data_hash: [u8; 32],
    address: [u8; 32],
    output_state_tree_index: u8,
    output_data_hash: [u8; 32],
) -> Result<()> {
    // 1. Verify the Ed25519 signature proof
    verify_ed25519_instruction(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.config.authority,
        request_id,
        &randomness,
    )?;

    // 2. Validate the current compressed account state
    require!(
        current_request.request_id == request_id,
        VrfError::CompressedAccountMismatch
    );
    require!(
        current_request.status == CompressedRandomnessRequest::STATUS_PENDING,
        VrfError::RequestNotPending
    );

    // 3. Build the input (current state to be nullified)
    let mut current_serialized = Vec::new();
    current_request.serialize(&mut current_serialized)?;

    let input_account = InputCompressedAccountWithMerkleContext {
        compressed_account: OutputCompressedAccount {
            owner: crate::ID,
            lamports: 0,
            data: Some(CompressedAccountData {
                discriminator: CompressedRandomnessRequest::LIGHT_DISCRIMINATOR,
                data: current_serialized,
                data_hash: input_data_hash,
            }),
            address: Some(address),
        },
        merkle_context,
        root_index,
        read_only: false,
    };

    // 4. Build the output (updated state with randomness)
    let updated_request = CompressedRandomnessRequest {
        request_id,
        requester: current_request.requester,
        seed: current_request.seed,
        request_slot: current_request.request_slot,
        status: CompressedRandomnessRequest::STATUS_FULFILLED,
        randomness,
    };

    let mut updated_serialized = Vec::new();
    updated_request.serialize(&mut updated_serialized)?;

    let output_account = OutputCompressedAccountWithPackedContext {
        compressed_account: OutputCompressedAccount {
            owner: crate::ID,
            lamports: 0,
            data: Some(CompressedAccountData {
                discriminator: CompressedRandomnessRequest::LIGHT_DISCRIMINATOR,
                data: updated_serialized,
                data_hash: output_data_hash,
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

    // 5. Invoke Light System Program: nullify old state + create new state
    invoke_light_system_program(
        &crate::ID,
        &ctx.accounts.authority.to_account_info(),
        cpi_authority_bump,
        ctx.remaining_accounts,
        InvokeCpiInstructionData {
            proof: Some(proof),
            input_compressed_accounts: vec![input_account],
            output_compressed_accounts: vec![output_account],
            new_address_params: vec![],
            relay_fee: None,
            compress_or_decompress_lamports: None,
            is_compress: false,
            signer_seeds: vec![],
            cpi_context: None,
        },
    )?;

    // 6. Emit event
    emit!(RandomnessFulfilled {
        request_id,
        randomness,
    });

    Ok(())
}
