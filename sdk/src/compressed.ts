/**
 * ZK Compressed randomness request support (Light Protocol).
 *
 * Compressed requests use zero-rent storage via Light Protocol's Merkle trees.
 * This module provides helpers for creating and monitoring compressed VRF requests.
 *
 * Requires `@lightprotocol/stateless.js` and `@lightprotocol/compressed-token`
 * as optional peer dependencies.
 *
 * @module compressed
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import { VRF_PROGRAM_ID, DISCRIMINATORS } from "./constants";
import { getConfigPda } from "./pda";
import { decodeVrfConfig } from "./accounts";
import { addPriorityFee } from "./utils";
import { VrfConfig } from "./types";

// ---------------------------------------------------------------------------
// Light Protocol program IDs
// ---------------------------------------------------------------------------

/** Light System Program ID (same on devnet and mainnet). */
export const LIGHT_SYSTEM_PROGRAM_ID = new PublicKey(
  "SySTEM1eSU2p4BGQfQpimFEWWSC1XDFeun3Nqzz3rT7"
);

/** Account Compression Program ID. */
export const ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey(
  "compr6CUsB5m2jS4Y3831ztGSTnDpnKJTKS95d64XVq"
);

/** Noop Program ID used by Light Protocol for logging. */
export const NOOP_PROGRAM_ID = new PublicKey(
  "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV"
);

/** Devnet address lookup table for Light Protocol accounts. */
export const DEVNET_LOOKUP_TABLE = new PublicKey(
  "qAJZMgnQJ8G6vA3WRcjD9Jan1wtKkaCFWLWskxJrR5V"
);

// ---------------------------------------------------------------------------
// Compressed account types
// ---------------------------------------------------------------------------

/** Status values for compressed randomness requests. */
export const CompressedRequestStatus = {
  Pending: 0,
  Fulfilled: 1,
} as const;

/** Decoded compressed randomness request. */
export interface CompressedRandomnessRequest {
  requestId: BN;
  requester: PublicKey;
  seed: Uint8Array;
  requestSlot: BN;
  status: number;
  randomness: Uint8Array;
}

/** Result from creating a compressed randomness request. */
export interface CompressedRequestResult {
  requestId: BN;
  /** Transaction signature. */
  signature: string;
}

/** Options for compressed randomness operations. */
export interface CompressedRandomnessOptions {
  /** Priority fee in micro-lamports per compute unit. */
  priorityFee?: number;
  /** Maximum time to wait for fulfillment in ms (default: 60000). */
  timeout?: number;
  /** Polling interval in ms (default: 3000). */
  interval?: number;
  /** Custom Photon RPC URL. If not set, uses the connection URL. */
  photonRpcUrl?: string;
}

// ---------------------------------------------------------------------------
// Discriminators
// ---------------------------------------------------------------------------

/**
 * Light Protocol discriminator for CompressedRandomnessRequest:
 * SHA256("CompressedRandomnessRequest")[..8]
 */
export const COMPRESSED_REQUEST_DISCRIMINATOR = Buffer.from([
  149, 31, 244, 154, 189, 164, 84, 79,
]);

// ---------------------------------------------------------------------------
// Photon indexer helpers
// ---------------------------------------------------------------------------

/**
 * Query the Photon indexer for compressed accounts owned by the VRF program.
 *
 * @param photonRpcUrl - The Photon indexer RPC URL.
 * @param programId - The VRF program ID.
 * @returns Array of compressed randomness requests.
 */
export async function fetchCompressedRequests(
  photonRpcUrl: string,
  programId: PublicKey = VRF_PROGRAM_ID
): Promise<CompressedRandomnessRequest[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(photonRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "getCompressedAccountsByOwner",
        params: {
          owner: programId.toBase58(),
          cursor: null,
          limit: 1000,
        },
      }),
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const json = (await response.json()) as {
    error?: { message: string };
    result?: {
      context?: { slot: number };
      value: { items: Array<{ data: { data: string } }>; cursor: string | null };
    };
  };
  if (json.error) {
    throw new Error(`Photon RPC error: ${json.error.message}`);
  }

  const items = json.result?.value?.items ?? [];
  const requests: CompressedRandomnessRequest[] = [];

  for (const item of items) {
    try {
      const data = Buffer.from(item.data.data, "base64");
      if (data.length < 8) continue;

      const disc = data.subarray(0, 8);
      if (!disc.equals(COMPRESSED_REQUEST_DISCRIMINATOR)) continue;

      const decoded = decodeCompressedRandomnessRequest(data.subarray(8));
      requests.push(decoded);
    } catch {
      // Skip unparseable accounts
    }
  }

  return requests;
}

