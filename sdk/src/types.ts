import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/** Request lifecycle status. */
export enum RequestStatus {
  /** Request created, awaiting oracle fulfillment. */
  Pending = 0,
  /** Oracle has written the VRF output; ready for consumption. */
  Fulfilled = 1,
  /** Requester has consumed the randomness; eligible for closure. */
  Consumed = 2,
}

/** Deserialized VrfConfiguration account. */
export interface VrfConfig {
  /** Privileged key that may update this configuration. */
  admin: PublicKey;
  /** Ed25519 public key of the off-chain oracle. */
  authority: PublicKey;
  /** Fee in lamports charged per randomness request. */
  fee: BN;
  /** Monotonically increasing counter for unique request PDA seeds. */
  requestCounter: BN;
  /** Account that receives request fees. */
  treasury: PublicKey;
  /** PDA bump seed. */
  bump: number;
}

/** Deserialized RandomnessRequest account. */
export interface RandomnessRequestAccount {
  /** Unique identifier from config counter. */
  requestId: BN;
  /** Account that created and paid for this request. */
  requester: PublicKey;
  /** Caller-provided 32-byte entropy. */
  seed: Uint8Array;
  /** Solana slot at creation time. */
  requestSlot: BN;
  /** Reserved for future callback program. */
  callbackProgram: PublicKey;
  /** Current lifecycle status. */
  status: RequestStatus;
  /** 32-byte VRF output (zeroed until fulfilled). */
  randomness: Uint8Array;
  /** Slot when fulfilled (0 until fulfilled). */
  fulfilledSlot: BN;
  /** PDA bump seed. */
  bump: number;
}

/** Result returned by `requestRandomness`. */
export interface RequestRandomnessResult {
  /** The assigned request ID. */
  requestId: BN;
  /** The request PDA address. */
  requestPda: PublicKey;
}

/** Options for `waitForFulfillment`. */
export interface WaitForFulfillmentOptions {
  /** Maximum time to wait in milliseconds (default: 30000). */
  timeout?: number;
  /** Polling interval in milliseconds (default: 2000). */
  interval?: number;
}

/** Options for the high-level `getRandomness` convenience method. */
export interface GetRandomnessOptions {
  /** 32-byte user-provided entropy. If omitted, a random seed is generated. */
  seed?: Uint8Array | Buffer;
  /** Priority fee in micro-lamports per compute unit. */
  priorityFee?: number;
  /** Maximum time to wait for fulfillment in ms (default: 60000). */
  timeout?: number;
  /** Polling interval in ms (default: 2000). */
  interval?: number;
}

/** Result returned by the `getRandomness` convenience method. */
export interface GetRandomnessResult {
  /** The 32-byte VRF randomness output. */
  randomness: Uint8Array;
  /** The assigned request ID. */
  requestId: BN;
  /** The request PDA address. */
  requestPda: PublicKey;
}
