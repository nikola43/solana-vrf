# @moirae-vrf/sdk

TypeScript SDK for the Moirae VRF (Verifiable Random Function) oracle on Solana. Zero Anchor runtime dependency.

## Install

```bash
npm install @moirae-vrf/sdk @solana/web3.js
```

## Quick Start

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { MoiraeVrf } from "@moirae-vrf/sdk";
import BN from "bn.js";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(/* your keypair */);
const vrf = new MoiraeVrf(connection);

// Create and fund a subscription
const { subscriptionId } = await vrf.createSubscription(payer);
await vrf.fundSubscription(payer, subscriptionId, new BN(1_000_000_000));

// Register a consumer program
await vrf.addConsumer(payer, subscriptionId, myConsumerProgramId);

// Read coordinator config
const config = await vrf.getConfig();
console.log("Fee per word:", config.feePerWord.toString());
console.log("Next request ID:", config.requestCounter.toString());
```

## API Reference

### `MoiraeVrf` (High-Level Client)

```ts
const vrf = new MoiraeVrf(connection, programId?);
```

#### Subscription Management

| Method | Description |
|--------|-------------|
| `createSubscription(payer, priorityFee?)` | Create a new subscription. Returns `{ subscriptionId, subscriptionPda }` |
| `fundSubscription(payer, subscriptionId, amount)` | Fund a subscription with SOL |
| `addConsumer(owner, subscriptionId, consumerProgramId)` | Register a consumer program for a subscription |
| `removeConsumer(owner, subscriptionId, consumerProgramId)` | Remove a consumer program from a subscription |
| `cancelSubscription(owner, subscriptionId)` | Cancel subscription and reclaim balance (requires 0 consumers) |

#### Account Fetchers

| Method | Description |
|--------|-------------|
| `getConfig()` | Fetch coordinator configuration |
| `getSubscription(subscriptionId)` | Fetch a subscription account |
| `getConsumerRegistration(subscriptionId, consumerProgramId)` | Fetch a consumer registration |
| `getRequest(requestId)` | Fetch a specific request account |
| `getNextRequestId()` | Get the next request ID from config counter |
| `getNextSubscriptionId()` | Get the next subscription ID from config counter |

#### PDA Derivation

| Method | Description |
|--------|-------------|
| `getConfigPda()` | Derive the config PDA address |
| `getSubscriptionPda(subscriptionId)` | Derive a subscription PDA address |
| `getConsumerPda(subscriptionId, consumerProgramId)` | Derive a consumer registration PDA address |
| `getRequestPda(requestId)` | Derive a request PDA address |

#### Fulfillment Monitoring

| Method | Description |
|--------|-------------|
| `waitForFulfillment(requestId, opts?)` | Poll until fulfilled. May throw if PDA was already closed (expected in callback model) |

### Low-Level Instruction Builders

```ts
import {
  createInitializeInstruction,
  createCreateSubscriptionInstruction,
  createFundSubscriptionInstruction,
  createAddConsumerInstruction,
  createRemoveConsumerInstruction,
  createCancelSubscriptionInstruction,
} from "@moirae-vrf/sdk";
```

Use these when building custom transactions (e.g., combining with priority fees or other instructions).

### PDA Derivation

```ts
import { getConfigPda, getSubscriptionPda, getConsumerPda, getRequestPda } from "@moirae-vrf/sdk";

const [configPda, configBump] = getConfigPda(programId);
const [subPda, subBump] = getSubscriptionPda(subscriptionId, programId);
const [consumerPda, consumerBump] = getConsumerPda(subscriptionId, consumerProgramId, programId);
const [requestPda, requestBump] = getRequestPda(requestId, programId);
```

### Account Deserialization

```ts
import {
  decodeCoordinatorConfig,
  decodeSubscription,
  decodeConsumerRegistration,
  decodeRandomnessRequest,
} from "@moirae-vrf/sdk";

const config = decodeCoordinatorConfig(Buffer.from(accountInfo.data));
const subscription = decodeSubscription(Buffer.from(accountInfo.data));
const registration = decodeConsumerRegistration(Buffer.from(accountInfo.data));
const request = decodeRandomnessRequest(Buffer.from(accountInfo.data));
```

### Utilities

```ts
import { waitForFulfillment, addPriorityFee } from "@moirae-vrf/sdk";

// Poll for fulfillment (note: request PDAs are closed after callback delivery)
const request = await waitForFulfillment(connection, requestId, programId, {
  timeout: 30_000,
  interval: 2_000,
});

// Add priority fee instructions
const feeIxs = addPriorityFee(1000, 200_000); // 1000 micro-lamports, 200k CU limit
```

### Types

```ts
import {
  RequestStatus,
  CoordinatorConfig,
  SubscriptionAccount,
  ConsumerRegistrationAccount,
  RandomnessRequestAccount,
  CreateSubscriptionResult,
  RequestRandomWordsResult,
  WaitForFulfillmentOptions,
} from "@moirae-vrf/sdk";
```

### Constants

```ts
import {
  VRF_PROGRAM_ID,
  DISCRIMINATORS,
  ACCOUNT_DISCRIMINATORS,
  COORDINATOR_CONFIG_SIZE,
  SUBSCRIPTION_SIZE,
  CONSUMER_REGISTRATION_SIZE,
  RANDOMNESS_REQUEST_SIZE,
} from "@moirae-vrf/sdk";
```

## Build

```bash
npm install
npm run build   # Dual CJS/ESM output in dist/
```

## License

ISC
