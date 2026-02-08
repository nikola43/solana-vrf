import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { DISCRIMINATORS, VRF_PROGRAM_ID } from "./constants";
import { getConfigPda, getRequestPda } from "./pda";

/**
 * Create a `request_randomness` instruction.
 *
 * Accounts: [requester (signer, writable), config (writable), request (writable), treasury (writable), system_program]
 */
export function createRequestRandomnessInstruction(
  requester: PublicKey,
  configPda: PublicKey,
  requestPda: PublicKey,
  treasury: PublicKey,
  seed: Uint8Array | Buffer,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  if (seed.length !== 32) {
    throw new Error(`Seed must be 32 bytes, got ${seed.length}`);
  }

  const data = Buffer.alloc(8 + 32);
  DISCRIMINATORS.requestRandomness.copy(data, 0);
  Buffer.from(seed).copy(data, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: requester, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: requestPda, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Create a `consume_randomness` instruction.
 *
 * Accounts: [requester (signer), request (writable)]
 */
export function createConsumeRandomnessInstruction(
  requester: PublicKey,
  requestPda: PublicKey,
  requestId: BN | number | bigint,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  const id = new BN(requestId.toString());
  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.consumeRandomness.copy(data, 0);
  id.toArrayLike(Buffer, "le", 8).copy(data, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: requester, isSigner: true, isWritable: false },
      { pubkey: requestPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Create a `close_request` instruction.
 *
 * Accounts: [requester (signer, writable), request (writable)]
 */
/**
 * Create a `request_randomness_with_callback` instruction.
 *
 * Accounts: [requester (signer, writable), config (writable), request (writable), treasury (writable), callback_program, system_program]
 */
export function createRequestRandomnessWithCallbackInstruction(
  requester: PublicKey,
  configPda: PublicKey,
  requestPda: PublicKey,
  treasury: PublicKey,
  callbackProgram: PublicKey,
  seed: Uint8Array | Buffer,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  if (seed.length !== 32) {
    throw new Error(`Seed must be 32 bytes, got ${seed.length}`);
  }

  const data = Buffer.alloc(8 + 32);
  DISCRIMINATORS.requestRandomnessWithCallback.copy(data, 0);
  Buffer.from(seed).copy(data, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: requester, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: requestPda, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: callbackProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Create a `close_request` instruction.
 *
 * Accounts: [requester (signer, writable), request (writable)]
 */
export function createCloseRequestInstruction(
  requester: PublicKey,
  requestPda: PublicKey,
  requestId: BN | number | bigint,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  const id = new BN(requestId.toString());
  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.closeRequest.copy(data, 0);
  id.toArrayLike(Buffer, "le", 8).copy(data, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: requester, isSigner: true, isWritable: true },
      { pubkey: requestPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}
