<p align="center">
  <img src="https://img.shields.io/badge/Solana-black?logo=solana&logoColor=9945FF&style=for-the-badge" alt="Solana" />
  <img src="https://img.shields.io/badge/Anchor_0.32-black?logo=anchor&logoColor=white&style=for-the-badge" alt="Anchor" />
  <img src="https://img.shields.io/badge/Rust-black?logo=rust&logoColor=white&style=for-the-badge" alt="Rust" />
  <img src="https://img.shields.io/badge/TypeScript-black?logo=typescript&logoColor=3178C6&style=for-the-badge" alt="TypeScript" />
</p>

<h1 align="center">Solana VRF</h1>

<p align="center">
  <strong>Verifiable Random Function oracle for Solana</strong><br/>
  On-chain cryptographic randomness with Ed25519 signature proofs
</p>

<p align="center">
  <a href="#architecture">Architecture</a> &bull;
  <a href="#programs">Programs</a> &bull;
  <a href="#getting-started">Getting Started</a> &bull;
  <a href="#integration-guide">Integration Guide</a> &bull;
  <a href="#testing">Testing</a>
</p>

---

## Overview

**solana-vrf** is a self-hosted VRF oracle system for Solana. It provides on-chain verifiable randomness through an HMAC-SHA256 + Ed25519 signature scheme:

- An on-chain program accepts randomness requests and verifies fulfillment proofs using Solana's native Ed25519 precompile
- An off-chain backend watches for requests in real-time and submits cryptographically signed fulfillment transactions
- Consumer programs integrate via CPI to request and consume randomness

No third-party dependencies. No token. Just math and signatures.

## Architecture

```
                         Solana Blockchain
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   ┌──────────────┐        CPI         ┌──────────────┐  │
  │   │   vrf-sol     │◄────────────────── │  roll-dice   │  │
  │   │              │                     │  (example)   │  │
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
  │  HTTP /health  │  HMAC-SHA256 + Ed25519
  │  HTTP /status  │  signature proof
  └────────────────┘
```

### Request Lifecycle

| Step | Instruction | Status | Who |
|------|-------------|--------|-----|
| 1 | `request_randomness` | `Pending (0)` | Any account |
| 2 | `fulfill_randomness` | `Fulfilled (1)` | Oracle backend |
| 3 | `consume_randomness` | `Consumed (2)` | Original requester |
| 4 | `close_request` | Account deleted | Original requester |

### How Verification Works

Each fulfillment transaction contains two instructions:

1. **Native Ed25519 signature-verify** - proves the oracle signed `request_id || randomness` with its authority key
2. **`fulfill_randomness`** - the program introspects the Instructions sysvar to verify the Ed25519 proof matches the configured authority and expected message

This means the oracle cannot submit arbitrary randomness - it must provide a valid Ed25519 signature that the program cryptographically verifies on-chain.

### Randomness Derivation

```
output = HMAC-SHA256(secret, seed || request_slot || request_id)
```

- `seed` - 32-byte caller-provided entropy (prevents oracle pre-computation)
- `request_slot` - Solana slot at creation time (binds to chain state)
- `request_id` - monotonic counter (ensures uniqueness)

## Programs

### vrf-sol

> Core VRF oracle program

| | |
|---|---|
| **Program ID** | `A4pDDsKvtX2U3jyEURVSoH15Mx4JcgUiSqCKxqWE3N48` |
| **Framework** | Anchor 0.32.1 |

**Accounts:**

| Account | Seeds | Description |
|---------|-------|-------------|
| `VrfConfiguration` | `["vrf-config"]` | Singleton. Admin, authority, fee, treasury, request counter |
| `RandomnessRequest` | `["request", request_id_le]` | Per-request. Seed, status, randomness output, slots |

**Instructions:**

| Instruction | Description |
|-------------|-------------|
| `initialize` | Create the singleton config PDA (once per deployment) |
| `request_randomness` | Create a request PDA, pay fee, emit `RandomnessRequested` |
| `fulfill_randomness` | Oracle submits VRF output + Ed25519 proof |
| `consume_randomness` | Requester acknowledges the randomness |
| `update_config` | Admin updates authority/fee/treasury/admin |
| `close_request` | Reclaim rent from consumed request |

### roll-dice

> Example consumer program demonstrating VRF integration

| | |
|---|---|
| **Program ID** | `7Q5b9aimnHmR8ooooRqxgfYfnLmPi6qrVR9GrJ1b6fDp` |
| **Framework** | Anchor 0.32.1 |

| Account | Seeds | Description |
|---------|-------|-------------|
| `DiceRoll` | `["dice-roll", player, request_id_le]` | Player, VRF request ID, result (0=pending, 1-6=settled) |

Two instructions:
- `request_roll` - CPIs into `vrf_sol::request_randomness`
- `settle_roll` - Reads randomness, CPIs `consume_randomness`, computes `(u64 % 6) + 1`

### Backend Oracle

Rust service (`actix-web` + `tokio`) with three concurrent subsystems:

