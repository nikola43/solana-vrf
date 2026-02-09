import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VrfSol } from "../target/types/vrf_sol";
import { RollDice } from "../target/types/roll_dice";
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

describe("vrf-sol coordinator", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vrfSol as Program<VrfSol>;
  const diceProgram = anchor.workspace.rollDice as Program<RollDice>;
  const admin = provider.wallet as anchor.Wallet;

  // Oracle authority keypair
  const authoritySecret = JSON.parse(
    fs.readFileSync("../backend/vrf-signer.json", "utf-8")
  );
  const authority = Keypair.fromSecretKey(Uint8Array.from(authoritySecret));

  const feePerWord = new anchor.BN(10_000); // 10,000 lamports per word
  const maxNumWords = 10;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("coordinator-config")],
    program.programId
  );

  // Track whether config was already initialized
  let configAlreadyExisted = false;

  // Subscription tracking
  let subscriptionId: number;
  let subscriptionPda: PublicKey;

  function getSubscriptionPda(subId: number | anchor.BN): PublicKey {
    const id = new anchor.BN(subId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("subscription"), id.toArrayLike(Buffer, "le", 8)],
      program.programId
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
      program.programId
    );
    return pda;
  }

  function getRequestPda(requestId: number | anchor.BN): PublicKey {
    const id = new anchor.BN(requestId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("request"), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    return pda;
  }

  async function getNextRequestId(): Promise<number> {
    const config = await program.account.coordinatorConfig.fetch(configPda);
    return config.requestCounter.toNumber();
  }

  async function getNextSubscriptionId(): Promise<number> {
    const config = await program.account.coordinatorConfig.fetch(configPda);
    return config.subscriptionCounter.toNumber();
  }

  async function fundAccount(
    destination: PublicKey,
    lamports: number
  ): Promise<void> {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: destination,
        lamports,
      })
    );
    await provider.sendAndConfirm(tx);
  }

  before(async () => {
    // Fund authority
    await fundAccount(authority.publicKey, 5 * LAMPORTS_PER_SOL);

    // Fund test keypairs
    await fundAccount(testKeys.wrongAuthority.publicKey, LAMPORTS_PER_SOL);
    await fundAccount(testKeys.wrongPlayer.publicKey, LAMPORTS_PER_SOL);
    await fundAccount(testKeys.nonAdmin.publicKey, LAMPORTS_PER_SOL);

    // Check if config already exists
    const existingConfig = await provider.connection.getAccountInfo(configPda);
    if (existingConfig) {
      configAlreadyExisted = true;
      // Update config to use our local authority for this run
      await program.methods
        .updateConfig(authority.publicKey, feePerWord, maxNumWords, null)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    }
  });

  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 1000));
  });

  // === INITIALIZATION ===

  it("Initializes the coordinator config", async () => {
    if (configAlreadyExisted) {
      const config = await program.account.coordinatorConfig.fetch(configPda);
      expect(config.admin.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(config.authority.toBase58()).to.equal(authority.publicKey.toBase58());
      expect(config.feePerWord.toNumber()).to.equal(10_000);
      expect(config.maxNumWords).to.equal(maxNumWords);
      return;
    }

    await program.methods
      .initialize(feePerWord, maxNumWords)
      .accounts({
        admin: admin.publicKey,
        authority: authority.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.coordinatorConfig.fetch(configPda);
    expect(config.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(config.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(config.feePerWord.toNumber()).to.equal(10_000);
    expect(config.maxNumWords).to.equal(maxNumWords);
    expect(config.requestCounter.toNumber()).to.equal(0);
    expect(config.subscriptionCounter.toNumber()).to.equal(0);
  });

  it("Fails to initialize config twice", async () => {
    try {
      await program.methods
        .initialize(feePerWord, maxNumWords)
        .accounts({
          admin: admin.publicKey,
          authority: authority.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have failed - config already initialized");
    } catch (e: any) {
      expect(e.toString()).to.contain("Error");
    }
  });

  // === SUBSCRIPTION MANAGEMENT ===

  it("Creates a subscription", async () => {
    subscriptionId = await getNextSubscriptionId();
    subscriptionPda = getSubscriptionPda(subscriptionId);

    await program.methods
      .createSubscription()
      .accounts({
        owner: admin.publicKey,
        config: configPda,
        subscription: subscriptionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.id.toNumber()).to.equal(subscriptionId);
    expect(sub.owner.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(sub.balance.toNumber()).to.equal(0);
    expect(sub.reqCount.toNumber()).to.equal(0);
    expect(sub.consumerCount).to.equal(0);

    // Verify counter incremented
    const config = await program.account.coordinatorConfig.fetch(configPda);
    expect(config.subscriptionCounter.toNumber()).to.equal(subscriptionId + 1);
  });

  it("Funds a subscription", async () => {
    const amount = new anchor.BN(LAMPORTS_PER_SOL);

    await program.methods
      .fundSubscription(new anchor.BN(subscriptionId), amount)
      .accounts({
        funder: admin.publicKey,
        subscription: subscriptionPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.balance.toNumber()).to.equal(LAMPORTS_PER_SOL);
  });

  it("Adds a consumer to the subscription", async () => {
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);

    await program.methods
      .addConsumer(new anchor.BN(subscriptionId))
      .accounts({
        owner: admin.publicKey,
        subscription: subscriptionPda,
        consumerProgram: diceProgram.programId,
        consumerRegistration: consumerPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const reg = await program.account.consumerRegistration.fetch(consumerPda);
    expect(reg.subscriptionId.toNumber()).to.equal(subscriptionId);
    expect(reg.programId.toBase58()).to.equal(diceProgram.programId.toBase58());

    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.consumerCount).to.equal(1);
  });

  it("Fails to cancel subscription with consumers", async () => {
    try {
      await program.methods
        .cancelSubscription(new anchor.BN(subscriptionId))
        .accounts({
          owner: admin.publicKey,
          subscription: subscriptionPda,
        })
        .rpc();
      expect.fail("Should have failed - subscription has consumers");
    } catch (e: any) {
      expect(e.toString()).to.contain("SubscriptionHasConsumers");
    }
  });

  it("Fails to add consumer with non-owner", async () => {
    const nonAdmin = testKeys.nonAdmin;
    const fakeConsumer = Keypair.generate();
    const consumerPda = getConsumerPda(subscriptionId, fakeConsumer.publicKey);

    try {
      await program.methods
        .addConsumer(new anchor.BN(subscriptionId))
        .accounts({
          owner: nonAdmin.publicKey,
          subscription: subscriptionPda,
          consumerProgram: fakeConsumer.publicKey,
          consumerRegistration: consumerPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([nonAdmin])
        .rpc();
      expect.fail("Should have failed - not owner");
    } catch (e: any) {
      expect(e.toString()).to.contain("Unauthorized");
    }
  });

  // === REQUEST RANDOM WORDS ===

  it("Requests random words via CPI from dice program", async () => {
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32, 0x01);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("dice-roll"),
        admin.publicKey.toBuffer(),
        new anchor.BN(requestId).toArrayLike(Buffer, "le", 8),
      ],
      diceProgram.programId
    )[0];

    // First initialize the game config
    const [gameConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game-config")],
      diceProgram.programId
    );

    const existingGameConfig = await provider.connection.getAccountInfo(gameConfigPda);
    if (!existingGameConfig) {
      await diceProgram.methods
        .initialize(program.programId, new anchor.BN(subscriptionId))
        .accounts({
          admin: admin.publicKey,
          gameConfig: gameConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

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
        vrfProgram: program.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Verify request was created
    const request = await program.account.randomnessRequest.fetch(requestPda);
    expect(request.requestId.toNumber()).to.equal(requestId);
    expect(request.subscriptionId.toNumber()).to.equal(subscriptionId);
    expect(request.consumerProgram.toBase58()).to.equal(diceProgram.programId.toBase58());
    expect(request.requester.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(request.numWords).to.equal(1);
    expect(request.status).to.equal(0); // Pending
    expect(request.requestSlot.toNumber()).to.be.greaterThan(0);

    // Verify subscription balance decreased
    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.balance.toNumber()).to.equal(LAMPORTS_PER_SOL - 10_000); // 1 word * fee_per_word

    // Verify dice roll created
    const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
    expect(diceRoll.result).to.equal(0);
    expect(diceRoll.player.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(diceRoll.vrfRequestId.toNumber()).to.equal(requestId);
  });

  it("Fails with insufficient subscription balance", async () => {
    // Create a new subscription with no funds
    const newSubId = await getNextSubscriptionId();
    const newSubPda = getSubscriptionPda(newSubId);

    await program.methods
      .createSubscription()
      .accounts({
        owner: admin.publicKey,
        config: configPda,
        subscription: newSubPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Register the dice program as consumer
    const consumerPda = getConsumerPda(newSubId, diceProgram.programId);
    await program.methods
      .addConsumer(new anchor.BN(newSubId))
      .accounts({
        owner: admin.publicKey,
        subscription: newSubPda,
        consumerProgram: diceProgram.programId,
        consumerRegistration: consumerPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Try to request (should fail — no balance)
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32, 0x02);
    const requestPda = getRequestPda(requestId);

    // Initialize a separate game config for this test if needed
    // Actually, the dice program uses its own game-config which points to the original subscription.
    // We need to call request_random_words directly to test with the unfunded subscription.
    try {
      await program.methods
        .requestRandomWords(1, [...seed] as any, 200_000)
        .accounts({
          requester: admin.publicKey,
          config: configPda,
          subscription: newSubPda,
          consumerRegistration: consumerPda,
          consumerProgram: diceProgram.programId,
          request: requestPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have failed - insufficient balance");
    } catch (e: any) {
      expect(e.toString()).to.contain("InsufficientSubscriptionBalance");
    }
  });

  // === FULFILL RANDOM WORDS ===

  it("Fulfills random words with Ed25519 proof and delivers callback", async () => {
    // Get the last created request (from the dice roll test)
    const requestId = (await getNextRequestId()) - 1;
    const reqId = new anchor.BN(requestId);
    const requestPda = getRequestPda(requestId);

    // Check if already fulfilled (backend may have raced us)
    const reqBefore = await program.account.randomnessRequest.fetch(requestPda);
    if (reqBefore.status !== 0) {
      // Already fulfilled — skip
      return;
    }

    const randomness = Buffer.alloc(32, 0x42);

    const message = Buffer.concat([
      reqId.toArrayLike(Buffer, "le", 8),
      randomness,
    ]);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: authority.secretKey,
      message: message,
    });

    // Derive consumer callback accounts
    const [gameConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game-config")],
      diceProgram.programId
    );
    const diceRollPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("dice-roll"),
        admin.publicKey.toBuffer(),
        reqId.toArrayLike(Buffer, "le", 8),
      ],
      diceProgram.programId
    )[0];

    try {
      await program.methods
        .fulfillRandomWords(reqId, [...randomness] as any)
        .accounts({
          authority: authority.publicKey,
          config: configPda,
          request: requestPda,
          requester: admin.publicKey,
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
    } catch (e: any) {
      const errStr = [e?.message, e?.logs?.join(" "), JSON.stringify(e)].filter(Boolean).join(" ");
      if (
        errStr.includes("RequestNotPending") ||
        errStr.includes('"Custom":6000') ||
        errStr.includes('"Custom": 6000')
      ) {
        // Backend already fulfilled
        return;
      }
      throw e;
    }

    // Verify dice roll was settled via callback
    const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
    expect(diceRoll.result).to.be.gte(1).and.lte(6);

    // Verify request PDA was closed (rent refunded)
    const requestAccount = await provider.connection.getAccountInfo(requestPda);
    expect(requestAccount).to.be.null;
  });

  it("Fails to fulfill with wrong authority", async () => {
    // Create a new request for this test
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32, 0x04);
    const requestPda = getRequestPda(requestId);
    const consumerPda = getConsumerPda(subscriptionId, diceProgram.programId);
    const [gameConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game-config")],
      diceProgram.programId
    );
    const diceRollPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("dice-roll"),
        admin.publicKey.toBuffer(),
        new anchor.BN(requestId).toArrayLike(Buffer, "le", 8),
      ],
      diceProgram.programId
    )[0];

    // Create request via CPI
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
        vrfProgram: program.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const wrongAuthority = testKeys.wrongAuthority;
    const reqId = new anchor.BN(requestId);
    const randomness = Buffer.alloc(32, 0x99);
    const message = Buffer.concat([
      reqId.toArrayLike(Buffer, "le", 8),
      randomness,
    ]);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: wrongAuthority.secretKey,
      message: message,
    });

    try {
      await program.methods
        .fulfillRandomWords(reqId, [...randomness] as any)
        .accounts({
          authority: wrongAuthority.publicKey,
          config: configPda,
          request: requestPda,
          requester: admin.publicKey,
          consumerProgram: diceProgram.programId,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: gameConfigPda, isWritable: false, isSigner: false },
          { pubkey: diceRollPda, isWritable: true, isSigner: false },
        ])
        .preInstructions([ed25519Ix])
        .signers([wrongAuthority])
        .rpc();
      expect.fail("Should have failed with wrong authority");
    } catch (e: any) {
      const errStr = [e?.message, e?.logs?.join(" "), JSON.stringify(e)].filter(Boolean).join(" ");
      expect(
        errStr.includes("Unauthorized") ||
        errStr.includes("RequestNotPending") ||
        errStr.includes('"Custom":6000') ||
        errStr.includes('"Custom": 6000') ||
        errStr.includes('"Custom":6007') ||
        errStr.includes('"Custom": 6007')
      ).to.be.true;
    }
  });

  // === REMOVE CONSUMER ===

  it("Removes a consumer from the subscription", async () => {
    // Add a second consumer to test removal
    const fakeConsumer = Keypair.generate();
    const consumerPda = getConsumerPda(subscriptionId, fakeConsumer.publicKey);

    await program.methods
      .addConsumer(new anchor.BN(subscriptionId))
      .accounts({
        owner: admin.publicKey,
        subscription: subscriptionPda,
        consumerProgram: fakeConsumer.publicKey,
        consumerRegistration: consumerPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const subBefore = await program.account.subscription.fetch(subscriptionPda);
    const countBefore = subBefore.consumerCount;

    await program.methods
      .removeConsumer(new anchor.BN(subscriptionId))
      .accounts({
        owner: admin.publicKey,
        subscription: subscriptionPda,
        consumerProgram: fakeConsumer.publicKey,
        consumerRegistration: consumerPda,
      })
      .rpc();

    const subAfter = await program.account.subscription.fetch(subscriptionPda);
    expect(subAfter.consumerCount).to.equal(countBefore - 1);

    // Registration account should be closed
    const regAccount = await provider.connection.getAccountInfo(consumerPda);
    expect(regAccount).to.be.null;
  });

  // === UPDATE CONFIG ===

  it("Updates config as admin", async () => {
    const newAuthority = testKeys.newAuthority;
    const newFee = new anchor.BN(20_000);

    await program.methods
      .updateConfig(newAuthority.publicKey, newFee, 20, null)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();

    const config = await program.account.coordinatorConfig.fetch(configPda);
    expect(config.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());
    expect(config.feePerWord.toNumber()).to.equal(20_000);
    expect(config.maxNumWords).to.equal(20);

    // Revert for further tests
    await program.methods
      .updateConfig(authority.publicKey, feePerWord, maxNumWords, null)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();
  });

  it("Fails to update config with non-admin", async () => {
    const nonAdmin = testKeys.nonAdmin;
    try {
      await program.methods
        .updateConfig(null, new anchor.BN(999), null, null)
        .accounts({
          admin: nonAdmin.publicKey,
          config: configPda,
        })
        .signers([nonAdmin])
        .rpc();
      expect.fail("Should have failed - not admin");
    } catch (e: any) {
      expect(e.toString()).to.contain("Unauthorized");
    }
  });

  it("Fails to update config with zero-address authority", async () => {
    try {
      await program.methods
        .updateConfig(PublicKey.default, null, null, null)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
      expect.fail("Should have failed - zero address authority");
    } catch (e: any) {
      expect(e.toString()).to.contain("ZeroAddressNotAllowed");
    }
  });

  it("Fails to update config with zero-address admin", async () => {
    try {
      await program.methods
        .updateConfig(null, null, null, PublicKey.default)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
      expect.fail("Should have failed - zero address admin");
    } catch (e: any) {
      expect(e.toString()).to.contain("ZeroAddressNotAllowed");
    }
  });
});
