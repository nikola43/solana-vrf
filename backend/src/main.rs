//! VRF Oracle Backend
//!
//! Off-chain service that monitors the Solana VRF coordinator program for
//! randomness requests and automatically fulfills them with callback delivery.
//!
//! Runs three concurrent subsystems:
//!
//! - **Listener** — WebSocket subscription to on-chain events + startup catch-up scan.
//! - **Fulfiller** — Consumes request events and submits fulfillment transactions.
//! - **HTTP server** — Liveness (`/health`), readiness (`/status`), and `/metrics` probes.

use actix_web::{web, App, HttpResponse, HttpServer};
use solana_sdk::signature::Signer;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::info;
use tracing_subscriber::{fmt, EnvFilter};

mod config;
mod consumer_accounts;
mod fulfiller;
mod listener;
mod metrics;
mod vrf;

use config::AppConfig;
use metrics::Metrics;

/// Shared application state accessible from HTTP handlers.
struct AppState {
    /// Number of fulfillment transactions currently in-flight.
    pending_count: Arc<AtomicU64>,
    /// Aggregated metrics.
    metrics: Arc<Metrics>,
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

/// Metrics endpoint — returns JSON counters for monitoring.
async fn metrics_handler(data: web::Data<AppState>) -> HttpResponse {
    let pending = data.pending_count.load(Ordering::Relaxed);
    let mut json = data.metrics.to_json();
    if let Some(obj) = json.as_object_mut() {
        obj.insert(
            "pending_fulfillments".to_string(),
            serde_json::json!(pending),
        );
    }
    HttpResponse::Ok().json(json)
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
    info!(
        port = config.http_port,
        concurrency = config.fulfillment_concurrency,
        priority_fee = config.priority_fee_micro_lamports,
        "Backend configuration"
    );

    let pending_count = Arc::new(AtomicU64::new(0));
    let metrics = Arc::new(Metrics::new());
    let (tx, rx) = mpsc::channel(256);

    // Scan for any requests that arrived while the backend was offline.
    listener::catch_up_pending_requests(&config, &tx, &metrics).await;

    // Background: stream on-chain events and forward to the fulfiller.
    let listener_config = config.clone();
    let listener_tx = tx.clone();
    let listener_metrics = metrics.clone();
    let listener_handle = tokio::spawn(async move {
        listener::listen_for_events(listener_config, listener_tx, listener_metrics).await;
    });

    // Background: consume events and submit fulfillment transactions.
    let fulfiller_config = config.clone();
    let fulfiller_pending = pending_count.clone();
    let fulfiller_metrics = metrics.clone();
    let fulfiller_handle = tokio::spawn(async move {
        fulfiller::run_fulfiller(
            fulfiller_config,
            rx,
            fulfiller_pending,
            fulfiller_metrics,
        )
        .await;
    });

    let state = web::Data::new(AppState {
        pending_count: pending_count.clone(),
        metrics: metrics.clone(),
    });

    let bind_addr = format!("0.0.0.0:{}", config.http_port);
    info!(addr = %bind_addr, "Starting HTTP server");

    let server = HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .route("/health", web::get().to(health))
            .route("/status", web::get().to(status))
            .route("/metrics", web::get().to(metrics_handler))
    })
    .bind(&bind_addr)?
    .run();

    let server_handle = server.handle();

    // Graceful shutdown on Ctrl-C
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            info!("Received Ctrl-C, shutting down gracefully");
            server_handle.stop(true).await;
        }
    });

    // Run until server stops
    let result = server.await;

    // Abort background tasks on shutdown
    listener_handle.abort();
    fulfiller_handle.abort();

    info!("VRF backend stopped");
    result
}
