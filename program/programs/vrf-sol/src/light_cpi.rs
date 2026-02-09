//! Vendored Light Protocol CPI helpers.
//!
//! Since `light-sdk 0.20` has Solana SDK version conflicts with Anchor 0.32.1,
//! we vendor the minimal CPI logic needed to create and update compressed
//! accounts on devnet. The client side (SDK/backend) handles validity proofs,
//! tree account packing, and Photon indexer queries.
//!
//! This module provides:
//! - Constants for Light Protocol program IDs
//! - Borsh-serializable types matching Light System Program's instruction format
//! - A thin CPI builder that constructs and invokes the Light System Program

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;

// ---------------------------------------------------------------------------
// Light Protocol program IDs (devnet + mainnet)
// ---------------------------------------------------------------------------

/// Light System Program — verifies proofs and manages compressed account state.
pub const LIGHT_SYSTEM_PROGRAM_ID: Pubkey =
    pubkey!("SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7");

/// Account Compression Program — manages Merkle trees.
pub const ACCOUNT_COMPRESSION_PROGRAM_ID: Pubkey =
    pubkey!("compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq");

/// Noop Program — used for event logging in Light Protocol.
pub const NOOP_PROGRAM_ID: Pubkey =
    pubkey!("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");

/// Pre-computed Anchor discriminator for `invoke_cpi`:
/// `sha256("global:invoke_cpi")[..8]`
const INVOKE_CPI_DISCRIMINATOR: [u8; 8] = [49, 212, 191, 129, 39, 194, 43, 196];

// ---------------------------------------------------------------------------
// Types matching Light System Program's instruction data format
// ---------------------------------------------------------------------------

/// Groth16 validity proof (128 bytes). Obtained from Photon indexer's
/// `getValidityProof` RPC method.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ValidityProof {
    pub a: [u8; 32],
    pub b: [u8; 64],
    pub c: [u8; 32],
}

impl Default for ValidityProof {
    fn default() -> Self {
        Self {
            a: [0u8; 32],
            b: [0u8; 64],
            c: [0u8; 32],
        }
    }
}

/// Compressed account data as expected by the Light System Program.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CompressedAccountData {
    /// First 8 bytes of SHA256(struct_name).
    pub discriminator: [u8; 8],
    /// Borsh-serialized account data (after discriminator).
    pub data: Vec<u8>,
    /// Poseidon or SHA256 hash of the data (computed client-side).
    pub data_hash: [u8; 32],
}

/// A compressed account record for output (new or updated state).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OutputCompressedAccount {
    /// Program that owns this compressed account.
    pub owner: Pubkey,
    /// Lamports stored in the compressed account (typically 0).
    pub lamports: u64,
    /// Optional account data.
    pub data: Option<CompressedAccountData>,
    /// Optional 32-byte address (for addressable compressed accounts).
    pub address: Option<[u8; 32]>,
}

/// Output compressed account with tree index.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OutputCompressedAccountWithPackedContext {
    pub compressed_account: OutputCompressedAccount,
    /// Index of the output state tree in remaining_accounts.
    pub merkle_tree_index: u8,
}

/// Merkle context for an input compressed account.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PackedMerkleContext {
    /// Index of the state Merkle tree in remaining_accounts.
    pub merkle_tree_pubkey_index: u8,
    /// Index of the nullifier queue in remaining_accounts.
    pub nullifier_queue_pubkey_index: u8,
    /// Leaf index in the Merkle tree.
    pub leaf_index: u32,
    /// Optional queue index for batched trees.
    pub queue_index: Option<QueueIndex>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct QueueIndex {
    /// Index of the queue in remaining_accounts.
    pub queue_id: u8,
    /// Index within the queue.
    pub index: u16,
}

