import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { randomBytes } from "crypto";
import { VRF_PROGRAM_ID } from "./constants";
import { getConfigPda, getRequestPda } from "./pda";
import { decodeVrfConfig, decodeRandomnessRequest } from "./accounts";
import {
  createRequestRandomnessInstruction,
  createRequestRandomnessWithCallbackInstruction,
  createConsumeRandomnessInstruction,
  createCloseRequestInstruction,
} from "./instructions";
import { waitForFulfillment, addPriorityFee } from "./utils";
import {
  VrfConfig,
  RandomnessRequestAccount,
  RequestRandomnessResult,
  WaitForFulfillmentOptions,
  GetRandomnessOptions,
  GetRandomnessResult,
} from "./types";

/**
 * High-level client for the Moirae VRF oracle on Solana.
 *
 * @example Simplest usage — one line to get randomness:
 * ```ts
 * const vrf = new MoiraeVrf(connection);
 * const { randomness } = await vrf.getRandomness(payer);
 * ```
 *
 * @example Full control:
 * ```ts
 * const vrf = new MoiraeVrf(connection);
 * const { requestId } = await vrf.requestRandomness(payer, seed);
 * const { randomness } = await vrf.waitForFulfillment(requestId);
 * await vrf.consumeRandomness(payer, requestId);
 * await vrf.closeRequest(payer, requestId);
 * ```
 */
export class MoiraeVrf {
  public readonly connection: Connection;
  public readonly programId: PublicKey;

  constructor(
    connection: Connection,
    programId: PublicKey = VRF_PROGRAM_ID
  ) {
    this.connection = connection;
    this.programId = programId;
  }

  /** Get the config PDA address. */
  getConfigPda(): PublicKey {
    return getConfigPda(this.programId)[0];
  }

  /** Get a request PDA address for a given request ID. */
  getRequestPda(requestId: BN | number | bigint): PublicKey {
    return getRequestPda(requestId, this.programId)[0];
  }

  /** Fetch and deserialize the VRF configuration account. */
  async getConfig(): Promise<VrfConfig> {
    const [configPda] = getConfigPda(this.programId);
    const accountInfo = await this.connection.getAccountInfo(configPda);
    if (!accountInfo) {
      throw new Error("VRF configuration account not found");
    }
    return decodeVrfConfig(Buffer.from(accountInfo.data));
  }

  /** Fetch and deserialize a randomness request account. */
  async getRequest(
    requestId: BN | number | bigint
  ): Promise<RandomnessRequestAccount> {
    const [requestPda] = getRequestPda(requestId, this.programId);
    const accountInfo = await this.connection.getAccountInfo(requestPda);
    if (!accountInfo) {
      throw new Error(
        `Request account not found for ID ${requestId.toString()}`
      );
    }
    return decodeRandomnessRequest(Buffer.from(accountInfo.data));
  }

  /** Get the next request ID from the config counter. */
  async getNextRequestId(): Promise<BN> {
    const config = await this.getConfig();
    return config.requestCounter;
  }

  /**
   * Submit a randomness request transaction.
   *
   * @param payer - The keypair paying for the request (signs the transaction).
   * @param seed - 32-byte user-provided entropy.
   * @param priorityFee - Optional priority fee in micro-lamports.
   * @returns The request ID and PDA address.
   */
  async requestRandomness(
    payer: Keypair,
    seed: Uint8Array | Buffer,
    priorityFee?: number
  ): Promise<RequestRandomnessResult> {
    const config = await this.getConfig();
    const requestId = config.requestCounter;
    const [configPda] = getConfigPda(this.programId);
    const [requestPda] = getRequestPda(requestId, this.programId);

    const ix = createRequestRandomnessInstruction(
      payer.publicKey,
      configPda,
      requestPda,
      config.treasury,
      seed,
      this.programId
    );

    const tx = new Transaction();
    if (priorityFee !== undefined) {
      tx.add(...addPriorityFee(priorityFee));
    }
    tx.add(ix);

    await sendAndConfirmTransaction(this.connection, tx, [payer]);

    return { requestId, requestPda };
  }

