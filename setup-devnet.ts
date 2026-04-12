/**
 * VRF Devnet Setup Script
 *
 * Deploys and initializes the VRF coordinator:
 * 1. Initialize coordinator config (admin=authority=wallet)
 * 2. Create subscription and fund it
 * 3. Register mining_launcher as a consumer
 *
 * Run: RPC_URL=... ts-node setup-devnet.ts
 */

import { Connection, PublicKey, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as fs from "fs";
import * as crypto from "crypto";

// ---- Config ----
const VRF_PROGRAM_ID = new PublicKey("531CgBXgrP1QxbQ4bfBj4ddqERp7eBWRxRNxZzNKVkT5");
const MINING_LAUNCHER_PROGRAM_ID = new PublicKey("GouGce6KDgnZ7gPfXvGeUh1vk6XYD8VVS2ZYD3FBKPGV");

const RPC_URL = process.env.RPC_URL || "https://solana-devnet.core.chainstack.com/d94f12887d06dde45fd75296bddf83e7";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || "/home/bigfoot/.config/solana/id.json";

// ---- Helpers ----

function loadKeypair(path: string): Keypair {
  const data = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

function anchorDiscriminator(namespace: string, name: string): Buffer {
  const hash = crypto.createHash("sha256").update(`${namespace}:${name}`).digest();
  return hash.subarray(0, 8);
}

// PDA derivations
function getConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("coordinator-config")],
    VRF_PROGRAM_ID
  );
}

function getSubscriptionPda(subscriptionId: bigint): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(subscriptionId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("subscription"), buf],
    VRF_PROGRAM_ID
  );
}

function getConsumerPda(subscriptionId: bigint, consumerProgram: PublicKey): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(subscriptionId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("consumer"), buf, consumerProgram.toBuffer()],
    VRF_PROGRAM_ID
  );
}

// ---- Instruction builders ----

function buildInitializeIx(admin: PublicKey, authority: PublicKey, feePerWord: bigint, maxNumWords: number): { ix: any; configPda: PublicKey } {
  const [configPda] = getConfigPda();

  const disc = anchorDiscriminator("global", "initialize");
  // Args: authority(32) + fee_per_word(8) + max_num_words(4)
  const data = Buffer.alloc(8 + 32 + 8 + 4);
  disc.copy(data, 0);
  authority.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(feePerWord, 40);
  data.writeUInt32LE(maxNumWords, 48);

  const ix = {
    programId: VRF_PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };

  return { ix, configPda };
}

function buildCreateSubscriptionIx(owner: PublicKey, subscriptionId: bigint): { ix: any; subscriptionPda: PublicKey } {
  const [configPda] = getConfigPda();
  const [subscriptionPda] = getSubscriptionPda(subscriptionId);

  const disc = anchorDiscriminator("global", "create_subscription");
  const data = Buffer.alloc(8);
  disc.copy(data, 0);

  const ix = {
    programId: VRF_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: subscriptionPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };

  return { ix, subscriptionPda };
}

