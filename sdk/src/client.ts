import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { VRF_PROGRAM_ID } from "./constants";
import {
  getConfigPda,
  getSubscriptionPda,
  getConsumerPda,
  getRequestPda,
} from "./pda";
import {
  decodeCoordinatorConfig,
  decodeSubscription,
  decodeConsumerRegistration,
  decodeRandomnessRequest,
} from "./accounts";
import {
  createInitializeInstruction,
  createCreateSubscriptionInstruction,
  createFundSubscriptionInstruction,
  createAddConsumerInstruction,
  createRemoveConsumerInstruction,
  createCancelSubscriptionInstruction,
} from "./instructions";
import { waitForFulfillment, addPriorityFee } from "./utils";
import {
  CoordinatorConfig,
  SubscriptionAccount,
  ConsumerRegistrationAccount,
  RandomnessRequestAccount,
  CreateSubscriptionResult,
  WaitForFulfillmentOptions,
} from "./types";

/**
 * High-level client for the Moirae VRF coordinator on Solana.
 *
 * The coordinator uses a subscription-based model with automatic callback delivery.
 * Consumer programs CPI into the coordinator to request randomness, and the coordinator
 * CPIs back into the consumer with the random words after fulfillment.
 *
 * @example Subscription management:
 * ```ts
 * const vrf = new MoiraeVrf(connection);
 * const { subscriptionId } = await vrf.createSubscription(admin);
 * await vrf.fundSubscription(admin, subscriptionId, new BN(1_000_000_000));
 * await vrf.addConsumer(admin, subscriptionId, myConsumerProgram);
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

  /** Get the coordinator config PDA address. */
  getConfigPda(): PublicKey {
    return getConfigPda(this.programId)[0];
  }

  /** Get a subscription PDA address for a given subscription ID. */
  getSubscriptionPda(subscriptionId: BN | number | bigint): PublicKey {
    return getSubscriptionPda(subscriptionId, this.programId)[0];
  }

  /** Get a consumer registration PDA address. */
  getConsumerPda(
    subscriptionId: BN | number | bigint,
    consumerProgramId: PublicKey
  ): PublicKey {
    return getConsumerPda(subscriptionId, consumerProgramId, this.programId)[0];
  }

  /** Get a request PDA address for a given request ID. */
  getRequestPda(requestId: BN | number | bigint): PublicKey {
    return getRequestPda(requestId, this.programId)[0];
  }

  /** Fetch and deserialize the coordinator configuration account. */
  async getConfig(): Promise<CoordinatorConfig> {
    const [configPda] = getConfigPda(this.programId);
    const accountInfo = await this.connection.getAccountInfo(configPda);
    if (!accountInfo) {
      throw new Error("Coordinator configuration account not found");
    }
    return decodeCoordinatorConfig(Buffer.from(accountInfo.data));
  }

  /** Fetch and deserialize a subscription account. */
  async getSubscription(
    subscriptionId: BN | number | bigint
  ): Promise<SubscriptionAccount> {
    const [subscriptionPda] = getSubscriptionPda(subscriptionId, this.programId);
    const accountInfo = await this.connection.getAccountInfo(subscriptionPda);
    if (!accountInfo) {
      throw new Error(
        `Subscription account not found for ID ${subscriptionId.toString()}`
      );
    }
    return decodeSubscription(Buffer.from(accountInfo.data));
  }

  /** Fetch and deserialize a consumer registration account. */
  async getConsumerRegistration(
    subscriptionId: BN | number | bigint,
    consumerProgramId: PublicKey
  ): Promise<ConsumerRegistrationAccount> {
    const [consumerPda] = getConsumerPda(
      subscriptionId,
      consumerProgramId,
      this.programId
    );
    const accountInfo = await this.connection.getAccountInfo(consumerPda);
    if (!accountInfo) {
      throw new Error(
        `Consumer registration not found for subscription ${subscriptionId.toString()} and program ${consumerProgramId.toBase58()}`
      );
    }
    return decodeConsumerRegistration(Buffer.from(accountInfo.data));
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

  /** Get the next subscription ID from the config counter. */
  async getNextSubscriptionId(): Promise<BN> {
    const config = await this.getConfig();
    return config.subscriptionCounter;
  }

  // ---------------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------------

  /**
   * Create a new subscription.
   *
   * @param payer - The keypair creating the subscription (becomes owner).
   * @param priorityFee - Optional priority fee in micro-lamports.
   * @returns The subscription ID and PDA address.
   */
  async createSubscription(
    payer: Keypair,
    priorityFee?: number
  ): Promise<CreateSubscriptionResult> {
    const config = await this.getConfig();
    const subscriptionId = config.subscriptionCounter;

    const ix = createCreateSubscriptionInstruction(
      payer.publicKey,
      subscriptionId,
      this.programId
    );

    const tx = new Transaction();
    if (priorityFee !== undefined) {
      tx.add(...addPriorityFee(priorityFee));
    }
    tx.add(ix);

    await sendAndConfirmTransaction(this.connection, tx, [payer]);

    const [subscriptionPda] = getSubscriptionPda(subscriptionId, this.programId);
    return { subscriptionId, subscriptionPda };
  }

  /**
   * Fund a subscription with SOL.
   *
   * @param payer - The keypair funding the subscription.
   * @param subscriptionId - The subscription to fund.
   * @param amount - Amount in lamports to add.
   */
  async fundSubscription(
    payer: Keypair,
    subscriptionId: BN | number,
    amount: BN
  ): Promise<void> {
    const ix = createFundSubscriptionInstruction(
      payer.publicKey,
      subscriptionId,
      amount,
      this.programId
    );

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(this.connection, tx, [payer]);
  }

  /**
   * Register a consumer program for a subscription.
   *
   * @param owner - The subscription owner keypair.
   * @param subscriptionId - The subscription ID.
   * @param consumerProgramId - The program to register as a consumer.
   */
  async addConsumer(
    owner: Keypair,
    subscriptionId: BN | number,
    consumerProgramId: PublicKey
  ): Promise<void> {
    const ix = createAddConsumerInstruction(
      owner.publicKey,
      subscriptionId,
      consumerProgramId,
      this.programId
    );

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(this.connection, tx, [owner]);
  }

  /**
   * Remove a consumer program from a subscription.
   *
   * @param owner - The subscription owner keypair.
   * @param subscriptionId - The subscription ID.
   * @param consumerProgramId - The program to remove.
   */
  async removeConsumer(
    owner: Keypair,
    subscriptionId: BN | number,
    consumerProgramId: PublicKey
  ): Promise<void> {
    const ix = createRemoveConsumerInstruction(
      owner.publicKey,
      subscriptionId,
      consumerProgramId,
      this.programId
    );

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(this.connection, tx, [owner]);
  }

  /**
   * Cancel a subscription and reclaim its balance.
   * Requires all consumers to be removed first.
   *
   * @param owner - The subscription owner keypair.
   * @param subscriptionId - The subscription to cancel.
   */
  async cancelSubscription(
    owner: Keypair,
    subscriptionId: BN | number
  ): Promise<void> {
    const ix = createCancelSubscriptionInstruction(
      owner.publicKey,
      subscriptionId,
      this.programId
    );

    const tx = new Transaction().add(ix);
    await sendAndConfirmTransaction(this.connection, tx, [owner]);
  }

  // ---------------------------------------------------------------------------
  // Request monitoring
  // ---------------------------------------------------------------------------

  /**
   * Wait for the oracle to fulfill a request.
   *
   * Note: In the callback model, the request PDA is closed after fulfillment.
   * This method may throw if the PDA was already closed.
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
}
