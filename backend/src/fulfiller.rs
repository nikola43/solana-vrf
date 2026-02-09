//! Fulfillment engine — consumes randomness request events and submits
//! on-chain fulfillment transactions with Ed25519 signature proofs and
//! automatic callback delivery via the coordinator.
//!
//! Each fulfillment transaction contains:
//! 1. (Optional) A `set_compute_unit_price` instruction for priority fees.
//! 2. A native Ed25519 signature-verify instruction (proof of VRF output).
//! 3. The `fulfill_random_words` coordinator instruction (verifies proof,
//!    expands randomness, CPIs callback into consumer, closes request PDA).

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
use crate::consumer_accounts::derive_callback_accounts;
use crate::listener::RandomWordsRequestedEvent;
use crate::metrics::Metrics;
use crate::vrf::compute_randomness;

/// Known non-retryable Anchor error codes.
const ERROR_REQUEST_NOT_PENDING: u32 = 6000;
const ERROR_UNAUTHORIZED: u32 = 6007;

/// Compute the Anchor instruction discriminator for `fulfill_random_words`.
fn fulfill_discriminator() -> [u8; 8] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"global:fulfill_random_words");
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Check if an error string contains a known non-retryable error.
fn is_non_retryable(err_str: &str) -> bool {
    let non_retryable_codes = [
        format!("0x{:x}", ERROR_REQUEST_NOT_PENDING),
        format!("0x{:x}", ERROR_UNAUTHORIZED),
    ];
    for code in &non_retryable_codes {
        if err_str.contains(code) {
            return true;
        }
    }
    err_str.contains("RequestNotPending")
        || err_str.contains("Unauthorized")
        || err_str.contains("AccountNotInitialized")
        || err_str.contains("already in use")
}

/// Main fulfiller loop.
pub async fn run_fulfiller(
    config: AppConfig,
    mut rx: mpsc::Receiver<RandomWordsRequestedEvent>,
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

        let permit = match semaphore.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => {
                error!("Semaphore closed, stopping fulfiller");
                break;
            }
        };
        let rpc = rpc_client.clone();
        let cfg = config.clone();
        let pending = pending_count.clone();
        let met = metrics.clone();

        tokio::spawn(async move {
            let _permit = permit;
            let start = Instant::now();

            info!(
                request_id = event.request_id,
                requester = %event.requester,
                consumer = %event.consumer_program,
                num_words = event.num_words,
                slot = event.request_slot,
                "Fulfilling randomness request"
            );

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
                Err(e) => handle_fulfillment_error(event.request_id, e, &met),
            }

            pending.fetch_sub(1, Ordering::Relaxed);
        });
    }

    info!("Fulfiller channel closed, shutting down");
}

fn handle_fulfillment_error(request_id: u64, error: anyhow::Error, metrics: &Metrics) {
    let err_str = format!("{error:#}");
    if is_non_retryable(&err_str) {
        warn!(
            request_id,
            reason = %err_str,
            "Skipping request (non-retryable)"
        );
    } else {
        metrics.record_failure();
        error!(
            request_id,
            error = %err_str,
            "Failed to fulfill"
        );
    }
}

/// Build, sign, and submit a fulfillment transaction with callback.
#[instrument(skip_all, fields(request_id = event.request_id))]
async fn fulfill_request(
    rpc_client: &RpcClient,
    config: &AppConfig,
    event: &RandomWordsRequestedEvent,
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

    // Derive consumer callback accounts
    let callback_remaining = derive_callback_accounts(
        &event.consumer_program,
        config.dice_program_id.as_ref(),
        event,
    );

    let fulfill_ix = build_fulfill_instruction(
        &config.program_id,
        &config.authority_keypair.pubkey(),
        event,
        &randomness,
        &callback_remaining,
    );

    let mut instructions = Vec::with_capacity(3);
    if config.priority_fee_micro_lamports > 0 {
        instructions.push(build_set_compute_unit_price_instruction(
            config.priority_fee_micro_lamports,
        ));
    }
    instructions.push(ed25519_ix);
    instructions.push(fulfill_ix);

    send_with_retries(rpc_client, config, &instructions, event.request_id).await
}

/// Send a transaction with exponential backoff on BlockhashNotFound.
async fn send_with_retries(
    rpc_client: &RpcClient,
    config: &AppConfig,
    instructions: &[Instruction],
    request_id: u64,
) -> Result<String> {
    let mut retry_delay = Duration::from_millis(config.initial_retry_delay_ms);

    for attempt in 0..config.max_retries {
        let blockhash = rpc_client
            .get_latest_blockhash()
            .await
            .context("failed to fetch latest blockhash")?;

        let tx = Transaction::new_signed_with_payer(
            instructions,
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
                retry_delay = retry_delay.saturating_mul(2).min(Duration::from_secs(60));
            }
            Err(e) => return Err(e).context("send_and_confirm_transaction failed"),
        }
    }

    anyhow::bail!(
        "max retries ({}) exceeded for request_id={}",
        config.max_retries,
        request_id
    )
}

/// Construct a native Ed25519 signature-verify instruction.
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

    data.push(1u8); // num_signatures
    data.push(0u8); // padding

    data.extend_from_slice(&signature_offset.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&public_key_offset.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());
    data.extend_from_slice(&message_data_offset.to_le_bytes());
    data.extend_from_slice(&message_data_size.to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes());

    data.extend_from_slice(&pubkey.to_bytes());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);

    Instruction {
        program_id: ed25519_program::id(),
        accounts: vec![],
        data,
    }
}

/// Build a `SetComputeUnitPrice` instruction.
fn build_set_compute_unit_price_instruction(micro_lamports: u64) -> Instruction {
    let compute_budget_id: Pubkey = "ComputeBudget111111111111111111111111111111"
        .parse()
        .unwrap();
    let mut data = Vec::with_capacity(9);
    data.push(3u8);
    data.extend_from_slice(&micro_lamports.to_le_bytes());
    Instruction {
        program_id: compute_budget_id,
        accounts: vec![],
        data,
    }
}

/// Build the `fulfill_random_words` coordinator instruction.
fn build_fulfill_instruction(
    program_id: &Pubkey,
    authority: &Pubkey,
    event: &RandomWordsRequestedEvent,
    randomness: &[u8; 32],
    callback_remaining: &[AccountMeta],
) -> Instruction {
    let (config_pda, _) = Pubkey::find_program_address(&[b"coordinator-config"], program_id);
    let (request_pda, _) =
        Pubkey::find_program_address(&[b"request", &event.request_id.to_le_bytes()], program_id);

    // Instruction data: discriminator + request_id + randomness
    let mut data = Vec::with_capacity(8 + 8 + 32);
    data.extend_from_slice(&fulfill_discriminator());
    data.extend_from_slice(&event.request_id.to_le_bytes());
    data.extend_from_slice(randomness);

    // Core accounts
    let mut accounts = vec![
        AccountMeta::new(*authority, true),                         // authority (signer, payer)
        AccountMeta::new_readonly(config_pda, false),               // coordinator config PDA
        AccountMeta::new(request_pda, false),                       // randomness request PDA
        AccountMeta::new(event.requester, false),                   // requester (rent refund)
        AccountMeta::new_readonly(event.consumer_program, false),   // consumer program
        AccountMeta::new_readonly(sysvar::instructions::ID, false), // instructions sysvar
    ];

    // Append consumer callback remaining_accounts
    accounts.extend_from_slice(callback_remaining);

    Instruction {
        program_id: *program_id,
        accounts,
        data,
    }
}
