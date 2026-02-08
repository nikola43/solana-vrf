/**
 * Simplest VRF example — get verifiable randomness in one call.
 *
 * Usage: npx ts-node request-randomness.ts
 * Requires: KEYPAIR_PATH env var or ~/.config/solana/id.json
 */

import { Connection, Keypair } from "@solana/web3.js";
import { MoiraeVrf } from "@moirae-vrf/sdk";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";

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

  // One call does everything: request → wait → consume → close
  console.log("Requesting randomness...");
  const { randomness, requestId } = await vrf.getRandomness(payer);

  console.log(`Request ID: ${requestId.toString()}`);
  console.log(`Randomness: ${Buffer.from(randomness).toString("hex")}`);
  console.log("Done! Request was automatically consumed and closed.");
}

main().catch(console.error);
