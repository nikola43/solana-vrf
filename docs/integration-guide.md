# Integration Guide

## Off-Chain (TypeScript SDK)

### Installation

```bash
npm install @moirae-vrf/sdk @solana/web3.js
```

### Quick Start

```typescript
import { Connection, Keypair } from "@solana/web3.js";
import { MoiraeVrf } from "@moirae-vrf/sdk";
import BN from "bn.js";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(/* ... */);
const vrf = new MoiraeVrf(connection);

// 1. Create and fund a subscription
const { subscriptionId } = await vrf.createSubscription(payer);
await vrf.fundSubscription(payer, subscriptionId, new BN(1_000_000_000)); // 1 SOL

// 2. Register your consumer program
await vrf.addConsumer(payer, subscriptionId, myConsumerProgramId);

// 3. Read config and accounts
const config = await vrf.getConfig();
console.log(`Fee: ${config.feePerWord.toString()} lamports/word`);
console.log(`Next request ID: ${config.requestCounter.toString()}`);
```

### Subscription Management

```typescript
// Create subscription
const { subscriptionId, subscriptionPda } = await vrf.createSubscription(payer);

// Fund subscription
await vrf.fundSubscription(payer, subscriptionId, new BN(5_000_000_000)); // 5 SOL

// Register consumer
await vrf.addConsumer(payer, subscriptionId, consumerProgramId);

// Remove consumer
await vrf.removeConsumer(payer, subscriptionId, consumerProgramId);

// Cancel subscription (requires 0 consumers, refunds balance)
await vrf.cancelSubscription(payer, subscriptionId);
```

### Using Low-Level Instructions

For custom transaction construction (e.g., combining with other instructions):

```typescript
import {
  createCreateSubscriptionInstruction,
  createFundSubscriptionInstruction,
  createAddConsumerInstruction,
  createRemoveConsumerInstruction,
  createCancelSubscriptionInstruction,
  createInitializeInstruction,
  getConfigPda,
  getSubscriptionPda,
  getConsumerPda,
  getRequestPda,
  addPriorityFee,
} from "@moirae-vrf/sdk";

// Build a subscription creation instruction
const nextSubId = config.subscriptionCounter;
const ix = createCreateSubscriptionInstruction(
  payer.publicKey,
  nextSubId,
);

// Optionally add priority fee
const tx = new Transaction();
tx.add(...addPriorityFee(1000)); // 1000 micro-lamports
tx.add(ix);
```

### Reading Account State

```typescript
import {
  decodeCoordinatorConfig,
  decodeSubscription,
  decodeConsumerRegistration,
  decodeRandomnessRequest,
} from "@moirae-vrf/sdk";

// Read VRF configuration
const [configPda] = getConfigPda();
const configInfo = await connection.getAccountInfo(configPda);
const config = decodeCoordinatorConfig(Buffer.from(configInfo.data));
console.log(`Fee: ${config.feePerWord.toString()} lamports`);
console.log(`Next ID: ${config.requestCounter.toString()}`);

// Read a subscription
const [subPda] = getSubscriptionPda(subscriptionId);
const subInfo = await connection.getAccountInfo(subPda);
const sub = decodeSubscription(Buffer.from(subInfo.data));
console.log(`Balance: ${sub.balance.toString()} lamports`);

// Read a specific request (if it hasn't been closed yet)
const [requestPda] = getRequestPda(requestId);
const requestInfo = await connection.getAccountInfo(requestPda);
if (requestInfo) {
  const request = decodeRandomnessRequest(Buffer.from(requestInfo.data));
  console.log(`Status: ${request.status}`); // 0=Pending, 1=Fulfilled
}
```

### Waiting for Fulfillment

```typescript
import { waitForFulfillment } from "@moirae-vrf/sdk";

// Note: In the callback model, request PDAs are closed after fulfillment.
// This may throw if the request was already fulfilled and closed.
try {
  const request = await waitForFulfillment(connection, requestId, undefined, {
    timeout: 30_000,
    interval: 2_000,
  });
  console.log("Fulfilled! Randomness:", Buffer.from(request.randomness).toString("hex"));
} catch (e) {
  // Expected: "Request PDA was closed (already fulfilled and callback delivered)"
  console.log("Request fulfilled and closed via callback");
}
```

---

## On-Chain (Rust CPI)

### Add Dependency

```toml
# Cargo.toml
[dependencies]
anchor-lang = "0.32.1"
vrf-sol = { path = "../vrf-sol", features = ["cpi"] }
```

### Request Randomness via CPI

```rust
use anchor_lang::prelude::*;

pub fn request_random(ctx: Context<RequestRandom>, seed: [u8; 32]) -> Result<()> {
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
    // Request 1 random word with 200k CU callback limit
    vrf_sol::cpi::request_random_words(cpi_ctx, 1, seed, 200_000)?;

    Ok(())
}
```

### Implement the Callback

The coordinator will automatically CPI into your program's `fulfill_random_words` instruction after the oracle fulfills the request:

