import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { VRF_PROGRAM_ID } from "./constants";

/**
 * Derive the coordinator configuration PDA.
 * Seeds: `["coordinator-config"]`
 */
export function getConfigPda(
  programId: PublicKey = VRF_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("coordinator-config")],
    programId
  );
}

/**
 * Derive a subscription PDA from its ID.
 * Seeds: `["subscription", subscription_id.to_le_bytes()]`
 */
export function getSubscriptionPda(
  subscriptionId: BN | number | bigint,
  programId: PublicKey = VRF_PROGRAM_ID
): [PublicKey, number] {
  const id = new BN(subscriptionId.toString());
  const idBuffer = id.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("subscription"), idBuffer],
    programId
  );
}

/**
 * Derive a consumer registration PDA.
 * Seeds: `["consumer", subscription_id.to_le_bytes(), consumer_program_id]`
 */
export function getConsumerPda(
  subscriptionId: BN | number | bigint,
  consumerProgramId: PublicKey,
  programId: PublicKey = VRF_PROGRAM_ID
): [PublicKey, number] {
  const id = new BN(subscriptionId.toString());
  const idBuffer = id.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("consumer"), idBuffer, consumerProgramId.toBuffer()],
    programId
  );
}

/**
 * Derive a randomness request PDA from its ID.
 * Seeds: `["request", request_id.to_le_bytes()]`
 */
export function getRequestPda(
  requestId: BN | number | bigint,
  programId: PublicKey = VRF_PROGRAM_ID
): [PublicKey, number] {
  const id = new BN(requestId.toString());
  const idBuffer = id.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("request"), idBuffer],
    programId
  );
}
