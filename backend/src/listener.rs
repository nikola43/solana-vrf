//! On-chain event listener for the VRF coordinator program.
//!
//! Two complementary strategies ensure no requests are missed:
//!
//! 1. **Catch-up scan** — on startup, queries `getProgramAccounts` for any
//!    existing `Pending` requests.
//! 2. **Live stream** — subscribes to program log events via WebSocket.

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
use std::sync::Arc;

/// Parsed representation of the on-chain `RandomWordsRequested` event.
#[derive(Debug, Clone)]
pub struct RandomWordsRequestedEvent {
    pub request_id: u64,
    pub subscription_id: u64,
    pub consumer_program: Pubkey,
    pub requester: Pubkey,
    pub num_words: u32,
    pub seed: [u8; 32],
    pub request_slot: u64,
    pub callback_compute_limit: u32,
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
/// Maximum WebSocket reconnect delay.
const WS_RECONNECT_MAX: Duration = Duration::from_secs(60);

/// Minimum expected account data length for a `RandomnessRequest`.
///
/// Layout: discriminator (8) + request_id (8) + subscription_id (8) +
/// consumer_program (32) + requester (32) + num_words (4) + seed (32) +
/// request_slot (8) + callback_compute_limit (4) + status (1) = 137 bytes.
const MIN_ACCOUNT_DATA_LEN: usize = 137;

/// Offset of the status byte in the RandomnessRequest account data.
/// discriminator(8) + request_id(8) + subscription_id(8) + consumer_program(32) +
/// requester(32) + num_words(4) + seed(32) + request_slot(8) + callback_compute_limit(4) = 136
const STATUS_OFFSET: usize = 136;

/// Tracks request IDs that have already been dispatched.
struct Deduplicator {
    seen: Mutex<HashSet<u64>>,
}

impl Deduplicator {
    fn new() -> Self {
        Self {
            seen: Mutex::new(HashSet::new()),
        }
    }

