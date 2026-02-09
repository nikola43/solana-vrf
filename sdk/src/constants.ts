import { PublicKey } from "@solana/web3.js";

/** Default deployed VRF program ID on devnet/mainnet. */
export const VRF_PROGRAM_ID = new PublicKey(
  "A4pDDsKvtX2U3jyEURVSoH15Mx4JcgUiSqCKxqWE3N48"
);

// Pre-computed Anchor instruction discriminators from IDL.
// sha256("global:<name>")[..8]
export const DISCRIMINATORS = {
  requestRandomness: Buffer.from([213, 5, 173, 166, 37, 236, 31, 18]),
  consumeRandomness: Buffer.from([190, 217, 49, 162, 99, 26, 73, 234]),
  closeRequest: Buffer.from([170, 46, 165, 120, 223, 102, 115, 2]),
  fulfillRandomness: Buffer.from([235, 105, 140, 46, 40, 88, 117, 2]),
  initialize: Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]),
  updateConfig: Buffer.from([29, 158, 252, 191, 10, 83, 219, 99]),
  requestRandomnessWithCallback: Buffer.from([140, 11, 204, 125, 241, 255, 204, 233]),
  requestRandomnessCompressed: Buffer.from([165, 191, 78, 118, 224, 244, 121, 83]),
  fulfillRandomnessCompressed: Buffer.from([69, 6, 198, 148, 3, 22, 28, 21]),
} as const;

// Pre-computed Anchor account discriminators from IDL.
// sha256("account:<Name>")[..8]
export const ACCOUNT_DISCRIMINATORS = {
  VrfConfiguration: Buffer.from([232, 41, 155, 150, 127, 28, 32, 160]),
  RandomnessRequest: Buffer.from([244, 231, 228, 160, 148, 28, 17, 184]),
} as const;

/** Anchor account space: 8-byte discriminator + struct fields. */
export const VRF_CONFIG_SIZE = 8 + 32 + 32 + 8 + 8 + 32 + 1; // 121 bytes
export const RANDOMNESS_REQUEST_SIZE = 8 + 8 + 32 + 32 + 8 + 32 + 1 + 32 + 8 + 1; // 162 bytes
