use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as sysvar_instructions;
use solana_sdk_ids::ed25519_program;

use crate::errors::VrfError;

/// Introspect the Instructions sysvar to verify that instruction at index 0 is
/// a valid Ed25519 signature verification with the expected authority and message.
///
/// ## Ed25519 instruction data layout
///
/// ```text
/// [0]       num_signatures (u8) — must be 1
/// [1]       padding (u8)
/// [2..16]   Ed25519SignatureOffsets (7 x u16 LE):
///             signature_offset, signature_instruction_index,
///             public_key_offset, public_key_instruction_index,
///             message_data_offset, message_data_size,
///             message_instruction_index
/// [16..]    payload: public_key (32) + signature (64) + message (variable)
/// ```
///
/// All `*_instruction_index` fields must be `0xFFFF` (self-referencing), meaning
/// the signature, public key, and message are all embedded in the same instruction.
pub fn verify_ed25519_instruction(
    instructions_sysvar: &UncheckedAccount,
    expected_pubkey: &Pubkey,
    request_id: u64,
    randomness: &[u8; 32],
) -> Result<()> {
    let ix = sysvar_instructions::load_instruction_at_checked(
        0,
        &instructions_sysvar.to_account_info(),
    )
    .map_err(|_| VrfError::InvalidEd25519Instruction)?;

    require_keys_eq!(ix.program_id, ed25519_program::ID, VrfError::InvalidEd25519Program);

    let data = &ix.data;
    require!(data.len() >= 16, VrfError::InvalidEd25519Instruction);

    let num_signatures = data[0];
    require!(num_signatures == 1, VrfError::InvalidSignatureCount);

    // Parse Ed25519SignatureOffsets
    let sig_offset = u16::from_le_bytes([data[2], data[3]]);
    let sig_ix_index = u16::from_le_bytes([data[4], data[5]]);
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]);
    let pubkey_ix_index = u16::from_le_bytes([data[8], data[9]]);
    let msg_offset = u16::from_le_bytes([data[10], data[11]]);
    let msg_size = u16::from_le_bytes([data[12], data[13]]);
    let msg_ix_index = u16::from_le_bytes([data[14], data[15]]);

    // All indices must be self-referencing (0xFFFF = data within the same instruction)
    let _ = sig_offset;
    require!(
        sig_ix_index == 0xFFFF,
        VrfError::InvalidEd25519InstructionIndex
    );
    require!(
        pubkey_ix_index == 0xFFFF,
        VrfError::InvalidEd25519InstructionIndex
    );
    require!(
        msg_ix_index == 0xFFFF,
        VrfError::InvalidEd25519InstructionIndex
    );

    // Verify the embedded public key matches the configured authority
    let pubkey_start = pubkey_offset as usize;
    let pubkey_end = pubkey_start + 32;
    require!(data.len() >= pubkey_end, VrfError::InvalidEd25519Instruction);
    let pubkey_bytes = &data[pubkey_start..pubkey_end];
    require!(
        pubkey_bytes == expected_pubkey.to_bytes(),
        VrfError::InvalidEd25519Pubkey
    );

    // Verify the signed message matches `request_id (8 LE) || randomness (32)`
    let msg_start = msg_offset as usize;
    let msg_end = msg_start + msg_size as usize;
    require!(data.len() >= msg_end, VrfError::InvalidEd25519Instruction);
    let message = &data[msg_start..msg_end];

    let mut expected_message = Vec::with_capacity(40);
    expected_message.extend_from_slice(&request_id.to_le_bytes());
    expected_message.extend_from_slice(randomness);

    require!(
        message == expected_message.as_slice(),
        VrfError::InvalidEd25519Message
    );

    Ok(())
}