/// Input compressed account with its Merkle proof context.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InputCompressedAccountWithMerkleContext {
    pub compressed_account: OutputCompressedAccount,
    pub merkle_context: PackedMerkleContext,
    /// Root index for the Merkle proof.
    pub root_index: u16,
    /// If true, account is read-only (not nullified).
    pub read_only: bool,
}

/// Address tree info for creating new addressable compressed accounts.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct NewAddressParamsPacked {
    pub seed: [u8; 32],
    pub address_queue_account_index: u8,
    pub address_merkle_tree_account_index: u8,
    pub address_merkle_tree_root_index: u16,
}

// ---------------------------------------------------------------------------
// Light System Program CPI instruction data
// ---------------------------------------------------------------------------

/// Instruction data for the Light System Program `invoke_cpi` instruction.
///
/// This matches the Borsh serialization format expected by the Light System
/// Program. The client constructs validity proofs and Merkle contexts;
/// the on-chain program populates account data and invokes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InvokeCpiInstructionData {
    pub proof: Option<ValidityProof>,
    pub input_compressed_accounts: Vec<InputCompressedAccountWithMerkleContext>,
    pub output_compressed_accounts: Vec<OutputCompressedAccountWithPackedContext>,
    pub new_address_params: Vec<NewAddressParamsPacked>,
    pub relay_fee: Option<u64>,
    pub compress_or_decompress_lamports: Option<u64>,
    pub is_compress: bool,
    pub signer_seeds: Vec<Vec<u8>>,
    pub cpi_context: Option<CpiContext>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CpiContext {
    pub set_context: bool,
    pub first_set_context: bool,
    pub cpi_context_account_index: u8,
}

/// Build and invoke a CPI to the Light System Program.
///
/// The caller passes pre-built instruction data (from the client) and the
/// program signs via its CPI authority PDA.
///
/// ## Account ordering in `remaining_accounts`:
/// 0. Light System Program
/// 1. Registered Program PDA
/// 2. Noop Program
/// 3. Account Compression Authority
/// 4. Account Compression Program
/// 5. CPI Authority PDA (this program's signer)
/// 6. System Program
/// 7+ Packed tree accounts (state trees, queues, address trees)
pub fn invoke_light_system_program<'info>(
    _program_id: &Pubkey,
    fee_payer: &AccountInfo<'info>,
    cpi_authority_bump: u8,
    remaining_accounts: &[AccountInfo<'info>],
    instruction_data: InvokeCpiInstructionData,
) -> Result<()> {
    // The invoke_cpi instruction discriminator
    // sha256("global:invoke_cpi")[..8]
    // Pre-computed to avoid runtime dependency
    let discriminator: [u8; 8] = INVOKE_CPI_DISCRIMINATOR;

    let mut data = Vec::new();
    data.extend_from_slice(&discriminator);
    instruction_data.serialize(&mut data)?;

    // Build account metas from remaining_accounts
    let mut account_metas = Vec::with_capacity(remaining_accounts.len() + 1);

    // Fee payer is always first, mutable signer
    account_metas.push(AccountMeta::new(fee_payer.key(), true));

    // Add remaining accounts with their existing signer/writable flags
    for acc in remaining_accounts {
        if acc.is_writable {
            account_metas.push(AccountMeta::new(acc.key(), acc.is_signer));
        } else {
            account_metas.push(AccountMeta::new_readonly(acc.key(), acc.is_signer));
        }
    }

    let ix = Instruction {
        program_id: LIGHT_SYSTEM_PROGRAM_ID,
        accounts: account_metas,
        data,
    };

    // Sign with our CPI authority PDA
    let signer_seeds: &[&[u8]] = &[b"cpi_authority", &[cpi_authority_bump]];

    // Collect all account infos for invoke_signed
    let mut account_infos = Vec::with_capacity(remaining_accounts.len() + 1);
    account_infos.push(fee_payer.clone());
    account_infos.extend_from_slice(remaining_accounts);

    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &account_infos,
        &[signer_seeds],
    )?;

    Ok(())
}
