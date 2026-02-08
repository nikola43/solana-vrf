# Moirae VRF Examples

Usage examples for the `@moirae-vrf/sdk` on devnet.

## Prerequisites

- Node.js 18+
- A Solana keypair with devnet SOL (`solana airdrop 2`)
- The VRF backend oracle running against devnet (for automatic fulfillment)

## Setup

```bash
cd examples
npm install
```

## Examples

### Basic Request

The simplest end-to-end flow: request, wait, consume, close.

```bash
npx ts-node request-randomness.ts
```

### Dice Game

Uses the deployed `roll-dice` program to demonstrate on-chain CPI integration.

```bash
npx ts-node dice-game.ts
```

### Batch Requests

Submits 5 concurrent randomness requests and verifies all produce unique results.

```bash
npx ts-node batch-requests.ts
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `KEYPAIR_PATH` | `~/.config/solana/id.json` | Path to payer keypair |
