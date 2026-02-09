<p align="center">
  <img src="https://img.shields.io/badge/Solana-black?logo=solana&logoColor=9945FF&style=for-the-badge" alt="Solana" />
  <img src="https://img.shields.io/badge/Anchor_0.32-black?logo=anchor&logoColor=white&style=for-the-badge" alt="Anchor" />
  <img src="https://img.shields.io/badge/Rust-black?logo=rust&logoColor=white&style=for-the-badge" alt="Rust" />
  <img src="https://img.shields.io/badge/TypeScript-black?logo=typescript&logoColor=3178C6&style=for-the-badge" alt="TypeScript" />
</p>

<h1 align="center">Moirae</h1>

<p align="center">
  <strong>Verifiable Random Function oracle for Solana</strong><br/>
  On-chain cryptographic randomness with Ed25519 signature proofs<br/>
  <em>Named after the Moirae (&Mu;&omicron;&iota;&rho;&alpha;&iota;) — the Greek goddesses of fate who spin the thread of destiny</em>
</p>

<p align="center">
  <a href="#sdk">SDK</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#programs">Programs</a> &bull;
  <a href="#getting-started">Getting Started</a> &bull;
  <a href="#integration-guide">Integration Guide</a> &bull;
  <a href="#testing">Testing</a> &bull;
  <a href="docs/">Documentation</a>
</p>

---

## Overview

**Moirae** is a self-hosted VRF oracle system for Solana. It provides on-chain verifiable randomness through an HMAC-SHA256 + Ed25519 signature scheme with automatic callback delivery:

- An on-chain coordinator program manages subscriptions, verifies Ed25519 proofs, expands randomness, and delivers callbacks via CPI
- An off-chain backend watches for requests in real-time and submits cryptographically signed fulfillment transactions
- A TypeScript SDK provides subscription management, PDA derivation, and account deserialization
- Consumer programs integrate via CPI — request randomness and receive results through automatic callbacks

No third-party dependencies. No token. Just math and signatures.

## SDK

Install the TypeScript SDK:

```bash
npm install @moirae-vrf/sdk @solana/web3.js
```

Manage subscriptions and read accounts:

```typescript
import { Connection, Keypair } from "@solana/web3.js";
import { MoiraeVrf } from "@moirae-vrf/sdk";
import BN from "bn.js";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const vrf = new MoiraeVrf(connection);

// Read coordinator config
const config = await vrf.getConfig();
console.log("Fee per word:", config.feePerWord.toString());

// Create and fund a subscription
const payer = Keypair.fromSecretKey(/* ... */);
const { subscriptionId } = await vrf.createSubscription(payer);
await vrf.fundSubscription(payer, subscriptionId, new BN(1_000_000_000));

// Register a consumer program
await vrf.addConsumer(payer, subscriptionId, consumerProgramId);
```

See the [SDK README](sdk/README.md) for full API reference and the [examples/](examples/) directory for runnable scripts.

## Comparison

| Feature | Moirae | Switchboard | ORAO |
|---------|--------|-------------|------|
| **Cost** | < 0.001 SOL | ~0.002 SOL | 0.001 SOL |
| **Lifecycle** | 2 steps (request + callback) | 2 steps | 2 steps |
| **Speed** | ~1-2 slots | ~2-3 slots | ~2-3 slots |
| **Verification** | Ed25519 sig | TEE attestation | Multi-sig |
| **Callback** | Yes (automatic CPI) | Yes | Yes |
| **Self-hostable** | Yes | No | No |
| **Token required** | No | No | No |

## Architecture

```
                         Solana Blockchain
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   ┌──────────────┐        CPI         ┌──────────────┐  │
  │   │   vrf-sol     │◄────────────────── │  roll-dice   │  │
  │   │  coordinator  │ ──callback CPI──► │  (example)   │  │
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
  │  HTTP /health  │  HMAC-SHA256 + Ed25519
  │  HTTP /status  │  signature proof
  │  HTTP /metrics │
  └────────────────┘
```

### Request Lifecycle

| Step | Instruction | What Happens | Who |
|------|-------------|--------------|-----|
| 1 | `request_random_words` | Request PDA created, fee deducted from subscription, event emitted | Consumer program (CPI) |
| 2 | `fulfill_random_words` | Ed25519 proof verified, randomness expanded, callback CPI delivered to consumer, request PDA closed | Oracle backend |

The coordinator handles fulfillment, callback delivery, and cleanup in a single transaction.

### How Verification Works

Each fulfillment transaction contains two instructions:

1. **Native Ed25519 signature-verify** - proves the oracle signed `request_id || randomness` with its authority key
2. **`fulfill_random_words`** - the program introspects the Instructions sysvar to verify the Ed25519 proof matches the configured authority and expected message

This means the oracle cannot submit arbitrary randomness - it must provide a valid Ed25519 signature that the program cryptographically verifies on-chain.

### Randomness Derivation

```
output = HMAC-SHA256(secret, seed || request_slot || request_id)
```

