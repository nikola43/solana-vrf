//! Prometheus-style metrics for the VRF oracle backend.

use std::sync::atomic::{AtomicU64, Ordering};

/// Aggregated metrics for the VRF oracle backend.
pub struct Metrics {
    /// Total number of randomness requests received.
    pub requests_received: AtomicU64,
    /// Total number of requests successfully fulfilled on-chain.
    pub requests_fulfilled: AtomicU64,
    /// Total number of fulfillment attempts that failed permanently.
    pub requests_failed: AtomicU64,
    /// Sum of fulfillment latencies in milliseconds.
    pub fulfillment_latency_sum_ms: AtomicU64,
    /// Number of fulfilled requests contributing to latency sum.
    pub fulfillment_count: AtomicU64,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            requests_received: AtomicU64::new(0),
            requests_fulfilled: AtomicU64::new(0),
            requests_failed: AtomicU64::new(0),
            fulfillment_latency_sum_ms: AtomicU64::new(0),
            fulfillment_count: AtomicU64::new(0),
        }
    }

    pub fn record_fulfillment(&self, latency_ms: u64) {
        self.requests_fulfilled.fetch_add(1, Ordering::Relaxed);
        self.fulfillment_latency_sum_ms
            .fetch_add(latency_ms, Ordering::Relaxed);
        self.fulfillment_count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_failure(&self) {
        self.requests_failed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_request(&self) {
        self.requests_received.fetch_add(1, Ordering::Relaxed);
    }

    pub fn avg_latency_ms(&self) -> u64 {
        let count = self.fulfillment_count.load(Ordering::Relaxed);
        if count == 0 {
            return 0;
        }
        self.fulfillment_latency_sum_ms.load(Ordering::Relaxed) / count
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "requests_received": self.requests_received.load(Ordering::Relaxed),
            "requests_fulfilled": self.requests_fulfilled.load(Ordering::Relaxed),
            "requests_failed": self.requests_failed.load(Ordering::Relaxed),
            "avg_fulfillment_latency_ms": self.avg_latency_ms(),
            "total_fulfillment_latency_ms": self.fulfillment_latency_sum_ms.load(Ordering::Relaxed),
            "fulfillment_count": self.fulfillment_count.load(Ordering::Relaxed),
        })
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}