  /**
   * Submit a randomness request with a callback program.
   *
   * After fulfillment, the oracle will CPI into the callback program
   * with the randomness output.
   *
   * @param payer - The keypair paying for the request.
   * @param seed - 32-byte user-provided entropy.
   * @param callbackProgram - The program to receive the callback after fulfillment.
   * @param priorityFee - Optional priority fee in micro-lamports.
   * @returns The request ID and PDA address.
   */
  async requestRandomnessWithCallback(
    payer: Keypair,
    seed: Uint8Array | Buffer,
    callbackProgram: PublicKey,
    priorityFee?: number
  ): Promise<RequestRandomnessResult> {
    const config = await this.getConfig();
    const requestId = config.requestCounter;
    const [configPda] = getConfigPda(this.programId);
    const [requestPda] = getRequestPda(requestId, this.programId);

    const ix = createRequestRandomnessWithCallbackInstruction(
      payer.publicKey,
      configPda,
      requestPda,
      config.treasury,
      callbackProgram,
      seed,
      this.programId
    );

    const tx = new Transaction();
    if (priorityFee !== undefined) {
      tx.add(...addPriorityFee(priorityFee));
    }
    tx.add(ix);

    await sendAndConfirmTransaction(this.connection, tx, [payer]);

    return { requestId, requestPda };
  }

  /**
   * Wait for the oracle to fulfill a request.
   *
   * @returns The fulfilled request account with randomness.
   */
  async waitForFulfillment(
    requestId: BN | number | bigint,
    opts?: WaitForFulfillmentOptions
  ): Promise<RandomnessRequestAccount> {
    return waitForFulfillment(
      this.connection,
      requestId,
      this.programId,
      opts
    );
  }

  /**
   * Consume a fulfilled randomness request.
   *
   * @param payer - The original requester keypair.
   * @param requestId - The request ID to consume.
   */
  async consumeRandomness(
    payer: Keypair,
    requestId: BN | number | bigint
  ): Promise<void> {
    const [requestPda] = getRequestPda(requestId, this.programId);
    const ix = createConsumeRandomnessInstruction(
      payer.publicKey,
      requestPda,
      requestId,
      this.programId
    );

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Close a consumed request and reclaim rent.
   *
   * @param payer - The original requester keypair.
   * @param requestId - The request ID to close.
   */
  async closeRequest(
    payer: Keypair,
    requestId: BN | number | bigint
  ): Promise<void> {
    const [requestPda] = getRequestPda(requestId, this.programId);
    const ix = createCloseRequestInstruction(
      payer.publicKey,
      requestPda,
      requestId,
      this.programId
    );

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  // ---------------------------------------------------------------------------
  // Convenience methods — simplest possible API
  // ---------------------------------------------------------------------------

  /**
   * Get random bytes in one call.
   *
   * Handles the full lifecycle: request → wait → consume → close.
   * Returns the 32-byte randomness output. This is the simplest way
   * to get verifiable randomness on Solana.
   *
   * @example
   * ```ts
   * const vrf = new MoiraeVrf(connection);
   * const { randomness } = await vrf.getRandomness(payer);
   * console.log("Random:", Buffer.from(randomness).toString("hex"));
   * ```
   *
   * @param payer - The keypair paying for the request (signs the transaction).
   * @param opts - Optional seed, priority fee, and timeout settings.
   */
  async getRandomness(
    payer: Keypair,
    opts: GetRandomnessOptions = {}
  ): Promise<GetRandomnessResult> {
    const seed = opts.seed ?? randomBytes(32);
    const { requestId, requestPda } = await this.requestRandomness(
      payer,
      seed,
      opts.priorityFee
    );

    const fulfilled = await this.waitForFulfillment(requestId, {
      timeout: opts.timeout ?? 60_000,
      interval: opts.interval,
    });

    await this.consumeRandomness(payer, requestId);
    await this.closeRequest(payer, requestId);

    return {
      randomness: fulfilled.randomness,
      requestId,
      requestPda,
    };
  }

  /**
   * Request randomness and wait for the oracle to fulfill it.
   *
   * Like `getRandomness` but does NOT consume or close — useful when
   * your on-chain program needs to read the request account.
   *
   * @param payer - The keypair paying for the request.
   * @param opts - Optional seed, priority fee, and timeout settings.
   * @returns The fulfilled request account with randomness.
   */
  async requestAndWait(
    payer: Keypair,
    opts: GetRandomnessOptions = {}
  ): Promise<RandomnessRequestAccount & { requestId: BN; requestPda: PublicKey }> {
    const seed = opts.seed ?? randomBytes(32);
    const { requestId, requestPda } = await this.requestRandomness(
      payer,
      seed,
      opts.priorityFee
    );

    const fulfilled = await this.waitForFulfillment(requestId, {
      timeout: opts.timeout ?? 60_000,
      interval: opts.interval,
    });

    return { ...fulfilled, requestId, requestPda };
  }
}