- `seed` - 32-byte caller-provided entropy (prevents oracle pre-computation)
- `request_slot` - Solana slot at creation time (binds to chain state)
- `request_id` - monotonic counter (ensures uniqueness)

Multi-word expansion: `word[i] = SHA256(base_randomness || i_le_bytes)`

## Programs

### vrf-sol

> VRF Coordinator program with subscription-based billing and automatic callback delivery

| | |
|---|---|
| **Program ID** | `A4pDDsKvtX2U3jyEURVSoH15Mx4JcgUiSqCKxqWE3N48` |
| **Framework** | Anchor 0.32.1 |

**Accounts:**

| Account | Seeds | Description |
|---------|-------|-------------|
| `CoordinatorConfig` | `["coordinator-config"]` | Singleton. Admin, authority, fee_per_word, max_num_words, counters |
| `Subscription` | `["subscription", sub_id_le]` | Per-subscription. Owner, balance, request/consumer counts |
| `ConsumerRegistration` | `["consumer", sub_id_le, program_id]` | Per-consumer per-subscription authorization |
| `RandomnessRequest` | `["vrf-request", request_id_le]` | Per-request. Seed, status, randomness, callback accounts |

**Instructions:**

| Instruction | Description |
|-------------|-------------|
| `initialize` | Create the singleton config PDA (once per deployment) |
| `create_subscription` | Create a new subscription account |
| `fund_subscription` | Transfer SOL to a subscription's balance |
| `cancel_subscription` | Close subscription, refund balance (requires 0 consumers) |
| `add_consumer` | Register a consumer program for a subscription |
| `remove_consumer` | Deregister a consumer program |
| `request_random_words` | Create a request PDA, deduct fee, emit `RandomWordsRequested` |
| `fulfill_random_words` | Oracle submits VRF output + Ed25519 proof, delivers callback CPI, closes request |
| `update_config` | Admin updates authority/fee/max_words/admin |

### roll-dice

> Example consumer program demonstrating VRF integration with automatic callbacks

| | |
|---|---|
| **Program ID** | `7Q5b9aimnHmR8ooooRqxgfYfnLmPi6qrVR9GrJ1b6fDp` |
| **Framework** | Anchor 0.32.1 |

| Account | Seeds | Description |
|---------|-------|-------------|
| `GameConfig` | `["game-config"]` | Singleton. Coordinator program, subscription ID, admin |
| `DiceRoll` | `["dice-result", player, request_id_le]` | Player, VRF request ID, result (0=pending, 1-6=settled) |

Three instructions:
- `initialize` - Create game config with coordinator program and subscription ID
- `request_roll` - CPIs into `vrf_sol::request_random_words` (1 word, 200k CU callback limit)
- `fulfill_random_words` - Callback from coordinator; verifies coordinator PDA signer, computes `(u64 % 6) + 1`

### Backend Oracle

Rust service (`actix-web` + `tokio`) with three concurrent subsystems:

| Subsystem | Role |
|-----------|------|
| **Listener** | WebSocket log subscription + startup `getProgramAccounts` catch-up scan, deduplication |
| **Fulfiller** | Concurrent fulfillment with Ed25519 proofs, callback accounts from request PDA, exponential backoff retry |
| **HTTP** | `/health` (liveness), `/status` (readiness), `/metrics` (JSON counters) on configurable port |

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