```rust
pub fn fulfill_random_words(
    ctx: Context<FulfillRandomWords>,
    request_id: u64,
    random_words: Vec<[u8; 32]>,
) -> Result<()> {
    // Verify the callback came from the real coordinator
    let expected_pda = Pubkey::find_program_address(
        &[b"coordinator-config"],
        &ctx.accounts.game_config.coordinator_program,
    ).0;
    require!(
        ctx.accounts.coordinator_config.key() == expected_pda,
        MyError::InvalidCoordinator
    );

    // Use the randomness for your game logic
    let random_value = u64::from_le_bytes(random_words[0][0..8].try_into().unwrap());
    let dice = (random_value % 6 + 1) as u8; // 1-6

    Ok(())
}
```

### Account Structs

```rust
#[derive(Accounts)]
pub struct RequestRandom<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    /// VRF coordinator config (read for counter, mutated by CPI).
    #[account(mut)]
    pub vrf_config: Account<'info, vrf_sol::state::CoordinatorConfig>,

    /// Subscription account (balance deducted by CPI).
    #[account(mut)]
    pub subscription: Account<'info, vrf_sol::state::Subscription>,

    /// Consumer registration proving this program is authorized.
    pub consumer_registration: Account<'info, vrf_sol::state::ConsumerRegistration>,

    /// CHECK: Created by the VRF program CPI
    #[account(mut)]
    pub vrf_request: UncheckedAccount<'info>,

    /// CHECK: Must be this program's ID
    #[account(address = crate::ID)]
    pub this_program: UncheckedAccount<'info>,

    pub vrf_program: Program<'info, vrf_sol::program::VrfSol>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct FulfillRandomWords<'info> {
    /// The coordinator-config PDA that signed this CPI.
    pub coordinator_config: Signer<'info>,

    /// Your program's config (stores coordinator_program for PDA verification).
    #[account(seeds = [b"game-config"], bump = game_config.bump)]
    pub game_config: Account<'info, GameConfig>,

    /// Your game state account to update with the result.
    #[account(mut)]
    pub game_state: Account<'info, GameState>,
}
```

### Callback Account Registration

When calling `request_random_words`, the coordinator stores up to 4 callback accounts from the remaining_accounts. These accounts are passed to your program's `fulfill_random_words` callback. Pass them as remaining accounts on the request CPI:

```rust
// The remaining accounts on the request CPI become callback accounts
let cpi_ctx = CpiContext::new(
    ctx.accounts.vrf_program.to_account_info(),
    cpi_accounts,
).with_remaining_accounts(vec![
    ctx.accounts.game_config.to_account_info(),  // read-only
    ctx.accounts.game_state.to_account_info(),    // writable
]);
vrf_sol::cpi::request_random_words(cpi_ctx, 1, seed, 200_000)?;
```

### Full Working Example

See the `roll-dice` program at `program/programs/roll-dice/src/lib.rs` for a complete working implementation.

---

## PDA Reference

| Account | Seeds | Size |
|---------|-------|------|
| `CoordinatorConfig` | `["coordinator-config"]` | 101 bytes |
| `Subscription` | `["subscription", sub_id.to_le_bytes()]` | 69 bytes |
| `ConsumerRegistration` | `["consumer", sub_id.to_le_bytes(), consumer_program_id]` | 57 bytes |
| `RandomnessRequest` | `["vrf-request", request_id.to_le_bytes()]` | 308 bytes |

## Account Layouts

### CoordinatorConfig (101 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 32 | admin (Pubkey) |
| 40 | 32 | authority (Pubkey) |
| 72 | 8 | fee_per_word (u64 LE) |
| 80 | 4 | max_num_words (u32 LE) |
| 84 | 8 | request_counter (u64 LE) |
| 92 | 8 | subscription_counter (u64 LE) |
| 100 | 1 | bump (u8) |

### Subscription (69 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 8 | id (u64 LE) |
| 16 | 32 | owner (Pubkey) |
| 48 | 8 | balance (u64 LE) |
| 56 | 8 | req_count (u64 LE) |
| 64 | 4 | consumer_count (u32 LE) |
| 68 | 1 | bump (u8) |

### ConsumerRegistration (57 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 8 | subscription_id (u64 LE) |
| 16 | 32 | program_id (Pubkey) |
| 48 | 8 | nonce (u64 LE) |
| 56 | 1 | bump (u8) |

### RandomnessRequest (308 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 8 | request_id (u64 LE) |
| 16 | 8 | subscription_id (u64 LE) |
| 24 | 32 | consumer_program (Pubkey) |
| 56 | 32 | requester (Pubkey) |
| 88 | 4 | num_words (u32 LE) |
| 92 | 32 | seed ([u8; 32]) |
| 124 | 8 | request_slot (u64 LE) |
| 132 | 4 | callback_compute_limit (u32 LE) |
| 136 | 1 | status (u8): 0=Pending, 1=Fulfilled |
| 137 | 32 | randomness ([u8; 32]) |
| 169 | 8 | fulfilled_slot (u64 LE) |
| 177 | 1 | bump (u8) |
| 178 | 1 | callback_account_count (u8, max 4) |
| 179 | 128 | callback_account_keys ([Pubkey; 4]) |
| 307 | 1 | callback_writable_bitmap (u8, bit i = account i writable) |