/**
 * Wait for a compressed randomness request to be fulfilled.
 *
 * Polls the Photon indexer until the request status changes to Fulfilled.
 *
 * @param photonRpcUrl - The Photon indexer RPC URL.
 * @param requestId - The request ID to monitor.
 * @param programId - The VRF program ID.
 * @param opts - Timeout and polling interval options.
 * @returns The fulfilled compressed request.
 */
export async function waitForCompressedFulfillment(
  photonRpcUrl: string,
  requestId: BN | number | bigint,
  programId: PublicKey = VRF_PROGRAM_ID,
  opts: { timeout?: number; interval?: number } = {}
): Promise<CompressedRandomnessRequest> {
  const timeout = opts.timeout ?? 60_000;
  const interval = opts.interval ?? 3_000;
  const targetId = new BN(requestId.toString());
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const requests = await fetchCompressedRequests(photonRpcUrl, programId);

    const found = requests.find(
      (r) => r.requestId.eq(targetId) && r.status >= CompressedRequestStatus.Fulfilled
    );

    if (found) {
      return found;
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Timeout waiting for compressed fulfillment of request ${requestId.toString()} after ${timeout}ms`
  );
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode a CompressedRandomnessRequest from raw bytes (after discriminator).
 *
 * Layout (113 bytes):
 * ```
 * [0..8]    request_id (u64 LE)
 * [8..40]   requester (Pubkey)
 * [40..72]  seed ([u8; 32])
 * [72..80]  request_slot (u64 LE)
 * [80]      status (u8)
 * [81..113] randomness ([u8; 32])
 * ```
 */
export function decodeCompressedRandomnessRequest(
  data: Buffer | Uint8Array
): CompressedRandomnessRequest {
  if (data.length < 113) {
    throw new Error(
      `CompressedRandomnessRequest data too short: expected 113 bytes, got ${data.length}`
    );
  }

  const buf = Buffer.from(data);
  return {
    requestId: new BN(buf.subarray(0, 8), "le"),
    requester: new PublicKey(buf.subarray(8, 40)),
    seed: new Uint8Array(buf.subarray(40, 72)),
    requestSlot: new BN(buf.subarray(72, 80), "le"),
    status: buf[80],
    randomness: new Uint8Array(buf.subarray(81, 113)),
  };
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

/**
 * Create a `request_randomness_compressed` instruction.
 *
 * Note: This builds the core VRF instruction. The caller is responsible for
 * adding the Light Protocol remaining accounts (system accounts + tree accounts)
 * using `@lightprotocol/stateless.js`.
 */
export function createRequestRandomnessCompressedInstruction(
  requester: PublicKey,
  configPda: PublicKey,
  treasury: PublicKey,
  seed: Uint8Array | Buffer,
  proof: { a: Uint8Array; b: Uint8Array; c: Uint8Array },
  newAddressParams: {
    seed: Uint8Array;
    addressQueueAccountIndex: number;
    addressMerkleTreeAccountIndex: number;
    addressMerkleTreeRootIndex: number;
  },
  outputStateTreeIndex: number,
  dataHash: Uint8Array,
  address: Uint8Array,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  if (seed.length !== 32) {
    throw new Error(`Seed must be 32 bytes, got ${seed.length}`);
  }

  // Instruction data: disc(8) + seed(32) + proof(128) + newAddressParams(37) +
  //   outputStateTreeIndex(1) + dataHash(32) + address(32) = 270 bytes
  const data = Buffer.alloc(
    8 + 32 + 128 + 37 + 1 + 32 + 32
  );
  let offset = 0;

  // Discriminator
  DISCRIMINATORS.requestRandomnessCompressed.copy(data, offset);
  offset += 8;

  // seed
  Buffer.from(seed).copy(data, offset);
  offset += 32;

  // proof.a (32)
  Buffer.from(proof.a).copy(data, offset);
  offset += 32;
  // proof.b (64)
  Buffer.from(proof.b).copy(data, offset);
  offset += 64;
  // proof.c (32)
  Buffer.from(proof.c).copy(data, offset);
  offset += 32;

  // newAddressParams.seed (32)
  Buffer.from(newAddressParams.seed).copy(data, offset);
  offset += 32;
  // addressQueueAccountIndex (1)
  data[offset++] = newAddressParams.addressQueueAccountIndex;
  // addressMerkleTreeAccountIndex (1)
  data[offset++] = newAddressParams.addressMerkleTreeAccountIndex;
  // addressMerkleTreeRootIndex (2)
  data.writeUInt16LE(newAddressParams.addressMerkleTreeRootIndex, offset);
  offset += 2;

  // outputStateTreeIndex (1)
  data[offset++] = outputStateTreeIndex;

  // dataHash (32)
  Buffer.from(dataHash).copy(data, offset);
  offset += 32;

  // address (32)
  Buffer.from(address).copy(data, offset);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: requester, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // remaining_accounts are added by the caller (Light Protocol accounts)
    ],
    data,
  });
}
