//! Fulfillment engine — consumes randomness request events and submits
//! on-chain fulfillment transactions with Ed25519 signature proofs.
//!
//! Each fulfillment transaction contains two instructions:
//! 1. A native Ed25519 signature-verify instruction (proof of VRF output).
//! 2. The `fulfill_randomness` Anchor instruction on the VRF program.
//!
//! Transactions are retried with exponential backoff on `BlockhashNotFound`
//! errors (common during RPC congestion).

use anyhow::{Context, Result};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signer;
use solana_sdk::sysvar;
use solana_sdk::transaction::Transaction;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, info, instrument, warn};

use crate::config::AppConfig;
use crate::listener::RandomnessRequestedEvent;
use crate::vrf::compute_randomness;

/// Maximum number of send-and-confirm attempts per fulfillment.
const MAX_RETRIES: u32 = 5;
/// Initial delay before the first retry (doubles each attempt).
const INITIAL_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Compute the Anchor instruction discriminator for `fulfill_randomness`:
/// first 8 bytes of `sha256("global:fulfill_randomness")`.
fn fulfill_discriminator() -> [u8; 8] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"global:fulfill_randomness");
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Main fulfiller loop.
///
/// Reads [`RandomnessRequestedEvent`]s from the channel, computes the VRF
/// output, builds the transaction, and submits it on-chain. Known non-retryable
/// errors (Unauthorized, RequestNotPending, AccountNotInitialized) are logged
/// as warnings and skipped.
pub async fn run_fulfiller(
    config: AppConfig,
    mut rx: mpsc::Receiver<RandomnessRequestedEvent>,
    pending_count: Arc<AtomicU64>,
) {
    let rpc_client = RpcClient::new_with_commitment(
        config.rpc_url.clone(),
        CommitmentConfig::confirmed(),
    );

    while let Some(event) = rx.recv().await {
        pending_count.fetch_add(1, Ordering::Relaxed);

        info!(
            request_id = event.request_id,
            requester = %event.requester,
            slot = event.request_slot,
            "Fulfilling randomness request"
        );

        match fulfill_request(&rpc_client, &config, &event).await {
            Ok(sig) => {
                info!(
                    request_id = event.request_id,
                    signature = %sig,
                    explorer = %format!("https://solscan.io/tx/{sig}?cluster=devnet"),
                    "Fulfilled successfully"
                );
            }
            Err(e) => {
                let err_str = format!("{e:#}");
                if err_str.contains("Unauthorized")
                    || err_str.contains("RequestNotPending")
                    || err_str.contains("AccountNotInitialized")
                {
                    warn!(
                        request_id = event.request_id,
                        reason = %err_str,
                        "Skipping request"
                    );
                } else {
                    error!(
                        request_id = event.request_id,
                        error = %err_str,
                        "Failed to fulfill"
                    );
                }
            }
        }

        pending_count.fetch_sub(1, Ordering::Relaxed);
    }

    info!("Fulfiller channel closed, shutting down");
}

/// Build, sign, and submit a fulfillment transaction with exponential-backoff retries.
#[instrument(skip_all, fields(request_id = event.request_id))]
async fn fulfill_request(
    rpc_client: &RpcClient,
    config: &AppConfig,
    event: &RandomnessRequestedEvent,
) -> Result<String> {
    let randomness = compute_randomness(
        &config.hmac_secret,
        &event.seed,
        event.request_slot,
        event.request_id,
    );

    // Signed message layout: request_id (8 bytes LE) || randomness (32 bytes)
    let mut message = Vec::with_capacity(40);
    message.extend_from_slice(&event.request_id.to_le_bytes());
    message.extend_from_slice(&randomness);

    let ed25519_ix = build_ed25519_instruction(config.authority_keypair.as_ref(), &message);

    let fulfill_ix = build_fulfill_instruction(
        &config.program_id,
        &config.authority_keypair.pubkey(),
        event.request_id,
        &randomness,
    );

    let mut retry_delay = INITIAL_RETRY_DELAY;

    for attempt in 0..MAX_RETRIES {
        let blockhash = rpc_client
            .get_latest_blockhash()
            .await
            .context("failed to fetch latest blockhash")?;

        let tx = Transaction::new_signed_with_payer(
            &[ed25519_ix.clone(), fulfill_ix.clone()],
            Some(&config.authority_keypair.pubkey()),
            &[config.authority_keypair.as_ref()],
            blockhash,
        );

        match rpc_client.send_and_confirm_transaction(&tx).await {
            Ok(sig) => return Ok(sig.to_string()),
            Err(e) if e.to_string().contains("BlockhashNotFound") && attempt < MAX_RETRIES - 1 => {
                warn!(
                    attempt = attempt + 1,
                    delay = ?retry_delay,
                    "BlockhashNotFound, retrying"
                );
                tokio::time::sleep(retry_delay).await;
                retry_delay *= 2;
            }
            Err(e) => return Err(e).context("send_and_confirm_transaction failed"),
        }
    }

    anyhow::bail!("max retries ({MAX_RETRIES}) exceeded for request_id={}", event.request_id)
}

