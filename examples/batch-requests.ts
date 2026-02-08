/**
 * Batch requests example: submit 5 randomness requests,
 * wait for all, and verify distinct results.
 *
 * Usage: npx ts-node batch-requests.ts
 * Requires: KEYPAIR_PATH env var or ~/.config/solana/id.json
 */

import { Connection, Keypair } from "@solana/web3.js";
import { MoiraeVrf } from "@moirae-vrf/sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const BATCH_SIZE = 5;

function loadKeypair(): Keypair {
  const keypairPath =
    process.env.KEYPAIR_PATH ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair();
  const vrf = new MoiraeVrf(connection);

  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`Requesting ${BATCH_SIZE} random values...\n`);

  // Each call handles the full lifecycle automatically
  const results = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const result = await vrf.getRandomness(payer);
    const hex = Buffer.from(result.randomness).toString("hex");
    console.log(`  #${i + 1} (ID ${result.requestId.toString()}): ${hex.slice(0, 32)}...`);
    results.push(hex);
  }

  // Verify uniqueness
  const unique = new Set(results);
  if (unique.size === BATCH_SIZE) {
    console.log(`\nAll ${BATCH_SIZE} values are unique!`);
  } else {
    console.error(`\nWARNING: Only ${unique.size}/${BATCH_SIZE} unique values`);
  }
}

main().catch(console.error);