After deployment, call `initialize` with your desired admin, authority (oracle signer), fee_per_word, and max_num_words. This can be done via the test suite or a custom script.

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
3. Automatically fulfill incoming randomness requests with callback delivery
4. Serve health/status/metrics endpoints on the configured port

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | No | `http://127.0.0.1:8899` | Solana JSON-RPC endpoint |
| `WS_URL` | No | `ws://127.0.0.1:8900` | Solana WebSocket endpoint |
| `AUTHORITY_KEYPAIR_PATH` | No | `~/.config/solana/id.json` | Path to oracle signer keypair |
| `HMAC_SECRET` | **Yes** | - | Secret for randomness derivation |
| `PROGRAM_ID` | **Yes** | - | Deployed VRF program ID |
| `CLUSTER` | No | `devnet` | Cluster name for explorer URLs |
| `HTTP_PORT` | No | `8080` | HTTP server port |
| `MAX_RETRIES` | No | `5` | Max retry attempts per fulfillment |
| `INITIAL_RETRY_DELAY_MS` | No | `500` | Initial retry delay (doubles each attempt) |
| `PRIORITY_FEE_MICRO_LAMPORTS` | No | `0` | Priority fee per compute unit |
| `FULFILLMENT_CONCURRENCY` | No | `4` | Max concurrent fulfillment tasks |

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
let cpi_accounts = vrf_sol::cpi::accounts::RequestRandomWords {
    requester: ctx.accounts.player.to_account_info(),
    config: ctx.accounts.vrf_config.to_account_info(),
    subscription: ctx.accounts.subscription.to_account_info(),
    consumer_registration: ctx.accounts.consumer_registration.to_account_info(),
    consumer_program: ctx.accounts.this_program.to_account_info(),
    request: ctx.accounts.vrf_request.to_account_info(),
    system_program: ctx.accounts.system_program.to_account_info(),
};
let cpi_ctx = CpiContext::new(
    ctx.accounts.vrf_program.to_account_info(),
    cpi_accounts,
);
vrf_sol::cpi::request_random_words(cpi_ctx, num_words, seed, callback_compute_limit)?;
```

### 3. Implement the callback

The coordinator will call your program's `fulfill_random_words` instruction automatically:

```rust
pub fn fulfill_random_words(
    ctx: Context<FulfillRandomWords>,
    request_id: u64,
    random_words: Vec<[u8; 32]>,
) -> Result<()> {
    // Verify the coordinator-config PDA signed this CPI
    let expected_pda = Pubkey::find_program_address(
        &[b"coordinator-config"],
        &ctx.accounts.game_config.coordinator_program,
    ).0;
    require!(
        ctx.accounts.coordinator_config.key() == expected_pda,
        MyError::InvalidCoordinator
    );

    // Use the randomness
    let random_value = u64::from_le_bytes(random_words[0][0..8].try_into().unwrap());
    let dice = (random_value % 6 + 1) as u8;

    Ok(())
}
```

See `program/programs/roll-dice/src/lib.rs` for a complete working example, or the [full integration guide](docs/integration-guide.md) for detailed documentation.

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
| `tests/01-vrf-sol.ts` | VRF program: init, subscriptions, consumers, request/fulfill, auth checks, config updates (16 tests) |
| `tests/02-roll-dice.ts` | Dice program: full callback flow, multiple rolls, events, error cases (6 tests) |
| `tests/03-integration.ts` | End-to-end with live backend: auto-fulfillment via callback, concurrent requests (3 tests) |

> **Note:** `03-integration.ts` requires the backend to be running against the same cluster. Tests 01 and 02 are self-contained and simulate the oracle locally.

### Backend Unit Tests

```bash
cd backend
cargo test
```

### SDK Build

```bash
cd sdk
npm install && npm run build
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
│   │   ├── vrf-sol/            # Core VRF coordinator program
│   │   │   └── src/
│   │   │       ├── lib.rs              # Program entrypoint
│   │   │       ├── state.rs            # CoordinatorConfig, Subscription, ConsumerRegistration, RandomnessRequest
│   │   │       ├── instructions/       # initialize, subscriptions, consumers, request, fulfill, update
│   │   │       ├── ed25519.rs          # Ed25519 instruction verification
│   │   │       ├── errors.rs           # VrfError enum
│   │   │       └── events.rs           # Anchor events
│   │   └── roll-dice/          # Example consumer program
│   │       └── src/lib.rs              # GameConfig, DiceRoll, request_roll, fulfill_random_words
│   ├── tests/                  # TypeScript test suite
│   └── Anchor.toml
├── sdk/                        # TypeScript SDK (@moirae-vrf/sdk)
│   └── src/
│       ├── client.ts           # MoiraeVrf class (subscriptions, accounts, PDAs)
│       ├── instructions.ts     # Low-level instruction builders
│       ├── accounts.ts         # Account deserialization
│       ├── pda.ts              # PDA derivation
│       ├── constants.ts        # Program IDs, discriminators, sizes
│       ├── types.ts            # TypeScript types
│       └── utils.ts            # waitForFulfillment, addPriorityFee
├── examples/                   # Runnable SDK examples
│   ├── request-randomness.ts   # Basic request flow
│   ├── dice-game.ts            # CPI dice game integration
│   └── batch-requests.ts       # Concurrent requests
├── backend/                    # Off-chain oracle service
│   ├── Dockerfile              # Production container
│   └── src/
│       ├── main.rs             # Entrypoint, HTTP server, graceful shutdown
│       ├── config.rs           # Environment-based configuration
│       ├── listener.rs         # WebSocket event listener + catch-up scan
│       ├── fulfiller.rs        # Concurrent fulfillment + retry logic
│       ├── consumer_accounts.rs# Callback account resolution from request PDA
│       ├── metrics.rs          # Atomic counters for monitoring
│       └── vrf.rs              # HMAC-SHA256 randomness computation
├── docs/                       # Documentation
│   ├── architecture.md         # System design, trust model, comparison
│   ├── integration-guide.md    # SDK + CPI integration reference
│   ├── deployment.md           # Deploy programs + backend
│   └── security.md             # Trust model, key management
├── .github/workflows/ci.yml   # CI pipeline
├── CLAUDE.md
└── LICENSE
```

## Documentation

- [Architecture](docs/architecture.md) — System design, randomness derivation, trust model, VRF comparison
- [Integration Guide](docs/integration-guide.md) — TypeScript SDK + Rust CPI integration with full code examples
- [Deployment](docs/deployment.md) — Program deploy, backend setup (Docker, systemd), env vars reference
- [Security](docs/security.md) — Trust model, HMAC secret management, key rotation

## License

ISC