/// Construct a native Ed25519 signature-verify instruction.
///
/// The on-chain VRF program inspects the Instructions sysvar to verify that
/// the authority actually signed the message, providing a non-interactive
/// cryptographic proof of the VRF output.
///
/// ## Instruction data layout
///
/// ```text
/// [0]       num_signatures (u8) = 1
/// [1]       padding (u8)
/// [2..16]   Ed25519SignatureOffsets (7 x u16 LE)
/// [16..48]  public key (32 bytes)
/// [48..112] signature  (64 bytes)
/// [112..]   message    (variable)
/// ```
fn build_ed25519_instruction(
    keypair: &solana_sdk::signature::Keypair,
    message: &[u8],
) -> Instruction {
    use solana_sdk::ed25519_program;

    let signature = keypair.sign_message(message);
    let pubkey = keypair.pubkey();

    const DATA_START: usize = 2 + 7 * 2; // 16
    let public_key_offset: u16 = DATA_START as u16;
    let signature_offset: u16 = (DATA_START + 32) as u16;
    let message_data_offset: u16 = (DATA_START + 32 + 64) as u16;
    let message_data_size: u16 = message.len() as u16;

    let mut data = Vec::with_capacity(DATA_START + 32 + 64 + message.len());

    // Header
    data.push(1u8); // num_signatures
    data.push(0u8); // padding

    // Ed25519SignatureOffsets
    data.extend_from_slice(&signature_offset.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes()); // signature_instruction_index = self
    data.extend_from_slice(&public_key_offset.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes()); // public_key_instruction_index = self
    data.extend_from_slice(&message_data_offset.to_le_bytes());
    data.extend_from_slice(&message_data_size.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes()); // message_instruction_index = self

    // Payload
    data.extend_from_slice(&pubkey.to_bytes());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);

    Instruction {
        program_id: ed25519_program::id(),
        accounts: vec![],
        data,
    }
}

/// Build the Anchor `fulfill_randomness` instruction.
///
/// Accounts: `[authority (signer), config_pda, request_pda, instructions_sysvar]`.
/// Data: `discriminator (8) || request_id (8 LE) || randomness (32)`.
fn build_fulfill_instruction(
    program_id: &Pubkey,
    authority: &Pubkey,
    request_id: u64,
    randomness: &[u8; 32],
) -> Instruction {
    let (config_pda, _) = Pubkey::find_program_address(&[b"vrf-config"], program_id);
    let (request_pda, _) =
        Pubkey::find_program_address(&[b"request", &request_id.to_le_bytes()], program_id);

    let mut data = Vec::with_capacity(8 + 8 + 32);
    data.extend_from_slice(&fulfill_discriminator());
    data.extend_from_slice(&request_id.to_le_bytes());
    data.extend_from_slice(randomness);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*authority, true),                         // authority (signer, payer)
            AccountMeta::new_readonly(config_pda, false),               // vrf config PDA
            AccountMeta::new(request_pda, false),                       // randomness request PDA
            AccountMeta::new_readonly(sysvar::instructions::ID, false), // instructions sysvar
        ],
        data,
    }
}
