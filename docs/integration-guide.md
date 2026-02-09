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
import { randomBytes } from "crypto";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(/* ... */);
const vrf = new MoiraeVrf(connection);

// Full lifecycle in 4 lines
const { requestId } = await vrf.requestRandomness(payer, randomBytes(32));
const { randomness } = await vrf.waitForFulfillment(requestId);
await vrf.consumeRandomness(payer, requestId);
await vrf.closeRequest(payer, requestId);
```

### Using Low-Level Instructions

For custom transaction construction (e.g., combining with other instructions):

```typescript
import {
  createRequestRandomnessInstruction,
  createConsumeRandomnessInstruction,
  createCloseRequestInstruction,
  getConfigPda,
  getRequestPda,
  addPriorityFee,
} from "@moirae-vrf/sdk";

// Build a request instruction manually
const [configPda] = getConfigPda();
const [requestPda] = getRequestPda(nextRequestId);

const ix = createRequestRandomnessInstruction(
  payer.publicKey,
  configPda,
  requestPda,
  treasuryPubkey,
  seed
);

// Optionally add priority fee
const tx = new Transaction();
tx.add(...addPriorityFee(1000)); // 1000 micro-lamports
tx.add(ix);
```

### Reading Account State

```typescript
import { decodeVrfConfig, decodeRandomnessRequest } from "@moirae-vrf/sdk";

// Read VRF configuration
const configInfo = await connection.getAccountInfo(configPda);
const config = decodeVrfConfig(Buffer.from(configInfo.data));
console.log(`Fee: ${config.fee.toString()} lamports`);
console.log(`Next ID: ${config.requestCounter.toString()}`);

// Read a specific request
const requestInfo = await connection.getAccountInfo(requestPda);
const request = decodeRandomnessRequest(Buffer.from(requestInfo.data));
console.log(`Status: ${request.status}`); // 0=Pending, 1=Fulfilled, 2=Consumed
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

// In your instruction handler:
pub fn request_random(ctx: Context<RequestRandom>, seed: [u8; 32]) -> Result<()> {
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

    // Store the request ID for later
    let request_id = ctx.accounts.vrf_config.request_counter;
    // Note: counter was already incremented by the CPI, so the actual
    // request ID is counter - 1 at this point

    Ok(())
}
```

### Consume Randomness via CPI

```rust
pub fn settle(ctx: Context<Settle>, request_id: u64) -> Result<()> {
    // Read the randomness BEFORE consuming
    let randomness = ctx.accounts.vrf_request.randomness;

    // Consume (marks as used, prevents double-consumption)
    let cpi_accounts = vrf_sol::cpi::accounts::ConsumeRandomness {
        requester: ctx.accounts.player.to_account_info(),
        request: ctx.accounts.vrf_request.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.vrf_program.to_account_info(),
        cpi_accounts,
    );
    vrf_sol::cpi::consume_randomness(cpi_ctx, request_id)?;

    // Use randomness for your game logic
    let random_value = u64::from_le_bytes(randomness[0..8].try_into().unwrap());
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

    #[account(mut)]
    pub vrf_config: Account<'info, vrf_sol::state::VrfConfiguration>,

    /// CHECK: Created by the VRF program CPI
    #[account(mut)]
    pub vrf_request: UncheckedAccount<'info>,

    /// CHECK: Must match vrf_config.treasury
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,

    pub vrf_program: Program<'info, vrf_sol::program::VrfSol>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(request_id: u64)]
pub struct Settle<'info> {
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [b"request", request_id.to_le_bytes().as_ref()],
        bump = vrf_request.bump,
        seeds::program = vrf_program.key(),
        constraint = vrf_request.status == 1, // Fulfilled
    )]
    pub vrf_request: Account<'info, vrf_sol::state::RandomnessRequest>,

    pub vrf_program: Program<'info, vrf_sol::program::VrfSol>,
}
```

### Full Working Example

See the `roll-dice` program at `program/programs/roll-dice/src/lib.rs` for a complete working implementation.

---

## PDA Reference

| Account | Seeds | Size |
|---------|-------|------|
| `VrfConfiguration` | `["vrf-config"]` | 121 bytes |
| `RandomnessRequest` | `["request", request_id.to_le_bytes()]` | 162 bytes |

## Account Layout

### VrfConfiguration (121 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 32 | admin (Pubkey) |
| 40 | 32 | authority (Pubkey) |
| 72 | 8 | fee (u64 LE) |
| 80 | 8 | request_counter (u64 LE) |
| 88 | 32 | treasury (Pubkey) |
| 120 | 1 | bump (u8) |

### RandomnessRequest (162 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 8 | request_id (u64 LE) |
| 16 | 32 | requester (Pubkey) |
| 48 | 32 | seed ([u8; 32]) |
| 80 | 8 | request_slot (u64 LE) |
| 88 | 32 | callback_program (Pubkey) |
| 120 | 1 | status (u8) |
| 121 | 32 | randomness ([u8; 32]) |
| 153 | 8 | fulfilled_slot (u64 LE) |
| 161 | 1 | bump (u8) |

---

## ZK Compressed Mode (Zero Rent)

For high-volume use cases, Moirae supports ZK Compressed requests that eliminate rent costs entirely.

### SDK Usage

```typescript
import { Connection, Keypair } from "@solana/web3.js";
import { MoiraeVrf, waitForCompressedFulfillment } from "@moirae-vrf/sdk";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(/* ... */);

const vrf = new MoiraeVrf(connection);
vrf.setPhotonRpcUrl("https://devnet.helius-rpc.com/?api-key=YOUR_KEY");

// Wait for a compressed request to be fulfilled
const result = await vrf.waitForCompressedFulfillment(requestId, {
  timeout: 60_000,
  interval: 3_000,
});
console.log("Randomness:", Buffer.from(result.randomness).toString("hex"));
```

### CompressedRandomnessRequest Layout (113 bytes, after discriminator)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | request_id (u64 LE) |
| 8 | 32 | requester (Pubkey) |
| 40 | 32 | seed ([u8; 32]) |
| 72 | 8 | request_slot (u64 LE) |
| 80 | 1 | status (u8): 0=Pending, 1=Fulfilled |
| 81 | 32 | randomness ([u8; 32]) |

### Backend Configuration

Set `PHOTON_RPC_URL` in your `.env` to enable compressed request support:

```env
PHOTON_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY"
```

The backend will automatically detect and fulfill both regular and compressed requests.
