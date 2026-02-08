//! Application configuration loaded from environment variables.
//!
//! Required: `HMAC_SECRET`, `PROGRAM_ID`
//! Optional: `RPC_URL`, `WS_URL`, `AUTHORITY_KEYPAIR_PATH`, `CLUSTER`,
//!           `HTTP_PORT`, `MAX_RETRIES`, `INITIAL_RETRY_DELAY_MS`,
//!           `PRIORITY_FEE_MICRO_LAMPORTS`, `FULFILLMENT_CONCURRENCY`

use anyhow::{Context, Result};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{read_keypair_file, Keypair};
use std::str::FromStr;
use std::sync::Arc;

/// Application configuration for the VRF oracle backend.
///
/// Loaded once at startup via [`AppConfig::from_env`]. The `authority_keypair`
/// is wrapped in `Arc` so the config can be cheaply cloned across async tasks.
#[derive(Clone)]
pub struct AppConfig {
    /// Solana JSON-RPC endpoint (HTTP).
    pub rpc_url: String,
    /// Solana PubSub endpoint (WebSocket) for log subscriptions.
    pub ws_url: String,
    /// Ed25519 keypair used to sign fulfillment proofs. Must match the on-chain
    /// `VrfConfiguration::authority`.
    pub authority_keypair: Arc<Keypair>,
    /// Secret key for HMAC-SHA256 randomness generation. Must be kept confidential;
    /// if leaked, requesters could predict VRF outputs.
    pub hmac_secret: Vec<u8>,
    /// The deployed VRF program ID to monitor and interact with.
    pub program_id: Pubkey,
    /// Cluster name for explorer URLs (`devnet` or `mainnet-beta`).
    pub cluster: String,
    /// HTTP server port for health/status/metrics endpoints.
    pub http_port: u16,
    /// Maximum number of send-and-confirm retry attempts per fulfillment.
    pub max_retries: u32,
    /// Initial retry delay in milliseconds (doubles each attempt).
    pub initial_retry_delay_ms: u64,
    /// Priority fee in micro-lamports per compute unit (0 = no priority fee).
    pub priority_fee_micro_lamports: u64,
    /// Maximum number of concurrent fulfillment tasks.
    pub fulfillment_concurrency: usize,
}

impl AppConfig {
    /// Load configuration from environment variables.
    ///
    /// Returns a descriptive error if any required variable is missing or invalid.
    pub fn from_env() -> Result<Self> {
        let rpc_url = std::env::var("RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8899".into());
        let ws_url = std::env::var("WS_URL").unwrap_or_else(|_| "ws://127.0.0.1:8900".into());

        let keypair_path = std::env::var("AUTHORITY_KEYPAIR_PATH")
            .unwrap_or_else(|_| "~/.config/solana/id.json".into());
        let keypair_path = shellexpand::tilde(&keypair_path).to_string();
        let authority_keypair = read_keypair_file(&keypair_path)
            .map_err(|e| anyhow::anyhow!("{e}"))
            .with_context(|| format!("failed to read keypair from {keypair_path}"))?;

        let hmac_secret = std::env::var("HMAC_SECRET")
            .context("HMAC_SECRET env var must be set")?
            .into_bytes();

        let program_id_str = std::env::var("PROGRAM_ID").context("PROGRAM_ID env var must be set")?;
        let program_id = Pubkey::from_str(&program_id_str)
            .with_context(|| format!("invalid PROGRAM_ID: {program_id_str}"))?;

        let cluster =
            std::env::var("CLUSTER").unwrap_or_else(|_| "devnet".into());

        let http_port = std::env::var("HTTP_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8080);

        let max_retries = std::env::var("MAX_RETRIES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5);

        let initial_retry_delay_ms = std::env::var("INITIAL_RETRY_DELAY_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(500);

        let priority_fee_micro_lamports = std::env::var("PRIORITY_FEE_MICRO_LAMPORTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        let fulfillment_concurrency = std::env::var("FULFILLMENT_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(4);

        Ok(Self {
            rpc_url,
            ws_url,
            authority_keypair: Arc::new(authority_keypair),
            hmac_secret,
            program_id,
            cluster,
            http_port,
            max_retries,
            initial_retry_delay_ms,
            priority_fee_micro_lamports,
            fulfillment_concurrency,
        })
    }

    /// Return the Solscan explorer URL for a given transaction signature.
    pub fn explorer_url(&self, signature: &str) -> String {
        match self.cluster.as_str() {
            "mainnet-beta" => format!("https://solscan.io/tx/{signature}"),
            cluster => format!("https://solscan.io/tx/{signature}?cluster={cluster}"),
        }
    }
}
