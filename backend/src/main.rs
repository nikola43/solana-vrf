//! VRF Oracle Backend
//!
//! Off-chain service that monitors the Solana VRF program for randomness
//! requests and automatically fulfills them. Runs three concurrent subsystems:
//!
//! - **Listener** — WebSocket subscription to on-chain events + startup catch-up scan.
//! - **Fulfiller** — Consumes request events and submits fulfillment transactions.
//! - **HTTP server** — Liveness (`/health`) and readiness (`/status`) probes.

use actix_web::{web, App, HttpResponse, HttpServer};
use solana_sdk::signature::Signer;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::info;
use tracing_subscriber::{fmt, EnvFilter};

mod config;
mod fulfiller;
mod listener;
mod vrf;

use config::AppConfig;

/// Shared application state accessible from HTTP handlers.
struct AppState {
    /// Number of fulfillment transactions currently in-flight.
    pending_count: Arc<AtomicU64>,
}

/// Liveness probe — returns 200 if the process is running.
async fn health() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({"status": "ok"}))
}

/// Readiness / status probe — reports the number of in-flight fulfillments.
async fn status(data: web::Data<AppState>) -> HttpResponse {
    let pending = data.pending_count.load(Ordering::Relaxed);
    HttpResponse::Ok().json(serde_json::json!({
        "status": "running",
        "pending_fulfillments": pending
    }))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();

    fmt::Subscriber::builder()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,solana_client=warn,solana_rpc_client=warn,hyper=warn,reqwest=warn")),
        )
        .with_target(true)
        .with_ansi(true)
        .init();

    let config = AppConfig::from_env().expect("invalid configuration");

    info!(
        program = %config.program_id,
        authority = %config.authority_keypair.pubkey(),
        "Starting VRF backend"
    );
    info!(rpc = %config.rpc_url, ws = %config.ws_url, "Endpoints configured");

    let pending_count = Arc::new(AtomicU64::new(0));
    let (tx, rx) = mpsc::channel(256);

    // Scan for any requests that arrived while the backend was offline.
    listener::catch_up_pending_requests(&config, &tx).await;

    // Background: stream on-chain events and forward to the fulfiller.
    let listener_config = config.clone();
    let listener_tx = tx.clone();
    tokio::spawn(async move {
        listener::listen_for_events(listener_config, listener_tx).await;
    });

    // Background: consume events and submit fulfillment transactions.
    let fulfiller_config = config.clone();
    let fulfiller_pending = pending_count.clone();
    tokio::spawn(async move {
        fulfiller::run_fulfiller(fulfiller_config, rx, fulfiller_pending).await;
    });

    let state = web::Data::new(AppState {
        pending_count: pending_count.clone(),
    });

    info!(addr = "0.0.0.0:8080", "Starting HTTP server");

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .route("/health", web::get().to(health))
            .route("/status", web::get().to(status))
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
