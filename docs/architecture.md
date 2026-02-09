# Architecture

## System Overview

Moirae is a verifiable randomness oracle that uses HMAC-SHA256 + Ed25519 signature proofs to deliver on-chain randomness.

```
                         Solana Blockchain
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   ┌──────────────┐        CPI         ┌──────────────┐  │
  │   │   vrf-sol     │◄────────────────── │  Your Game   │  │
  │   │              │                     │  Program     │  │
  │   │  - request   │                     │              │  │
  │   │  - fulfill   │                     │  - request   │  │
  │   │  - consume   │                     │  - settle    │  │
  │   │  - close     │                     │              │  │
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

## Ed25519 Verification Flow

Each fulfillment transaction contains two instructions:

1. **Native Ed25519 signature-verify** (instruction index 0)
   - Proves the oracle signed `request_id (8 LE bytes) || randomness (32 bytes)` with its authority key
   - Uses the Solana runtime's built-in Ed25519 precompile

2. **`fulfill_randomness`** (instruction index 1)
   - Introspects the Instructions sysvar to verify instruction 0
   - Checks: correct program, 1 signature, matching public key, matching message
   - All `*_instruction_index` offsets must be `0xFFFF` (self-referencing)

This means the oracle **cannot submit arbitrary randomness** — it must provide a valid signature that the program cryptographically verifies on-chain.

## Request Lifecycle

```
                    ┌─────────┐
                    │ Request │  User calls request_randomness
                    │ Pending │  with a 32-byte seed
                    └────┬────┘
                         │
              Oracle detects event via WS
              Computes HMAC-SHA256 output
              Signs with Ed25519
                         │
                    ┌────▼────┐
                    │ Fulfill │  Oracle submits Ed25519 proof +
                    │ Filled  │  fulfill_randomness instruction
                    └────┬────┘
                         │
              Requester reads randomness
              and calls consume_randomness
                         │
                    ┌────▼────┐
                    │Consumed │  Prevents double-consumption
                    └────┬────┘
                         │
              Requester calls close_request
                         │
                    ┌────▼────┐
                    │ Closed  │  Account deleted, rent reclaimed
                    └─────────┘
```

## ZK Compressed Mode (Light Protocol)

Moirae supports an alternative compressed mode that eliminates rent costs using Light Protocol's ZK Compression.

### Compressed vs Regular

| Aspect | Regular | Compressed |
|--------|---------|------------|
| **Rent** | ~0.0016 SOL per request (refunded on close) | 0 SOL |
| **Lifecycle** | 4 steps: request → fulfill → consume → close | 2 steps: request → fulfill |
| **Storage** | On-chain PDA | Off-chain Merkle tree (via Light Protocol) |
| **Concurrent lock** | 1000 requests = 1.6 SOL locked | 1000 requests = 0 SOL locked |
| **Complexity** | Simple PDA model | Requires Photon indexer for state queries |

### Compressed Flow

```
  Requester                  VRF Program              Light System Program
     │                          │                            │
     │  request_compressed      │                            │
     │─────────────────────────►│                            │
     │  (seed, proof, address)  │       CPI: create          │
     │                          │───────────────────────────►│
     │                          │  ◄── compressed account ───│
     │                          │                            │
     │         CompressedRandomnessRequested event           │
     │                          │                            │
     │                    Oracle detects event                │
     │                    Queries Photon for state            │
     │                    Computes HMAC + Ed25519             │
     │                          │                            │
     │  fulfill_compressed      │                            │
     │◄─────────────────────────│       CPI: update          │
     │  (randomness, proof)     │───────────────────────────►│
     │                          │  ◄── updated account ──────│
     │                          │                            │
     │         RandomnessFulfilled event                      │
     │                                                       │
     │  Query Photon for result  ─────────────────────────────
```

### Required Infrastructure

- **Photon Indexer**: Helius provides a Photon indexer on devnet at `https://devnet.helius-rpc.com/?api-key=<key>`
- **Light System Program**: `SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7` (deployed on devnet + mainnet)
- **Account Compression Program**: `compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq`

## Trust Model

| Party | Trust Assumption |
|-------|-----------------|
| **Oracle operator** | Must keep HMAC secret confidential. If leaked, requesters could predict outputs. |
| **Requester** | Does not need to trust the oracle for correctness — the Ed25519 proof is verified on-chain. However, the oracle could censor (refuse to fulfill) requests. |
| **On-chain program** | Trustless verification. The program only accepts randomness backed by a valid Ed25519 signature from the configured authority. |

**Single oracle model**: This is a single-oracle system (not multi-party). The oracle is trusted for liveness (it must fulfill requests) but not for correctness (the cryptographic proof is verified on-chain). This makes it faster and cheaper than multi-party schemes.

## Comparison with Other VRF Solutions

| Feature | Moirae | Switchboard | ORAO | MagicBlock |
|---------|-----------|-------------|------|------------|
| **Approach** | HMAC + Ed25519 | TEE (Intel SGX) | Ed25519 multi-party | Ephemeral Rollups |
| **Oracle model** | Single oracle | TEE-based | Multi-party (3+) | Single |
| **Cost per request** | < 0.001 SOL | ~0.002 SOL | 0.001 SOL | 0.0005 SOL |
| **Fulfillment time** | ~1-2 slots | ~2-3 slots | ~2-3 slots | ~1 slot |
| **Callback support** | Planned | Yes | Yes | Yes |
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
- Startup catch-up scan via `getProgramAccounts` (finds missed requests)
- Live WebSocket subscription to program logs
- Exponential backoff on disconnect (1s → 60s cap)
- Request deduplication to prevent overlap between catch-up and live streams

### Fulfiller
- Concurrent fulfillment with configurable semaphore (default: 4 concurrent)
- Exponential backoff retry on `BlockhashNotFound` errors
- Optional priority fee for congested periods
- Metrics recording (latency, success/fail counts)

### HTTP Server
- `/health` — liveness probe
- `/status` — readiness + pending count
- `/metrics` — JSON counters for monitoring
