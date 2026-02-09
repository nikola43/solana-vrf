import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/** Request lifecycle status. */
export enum RequestStatus {
  /** Request created, awaiting oracle fulfillment. */
  Pending = 0,
  /** Oracle has fulfilled and delivered callback. */
  Fulfilled = 1,
}

/** Deserialized CoordinatorConfig account. */
export interface CoordinatorConfig {
  /** Privileged key that may update this configuration. */
  admin: PublicKey;
  /** Ed25519 public key of the off-chain oracle. */
  authority: PublicKey;
  /** Fee in lamports charged per random word requested. */
  feePerWord: BN;
  /** Maximum number of random words a consumer may request at once. */
  maxNumWords: number;
  /** Monotonically increasing counter for unique request PDA seeds. */
  requestCounter: BN;
  /** Monotonically increasing counter for unique subscription PDA seeds. */
  subscriptionCounter: BN;
  /** PDA bump seed. */
  bump: number;
}

/** Deserialized Subscription account. */
export interface SubscriptionAccount {
  /** Unique subscription identifier. */
  id: BN;
  /** The account that owns and manages this subscription. */
  owner: PublicKey;
  /** Current balance in lamports available for VRF fees. */
  balance: BN;
  /** Total number of VRF requests made through this subscription. */
  reqCount: BN;
  /** Number of consumer programs currently registered. */
  consumerCount: number;
  /** PDA bump seed. */
  bump: number;
}

/** Deserialized ConsumerRegistration account. */
export interface ConsumerRegistrationAccount {
  /** The subscription this consumer is registered under. */
  subscriptionId: BN;
  /** The program ID of the consumer that may request randomness. */
  programId: PublicKey;
  /** Nonce for additional uniqueness / versioning. */
  nonce: BN;
  /** PDA bump seed. */
  bump: number;
}

/** Deserialized RandomnessRequest account. */
export interface RandomnessRequestAccount {
  /** Unique identifier from config counter. */
  requestId: BN;
  /** Subscription ID used for billing. */
  subscriptionId: BN;
  /** The consumer program that requested randomness. */
  consumerProgram: PublicKey;
  /** Account that created and paid for this request. */
  requester: PublicKey;
  /** Number of random words requested. */
  numWords: number;
  /** Caller-provided 32-byte entropy. */
  seed: Uint8Array;
  /** Solana slot at creation time. */
  requestSlot: BN;
  /** Compute budget for the callback CPI. */
  callbackComputeLimit: number;
  /** Current lifecycle status. */
  status: RequestStatus;
  /** 32-byte base randomness (zeroed until fulfilled). */
  randomness: Uint8Array;
  /** Slot when fulfilled (0 until fulfilled). */
  fulfilledSlot: BN;
  /** PDA bump seed. */
  bump: number;
}

/** Result returned by subscription creation. */
export interface CreateSubscriptionResult {
  /** The assigned subscription ID. */
  subscriptionId: BN;
  /** The subscription PDA address. */
  subscriptionPda: PublicKey;
}

/** Result returned by `requestRandomWords`. */
export interface RequestRandomWordsResult {
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
