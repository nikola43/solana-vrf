# @moirae-vrf/sdk

TypeScript SDK for the Moirae VRF (Verifiable Random Function) oracle on Solana. Zero Anchor runtime dependency.

## Install

```bash
npm install @moirae-vrf/sdk @solana/web3.js
```

## Quick Start

Get verifiable randomness in 3 lines:

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { MoiraeVrf } from "@moirae-vrf/sdk";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(/* your keypair */);
const vrf = new MoiraeVrf(connection);

// One call does everything: request → wait for oracle → consume → close
const { randomness } = await vrf.getRandomness(payer);
console.log("Random bytes:", Buffer.from(randomness).toString("hex"));
```

That's it. The `getRandomness` method handles the entire lifecycle automatically.

## API Reference

### `MoiraeVrf` (High-Level Client)

```ts
const vrf = new MoiraeVrf(connection, programId?);
```

#### Simple Methods (recommended)

| Method | Description |
|--------|-------------|
| `getRandomness(payer, opts?)` | Get random bytes in one call. Handles request, wait, consume, and close automatically. |
| `requestAndWait(payer, opts?)` | Request + wait for fulfillment. Does NOT consume/close (for on-chain programs that read the request account). |

Options for both methods:

```ts
{
  seed?: Uint8Array;      // 32-byte entropy (auto-generated if omitted)
  priorityFee?: number;   // Micro-lamports per compute unit
  timeout?: number;       // Max wait time in ms (default: 60000)
  interval?: number;      // Polling interval in ms (default: 2000)
}
```

#### Step-by-Step Methods (advanced)

| Method | Description |
|--------|-------------|
| `requestRandomness(payer, seed, priorityFee?)` | Submit a randomness request. Returns `{ requestId, requestPda }` |
| `requestRandomnessWithCallback(payer, seed, callbackProgram, priorityFee?)` | Request with a callback program for automatic CPI |
| `waitForFulfillment(requestId, opts?)` | Poll until fulfilled. Returns the request account with randomness |
| `consumeRandomness(payer, requestId)` | Mark randomness as consumed |
| `closeRequest(payer, requestId)` | Close request account and reclaim rent |

#### Read Methods

| Method | Description |
|--------|-------------|
| `getConfig()` | Fetch VRF configuration |
| `getRequest(requestId)` | Fetch a specific request account |
| `getNextRequestId()` | Get the next request ID from the config counter |
| `getConfigPda()` | Derive the config PDA address |
| `getRequestPda(requestId)` | Derive a request PDA address |

### Low-Level Instruction Builders

```ts
import {
  createRequestRandomnessInstruction,
  createRequestRandomnessWithCallbackInstruction,
  createConsumeRandomnessInstruction,
  createCloseRequestInstruction,
} from "@moirae-vrf/sdk";
```

Use these when building custom transactions (e.g., combining with priority fees or other instructions).

### PDA Derivation

```ts
import { getConfigPda, getRequestPda } from "@moirae-vrf/sdk";

const [configPda, configBump] = getConfigPda(programId);
const [requestPda, requestBump] = getRequestPda(requestId, programId);
```

### Account Deserialization

```ts
import { decodeVrfConfig, decodeRandomnessRequest } from "@moirae-vrf/sdk";

const config = decodeVrfConfig(Buffer.from(accountInfo.data));
const request = decodeRandomnessRequest(Buffer.from(accountInfo.data));
```

### Utilities

```ts
import { waitForFulfillment, addPriorityFee } from "@moirae-vrf/sdk";

// Poll for fulfillment
const request = await waitForFulfillment(connection, requestId, programId, {
  timeout: 60_000,
  interval: 1_000,
});

// Add priority fee instructions
const feeIxs = addPriorityFee(1000, 200_000); // 1000 micro-lamports, 200k CU limit
```

### Types

```ts
import {
  RequestStatus,
  VrfConfig,
  RandomnessRequestAccount,
  RequestRandomnessResult,
  GetRandomnessOptions,
  GetRandomnessResult,
  WaitForFulfillmentOptions,
} from "@moirae-vrf/sdk";
```

## Build

```bash
npm install
npm run build   # Dual CJS/ESM output in dist/
```

## License

ISC
