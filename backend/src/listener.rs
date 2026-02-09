//! On-chain event listener for the VRF program.
//!
//! Two complementary strategies ensure no requests are missed:
//!
//! 1. **Catch-up scan** ([`catch_up_pending_requests`]) — on startup, queries
//!    `getProgramAccounts` for any existing `Pending` requests that arrived
//!    while the backend was offline.
//!
//! 2. **Live stream** ([`listen_for_events`]) — subscribes to program log
//!    events via WebSocket, parses `RandomnessRequested` Anchor events in
//!    real-time, and auto-reconnects with exponential backoff on disconnection.
//!
//! Also supports ZK Compressed requests via the Photon indexer when configured.

use base64::Engine;
use solana_account_decoder::UiAccountEncoding;
use solana_client::nonblocking::pubsub_client::PubsubClient;
use solana_client::rpc_config::{
    RpcAccountInfoConfig, RpcProgramAccountsConfig, RpcTransactionLogsConfig,
    RpcTransactionLogsFilter,
};
use solana_client::rpc_filter::{Memcmp, RpcFilterType};
use solana_commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::config::AppConfig;
use crate::metrics::Metrics;
use crate::photon::PhotonClient;
use std::sync::Arc;

/// Parsed representation of the on-chain `RandomnessRequested` Anchor event.
#[derive(Debug, Clone)]
pub struct RandomnessRequestedEvent {
    pub request_id: u64,
    pub requester: Pubkey,
    pub seed: [u8; 32],
    pub request_slot: u64,
}

/// A fulfillment request — either regular (PDA) or compressed (Light Protocol).
#[derive(Debug, Clone)]
pub enum FulfillmentRequest {
    /// Regular request backed by an on-chain PDA.
    Regular(RandomnessRequestedEvent),
    /// Compressed request backed by a Light Protocol compressed account.
    Compressed(CompressedFulfillmentRequest),
}

/// Data needed to fulfill a compressed randomness request.
#[derive(Debug, Clone)]
pub struct CompressedFulfillmentRequest {
    pub event: RandomnessRequestedEvent,
    /// Compressed account address.
    pub address: [u8; 32],
}

/// Compute the Anchor event discriminator: `sha256("event:<Name>")[..8]`.
fn event_discriminator(event_name: &str) -> [u8; 8] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("event:{event_name}"));
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Compute the Anchor account discriminator: `sha256("account:<Name>")[..8]`.
fn account_discriminator(account_name: &str) -> [u8; 8] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("account:{account_name}"));
    let hash = hasher.finalize();
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hash[..8]);
    disc
}

/// Minimum WebSocket reconnect delay.
const WS_RECONNECT_MIN: Duration = Duration::from_secs(1);
/// Maximum WebSocket reconnect delay (capped exponential backoff).
const WS_RECONNECT_MAX: Duration = Duration::from_secs(60);

/// Minimum expected account data length for a `RandomnessRequest`.
///
/// Layout: discriminator (8) + request_id (8) + requester (32) + seed (32) +
/// request_slot (8) + callback_program (32) + status (1) = 121 bytes.
const MIN_ACCOUNT_DATA_LEN: usize = 121;

/// Tracks request IDs that have already been dispatched to prevent duplicate
/// fulfillment attempts when catch-up and WebSocket streams overlap.
struct Deduplicator {
    seen: Mutex<HashSet<u64>>,
}

impl Deduplicator {
    fn new() -> Self {
        Self {
            seen: Mutex::new(HashSet::new()),
        }
    }

    /// Returns `true` if this is the first time seeing this request ID.
    fn insert(&self, request_id: u64) -> bool {
        self.seen.lock().unwrap().insert(request_id)
    }
}