| Subsystem | Role |
|-----------|------|
| **Listener** | WebSocket log subscription + startup `getProgramAccounts` catch-up scan |
| **Fulfiller** | Builds Ed25519 + fulfill transactions, exponential backoff retry |
| **HTTP** | `/health` (liveness) and `/status` (readiness + pending count) on `:8080` |

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) (v1.18+)
- [Anchor](https://www.anchor-lang.com/docs/installation) (v0.32.1)
- [Node.js](https://nodejs.org/) (v18+) + Yarn
- A Solana keypair (`solana-keygen new` if you don't have one)

### 1. Build the programs

```bash
cd program
yarn install
anchor build
```

### 2. Deploy to devnet

```bash
cd program
solana config set --url devnet
anchor deploy
```

### 3. Initialize the VRF config

After deployment, call `initialize` with your desired admin, authority (oracle signer), treasury, and fee. This can be done via the test suite or a custom script.

### 4. Run the backend oracle

```bash
cd backend
cp .env.example .env
# Edit .env with your RPC URL, keypair path, HMAC secret, and program ID
cargo run
```

The backend will:
1. Scan for any pending requests that were missed while offline
2. Subscribe to real-time events via WebSocket
3. Automatically fulfill incoming randomness requests
4. Serve health/status endpoints on port 8080

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | No | `http://127.0.0.1:8899` | Solana JSON-RPC endpoint |
| `WS_URL` | No | `ws://127.0.0.1:8900` | Solana WebSocket endpoint |
| `AUTHORITY_KEYPAIR_PATH` | No | `~/.config/solana/id.json` | Path to oracle signer keypair |
| `HMAC_SECRET` | **Yes** | - | Hex-encoded secret for randomness derivation |
| `PROGRAM_ID` | **Yes** | - | Deployed VRF program ID |

## Integration Guide

To consume VRF randomness in your own program:

### 1. Add the dependency

```toml
# Cargo.toml
[dependencies]
vrf-sol = { path = "../vrf-sol", features = ["cpi"] }
```

### 2. Request randomness (CPI)

```rust
let cpi_accounts = vrf_sol::cpi::accounts::RequestRandomness {
    requester: ctx.accounts.player.to_account_info(),
    config: ctx.accounts.vrf_config.to_account_info(),
    request: ctx.accounts.vrf_request.to_account_info(),
    treasury: ctx.accounts.treasury.to_account_info(),
    system_program: ctx.accounts.system_program.to_account_info(),
};
let cpi_ctx = CpiContext::new(
    ctx.accounts.vrf_program.to_account_info(),
    cpi_accounts,
);
vrf_sol::cpi::request_randomness(cpi_ctx, seed)?;
```

### 3. Consume randomness after fulfillment (CPI)

```rust
// Read the randomness from the fulfilled request
let randomness = ctx.accounts.vrf_request.randomness;

// Consume it (marks as used, prevents double-consumption)
let cpi_accounts = vrf_sol::cpi::accounts::ConsumeRandomness {
    requester: ctx.accounts.player.to_account_info(),
    request: ctx.accounts.vrf_request.to_account_info(),
};
let cpi_ctx = CpiContext::new(
    ctx.accounts.vrf_program.to_account_info(),
    cpi_accounts,
);
vrf_sol::cpi::consume_randomness(cpi_ctx, request_id)?;

// Use the randomness bytes however you need
let value = u64::from_le_bytes(randomness[0..8].try_into().unwrap());
```

See `program/programs/roll-dice/src/lib.rs` for a complete working example.

## Testing

### Unit & Integration Tests

```bash
cd program

# Run all tests (builds programs, starts local validator)
anchor test

# Run without rebuilding
anchor test --skip-build

# Run a specific test file
yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/01-vrf-sol.ts
```

| Test File | Description |
|-----------|-------------|
| `tests/01-vrf-sol.ts` | VRF program: full lifecycle, auth checks, Ed25519 verification, error cases (23 tests) |
| `tests/02-roll-dice.ts` | Dice program: CPI integration, settle logic, edge cases (8 tests) |
| `tests/03-integration.ts` | End-to-end with live backend: auto-fulfillment, concurrent requests |

> **Note:** `03-integration.ts` requires the backend to be running against the same cluster. Tests 01 and 02 are self-contained and simulate the oracle locally.

### Backend Unit Tests

```bash
cd backend
cargo test
```

### Linting

```bash
cd program
yarn lint        # Check
yarn lint:fix    # Auto-fix
```

## Project Structure

```
solana-vrf/
├── program/                    # Anchor workspace
│   ├── programs/
│   │   ├── vrf-sol/            # Core VRF oracle program
│   │   │   └── src/
│   │   │       ├── lib.rs              # Program entrypoint
│   │   │       ├── state.rs            # VrfConfiguration, RandomnessRequest
│   │   │       ├── instructions/       # initialize, request, fulfill, consume, close, update
│   │   │       ├── errors.rs           # VrfError enum
│   │   │       └── events.rs           # Anchor events
│   │   └── roll-dice/          # Example consumer program
│   │       └── src/lib.rs              # DiceRoll, request_roll, settle_roll
│   ├── tests/                  # TypeScript test suite
│   └── Anchor.toml
├── backend/                    # Off-chain oracle service
│   └── src/
│       ├── main.rs             # Entrypoint, HTTP server
│       ├── config.rs           # Environment-based configuration
│       ├── listener.rs         # WebSocket event listener + catch-up scan
│       ├── fulfiller.rs        # Transaction builder + retry logic
│       └── vrf.rs              # HMAC-SHA256 randomness computation
└── CLAUDE.md
```

## License

ISC
