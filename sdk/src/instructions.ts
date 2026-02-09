import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { DISCRIMINATORS, VRF_PROGRAM_ID } from "./constants";
import { getConfigPda, getSubscriptionPda, getConsumerPda, getRequestPda } from "./pda";

/**
 * Create an `initialize` instruction for the coordinator config.
 *
 * Accounts: [admin (signer, writable), authority, config (writable), system_program]
 */
export function createInitializeInstruction(
  admin: PublicKey,
  authority: PublicKey,
  feePerWord: BN,
  maxNumWords: number,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  const [configPda] = getConfigPda(programId);

  // data: disc(8) + fee_per_word(8) + max_num_words(4)
  const data = Buffer.alloc(8 + 8 + 4);
  DISCRIMINATORS.initialize.copy(data, 0);
  feePerWord.toArrayLike(Buffer, "le", 8).copy(data, 8);
  data.writeUInt32LE(maxNumWords, 16);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Create a `create_subscription` instruction.
 *
 * Accounts: [owner (signer, writable), config (writable), subscription (writable), system_program]
 */
export function createCreateSubscriptionInstruction(
  owner: PublicKey,
  subscriptionId: BN | number,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  const [configPda] = getConfigPda(programId);
  const [subscriptionPda] = getSubscriptionPda(subscriptionId, programId);

  const data = Buffer.alloc(8);
  DISCRIMINATORS.createSubscription.copy(data, 0);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: subscriptionPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Create a `fund_subscription` instruction.
 *
 * Accounts: [funder (signer, writable), subscription (writable), system_program]
 */
export function createFundSubscriptionInstruction(
  funder: PublicKey,
  subscriptionId: BN | number,
  amount: BN,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  const [subscriptionPda] = getSubscriptionPda(subscriptionId, programId);
  const id = new BN(subscriptionId.toString());

  // data: disc(8) + subscription_id(8) + amount(8)
  const data = Buffer.alloc(8 + 8 + 8);
  DISCRIMINATORS.fundSubscription.copy(data, 0);
  id.toArrayLike(Buffer, "le", 8).copy(data, 8);
  amount.toArrayLike(Buffer, "le", 8).copy(data, 16);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: subscriptionPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Create an `add_consumer` instruction.
 *
 * Accounts: [owner (signer, writable), subscription, consumer_program, consumer_registration (writable), system_program]
 */
export function createAddConsumerInstruction(
  owner: PublicKey,
  subscriptionId: BN | number,
  consumerProgramId: PublicKey,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  const [subscriptionPda] = getSubscriptionPda(subscriptionId, programId);
  const [consumerPda] = getConsumerPda(subscriptionId, consumerProgramId, programId);
  const id = new BN(subscriptionId.toString());

  // data: disc(8) + subscription_id(8)
  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.addConsumer.copy(data, 0);
  id.toArrayLike(Buffer, "le", 8).copy(data, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: subscriptionPda, isSigner: false, isWritable: true },
      { pubkey: consumerProgramId, isSigner: false, isWritable: false },
      { pubkey: consumerPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Create a `remove_consumer` instruction.
 *
 * Accounts: [owner (signer, writable), subscription (writable), consumer_registration (writable)]
 */
export function createRemoveConsumerInstruction(
  owner: PublicKey,
  subscriptionId: BN | number,
  consumerProgramId: PublicKey,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  const [subscriptionPda] = getSubscriptionPda(subscriptionId, programId);
  const [consumerPda] = getConsumerPda(subscriptionId, consumerProgramId, programId);
  const id = new BN(subscriptionId.toString());

  // data: disc(8) + subscription_id(8)
  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.removeConsumer.copy(data, 0);
  id.toArrayLike(Buffer, "le", 8).copy(data, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: subscriptionPda, isSigner: false, isWritable: true },
      { pubkey: consumerPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/**
 * Create a `cancel_subscription` instruction.
 *
 * Accounts: [owner (signer, writable), subscription (writable)]
 */
export function createCancelSubscriptionInstruction(
  owner: PublicKey,
  subscriptionId: BN | number,
  programId: PublicKey = VRF_PROGRAM_ID
): TransactionInstruction {
  const [subscriptionPda] = getSubscriptionPda(subscriptionId, programId);
  const id = new BN(subscriptionId.toString());

  // data: disc(8) + subscription_id(8)
  const data = Buffer.alloc(8 + 8);
  DISCRIMINATORS.cancelSubscription.copy(data, 0);
  id.toArrayLike(Buffer, "le", 8).copy(data, 8);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: subscriptionPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}
