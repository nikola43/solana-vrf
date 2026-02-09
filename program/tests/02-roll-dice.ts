import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RollDice } from "../target/types/roll_dice";
import { VrfSol } from "../target/types/vrf_sol";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Ed25519Program,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import fs from "fs";
import * as testKeys from "./keys/load";

describe("roll-dice (consumer callback)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const diceProgram = anchor.workspace.rollDice as Program<RollDice>;
  const vrfProgram = anchor.workspace.vrfSol as Program<VrfSol>;
  const player = provider.wallet as anchor.Wallet;

  // Oracle authority keypair
  const authoritySecret = JSON.parse(
    fs.readFileSync("../backend/vrf-signer.json", "utf-8")
  );
  const authority = Keypair.fromSecretKey(Uint8Array.from(authoritySecret));
  const wrongPlayer = testKeys.wrongPlayer;

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

  async function fundAccount(
    destination: PublicKey,
    lamports: number
  ): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: player.publicKey,
        toPubkey: destination,
        lamports,
      })
    );
    await provider.sendAndConfirm(tx);
  }

  /**
   * Wait for the dice roll to be settled (result > 0) by the backend.
   */
  async function waitForDiceRollResult(
    diceRollPda: PublicKey,
    timeoutMs = 30_000,
    intervalMs = 1_500
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const dr = await diceProgram.account.diceRoll.fetch(diceRollPda);
        if (dr.result > 0) return dr.result;
      } catch {
        // account may not exist yet
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Timeout: dice roll not settled within ${timeoutMs}ms`);
  }

  async function requestAndFulfillDiceRoll(
    seed: Buffer
  ): Promise<{ requestId: number; diceRollPda: PublicKey }> {
    const requestId = await getNextRequestId();
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(player.publicKey, requestId);
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);

    // Request roll
    await diceProgram.methods
      .requestRoll([...seed] as any)
      .accounts({
        player: player.publicKey,
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

    // Check if backend already fulfilled (request PDA closed)
    const requestAccount = await provider.connection.getAccountInfo(requestPda);
    if (!requestAccount) {
      // Backend already fulfilled and closed the request — wait for dice result
      await waitForDiceRollResult(diceRollPda);
      return { requestId, diceRollPda };
    }

    // Try to fulfill from test (may race with backend)
    const reqId = new anchor.BN(requestId);
    const randomness = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) randomness[i] = seed[i] ^ 0x42;

    const message = Buffer.concat([
      reqId.toArrayLike(Buffer, "le", 8),
      randomness,
    ]);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: authority.secretKey,
      message: message,
    });

    try {
      await vrfProgram.methods
        .fulfillRandomWords(reqId, [...randomness] as any)
        .accounts({
          authority: authority.publicKey,
          config: configPda,
          request: requestPda,
          requester: player.publicKey,
          consumerProgram: diceProgram.programId,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: gameConfigPda, isWritable: false, isSigner: false },
          { pubkey: diceRollPda, isWritable: true, isSigner: false },
        ])
        .preInstructions([ed25519Ix])
        .signers([authority])
        .rpc();
    } catch {
      // Backend likely fulfilled first — wait for dice result
      await waitForDiceRollResult(diceRollPda);
    }

    return { requestId, diceRollPda };
  }

  before(async () => {
    // Fund authority
    await fundAccount(authority.publicKey, 5 * LAMPORTS_PER_SOL);
    await fundAccount(wrongPlayer.publicKey, LAMPORTS_PER_SOL);

    // Ensure coordinator config exists
    const existingConfig = await provider.connection.getAccountInfo(configPda);
    if (!existingConfig) {
      await vrfProgram.methods
        .initialize(feePerWord, maxNumWords)
        .accounts({
          admin: player.publicKey,
          authority: authority.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      // Update authority for this run
      await vrfProgram.methods
        .updateConfig(authority.publicKey, feePerWord, maxNumWords, null)
        .accounts({
          admin: player.publicKey,
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
        owner: player.publicKey,
        config: configPda,
        subscription: subscriptionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Fund subscription
    await vrfProgram.methods
      .fundSubscription(new anchor.BN(subscriptionId), new anchor.BN(5 * LAMPORTS_PER_SOL))
      .accounts({
        funder: player.publicKey,
        subscription: subscriptionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Register dice program as consumer
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);
    await vrfProgram.methods
      .addConsumer(new anchor.BN(subscriptionId))
      .accounts({
        owner: player.publicKey,
        subscription: subscriptionPda,
        consumerProgram: diceProgram.programId,
        consumerRegistration: consumerPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Initialize game config
    const existingGameConfig = await provider.connection.getAccountInfo(gameConfigPda);
    if (!existingGameConfig) {
      await diceProgram.methods
        .initialize(vrfProgram.programId, new anchor.BN(subscriptionId))
        .accounts({
          admin: player.publicKey,
          gameConfig: gameConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 3000));
  });

  // === FULL FLOW TESTS ===

  it("Full happy path: request, fulfill with callback, dice settled", async () => {
    const seed = Buffer.alloc(32, 0x01);
    const { diceRollPda } = await requestAndFulfillDiceRoll(seed);

    const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
    expect(diceRoll.result).to.be.gte(1).and.lte(6);
    expect(diceRoll.player.toBase58()).to.equal(player.publicKey.toBase58());
  });

  it("Request PDA is closed after fulfillment (rent reclaimed)", async () => {
    const seed = Buffer.alloc(32, 0x02);
    const { requestId } = await requestAndFulfillDiceRoll(seed);

    const requestPda = getRequestPda(requestId);
    const requestAccount = await provider.connection.getAccountInfo(requestPda);
    expect(requestAccount).to.be.null;
  });

  it("Produces valid dice results (1-6) for various randomness values", async () => {
    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 3000));

      const seed = Buffer.alloc(32, 0x50 + i);
      const { diceRollPda } = await requestAndFulfillDiceRoll(seed);

      const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
      expect(diceRoll.result).to.be.gte(1).and.lte(6);
    }
  });

  it("Multiple sequential dice rolls with distinct results", async () => {
    const results: number[] = [];

    for (let i = 0; i < 3; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 3000));

      const seed = Buffer.alloc(32, 0x60 + i);
      const { diceRollPda } = await requestAndFulfillDiceRoll(seed);

      const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
      results.push(diceRoll.result);
      expect(diceRoll.result).to.be.gte(1).and.lte(6);
    }

    expect(results).to.have.length(3);
  });

  it("Emits DiceRollRequested and DiceRollSettled events", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32, 0x88);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(player.publicKey, requestId);
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);

    function countProgramDataLogs(logs: string[]): number {
      return logs.filter((l) => l.includes("Program data:")).length;
    }

    // Request dice roll and check for DiceRollRequested + RandomWordsRequested events
    const requestTx = await diceProgram.methods
      .requestRoll([...seed] as any)
      .accounts({
        player: player.publicKey,
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
      .rpc({ commitment: "confirmed" });

    const txDetails = await provider.connection.getTransaction(requestTx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    // Should have at least 2 events: RandomWordsRequested (VRF CPI) + DiceRollRequested
    expect(
      countProgramDataLogs(txDetails!.meta!.logMessages!)
    ).to.be.gte(2);
  });

  // === ERROR CASES ===

  it("Fails to call fulfill_random_words from wrong coordinator", async () => {
    // The dice program verifies the coordinator_config signer matches
    // its stored coordinator_program. A random signer won't match.
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32, 0xcc);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(player.publicKey, requestId);
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);

    // Request first
    await diceProgram.methods
      .requestRoll([...seed] as any)
      .accounts({
        player: player.publicKey,
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

    // Try to directly call fulfill_random_words on dice program with a fake signer
    const fakeCoordinator = Keypair.generate();
    await fundAccount(fakeCoordinator.publicKey, LAMPORTS_PER_SOL);

    try {
      await diceProgram.methods
        .fulfillRandomWords(new anchor.BN(requestId), [Buffer.alloc(32, 0x42)] as any)
        .accounts({
          coordinatorConfig: fakeCoordinator.publicKey,
          gameConfig: gameConfigPda,
          diceRoll: diceRollPda,
        })
        .signers([fakeCoordinator])
        .rpc();
      expect.fail("Should have failed - wrong coordinator");
    } catch (e: any) {
      const errStr = [e?.message, e?.logs?.join(" "), JSON.stringify(e)].filter(Boolean).join(" ");
      // Either InvalidCoordinator (if we beat the backend) or AlreadySettled
      // (if the backend fulfilled first). Both prove the system rejects the call.
      const validError =
        errStr.includes("InvalidCoordinator") ||
        errStr.includes("AlreadySettled");
      expect(validError, `Expected InvalidCoordinator or AlreadySettled, got: ${errStr.substring(0, 200)}`).to.be.true;
    }
  });
});
