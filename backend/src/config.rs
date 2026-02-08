//! Application configuration loaded from environment variables.
//!
//! Required: `HMAC_SECRET`, `PROGRAM_ID`
//! Optional: `RPC_URL`, `WS_URL`, `AUTHORITY_KEYPAIR_PATH`

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

        Ok(Self {
            rpc_url,
            ws_url,
            authority_keypair: Arc::new(authority_keypair),
            hmac_secret,
            program_id,
        })
    }
}
