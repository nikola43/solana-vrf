import { PublicKey } from "@solana/web3.js";

/** Default deployed VRF coordinator program ID on devnet/mainnet. */
export const VRF_PROGRAM_ID = new PublicKey(
  "A4pDDsKvtX2U3jyEURVSoH15Mx4JcgUiSqCKxqWE3N48"
);

// Pre-computed Anchor instruction discriminators from IDL.
// sha256("global:<name>")[..8]
export const DISCRIMINATORS = {
  initialize: Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]),
  createSubscription: Buffer.from([206, 36, 102, 105, 21, 168, 239, 202]),
  fundSubscription: Buffer.from([167, 167, 19, 164, 121, 57, 237, 14]),
  cancelSubscription: Buffer.from([10, 118, 244, 87, 214, 118, 97, 15]),
  addConsumer: Buffer.from([214, 196, 187, 148, 104, 86, 254, 106]),
  removeConsumer: Buffer.from([2, 200, 66, 138, 109, 184, 73, 135]),
  requestRandomWords: Buffer.from([197, 218, 104, 215, 7, 30, 16, 229]),
  fulfillRandomWords: Buffer.from([241, 31, 92, 116, 42, 230, 221, 188]),
  updateConfig: Buffer.from([29, 158, 252, 191, 10, 83, 219, 99]),
} as const;

// Pre-computed Anchor account discriminators from IDL.
// sha256("account:<Name>")[..8]
export const ACCOUNT_DISCRIMINATORS = {
  CoordinatorConfig: Buffer.from([172, 64, 171, 72, 168, 230, 93, 208]),
  Subscription: Buffer.from([64, 7, 26, 135, 102, 132, 98, 33]),
  ConsumerRegistration: Buffer.from([214, 111, 64, 176, 202, 160, 126, 150]),
  RandomnessRequest: Buffer.from([244, 231, 228, 160, 148, 28, 17, 184]),
} as const;

/** Anchor account space: 8-byte discriminator + struct fields. */
// CoordinatorConfig: admin(32) + authority(32) + fee_per_word(8) + max_num_words(4) + request_counter(8) + subscription_counter(8) + bump(1)
export const COORDINATOR_CONFIG_SIZE = 8 + 32 + 32 + 8 + 4 + 8 + 8 + 1; // 101 bytes
// Subscription: id(8) + owner(32) + balance(8) + req_count(8) + consumer_count(4) + bump(1)
export const SUBSCRIPTION_SIZE = 8 + 8 + 32 + 8 + 8 + 4 + 1; // 69 bytes
// ConsumerRegistration: subscription_id(8) + program_id(32) + nonce(8) + bump(1)
export const CONSUMER_REGISTRATION_SIZE = 8 + 8 + 32 + 8 + 1; // 57 bytes
// RandomnessRequest: request_id(8) + subscription_id(8) + consumer_program(32) + requester(32) + num_words(4) + seed(32) + request_slot(8) + callback_compute_limit(4) + status(1) + randomness(32) + fulfilled_slot(8) + bump(1)
export const RANDOMNESS_REQUEST_SIZE = 8 + 8 + 8 + 32 + 32 + 4 + 32 + 8 + 4 + 1 + 32 + 8 + 1; // 178 bytes
