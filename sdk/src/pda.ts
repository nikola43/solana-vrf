import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { VRF_PROGRAM_ID } from "./constants";

/**
 * Derive the VRF configuration PDA.
 * Seeds: `["vrf-config"]`
 */
export function getConfigPda(
  programId: PublicKey = VRF_PROGRAM_ID
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vrf-config")],
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
