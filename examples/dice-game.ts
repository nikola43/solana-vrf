/**
 * Dice game example using the deployed roll-dice program + VRF SDK.
 *
 * Demonstrates how to:
 * 1. Request a dice roll via the roll-dice program (which CPIs into vrf-sol)
 * 2. Wait for VRF fulfillment using the SDK
 * 3. Settle the roll to get a 1-6 result
 *
 * Usage: npx ts-node dice-game.ts
 * Requires: KEYPAIR_PATH env var or ~/.config/solana/id.json
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { MoiraeVrf, getConfigPda, VRF_PROGRAM_ID } from "@moirae-vrf/sdk";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { createHash } from "crypto";

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const ROLL_DICE_PROGRAM_ID = new PublicKey(
  "7Q5b9aimnHmR8ooooRqxgfYfnLmPi6qrVR9GrJ1b6fDp"
);

function loadKeypair(): Keypair {
  const keypairPath =
    process.env.KEYPAIR_PATH ||
    path.join(os.homedir(), ".config", "solana", "id.json");
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

/** Compute sha256("global:<name>")[..8] for an Anchor discriminator. */
function anchorDiscriminator(name: string): Buffer {
  const hash = createHash("sha256").update(`global:${name}`).digest();
  return hash.subarray(0, 8);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const player = loadKeypair();
  const vrf = new MoiraeVrf(connection);

  console.log(`Player: ${player.publicKey.toBase58()}`);

  // Fetch current VRF config to get the next request ID and treasury
  const config = await vrf.getConfig();
  const requestId = config.requestCounter;
  const idBytes = requestId.toArrayLike(Buffer, "le", 8);

  // Derive PDAs
  const [configPda] = getConfigPda();
  const [requestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("request"), idBytes],
    VRF_PROGRAM_ID
  );
  const [diceRollPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("dice-roll"), player.publicKey.toBuffer(), idBytes],
    ROLL_DICE_PROGRAM_ID
  );

  // 1. Request a dice roll
  const seed = randomBytes(32);
  const requestRollDisc = anchorDiscriminator("request_roll");
  const requestRollData = Buffer.concat([requestRollDisc, seed]);

  const requestRollIx = new TransactionInstruction({
    programId: ROLL_DICE_PROGRAM_ID,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: requestPda, isSigner: false, isWritable: true },
      { pubkey: config.treasury, isSigner: false, isWritable: true },
      { pubkey: diceRollPda, isSigner: false, isWritable: true },
      { pubkey: VRF_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: requestRollData,
  });

  console.log("Rolling dice...");
  const tx1 = new Transaction().add(requestRollIx);
  await sendAndConfirmTransaction(connection, tx1, [player]);
  console.log(`Dice roll requested! Request ID: ${requestId.toString()}`);

  // 2. Wait for VRF fulfillment
  console.log("Waiting for oracle fulfillment...");
  const fulfilled = await vrf.waitForFulfillment(requestId, {
    timeout: 60_000,
  });
  console.log(
    `VRF fulfilled with randomness: ${Buffer.from(fulfilled.randomness).toString("hex").slice(0, 16)}...`
  );

  // 3. Settle the roll
  const settleRollDisc = anchorDiscriminator("settle_roll");
  const settleRollData = Buffer.concat([settleRollDisc, idBytes]);

  const settleRollIx = new TransactionInstruction({
    programId: ROLL_DICE_PROGRAM_ID,
    keys: [
      { pubkey: player.publicKey, isSigner: true, isWritable: false },
      { pubkey: requestPda, isSigner: false, isWritable: true },
      { pubkey: diceRollPda, isSigner: false, isWritable: true },
      { pubkey: VRF_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: settleRollData,
  });

  console.log("Settling roll...");
  const tx2 = new Transaction().add(settleRollIx);
  await sendAndConfirmTransaction(connection, tx2, [player]);

  // Compute expected dice value from randomness
  const randomU64 = new BN(Buffer.from(fulfilled.randomness.slice(0, 8)), "le");
  const diceValue = randomU64.mod(new BN(6)).add(new BN(1)).toNumber();
  console.log(`Dice result: ${diceValue}`);
}

main().catch(console.error);
