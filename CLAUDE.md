# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Solana VRF (Verifiable Random Function) oracle system — Chainlink VRF v2-style with subscriptions, consumer registration, and automatic callback delivery. Four main components:

- **`program/`** — Anchor workspace with two Solana programs (Anchor 0.32.1, Rust 2021 edition)
- **`backend/`** — Rust off-chain oracle service (Rust 2024 edition) that fulfills randomness requests
- **`sdk/`** — TypeScript SDK (`@moirae-vrf/sdk`) for subscription management and account deserialization
- **`examples/`** — Runnable TypeScript examples using the SDK

## Architecture

### Request Lifecycle

1. **Request** — consumer program CPIs `request_random_words` with a seed, num_words, and callback_compute_limit; fee deducted from subscription balance; request PDA created with status `Pending`
2. **Fulfill** — the off-chain oracle detects the `RandomWordsRequested` event, computes `HMAC-SHA256(secret, seed || slot || request_id)`, signs `request_id || randomness` with Ed25519, and submits a fulfillment tx; the coordinator verifies the proof, expands randomness into `num_words` values via `SHA256(randomness || i)`, CPIs callback into the consumer program, and closes the request PDA (returning rent to requester)

No consume/close steps needed — the coordinator handles everything in one transaction.

### On-chain Programs

**vrf-sol** (`A4pDDsKvtX2U3jyEURVSoH15Mx4JcgUiSqCKxqWE3N48`): VRF Coordinator program. Key PDAs:
- `CoordinatorConfig` — singleton at seeds `["coordinator-config"]`, holds admin/authority/fee_per_word/max_num_words/request_counter/subscription_counter/bump
- `Subscription` — per-subscription at seeds `["subscription", sub_id_le_bytes]`, holds id/owner/balance/req_count/consumer_count/bump
- `ConsumerRegistration` — per-consumer at seeds `["consumer", sub_id_le_bytes, consumer_program_id]`, holds subscription_id/program_id/nonce/bump
- `RandomnessRequest` — per-request at seeds `["vrf-request", request_id_le_bytes]`, holds request_id/subscription_id/consumer_program/requester/num_words/seed/request_slot/callback_compute_limit/status/randomness/fulfilled_slot/bump/callback_account_count/callback_account_keys([Pubkey;4])/callback_writable_bitmap

Fulfillment verification: the `fulfill_random_words` instruction introspects the Instructions sysvar to verify that an Ed25519 signature-verify instruction exists with the correct authority pubkey and message (`request_id || randomness`). The Ed25519 instruction can be at any index (scans up to 8 instructions, allowing ComputeBudget instructions before it).

Callback delivery: the coordinator signs the CPI into the consumer program using `invoke_signed` with the coordinator-config PDA seeds (`["coordinator-config", bump]`). The consumer verifies the signer matches the expected PDA derived from its stored coordinator_program.

Instructions: `initialize`, `create_subscription`, `fund_subscription`, `cancel_subscription`, `add_consumer`, `remove_consumer`, `request_random_words`, `fulfill_random_words`, `update_config`

**roll-dice** (`7Q5b9aimnHmR8ooooRqxgfYfnLmPi6qrVR9GrJ1b6fDp`): Example consumer program. Key PDAs:
- `GameConfig` — singleton at seeds `["game-config"]`, holds coordinator_program/subscription_id/admin/bump
- `DiceRoll` — per-roll at seeds `["dice-result", player, request_id_le_bytes]`, holds player/vrf_request_id/result/bump

Instructions: `initialize`, `request_roll` (CPIs `request_random_words`), `fulfill_random_words` (callback from coordinator)

### Backend Oracle

Rust service using `actix-web` + `tokio`. Three concurrent subsystems:
- **Listener** — WebSocket log subscription for real-time `RandomWordsRequested` events + startup catch-up scan via `getProgramAccounts`; deduplication via in-memory HashSet; exponential backoff reconnection (1s → 60s)
- **Fulfiller** — builds Ed25519 signature-verify + `fulfill_random_words` transactions with callback remaining_accounts read from request PDA; semaphore-based concurrency (default 4); exponential backoff retry on `BlockhashNotFound`; non-retryable error classification
- **Consumer accounts** — `consumer_accounts.rs` reads callback account keys and writable bitmap from the request PDA (up to 4 accounts)
- **HTTP server** — `/health` (liveness), `/status` (readiness + pending count), `/metrics` (JSON counters) on configurable port

Config via env vars: `RPC_URL`, `WS_URL`, `AUTHORITY_KEYPAIR_PATH`, `HMAC_SECRET`, `PROGRAM_ID`, `CLUSTER`, `HTTP_PORT`, `MAX_RETRIES`, `INITIAL_RETRY_DELAY_MS`, `PRIORITY_FEE_MICRO_LAMPORTS`, `FULFILLMENT_CONCURRENCY`.

