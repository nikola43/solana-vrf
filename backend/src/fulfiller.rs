//! Fulfillment engine — consumes randomness request events and submits
//! on-chain fulfillment transactions with Ed25519 signature proofs.
//!
//! Each fulfillment transaction contains two instructions (optionally three
//! with a priority fee):
//! 1. (Optional) A `set_compute_unit_price` instruction for priority fees.
//! 2. A native Ed25519 signature-verify instruction (proof of VRF output).
//! 3. The `fulfill_randomness` Anchor instruction on the VRF program.
//!
//! Requests are fulfilled concurrently up to the configured concurrency limit,
//! with exponential backoff on `BlockhashNotFound` errors.

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
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Semaphore};
use tracing::{error, info, instrument, warn};

use crate::config::AppConfig;
use crate::listener::RandomnessRequestedEvent;
use crate::metrics::Metrics;
use crate::vrf::compute_randomness;

/// Known non-retryable Anchor error codes.
const ERROR_REQUEST_NOT_PENDING: u32 = 6000;
const ERROR_UNAUTHORIZED: u32 = 6009;

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

/// Check if an error string contains a known non-retryable error.
fn is_non_retryable(err_str: &str) -> bool {
    // Check for Anchor error codes
    let non_retryable_codes = [
        format!("0x{:x}", ERROR_REQUEST_NOT_PENDING), // "0x1770"
        format!("0x{:x}", ERROR_UNAUTHORIZED),         // "0x1779"
    ];
    for code in &non_retryable_codes {
        if err_str.contains(code) {
            return true;
        }
    }
    // Also check for string-based error names
    err_str.contains("RequestNotPending")
        || err_str.contains("Unauthorized")
        || err_str.contains("AccountNotInitialized")
        || err_str.contains("already in use")
}

/// Main fulfiller loop.
///
/// Reads [`RandomnessRequestedEvent`]s from the channel and spawns concurrent
/// fulfillment tasks up to the configured concurrency limit.
pub async fn run_fulfiller(
    config: AppConfig,
    mut rx: mpsc::Receiver<RandomnessRequestedEvent>,
    pending_count: Arc<AtomicU64>,
    metrics: Arc<Metrics>,
) {
    let rpc_client = Arc::new(RpcClient::new_with_commitment(
        config.rpc_url.clone(),
        CommitmentConfig::confirmed(),
    ));

    let semaphore = Arc::new(Semaphore::new(config.fulfillment_concurrency));

    while let Some(event) = rx.recv().await {
        pending_count.fetch_add(1, Ordering::Relaxed);

        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let rpc = rpc_client.clone();
        let cfg = config.clone();
        let pending = pending_count.clone();
        let met = metrics.clone();

        tokio::spawn(async move {
            let _permit = permit; // held until task completes

            info!(
                request_id = event.request_id,
                requester = %event.requester,
                slot = event.request_slot,
                "Fulfilling randomness request"
            );

            let start = Instant::now();

            match fulfill_request(&rpc, &cfg, &event).await {
                Ok(sig) => {
                    let latency_ms = start.elapsed().as_millis() as u64;
                    met.record_fulfillment(latency_ms);
                    info!(
                        request_id = event.request_id,
                        signature = %sig,
                        latency_ms,
                        explorer = %cfg.explorer_url(&sig),
                        "Fulfilled successfully"
                    );
                }
                Err(e) => {
                    let err_str = format!("{e:#}");
                    if is_non_retryable(&err_str) {
                        warn!(
                            request_id = event.request_id,
                            reason = %err_str,
                            "Skipping request (non-retryable)"
                        );
                    } else {
                        met.record_failure();
                        error!(
                            request_id = event.request_id,
                            error = %err_str,
                            "Failed to fulfill"
                        );
                    }
                }
            }

            pending.fetch_sub(1, Ordering::Relaxed);
        });
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

    // Build instruction list
    let mut instructions = Vec::with_capacity(3);

    // Prepend priority fee instruction if configured
    if config.priority_fee_micro_lamports > 0 {
        instructions.push(build_set_compute_unit_price_instruction(
            config.priority_fee_micro_lamports,
        ));
    }

    instructions.push(ed25519_ix);
    instructions.push(fulfill_ix);

    let mut retry_delay = Duration::from_millis(config.initial_retry_delay_ms);

    for attempt in 0..config.max_retries {
        let blockhash = rpc_client
            .get_latest_blockhash()
            .await
            .context("failed to fetch latest blockhash")?;

        let tx = Transaction::new_signed_with_payer(
            &instructions,
            Some(&config.authority_keypair.pubkey()),
            &[config.authority_keypair.as_ref()],
            blockhash,
        );

        match rpc_client.send_and_confirm_transaction(&tx).await {
            Ok(sig) => return Ok(sig.to_string()),
            Err(e) if e.to_string().contains("BlockhashNotFound") && attempt < config.max_retries - 1 => {
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

    anyhow::bail!(
        "max retries ({}) exceeded for request_id={}",
        config.max_retries,
        event.request_id
    )
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

/// Build a `SetComputeUnitPrice` instruction manually.
///
/// ComputeBudget program ID: `ComputeBudget111111111111111111111111111111`
/// Instruction index 3 = SetComputeUnitPrice, data: [3u8, micro_lamports as u64 LE]
fn build_set_compute_unit_price_instruction(micro_lamports: u64) -> Instruction {
    let compute_budget_id: Pubkey = "ComputeBudget111111111111111111111111111111"
        .parse()
        .unwrap();
    let mut data = Vec::with_capacity(9);
    data.push(3u8); // SetComputeUnitPrice instruction index
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction {
        program_id: compute_budget_id,
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
