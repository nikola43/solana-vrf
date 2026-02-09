import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ACCOUNT_DISCRIMINATORS } from "./constants";
import {
  CoordinatorConfig,
  SubscriptionAccount,
  ConsumerRegistrationAccount,
  RandomnessRequestAccount,
  RequestStatus,
} from "./types";

/**
 * Deserialize a CoordinatorConfig account from raw buffer data.
 *
 * Layout (101 bytes total):
 * ```
 * [0..8]    discriminator
 * [8..40]   admin (Pubkey)
 * [40..72]  authority (Pubkey)
 * [72..80]  fee_per_word (u64 LE)
 * [80..84]  max_num_words (u32 LE)
 * [84..92]  request_counter (u64 LE)
 * [92..100] subscription_counter (u64 LE)
 * [100]     bump (u8)
 * ```
 */
export function decodeCoordinatorConfig(data: Buffer): CoordinatorConfig {
  if (data.length < 101) {
    throw new Error(
      `CoordinatorConfig data too short: expected 101 bytes, got ${data.length}`
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DISCRIMINATORS.CoordinatorConfig)) {
    throw new Error("Invalid CoordinatorConfig discriminator");
  }

  return {
    admin: new PublicKey(data.subarray(8, 40)),
    authority: new PublicKey(data.subarray(40, 72)),
    feePerWord: new BN(data.subarray(72, 80), "le"),
    maxNumWords: data.readUInt32LE(80),
    requestCounter: new BN(data.subarray(84, 92), "le"),
    subscriptionCounter: new BN(data.subarray(92, 100), "le"),
    bump: data[100],
  };
}

/**
 * Deserialize a Subscription account from raw buffer data.
 *
 * Layout (69 bytes total):
 * ```
 * [0..8]   discriminator
 * [8..16]  id (u64 LE)
 * [16..48] owner (Pubkey)
 * [48..56] balance (u64 LE)
 * [56..64] req_count (u64 LE)
 * [64..68] consumer_count (u32 LE)
 * [68]     bump (u8)
 * ```
 */
export function decodeSubscription(data: Buffer): SubscriptionAccount {
  if (data.length < 69) {
    throw new Error(
      `Subscription data too short: expected 69 bytes, got ${data.length}`
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DISCRIMINATORS.Subscription)) {
    throw new Error("Invalid Subscription discriminator");
  }

  return {
    id: new BN(data.subarray(8, 16), "le"),
    owner: new PublicKey(data.subarray(16, 48)),
    balance: new BN(data.subarray(48, 56), "le"),
    reqCount: new BN(data.subarray(56, 64), "le"),
    consumerCount: data.readUInt32LE(64),
    bump: data[68],
  };
}

/**
 * Deserialize a ConsumerRegistration account from raw buffer data.
 *
 * Layout (57 bytes total):
 * ```
 * [0..8]   discriminator
 * [8..16]  subscription_id (u64 LE)
 * [16..48] program_id (Pubkey)
 * [48..56] nonce (u64 LE)
 * [56]     bump (u8)
 * ```
 */
export function decodeConsumerRegistration(
  data: Buffer
): ConsumerRegistrationAccount {
  if (data.length < 57) {
    throw new Error(
      `ConsumerRegistration data too short: expected 57 bytes, got ${data.length}`
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DISCRIMINATORS.ConsumerRegistration)) {
    throw new Error("Invalid ConsumerRegistration discriminator");
  }

  return {
    subscriptionId: new BN(data.subarray(8, 16), "le"),
    programId: new PublicKey(data.subarray(16, 48)),
    nonce: new BN(data.subarray(48, 56), "le"),
    bump: data[56],
  };
}

/**
 * Deserialize a RandomnessRequest account from raw buffer data.
 *
 * Layout (178 bytes total):
 * ```
 * [0..8]     discriminator
 * [8..16]    request_id (u64 LE)
 * [16..24]   subscription_id (u64 LE)
 * [24..56]   consumer_program (Pubkey)
 * [56..88]   requester (Pubkey)
 * [88..92]   num_words (u32 LE)
 * [92..124]  seed ([u8; 32])
 * [124..132] request_slot (u64 LE)
 * [132..136] callback_compute_limit (u32 LE)
 * [136]      status (u8)
 * [137..169] randomness ([u8; 32])
 * [169..177] fulfilled_slot (u64 LE)
 * [177]      bump (u8)
 * ```
 */
export function decodeRandomnessRequest(
  data: Buffer
): RandomnessRequestAccount {
  if (data.length < 178) {
    throw new Error(
      `RandomnessRequest data too short: expected 178 bytes, got ${data.length}`
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DISCRIMINATORS.RandomnessRequest)) {
    throw new Error("Invalid RandomnessRequest discriminator");
  }

  return {
    requestId: new BN(data.subarray(8, 16), "le"),
    subscriptionId: new BN(data.subarray(16, 24), "le"),
    consumerProgram: new PublicKey(data.subarray(24, 56)),
    requester: new PublicKey(data.subarray(56, 88)),
    numWords: data.readUInt32LE(88),
    seed: new Uint8Array(data.subarray(92, 124)),
    requestSlot: new BN(data.subarray(124, 132), "le"),
    callbackComputeLimit: data.readUInt32LE(132),
    status: data[136] as RequestStatus,
    randomness: new Uint8Array(data.subarray(137, 169)),
    fulfilledSlot: new BN(data.subarray(169, 177), "le"),
    bump: data[177],
  };
}
