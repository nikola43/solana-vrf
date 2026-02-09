import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VrfSol } from "../target/types/vrf_sol";
import { RollDice } from "../target/types/roll_dice";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";

/**
 * Integration tests that verify end-to-end flow with a live backend.
 *
 * Prerequisites:
 *   - Programs deployed to devnet
 *   - Backend running: cd backend && cargo run
 *
 * The backend automatically fulfills randomness requests by watching on-chain
 * events, computing HMAC randomness, and submitting fulfillment transactions
 * with Ed25519 proofs and callback CPIs.
 */
describe("integration (live backend)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const vrfProgram = anchor.workspace.vrfSol as Program<VrfSol>;
  const diceProgram = anchor.workspace.rollDice as Program<RollDice>;
  const admin = provider.wallet as anchor.Wallet;

  // The live backend authority
  const AUTHORITY_PUBKEY = new PublicKey(
    "G6LWGyqeT1WYnkGy2T2wgPqXJPeZPw5RNE3EWgoVSkV"
  );

  const feePerWord = new anchor.BN(10_000);
  const maxNumWords = 10;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("coordinator-config")],
    vrfProgram.programId
  );

  const [gameConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game-config")],
    diceProgram.programId
  );

  let subscriptionId: number;
  let subscriptionPda: PublicKey;

  function getSubscriptionPda(subId: number | anchor.BN): PublicKey {
    const id = new anchor.BN(subId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("subscription"), id.toArrayLike(Buffer, "le", 8)],
      vrfProgram.programId
    );
    return pda;
  }

  function getConsumerPda(subId: number | anchor.BN, consumerProgram: PublicKey): PublicKey {
    const id = new anchor.BN(subId);
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("consumer"),
        id.toArrayLike(Buffer, "le", 8),
        consumerProgram.toBuffer(),
      ],
      vrfProgram.programId
    );
    return pda;
  }

  function getRequestPda(requestId: number | anchor.BN): PublicKey {
    const id = new anchor.BN(requestId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vrf-request"), id.toArrayLike(Buffer, "le", 8)],
      vrfProgram.programId
    );
    return pda;
  }

  function getDiceRollPda(
    playerKey: PublicKey,
    requestId: number | anchor.BN
  ): PublicKey {
    const id = new anchor.BN(requestId);
    const [pda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("dice-result"),
        playerKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      diceProgram.programId
    );
    return pda;
  }

  async function getNextRequestId(): Promise<number> {
    const config = await vrfProgram.account.coordinatorConfig.fetch(configPda);
    return config.requestCounter.toNumber();
  }

  /**
   * Poll a dice roll PDA until it has a non-zero result (settled via callback).
   */
  async function pollDiceRollResult(
    diceRollPda: PublicKey,
    timeoutMs = 60_000,
    intervalMs = 2_000
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
        if (diceRoll.result > 0) {
          return diceRoll.result;
        }
      } catch {
        // Account may not exist yet
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `Timeout: dice roll not settled within ${timeoutMs}ms`
    );
  }

  before(async () => {
    // Ensure coordinator config exists
    const existingConfig = await provider.connection.getAccountInfo(configPda);

    if (!existingConfig) {
      await vrfProgram.methods
        .initialize(feePerWord, maxNumWords)
        .accounts({
          admin: admin.publicKey,
          authority: AUTHORITY_PUBKEY,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      // Update config to set live backend authority
      await vrfProgram.methods
        .updateConfig(AUTHORITY_PUBKEY, feePerWord, maxNumWords, null)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    }

    // Create subscription
    const config = await vrfProgram.account.coordinatorConfig.fetch(configPda);
    subscriptionId = config.subscriptionCounter.toNumber();
    subscriptionPda = getSubscriptionPda(subscriptionId);

    await vrfProgram.methods
      .createSubscription()
      .accounts({
        owner: admin.publicKey,
        config: configPda,
        subscription: subscriptionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Fund subscription generously
    await vrfProgram.methods
      .fundSubscription(new anchor.BN(subscriptionId), new anchor.BN(10 * LAMPORTS_PER_SOL))
      .accounts({
        funder: admin.publicKey,
        subscription: subscriptionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Register dice program as consumer
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);
    await vrfProgram.methods
      .addConsumer(new anchor.BN(subscriptionId))
      .accounts({
        owner: admin.publicKey,
        subscription: subscriptionPda,
        consumerProgram: diceProgram.programId,
        consumerRegistration: consumerPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Initialize game config (if not already done)
    const existingGameConfig = await provider.connection.getAccountInfo(gameConfigPda);
    if (!existingGameConfig) {
      await diceProgram.methods
        .initialize(vrfProgram.programId, new anchor.BN(subscriptionId))
        .accounts({
          admin: admin.publicKey,
          gameConfig: gameConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // Verify config
    const updatedConfig = await vrfProgram.account.coordinatorConfig.fetch(configPda);
    expect(updatedConfig.authority.toBase58()).to.equal(AUTHORITY_PUBKEY.toBase58());
  });

  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 3000));
  });

  it("Backend fulfills dice roll request automatically via callback", async () => {
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32);
    seed.writeUInt32LE(Date.now() % 0xffffffff, 0);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(admin.publicKey, requestId);
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);

    // Request dice roll
    await diceProgram.methods
      .requestRoll([...seed] as any)
      .accounts({
        player: admin.publicKey,
        gameConfig: gameConfigPda,
        vrfConfig: configPda,
        subscription: subscriptionPda,
        consumerRegistration: consumerPda,
        vrfRequest: requestPda,
        thisProgram: diceProgram.programId,
        diceRoll: diceRollPda,
        vrfProgram: vrfProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Verify dice roll exists (may already be settled by backend)
    let diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
    expect(diceRoll.result).to.be.gte(0).and.lte(6);

    // Wait for backend to fulfill + deliver callback (dice settled automatically)
    const result = diceRoll.result > 0
      ? diceRoll.result
      : await pollDiceRollResult(diceRollPda);
    expect(result).to.be.gte(1).and.lte(6);

    // Verify request PDA was closed (rent refunded)
    const requestAccount = await provider.connection.getAccountInfo(requestPda);
    expect(requestAccount).to.be.null;
  });

  it("Subscription balance decreases by fee_per_word * num_words", async () => {
    const subBefore = await vrfProgram.account.subscription.fetch(subscriptionPda);
    const balanceBefore = subBefore.balance.toNumber();

    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32);
    seed.writeUInt32LE((Date.now() + 1) % 0xffffffff, 0);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(admin.publicKey, requestId);
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);

    await diceProgram.methods
      .requestRoll([...seed] as any)
      .accounts({
        player: admin.publicKey,
        gameConfig: gameConfigPda,
        vrfConfig: configPda,
        subscription: subscriptionPda,
        consumerRegistration: consumerPda,
        vrfRequest: requestPda,
        thisProgram: diceProgram.programId,
        diceRoll: diceRollPda,
        vrfProgram: vrfProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const subAfter = await vrfProgram.account.subscription.fetch(subscriptionPda);
    const balanceAfter = subAfter.balance.toNumber();

    // 1 word * 10,000 lamports/word = 10,000 lamports deducted
    expect(balanceBefore - balanceAfter).to.equal(10_000);
  });

  it("Backend handles multiple concurrent dice roll requests", async () => {
    const count = 3;
    const diceRollPdas: PublicKey[] = [];
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);

    // Submit 3 dice roll requests
    for (let i = 0; i < count; i++) {
      const requestId = await getNextRequestId();
      const seed = Buffer.alloc(32);
      seed.writeUInt32LE((Date.now() + i + 100) % 0xffffffff, 0);
      seed[4] = i;
      const requestPda = getRequestPda(requestId);
      const diceRollPda = getDiceRollPda(admin.publicKey, requestId);

      await diceProgram.methods
        .requestRoll([...seed] as any)
        .accounts({
          player: admin.publicKey,
          gameConfig: gameConfigPda,
          vrfConfig: configPda,
          subscription: subscriptionPda,
          consumerRegistration: consumerPda,
          vrfRequest: requestPda,
          thisProgram: diceProgram.programId,
          diceRoll: diceRollPda,
          vrfProgram: vrfProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      diceRollPdas.push(diceRollPda);
    }

    // Wait for all to be settled via callback (poll in parallel)
    const results = await Promise.all(
      diceRollPdas.map((pda) => pollDiceRollResult(pda, 60_000))
    );

    // Verify all have valid dice results
    for (const result of results) {
      expect(result).to.be.gte(1).and.lte(6);
    }

    expect(results).to.have.length(count);
  });
});
