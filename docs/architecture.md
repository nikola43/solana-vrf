# Architecture

## System Overview

Moirae is a verifiable randomness oracle that uses HMAC-SHA256 + Ed25519 signature proofs to deliver on-chain randomness with automatic callback delivery.

```
                         Solana Blockchain
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   ┌──────────────┐        CPI         ┌──────────────┐  │
  │   │   vrf-sol     │◄────────────────── │  Your Game   │  │
  │   │  coordinator  │ ──callback CPI──► │  Program     │  │
  │   │              │                     │              │  │
  │   │  - request   │                     │  - request   │  │
  │   │  - fulfill   │                     │  - callback  │  │
  │   │  + callback  │                     │              │  │
  │   └──────┬───────┘                     └──────────────┘  │
  │          │                                               │
  └──────────┼───────────────────────────────────────────────┘
             │ Events (WebSocket)
             ▼
  ┌──────────────────────┐
  │   Backend Oracle      │
  │                       │
  │  Listener ──► Fulfiller
  │                │
  │  /health       │  HMAC-SHA256 + Ed25519
  │  /status       │  signature proof
  │  /metrics      │
  └────────────────┘
```

## Randomness Derivation

```
output = HMAC-SHA256(secret, seed || request_slot || request_id)
```

| Input | Source | Purpose |
|-------|--------|---------|
| `secret` | Oracle's HMAC key (env var) | Makes output unpredictable without the key |
| `seed` | 32 bytes from requester | Prevents oracle pre-computation |
| `request_slot` | Solana slot at creation | Binds output to chain state at request time |
| `request_id` | Monotonic counter | Ensures uniqueness across requests |

The output is **deterministic** (same inputs = same output) but **unpredictable** without knowledge of the HMAC secret.

### Multi-Word Expansion

For requests with `num_words > 1`, the base randomness is expanded:

```
word[i] = SHA256(base_randomness || i.to_le_bytes())
```

This produces `num_words` independent 32-byte random values from a single HMAC output.

## Ed25519 Verification Flow

Each fulfillment transaction contains two instructions:

1. **Native Ed25519 signature-verify** (can be at any index; the program scans up to 8 instructions)
   - Proves the oracle signed `request_id (8 LE bytes) || randomness (32 bytes)` with its authority key
   - Uses the Solana runtime's built-in Ed25519 precompile

2. **`fulfill_random_words`** (the coordinator instruction)
   - Introspects the Instructions sysvar to find the Ed25519 instruction
   - Checks: correct program, 1 signature, matching public key, matching message
   - All `*_instruction_index` offsets must be `0xFFFF` (self-referencing)

This means the oracle **cannot submit arbitrary randomness** — it must provide a valid signature that the program cryptographically verifies on-chain.

## Request Lifecycle

```
                    ┌──────────┐
                    │ Request  │  Consumer CPIs request_random_words
                    │ Pending  │  with seed, num_words, callback_compute_limit
                    └────┬─────┘
                         │
              Oracle detects event via WebSocket
              Computes HMAC-SHA256 output
              Signs request_id || randomness with Ed25519
                         │
                    ┌────▼─────┐
                    │ Fulfill  │  Oracle submits Ed25519 proof +
                    │          │  fulfill_random_words instruction
                    │          │  Coordinator:
                    │          │    1. Verifies Ed25519 proof
                    │          │    2. Expands randomness into num_words
                    │          │    3. CPIs fulfill_random_words into consumer
                    │          │    4. Closes request PDA (rent → requester)
                    └──────────┘
```

The entire fulfill + callback + cleanup happens in a single transaction. No separate consume or close steps are needed.

## Subscription Model

Moirae uses a subscription-based billing model similar to Chainlink VRF v2:

1. **Create subscription** — owner gets a subscription ID
2. **Fund subscription** — deposit SOL to cover VRF fees
3. **Register consumers** — authorize specific programs to use the subscription
4. **Request randomness** — consumer CPIs request_random_words; fee deducted from subscription
5. **Manage** — owner can remove consumers, cancel subscription (refund remaining balance)

### Fee Calculation

```
fee = fee_per_word × num_words
```

The fee is deducted from the subscription balance at request time, before the oracle fulfills.

## Trust Model

| Party | Trust Assumption |
|-------|-----------------|
| **Oracle operator** | Must keep HMAC secret confidential. If leaked, requesters could predict outputs. |
| **Requester** | Does not need to trust the oracle for correctness — the Ed25519 proof is verified on-chain. However, the oracle could censor (refuse to fulfill) requests. |
| **On-chain program** | Trustless verification. The program only accepts randomness backed by a valid Ed25519 signature from the configured authority. |

**Single oracle model**: This is a single-oracle system (not multi-party). The oracle is trusted for liveness (it must fulfill requests) but not for correctness (the cryptographic proof is verified on-chain). This makes it faster and cheaper than multi-party schemes.

## Comparison with Other VRF Solutions

| Feature | Moirae | Switchboard | ORAO | MagicBlock |
|---------|--------|-------------|------|------------|
| **Approach** | HMAC + Ed25519 | TEE (Intel SGX) | Ed25519 multi-party | Ephemeral Rollups |
| **Oracle model** | Single oracle | TEE-based | Multi-party (3+) | Single |
| **Cost per request** | < 0.001 SOL | ~0.002 SOL | 0.001 SOL | 0.0005 SOL |
| **Fulfillment time** | ~1-2 slots | ~2-3 slots | ~2-3 slots | ~1 slot |
| **Callback support** | Yes (automatic CPI) | Yes | Yes | Yes |
| **Subscription billing** | Yes | Yes | No | No |
| **SDK** | TypeScript | TypeScript + Rust | TypeScript + Rust | TypeScript |
| **Self-hostable** | Yes | No (TEE required) | No | Partial |
| **On-chain verification** | Ed25519 sig proof | TEE attestation | Multi-sig threshold | Rollup proof |

### Key Trade-offs

- **Simplicity**: Single oracle = simpler architecture, fewer failure modes, lower latency
- **Cost**: No token staking, no multi-party coordination overhead
- **Self-hostable**: Run your own oracle with your own keys
- **Centralization**: Single point of failure for liveness (mitigated by monitoring + redundancy)

## Backend Architecture

The backend oracle runs three concurrent subsystems:

### Listener
- Startup catch-up scan via `getProgramAccounts` (finds missed requests by filtering status byte)
- Live WebSocket subscription to program logs
- Exponential backoff on disconnect (1s → 60s cap)
- Request deduplication via in-memory HashSet to prevent overlap between catch-up and live streams

### Fulfiller
- Concurrent fulfillment with configurable semaphore (default: 4 concurrent)
- Reads callback accounts (up to 4) from the request PDA's stored keys and writable bitmap
- Exponential backoff retry on `BlockhashNotFound` errors (initial 500ms, doubles each attempt, max 60s)
- Non-retryable error classification (RequestNotPending, Unauthorized, etc.) to skip stale requests
- Optional priority fee for congested periods
- Metrics recording (latency, success/fail counts)

### HTTP Server
- `/health` — liveness probe (`{"status":"ok"}`)
- `/status` — readiness + pending count (`{"status":"running","pending_fulfillments":N}`)
- `/metrics` — JSON counters (requests received/fulfilled/failed, avg latency, pending)
