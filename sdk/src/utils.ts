import {
  Connection,
  PublicKey,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import { getRequestPda } from "./pda";
import { decodeRandomnessRequest } from "./accounts";
import { VRF_PROGRAM_ID } from "./constants";
import {
  RandomnessRequestAccount,
  RequestStatus,
  WaitForFulfillmentOptions,
} from "./types";

/**
 * Poll a randomness request until it reaches `Fulfilled` status.
 *
 * Note: In the coordinator callback model, requests are typically closed
 * after fulfillment. This function may return null if the request PDA
 * was already closed by the coordinator.
 *
 * @returns The fulfilled request account, or throws if timeout is reached.
 */
export async function waitForFulfillment(
  connection: Connection,
  requestId: BN | number | bigint,
  programId: PublicKey = VRF_PROGRAM_ID,
  opts: WaitForFulfillmentOptions = {}
): Promise<RandomnessRequestAccount> {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 2_000;

  const [requestPda] = getRequestPda(requestId, programId);
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const accountInfo = await connection.getAccountInfo(requestPda);
    if (accountInfo?.data) {
      const request = decodeRandomnessRequest(
        Buffer.from(accountInfo.data)
      );
      if (request.status >= RequestStatus.Fulfilled) {
        return request;
      }
    } else if (accountInfo === null) {
      // Request PDA was closed (fulfilled + callback completed).
      // This is the expected outcome in the coordinator callback model.
      throw new Error(
        `Request ${requestId.toString()} PDA was closed (already fulfilled and callback delivered)`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(
    `Timeout waiting for fulfillment of request ${requestId.toString()} after ${timeout}ms`
  );
}

/**
 * Create ComputeBudget instructions to set a priority fee.
 *
 * @param microLamports - Priority fee in micro-lamports per compute unit.
 * @param computeUnits - Optional compute unit limit (default: no limit instruction).
 * @returns Array of 1-2 ComputeBudget instructions to prepend to a transaction.
 */
export function addPriorityFee(
  microLamports: number,
  computeUnits?: number
): TransactionInstruction[] {
  const instructions: TransactionInstruction[] = [];

  if (computeUnits !== undefined) {
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })
    );
  }

  instructions.push(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
  );

  return instructions;
}
