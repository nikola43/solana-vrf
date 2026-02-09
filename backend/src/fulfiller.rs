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
//!
//! Compressed requests route through `fulfill_compressed_request()` which
//! queries the Photon indexer for current state + validity proof before
//! submitting a `fulfill_randomness_compressed` instruction.

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
use crate::listener::{CompressedFulfillmentRequest, FulfillmentRequest, RandomnessRequestedEvent};
use crate::metrics::Metrics;
use crate::photon::PhotonClient;
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

/// Compute the Anchor instruction discriminator for `fulfill_randomness_compressed`.
fn fulfill_compressed_discriminator() -> [u8; 8] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"global:fulfill_randomness_compressed");
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
        || err_str.contains("CompressedAccountMismatch")
}

/// Main fulfiller loop.
///
/// Reads [`FulfillmentRequest`]s from the channel and spawns concurrent
/// fulfillment tasks up to the configured concurrency limit.
pub async fn run_fulfiller(
    config: AppConfig,
    mut rx: mpsc::Receiver<FulfillmentRequest>,
    pending_count: Arc<AtomicU64>,
    metrics: Arc<Metrics>,
    photon: Option<Arc<PhotonClient>>,
) {
    let rpc_client = Arc::new(RpcClient::new_with_commitment(
        config.rpc_url.clone(),
        CommitmentConfig::confirmed(),
    ));

    let semaphore = Arc::new(Semaphore::new(config.fulfillment_concurrency));

    while let Some(request) = rx.recv().await {
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
        let photon_client = photon.clone();

        tokio::spawn(async move {
            let _permit = permit; // held until task completes

            let start = Instant::now();

            match request {
                FulfillmentRequest::Regular(ref event) => {
                    info!(
                        request_id = event.request_id,
                        requester = %event.requester,
                        slot = event.request_slot,
                        "Fulfilling randomness request"
                    );

                    match fulfill_request(&rpc, &cfg, event).await {
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
                }
                FulfillmentRequest::Compressed(ref comp_req) => {
                    info!(
                        request_id = comp_req.event.request_id,
                        requester = %comp_req.event.requester,
                        slot = comp_req.event.request_slot,
                        compressed = true,
                        "Fulfilling compressed randomness request"
                    );

                    if let Some(ref photon) = photon_client {
                        match fulfill_compressed_request(&rpc, &cfg, comp_req, photon).await {
                            Ok(sig) => {
                                let latency_ms = start.elapsed().as_millis() as u64;
                                met.record_compressed_fulfillment(latency_ms);
                                info!(
                                    request_id = comp_req.event.request_id,
                                    signature = %sig,
                                    latency_ms,
                                    compressed = true,
                                    explorer = %cfg.explorer_url(&sig),
                                    "Fulfilled compressed request successfully"
                                );
                            }
                            Err(e) => handle_fulfillment_error(
                                comp_req.event.request_id,
                                e,
                                &met,
                            ),
                        }
                    } else {
                        error!(
                            request_id = comp_req.event.request_id,
                            "Cannot fulfill compressed request: PHOTON_RPC_URL not configured"
                        );
                        met.record_failure();
                    }
                }
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

/// Build, sign, and submit a regular fulfillment transaction with exponential-backoff retries.
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

    send_with_retries(rpc_client, config, &instructions, event.request_id).await
}

/// Build, sign, and submit a compressed fulfillment transaction.
///
/// Queries the Photon indexer for the current compressed account state and
/// validity proof, then builds a `fulfill_randomness_compressed` instruction.
#[instrument(skip_all, fields(request_id = comp_req.event.request_id))]
async fn fulfill_compressed_request(
    rpc_client: &RpcClient,
    config: &AppConfig,
    comp_req: &CompressedFulfillmentRequest,
    photon: &PhotonClient,
) -> Result<String> {
    let event = &comp_req.event;

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

    // Validate address is non-zero (it must be resolved by the listener/Photon)
    anyhow::ensure!(
        comp_req.address != [0u8; 32],
        "Compressed request address is unresolved (zeroed) for request_id={}",
        comp_req.event.request_id,
    );

    // Query Photon for the compressed account state and validity proof
    let (account_info, proof_a, proof_b, proof_c) = photon
        .get_compressed_account_with_proof(&comp_req.address)
        .await
        .context("Failed to get compressed account from Photon")?;

    // Verify Photon returned the correct request
    anyhow::ensure!(
        account_info.request.request_id == comp_req.event.request_id,
        "Photon returned wrong request: expected {}, got {}",
        comp_req.event.request_id,
        account_info.request.request_id,
    );

    let fulfill_ix = build_fulfill_compressed_instruction(
        &config.program_id,
        &config.authority_keypair.pubkey(),
        event.request_id,
        &randomness,
        &proof_a,
        &proof_b,
        &proof_c,
        &account_info,
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

/// Build the `fulfill_randomness_compressed` instruction.
///
/// This is a simplified version — the full implementation would include
/// all the Light Protocol remaining_accounts. For now, we build the core
/// instruction data and the client/SDK handles account packing.
fn build_fulfill_compressed_instruction(
    program_id: &Pubkey,
    authority: &Pubkey,
    request_id: u64,
    randomness: &[u8; 32],
    proof_a: &[u8; 32],
    proof_b: &[u8; 64],
    proof_c: &[u8; 32],
    account_info: &crate::photon::CompressedAccountInfo,
) -> Instruction {
    let (config_pda, _) = Pubkey::find_program_address(&[b"vrf-config"], program_id);

    // Build instruction data: discriminator + borsh-encoded args
    let mut data = Vec::with_capacity(512);
    data.extend_from_slice(&fulfill_compressed_discriminator());

    // request_id: u64
    data.extend_from_slice(&request_id.to_le_bytes());
    // randomness: [u8; 32]
    data.extend_from_slice(randomness);
    // proof: ValidityProof { a: [u8;32], b: [u8;64], c: [u8;32] }
    data.extend_from_slice(proof_a);
    data.extend_from_slice(proof_b);
    data.extend_from_slice(proof_c);
    // merkle_context: PackedMerkleContext
    data.push(account_info.merkle_tree_index);
    data.push(account_info.nullifier_queue_index);
    data.extend_from_slice(&account_info.leaf_index.to_le_bytes());
    data.push(0); // queue_index Option: None
    // root_index: u16
    data.extend_from_slice(&account_info.root_index.to_le_bytes());
    // current_request: CompressedRandomnessRequest (manually serialized)
    data.extend_from_slice(&account_info.request.to_bytes());
    // input_data_hash: [u8; 32]
    data.extend_from_slice(&account_info.hash);
    // address: [u8; 32]
    data.extend_from_slice(&account_info.address);
    // output_state_tree_index: u8
    data.push(account_info.merkle_tree_index);
    // output_data_hash: [u8; 32] — computed from the updated state
    // For now, use a placeholder; the on-chain program re-hashes
    data.extend_from_slice(&[0u8; 32]);

    // Accounts: authority, config, instructions_sysvar + remaining_accounts for Light
    let mut accounts = vec![
        AccountMeta::new(*authority, true),
        AccountMeta::new_readonly(config_pda, false),
        AccountMeta::new_readonly(sysvar::instructions::ID, false),
    ];

    // Add Light Protocol remaining accounts
    // The tree accounts are added by the SDK/client when constructing the transaction
    accounts.push(AccountMeta::new(account_info.merkle_tree, false));

    Instruction {
        program_id: *program_id,
        accounts,
        data,
    }
}