function buildFundSubscriptionIx(funder: PublicKey, subscriptionId: bigint, amount: bigint): any {
  const [subscriptionPda] = getSubscriptionPda(subscriptionId);

  const disc = anchorDiscriminator("global", "fund_subscription");
  // Args: subscription_id(8) + amount(8)
  const data = Buffer.alloc(8 + 8 + 8);
  disc.copy(data, 0);
  data.writeBigUInt64LE(subscriptionId, 8);
  data.writeBigUInt64LE(amount, 16);

  return {
    programId: VRF_PROGRAM_ID,
    keys: [
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: subscriptionPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
}

function buildAddConsumerIx(owner: PublicKey, subscriptionId: bigint, consumerProgram: PublicKey): { ix: any; consumerPda: PublicKey } {
  const [subscriptionPda] = getSubscriptionPda(subscriptionId);
  const [consumerPda] = getConsumerPda(subscriptionId, consumerProgram);

  const disc = anchorDiscriminator("global", "add_consumer");
  // Args: consumer_program(32)
  const data = Buffer.alloc(8 + 32);
  disc.copy(data, 0);
  consumerProgram.toBuffer().copy(data, 8);

  const ix = {
    programId: VRF_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: subscriptionPda, isSigner: false, isWritable: true },
      { pubkey: consumerPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };

  return { ix, consumerPda };
}

// ---- Main ----

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(KEYPAIR_PATH);
  console.log(`Wallet: ${payer.publicKey.toBase58()}`);
  console.log(`VRF Program: ${VRF_PROGRAM_ID.toBase58()}`);
  console.log(`Mining Launcher: ${MINING_LAUNCHER_PROGRAM_ID.toBase58()}`);

  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(2)} SOL\n`);

  // Step 1: Initialize coordinator config
  console.log("=== Step 1: Initialize VRF Config ===");
  const { ix: initIx, configPda } = buildInitializeIx(
    payer.publicKey,
    payer.publicKey, // authority = wallet (VRF backend uses same keypair)
    0n,              // fee_per_word = 0 (devnet)
    10               // max_num_words
  );
  console.log(`Config PDA: ${configPda.toBase58()}`);

  try {
    const tx1 = new Transaction().add(initIx);
    const sig1 = await sendAndConfirmTransaction(connection, tx1, [payer]);
    console.log(`Initialize tx: ${sig1}`);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("Config already initialized (OK)");
    } else {
      throw e;
    }
  }

  // Step 2: Create subscription (ID will be 0 for fresh program)
  console.log("\n=== Step 2: Create Subscription ===");
  const subscriptionId = 0n;
  const { ix: createSubIx, subscriptionPda } = buildCreateSubscriptionIx(payer.publicKey, subscriptionId);
  console.log(`Subscription PDA: ${subscriptionPda.toBase58()}`);

  try {
    const tx2 = new Transaction().add(createSubIx);
    const sig2 = await sendAndConfirmTransaction(connection, tx2, [payer]);
    console.log(`Create subscription tx: ${sig2}`);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("Subscription already exists (OK)");
    } else {
      throw e;
    }
  }

  // Step 3: Fund subscription (10 SOL for devnet)
  console.log("\n=== Step 3: Fund Subscription ===");
  const fundAmount = 10_000_000_000n; // 10 SOL
  const fundIx = buildFundSubscriptionIx(payer.publicKey, subscriptionId, fundAmount);

  try {
    const tx3 = new Transaction().add(fundIx);
    const sig3 = await sendAndConfirmTransaction(connection, tx3, [payer]);
    console.log(`Fund subscription tx: ${sig3} (10 SOL)`);
  } catch (e: any) {
    console.error(`Fund failed: ${e.message}`);
  }

  // Step 4: Register mining_launcher as consumer
  console.log("\n=== Step 4: Register Mining Launcher as Consumer ===");
  const { ix: addConsumerIx, consumerPda } = buildAddConsumerIx(
    payer.publicKey,
    subscriptionId,
    MINING_LAUNCHER_PROGRAM_ID
  );
  console.log(`Consumer Registration PDA: ${consumerPda.toBase58()}`);

  try {
    const tx4 = new Transaction().add(addConsumerIx);
    const sig4 = await sendAndConfirmTransaction(connection, tx4, [payer]);
    console.log(`Add consumer tx: ${sig4}`);
  } catch (e: any) {
    if (e.message?.includes("already in use")) {
      console.log("Consumer already registered (OK)");
    } else {
      throw e;
    }
  }

  // Print summary
  console.log("\n========================================");
  console.log("=== VRF Setup Complete ===");
  console.log("========================================");
  console.log(`VRF_PROGRAM_ID = ${VRF_PROGRAM_ID.toBase58()}`);
  console.log(`VRF_CONFIG = ${configPda.toBase58()}`);
  console.log(`VRF_SUBSCRIPTION = ${subscriptionPda.toBase58()}`);
  console.log(`VRF_CONSUMER_REGISTRATION = ${consumerPda.toBase58()}`);
  console.log(`MINING_LAUNCHER_PROGRAM_ID = ${MINING_LAUNCHER_PROGRAM_ID.toBase58()}`);
  console.log("========================================");

  // Write addresses to file for easy reference
  const addresses = {
    VRF_PROGRAM_ID: VRF_PROGRAM_ID.toBase58(),
    VRF_CONFIG: configPda.toBase58(),
    VRF_SUBSCRIPTION: subscriptionPda.toBase58(),
    VRF_CONSUMER_REGISTRATION: consumerPda.toBase58(),
    MINING_LAUNCHER_PROGRAM_ID: MINING_LAUNCHER_PROGRAM_ID.toBase58(),
  };
  fs.writeFileSync("/home/bigfoot/new-addresses.json", JSON.stringify(addresses, null, 2));
  console.log("\nAddresses saved to /home/bigfoot/new-addresses.json");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