### TypeScript SDK

Package `@moirae-vrf/sdk` with zero Anchor runtime dependency. Provides:
- **`MoiraeVrf`** class — subscription management (create, fund, add/remove consumer, cancel), account fetching, PDA derivation, `waitForFulfillment`
- **Instruction builders** — `createInitializeInstruction`, `createCreateSubscriptionInstruction`, `createFundSubscriptionInstruction`, `createAddConsumerInstruction`, `createRemoveConsumerInstruction`, `createCancelSubscriptionInstruction`
- **Account decoders** — `decodeCoordinatorConfig`, `decodeSubscription`, `decodeConsumerRegistration`, `decodeRandomnessRequest`
- **PDA helpers** — `getConfigPda`, `getSubscriptionPda`, `getConsumerPda`, `getRequestPda`
- **Utilities** — `waitForFulfillment`, `addPriorityFee`

## Build & Test Commands

### Programs (from `program/` directory)

```bash
anchor build                    # Build both programs
anchor test                     # Build + run all tests (01-vrf-sol, 02-roll-dice, 03-integration)
anchor test --skip-build        # Run tests without rebuilding
anchor deploy                   # Deploy to configured cluster
```

Tests use ts-mocha with 1,000,000ms timeout. Tests load the oracle keypair from `backend/vrf-signer.json`.

Run a specific test file:
```bash
cd program && yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/01-vrf-sol.ts
```

Lint:
```bash
cd program && yarn lint          # Check formatting
cd program && yarn lint:fix      # Fix formatting
```

### Backend (from `backend/` directory)

```bash
cargo build                     # Build
cargo run                       # Run (requires .env or env vars)
cargo test                      # Run unit tests (vrf::tests)
```

### SDK (from `sdk/` directory)

```bash
npm install                     # Install dependencies
npm run build                   # Dual CJS/ESM output in dist/
```

### CI

GitHub Actions (`.github/workflows/ci.yml`) runs three jobs on push/PR to main:
- **Backend**: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`
- **SDK**: `npm install`, `npm run build`
- **Programs**: `yarn install --frozen-lockfile`, `anchor build`

## Key Implementation Details

- Anchor discriminators: instruction = `sha256("global:<name>")[..8]`, event = `sha256("event:<name>")[..8]`, account = `sha256("account:<Name>")[..8]`
- Ed25519 instruction data layout: `[num_sigs(1), pad(1), offsets(7×u16), pubkey(32), sig(64), message(var)]` — all `*_instruction_index` fields must be `0xFFFF` (self-referencing)
- Ed25519 verification via `crate::ed25519::verify_ed25519_instruction()` — scans up to 8 instructions to find the Ed25519 program (allows ComputeBudget instructions before it)
- Randomness expansion: `word[i] = SHA256(base_randomness || i_le_bytes)` for multi-word requests
- Consumer callback discriminator: `SHA256("global:fulfill_random_words")[..8]`
- The backend manually constructs Anchor instructions (discriminator + borsh-encoded args) rather than using an IDL client
- Request counter on `CoordinatorConfig` is monotonically increasing and used as PDA seed for each request
- Subscription counter on `CoordinatorConfig` is monotonically increasing and used as PDA seed for each subscription
- Fee is deducted from the subscription balance at request time: `fee_per_word * num_words`
- The coordinator PDA (`["coordinator-config"]`) signs callback CPIs into consumer programs via `invoke_signed`
- Consumer programs verify the callback signer by deriving the expected coordinator-config PDA from their stored coordinator_program ID
- The `fulfill_random_words` instruction closes the request PDA after successful callback, returning rent to the requester
- Request PDA stores up to 4 callback accounts with a writable bitmap for the coordinator to pass as remaining_accounts during callback CPI
- The `Anchor.toml` provider currently points to devnet via Helius RPC
- Backend status byte offset in RandomnessRequest account: byte 136 (after discriminator)
- RandomWordsRequested event layout (after discriminator): request_id(8) + subscription_id(8) + consumer_program(32) + requester(32) + num_words(4) + seed(32) + request_slot(8) + callback_compute_limit(4) = 128 bytes
- Backend callback account offsets in RandomnessRequest: callback_count at byte 178, keys at 179 (4×32=128 bytes), writable bitmap at byte 307

## Account Sizes (including 8-byte discriminator)

| Account | Size |
|---------|------|
| CoordinatorConfig | 101 bytes |
| Subscription | 69 bytes |
| ConsumerRegistration | 57 bytes |
| RandomnessRequest | 308 bytes (178 core + 129 callback fields + 1 bitmap) |
