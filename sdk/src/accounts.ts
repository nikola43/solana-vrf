import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ACCOUNT_DISCRIMINATORS } from "./constants";
import {
  VrfConfig,
  RandomnessRequestAccount,
  RequestStatus,
} from "./types";

/**
 * Deserialize a VrfConfiguration account from raw buffer data.
 *
 * Layout (121 bytes total):
 * ```
 * [0..8]    discriminator
 * [8..40]   admin (Pubkey)
 * [40..72]  authority (Pubkey)
 * [72..80]  fee (u64 LE)
 * [80..88]  request_counter (u64 LE)
 * [88..120] treasury (Pubkey)
 * [120]     bump (u8)
 * ```
 */
export function decodeVrfConfig(data: Buffer): VrfConfig {
  if (data.length < 121) {
    throw new Error(
      `VrfConfiguration data too short: expected 121 bytes, got ${data.length}`
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DISCRIMINATORS.VrfConfiguration)) {
    throw new Error("Invalid VrfConfiguration discriminator");
  }

  return {
    admin: new PublicKey(data.subarray(8, 40)),
    authority: new PublicKey(data.subarray(40, 72)),
    fee: new BN(data.subarray(72, 80), "le"),
    requestCounter: new BN(data.subarray(80, 88), "le"),
    treasury: new PublicKey(data.subarray(88, 120)),
    bump: data[120],
  };
}

/**
 * Deserialize a RandomnessRequest account from raw buffer data.
 *
 * Layout (162 bytes total):
 * ```
 * [0..8]     discriminator
 * [8..16]    request_id (u64 LE)
 * [16..48]   requester (Pubkey)
 * [48..80]   seed ([u8; 32])
 * [80..88]   request_slot (u64 LE)
 * [88..120]  callback_program (Pubkey)
 * [120]      status (u8)
 * [121..153] randomness ([u8; 32])
 * [153..161] fulfilled_slot (u64 LE)
 * [161]      bump (u8)
 * ```
 */
export function decodeRandomnessRequest(
  data: Buffer
): RandomnessRequestAccount {
  if (data.length < 162) {
    throw new Error(
      `RandomnessRequest data too short: expected 162 bytes, got ${data.length}`
    );
  }

  const disc = data.subarray(0, 8);
  if (!disc.equals(ACCOUNT_DISCRIMINATORS.RandomnessRequest)) {
    throw new Error("Invalid RandomnessRequest discriminator");
  }

  return {
    requestId: new BN(data.subarray(8, 16), "le"),
    requester: new PublicKey(data.subarray(16, 48)),
    seed: new Uint8Array(data.subarray(48, 80)),
    requestSlot: new BN(data.subarray(80, 88), "le"),
    callbackProgram: new PublicKey(data.subarray(88, 120)),
    status: data[120] as RequestStatus,
    randomness: new Uint8Array(data.subarray(121, 153)),
    fulfilledSlot: new BN(data.subarray(153, 161), "le"),
    bump: data[161],
  };
}