/// Scan for any existing unfulfilled (Pending) requests on startup.
///
/// Uses `getProgramAccounts` with Memcmp filters to find request PDAs where:
/// - The account discriminator matches `RandomnessRequest`.
/// - The status byte at offset 120 is `0` (Pending).
///
/// Each found request is sent through the channel for fulfillment.
pub async fn catch_up_pending_requests(
    config: &AppConfig,
    tx: &mpsc::Sender<FulfillmentRequest>,
    metrics: &Arc<Metrics>,
) {
    info!("Scanning for pending requests");

    let client = solana_client::nonblocking::rpc_client::RpcClient::new(config.rpc_url.clone());

    let disc = account_discriminator("RandomnessRequest");

    // Account data layout (offsets include the 8-byte discriminator):
    //   [0..8]     discriminator
    //   [8..16]    request_id   (u64)
    //   [16..48]   requester    (Pubkey)
    //   [48..80]   seed         ([u8; 32])
    //   [80..88]   request_slot (u64)
    //   [88..120]  callback_program (Pubkey)
    //   [120]      status       (u8)  — 0 = Pending
    let filters = vec![
        RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, disc.to_vec())),
        RpcFilterType::Memcmp(Memcmp::new_raw_bytes(120, vec![0u8])), // Pending
    ];

    let account_config = RpcProgramAccountsConfig {
        filters: Some(filters),
        account_config: RpcAccountInfoConfig {
            encoding: Some(UiAccountEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            ..Default::default()
        },
        ..Default::default()
    };

    match client
        .get_program_ui_accounts_with_config(&config.program_id, account_config)
        .await
    {
        Ok(accounts) => {
            info!(count = accounts.len(), "Found pending requests");
            for (pubkey, ui_account) in accounts {
                let data = match ui_account.data.decode() {
                    Some(d) => d,
                    None => {
                        warn!(account = %pubkey, "Failed to decode account data, skipping");
                        continue;
                    }
                };

                if data.len() < MIN_ACCOUNT_DATA_LEN {
                    warn!(
                        account = %pubkey,
                        len = data.len(),
                        "Account data too short, skipping"
                    );
                    continue;
                }

                // Skip the 8-byte discriminator, then parse fixed-layout fields.
                let body = &data[8..];
                let Ok(request_id_bytes) = body[0..8].try_into() else {
                    warn!(account = %pubkey, "Failed to parse request_id, skipping");
                    continue;
                };
                let request_id = u64::from_le_bytes(request_id_bytes);
                let Ok(requester) = Pubkey::try_from(&body[8..40]) else {
                    warn!(account = %pubkey, "Failed to parse requester pubkey, skipping");
                    continue;
                };
                let mut seed = [0u8; 32];
                seed.copy_from_slice(&body[40..72]);
                let Ok(slot_bytes) = body[72..80].try_into() else {
                    warn!(account = %pubkey, "Failed to parse request_slot, skipping");
                    continue;
                };
                let request_slot = u64::from_le_bytes(slot_bytes);

                info!(
                    request_id,
                    requester = %requester,
                    slot = request_slot,
                    "Queued pending request"
                );

                metrics.record_request();

                let event = RandomnessRequestedEvent {
                    request_id,
                    requester,
                    seed,
                    request_slot,
                };
                if tx.send(FulfillmentRequest::Regular(event)).await.is_err() {
                    error!("Channel closed while catching up pending requests");
                    return;
                }
            }
        }
        Err(e) => {
            error!(error = %e, "Failed to fetch program accounts");
        }
    }
}

/// Scan for pending compressed requests via the Photon indexer.
pub async fn catch_up_compressed_requests(
    config: &AppConfig,
    photon: &PhotonClient,
    tx: &mpsc::Sender<FulfillmentRequest>,
    metrics: &Arc<Metrics>,
) {
    info!("Scanning Photon for pending compressed requests");

    match photon.find_pending_compressed_requests(&config.program_id).await {
        Ok(accounts) => {
            info!(count = accounts.len(), "Found pending compressed requests");
            for account in accounts {
                let event = RandomnessRequestedEvent {
                    request_id: account.request.request_id,
                    requester: account.request.requester,
                    seed: account.request.seed,
                    request_slot: account.request.request_slot,
                };

                metrics.record_compressed_request();

                let req = FulfillmentRequest::Compressed(CompressedFulfillmentRequest {
                    event,
                    address: account.address,
                });

                if tx.send(req).await.is_err() {
                    error!("Channel closed while catching up compressed requests");
                    return;
                }
            }
        }
        Err(e) => {
            error!(error = %e, "Failed to fetch compressed accounts from Photon");
        }
    }
}