    fn insert(&self, request_id: u64) -> bool {
        self.seen.lock().unwrap().insert(request_id)
    }
}

/// Scan for any existing unfulfilled (Pending) requests on startup.
pub async fn catch_up_pending_requests(
    config: &AppConfig,
    tx: &mpsc::Sender<RandomWordsRequestedEvent>,
    metrics: &Arc<Metrics>,
) {
    info!("Scanning for pending requests");

    let client = solana_client::nonblocking::rpc_client::RpcClient::new(config.rpc_url.clone());

    let disc = account_discriminator("RandomnessRequest");

    let filters = vec![
        RpcFilterType::Memcmp(Memcmp::new_raw_bytes(0, disc.to_vec())),
        RpcFilterType::Memcmp(Memcmp::new_raw_bytes(STATUS_OFFSET, vec![0u8])), // Pending
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

                let Some(event) = parse_request_account_data(&data[8..]) else {
                    warn!(account = %pubkey, "Failed to parse request account data, skipping");
                    continue;
                };

                // Skip stale requests from old architecture (they parse as num_words=0)
                if event.num_words == 0 {
                    debug!(
                        account = %pubkey,
                        request_id = event.request_id,
                        "Skipping request with num_words=0 (likely stale old-architecture account)"
                    );
                    continue;
                }

                // Verify the account PDA matches the expected derivation.
                // Old-architecture accounts at ["request", id_le] will not match
                // the new seed prefix ["vrf-request", id_le].
                let (expected_pda, _) = Pubkey::find_program_address(
                    &[b"vrf-request", &event.request_id.to_le_bytes()],
                    &config.program_id,
                );
                if pubkey.to_string() != expected_pda.to_string() {
                    debug!(
                        account = %pubkey,
                        expected = %expected_pda,
                        request_id = event.request_id,
                        "Skipping account with mismatched PDA (stale old-architecture request)"
                    );
                    continue;
                }

                info!(
                    request_id = event.request_id,
                    subscription_id = event.subscription_id,
                    requester = %event.requester,
                    consumer = %event.consumer_program,
                    num_words = event.num_words,
                    slot = event.request_slot,
                    "Queued pending request"
                );

                metrics.record_request();

                if tx.send(event).await.is_err() {
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

/// Subscribe to program logs via WebSocket and forward events to the fulfiller.
pub async fn listen_for_events(
    config: AppConfig,
    tx: mpsc::Sender<RandomWordsRequestedEvent>,
    metrics: Arc<Metrics>,
) {
    let event_disc = event_discriminator("RandomWordsRequested");
    let dedup = Deduplicator::new();
    let mut reconnect_delay = WS_RECONNECT_MIN;

    loop {
        info!(url = %config.ws_url, "Connecting to WebSocket");

        match PubsubClient::new(&config.ws_url).await {
            Ok(pubsub) => {
                info!("WebSocket connected");
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
                                &event_disc,
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
        reconnect_delay = (reconnect_delay * 2).min(WS_RECONNECT_MAX);
    }
}

/// Scan transaction log lines for `RandomWordsRequested` events.
async fn process_log_lines(
    logs: &[String],
    event_disc: &[u8; 8],
    tx: &mpsc::Sender<RandomWordsRequestedEvent>,
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

        if disc == event_disc {
            let Some(event) = parse_random_words_requested_event(payload) else {
                warn!("Failed to parse RandomWordsRequested event payload");
                continue;
            };

            if !dedup.insert(event.request_id) {
                debug!(request_id = event.request_id, "Duplicate request, skipping");
                continue;
            }

            metrics.record_request();

            info!(
                request_id = event.request_id,
                subscription_id = event.subscription_id,
                requester = %event.requester,
                consumer = %event.consumer_program,
                num_words = event.num_words,
                callback_compute_limit = event.callback_compute_limit,
                slot = event.request_slot,
                "Received RandomWordsRequested event"
            );

            if tx.send(event).await.is_err() {
                error!("Channel closed, stopping listener");
                return;
            }
        }
    }
}

/// Parse a `RandomWordsRequested` event from its body (after discriminator).
///
/// Layout: request_id(8) + subscription_id(8) + consumer_program(32) +
/// requester(32) + num_words(4) + seed(32) + request_slot(8) + callback_compute_limit(4) = 128 bytes.
fn parse_random_words_requested_event(data: &[u8]) -> Option<RandomWordsRequestedEvent> {
    if data.len() < 128 {
        return None;
    }

    let request_id = u64::from_le_bytes(data[0..8].try_into().ok()?);
    let subscription_id = u64::from_le_bytes(data[8..16].try_into().ok()?);
    let consumer_program = Pubkey::try_from(&data[16..48]).ok()?;
    let requester = Pubkey::try_from(&data[48..80]).ok()?;
    let num_words = u32::from_le_bytes(data[80..84].try_into().ok()?);
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&data[84..116]);
    let request_slot = u64::from_le_bytes(data[116..124].try_into().ok()?);
    let callback_compute_limit = u32::from_le_bytes(data[124..128].try_into().ok()?);

    Some(RandomWordsRequestedEvent {
        request_id,
        subscription_id,
        consumer_program,
        requester,
        num_words,
        seed,
        request_slot,
        callback_compute_limit,
    })
}

/// Parse a RandomnessRequest account body (after discriminator).
///
/// Layout: request_id(8) + subscription_id(8) + consumer_program(32) +
/// requester(32) + num_words(4) + seed(32) + request_slot(8) + callback_compute_limit(4) +
/// status(1) + randomness(32) + fulfilled_slot(8) + bump(1)
fn parse_request_account_data(body: &[u8]) -> Option<RandomWordsRequestedEvent> {
    if body.len() < MIN_ACCOUNT_DATA_LEN - 8 {
        return None;
    }

    let request_id = u64::from_le_bytes(body[0..8].try_into().ok()?);
    let subscription_id = u64::from_le_bytes(body[8..16].try_into().ok()?);
    let consumer_program = Pubkey::try_from(&body[16..48]).ok()?;
    let requester = Pubkey::try_from(&body[48..80]).ok()?;
    let num_words = u32::from_le_bytes(body[80..84].try_into().ok()?);
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&body[84..116]);
    let request_slot = u64::from_le_bytes(body[116..124].try_into().ok()?);
    let callback_compute_limit = u32::from_le_bytes(body[124..128].try_into().ok()?);

    Some(RandomWordsRequestedEvent {
        request_id,
        subscription_id,
        consumer_program,
        requester,
        num_words,
        seed,
        request_slot,
        callback_compute_limit,
    })
}
