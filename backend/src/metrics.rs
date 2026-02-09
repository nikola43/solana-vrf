//! Prometheus-style metrics for the VRF oracle backend.
//!
//! All counters are backed by atomics for lock-free concurrent access.

use std::sync::atomic::{AtomicU64, Ordering};

/// Aggregated metrics for the VRF oracle backend.
///
/// Thread-safe via atomics; cloneable via `Arc<Metrics>`.
pub struct Metrics {
    /// Total number of regular randomness requests received.
    pub requests_received: AtomicU64,
    /// Total number of regular requests successfully fulfilled on-chain.
    pub requests_fulfilled: AtomicU64,
    /// Total number of fulfillment attempts that failed permanently.
    pub requests_failed: AtomicU64,
    /// Sum of fulfillment latencies in milliseconds (for computing average).
    pub fulfillment_latency_sum_ms: AtomicU64,
    /// Number of fulfilled requests contributing to latency sum.
    pub fulfillment_count: AtomicU64,

    // Compressed request metrics
    /// Total number of compressed randomness requests received.
    pub compressed_requests_received: AtomicU64,
    /// Total number of compressed requests successfully fulfilled.
    pub compressed_requests_fulfilled: AtomicU64,
    /// Sum of compressed fulfillment latencies in milliseconds.
    pub compressed_fulfillment_latency_sum_ms: AtomicU64,
    /// Number of compressed fulfilled requests contributing to latency sum.
    pub compressed_fulfillment_count: AtomicU64,
}

impl Metrics {
    /// Create a new zeroed metrics instance.
    pub fn new() -> Self {
        Self {
            requests_received: AtomicU64::new(0),
            requests_fulfilled: AtomicU64::new(0),
            requests_failed: AtomicU64::new(0),
            fulfillment_latency_sum_ms: AtomicU64::new(0),
            fulfillment_count: AtomicU64::new(0),
            compressed_requests_received: AtomicU64::new(0),
            compressed_requests_fulfilled: AtomicU64::new(0),
            compressed_fulfillment_latency_sum_ms: AtomicU64::new(0),
            compressed_fulfillment_count: AtomicU64::new(0),
        }
    }

    /// Record a successful regular fulfillment with its latency.
    pub fn record_fulfillment(&self, latency_ms: u64) {
        self.requests_fulfilled.fetch_add(1, Ordering::Relaxed);
        self.fulfillment_latency_sum_ms
            .fetch_add(latency_ms, Ordering::Relaxed);
        self.fulfillment_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a failed fulfillment.
    pub fn record_failure(&self) {
        self.requests_failed.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a new regular request received.
    pub fn record_request(&self) {
        self.requests_received.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a new compressed request received.
    pub fn record_compressed_request(&self) {
        self.compressed_requests_received
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Record a successful compressed fulfillment with its latency.
    pub fn record_compressed_fulfillment(&self, latency_ms: u64) {
        self.compressed_requests_fulfilled
            .fetch_add(1, Ordering::Relaxed);
        self.compressed_fulfillment_latency_sum_ms
            .fetch_add(latency_ms, Ordering::Relaxed);
        self.compressed_fulfillment_count
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Compute average fulfillment latency in milliseconds, or 0 if none.
    pub fn avg_latency_ms(&self) -> u64 {
        let count = self.fulfillment_count.load(Ordering::Relaxed);
        if count == 0 {
            return 0;
        }
        self.fulfillment_latency_sum_ms.load(Ordering::Relaxed) / count
    }

    /// Compute average compressed fulfillment latency in ms, or 0 if none.
    pub fn avg_compressed_latency_ms(&self) -> u64 {
        let count = self.compressed_fulfillment_count.load(Ordering::Relaxed);
        if count == 0 {
            return 0;
        }
        self.compressed_fulfillment_latency_sum_ms
            .load(Ordering::Relaxed)
            / count
    }

    /// Serialize metrics as a JSON value.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "requests_received": self.requests_received.load(Ordering::Relaxed),
            "requests_fulfilled": self.requests_fulfilled.load(Ordering::Relaxed),
            "requests_failed": self.requests_failed.load(Ordering::Relaxed),
            "avg_fulfillment_latency_ms": self.avg_latency_ms(),
            "total_fulfillment_latency_ms": self.fulfillment_latency_sum_ms.load(Ordering::Relaxed),
            "fulfillment_count": self.fulfillment_count.load(Ordering::Relaxed),
            "compressed_requests_received": self.compressed_requests_received.load(Ordering::Relaxed),
            "compressed_requests_fulfilled": self.compressed_requests_fulfilled.load(Ordering::Relaxed),
            "avg_compressed_latency_ms": self.avg_compressed_latency_ms(),
            "compressed_fulfillment_count": self.compressed_fulfillment_count.load(Ordering::Relaxed),
        })
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}