/// Subscribe to program logs via WebSocket and forward `RandomnessRequested`
/// events to the fulfiller. Automatically reconnects with exponential backoff.
pub async fn listen_for_events(
    config: AppConfig,
    tx: mpsc::Sender<FulfillmentRequest>,
    metrics: Arc<Metrics>,
) {
    let regular_discriminator = event_discriminator("RandomnessRequested");
    let compressed_discriminator = event_discriminator("CompressedRandomnessRequested");
    let dedup = Deduplicator::new();
    let mut reconnect_delay = WS_RECONNECT_MIN;

    loop {
        info!(url = %config.ws_url, "Connecting to WebSocket");

        match PubsubClient::new(&config.ws_url).await {
            Ok(pubsub) => {
                info!("WebSocket connected");
                // Reset backoff on successful connection
                reconnect_delay = WS_RECONNECT_MIN;

                let filter =
                    RpcTransactionLogsFilter::Mentions(vec![config.program_id.to_string()]);
                let logs_config = RpcTransactionLogsConfig {
                    commitment: Some(CommitmentConfig::confirmed()),
                };

                match pubsub.logs_subscribe(filter, logs_config).await {
                    Ok((mut stream, _unsub)) => {
                        use futures_util::StreamExt;
                        while let Some(log_result) = stream.next().await {
                            process_log_lines(
                                &log_result.value.logs,
                                &regular_discriminator,
                                &compressed_discriminator,
                                &tx,
                                &dedup,
                                &metrics,
                            )
                            .await;
                        }
                        warn!("WebSocket stream ended, reconnecting");
                    }
                    Err(e) => {
                        error!(error = %e, "Failed to subscribe to logs");
                    }
                }
            }
            Err(e) => {
                error!(error = %e, "Failed to connect to WebSocket");
            }
        }

        info!(delay = ?reconnect_delay, "Reconnecting");
        tokio::time::sleep(reconnect_delay).await;
        // Exponential backoff capped at WS_RECONNECT_MAX
        reconnect_delay = (reconnect_delay * 2).min(WS_RECONNECT_MAX);
    }
}

/// Scan transaction log lines for `Program data:` entries that match either
/// `RandomnessRequested` or `CompressedRandomnessRequested` event discriminators.
async fn process_log_lines(
    logs: &[String],
    regular_discriminator: &[u8; 8],
    compressed_discriminator: &[u8; 8],
    tx: &mpsc::Sender<FulfillmentRequest>,
    dedup: &Deduplicator,
    metrics: &Arc<Metrics>,
) {
    for log_line in logs {
        let Some(data_str) = log_line.strip_prefix("Program data: ") else {
            continue;
        };

        let decoded = match base64::engine::general_purpose::STANDARD.decode(data_str.trim()) {
            Ok(d) => d,
            Err(e) => {
                debug!(error = %e, "Failed to decode base64 log data");
                continue;
            }
        };

        if decoded.len() < 8 {
            continue;
        }

        let disc = &decoded[..8];
        let payload = &decoded[8..];

        // Check if it's a regular request event
        if disc == regular_discriminator {
            let Some(event) = parse_randomness_requested_event(payload) else {
                warn!("Failed to parse RandomnessRequested event payload");
                continue;
            };

            if !dedup.insert(event.request_id) {
                debug!(request_id = event.request_id, "Duplicate request, skipping");
                continue;
            }

            metrics.record_request();

            info!(
                request_id = event.request_id,
                requester = %event.requester,
                slot = event.request_slot,
                "Received RandomnessRequested event"
            );

            if tx.send(FulfillmentRequest::Regular(event)).await.is_err() {
                error!("Channel closed, stopping listener");
                return;
            }
            continue;
        }

        // Check if it's a compressed request event
        if disc == compressed_discriminator {
            let Some(event) = parse_randomness_requested_event(payload) else {
                warn!("Failed to parse CompressedRandomnessRequested event payload");
                continue;
            };

            if !dedup.insert(event.request_id) {
                debug!(request_id = event.request_id, "Duplicate compressed request, skipping");
                continue;
            }

            metrics.record_compressed_request();

            info!(
                request_id = event.request_id,
                requester = %event.requester,
                slot = event.request_slot,
                compressed = true,
                "Received CompressedRandomnessRequested event"
            );

            // For compressed requests, we don't have the address from the event alone.
            // The fulfiller will query Photon to find the compressed account.
            let req = FulfillmentRequest::Compressed(CompressedFulfillmentRequest {
                event,
                address: [0u8; 32], // Will be resolved by fulfiller via Photon
            });

            if tx.send(req).await.is_err() {
                error!("Channel closed, stopping listener");
                return;
            }
        }
    }
}

/// Deserialize a `RandomnessRequested` event from its Borsh-encoded body
/// (after the 8-byte discriminator has been stripped).
///
/// Layout: `request_id (8) + requester (32) + seed (32) + request_slot (8) = 80 bytes`.
fn parse_randomness_requested_event(data: &[u8]) -> Option<RandomnessRequestedEvent> {
    if data.len() < 80 {
        return None;
    }

    let request_id = u64::from_le_bytes(data[0..8].try_into().ok()?);
    let requester = Pubkey::try_from(&data[8..40]).ok()?;
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&data[40..72]);
    let request_slot = u64::from_le_bytes(data[72..80].try_into().ok()?);

    Some(RandomnessRequestedEvent {
        request_id,
        requester,
        seed,
        request_slot,
    })
}
