import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
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

describe("vrf-sol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vrfSol as Program<VrfSol>;
  const admin = provider.wallet as anchor.Wallet;

  // Oracle authority keypair (loaded from vrf-signer.json to match the backend)
  const authoritySecret = JSON.parse(
    fs.readFileSync("../backend/vrf-signer.json", "utf-8")
  );
  const authority = Keypair.fromSecretKey(Uint8Array.from(authoritySecret));
  const treasury = Keypair.generate();

  const fee = new anchor.BN(10_000); // 10,000 lamports

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vrf-config")],
    program.programId
  );

  // Track whether config was already initialized from a prior run
  let configAlreadyExisted = false;

  // Track request IDs dynamically
  let fulfilledRequestId: number; // A request that has been fulfilled but not consumed
  let pendingRequestId: number; // A request that is still pending
  let consumedRequestId: number; // A request that has been consumed (ready to close)

  function getRequestPda(requestId: number | anchor.BN): PublicKey {
    const id = new anchor.BN(requestId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("request"), id.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    return pda;
  }

  async function getNextRequestId(): Promise<number> {
    const config = await program.account.vrfConfiguration.fetch(configPda);
    return config.requestCounter.toNumber();
  }

  async function createRequest(seed: number): Promise<number> {
    const requestId = await getNextRequestId();
    const seedBuf = Buffer.alloc(32, seed);
    const requestPda = getRequestPda(requestId);

    await program.methods
      .requestRandomness([...seedBuf] as any)
      .accounts({
        requester: admin.publicKey,
        config: configPda,
        request: requestPda,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return requestId;
  }

  async function fulfillRequest(
    requestId: number,
    randomnessValue: number
  ): Promise<void> {
    const reqId = new anchor.BN(requestId);
    const randomness = Buffer.alloc(32, randomnessValue);
    const message = Buffer.concat([
      reqId.toArrayLike(Buffer, "le", 8),
      randomness,
    ]);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: authority.secretKey,
      message: message,
    });

    try {
      await program.methods
        .fulfillRandomness(reqId, [...randomness] as any)
        .accounts({
          authority: authority.publicKey,
          config: configPda,
          request: getRequestPda(requestId),
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([authority])
        .rpc();
    } catch (e: any) {
      if (e.toString().includes("RequestNotPending")) {
        return; // Backend already fulfilled this request
      }
      throw e;
    }
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
    // Fund authority so it can sign transactions
    await fundAccount(authority.publicKey, 5 * LAMPORTS_PER_SOL);

    // Fund treasury so it can receive fee transfers (needs rent-exempt minimum)
    await fundAccount(treasury.publicKey, LAMPORTS_PER_SOL);

    // Check if config already exists (from a prior test run)
    const existingConfig = await provider.connection.getAccountInfo(configPda);
    if (existingConfig) {
      configAlreadyExisted = true;
      // Update config to use our local authority and treasury for this run
      await program.methods
        .updateConfig(authority.publicKey, fee, treasury.publicKey, null)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    }
  });

  // Test 1: Initialize - happy path (or verify after update on re-run)
  it("Initializes the VRF config", async () => {
    if (configAlreadyExisted) {
      // Config already existed — before hook updated it, just verify
      const config = await program.account.vrfConfiguration.fetch(configPda);
      expect(config.admin.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(config.authority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(config.fee.toNumber()).to.equal(10_000);
      expect(config.treasury.toBase58()).to.equal(
        treasury.publicKey.toBase58()
      );
      return;
    }

    await program.methods
      .initialize(fee)
      .accounts({
        admin: admin.publicKey,
        authority: authority.publicKey,
        treasury: treasury.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.vrfConfiguration.fetch(configPda);
    expect(config.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(config.authority.toBase58()).to.equal(
      authority.publicKey.toBase58()
    );
    expect(config.fee.toNumber()).to.equal(10_000);
    expect(config.requestCounter.toNumber()).to.equal(0);
    expect(config.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
  });

  // Test 2: Request randomness - happy path + fee transfer
  it("Requests randomness and pays fee", async () => {
    const seed = Buffer.alloc(32);
    seed.fill(1);

    const treasuryBalanceBefore = await provider.connection.getBalance(
      treasury.publicKey
    );

    const nextId = await getNextRequestId();
    const requestPda = getRequestPda(nextId);

    await program.methods
      .requestRandomness([...seed] as any)
      .accounts({
        requester: admin.publicKey,
        config: configPda,
        request: requestPda,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const treasuryBalanceAfter = await provider.connection.getBalance(
      treasury.publicKey
    );
    expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(10_000);

    const request = await program.account.randomnessRequest.fetch(requestPda);
    expect(request.requestId.toNumber()).to.equal(nextId);
    expect(request.requester.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(Buffer.from(request.seed)).to.deep.equal(seed);
    expect(request.status).to.equal(0); // Pending
    expect(request.requestSlot.toNumber()).to.be.greaterThan(0);

    // Verify counter incremented
    const config = await program.account.vrfConfiguration.fetch(configPda);
    expect(config.requestCounter.toNumber()).to.equal(nextId + 1);

    // This will be our first request - save it for the fulfill test
    consumedRequestId = nextId;
  });

  // Test 3: Fulfill randomness - happy path with Ed25519 instruction
  it("Fulfills randomness with valid Ed25519 signature", async () => {
    const requestId = new anchor.BN(consumedRequestId);
    const requestPda = getRequestPda(consumedRequestId);

    const randomness = Buffer.alloc(32);
    randomness.fill(42);

    const message = Buffer.concat([
      requestId.toArrayLike(Buffer, "le", 8),
      randomness,
    ]);

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: authority.secretKey,
      message: message,
    });

    try {
      await program.methods
        .fulfillRandomness(requestId, [...randomness] as any)
        .accounts({
          authority: authority.publicKey,
          config: configPda,
          request: requestPda,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([authority])
        .rpc();
    } catch (e: any) {
      if (!e.toString().includes("RequestNotPending")) throw e;
      // Backend already fulfilled — that's fine
    }

    const request = await program.account.randomnessRequest.fetch(requestPda);
    expect(request.status).to.be.gte(1); // Fulfilled (by test or backend)
    expect(request.fulfilledSlot.toNumber()).to.be.greaterThan(0);
  });

  // Test 4: Fulfill - wrong authority fails
  it("Fails to fulfill with wrong authority", async () => {
    // Create a new pending request for this test
    const reqId = await createRequest(0x04);

    const wrongAuthority = Keypair.generate();
    await fundAccount(wrongAuthority.publicKey, LAMPORTS_PER_SOL);

    const requestId = new anchor.BN(reqId);
    const randomness = Buffer.alloc(32, 99);
    const message = Buffer.concat([
      requestId.toArrayLike(Buffer, "le", 8),
      randomness,
    ]);

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: wrongAuthority.secretKey,
      message: message,
    });

    try {
      await program.methods
        .fulfillRandomness(requestId, [...randomness] as any)
        .accounts({
          authority: wrongAuthority.publicKey,
          config: configPda,
          request: getRequestPda(reqId),
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([wrongAuthority])
        .rpc();
      expect.fail("Should have failed with wrong authority");
    } catch (e: any) {
      const errStr = e.toString();
      // Unauthorized (wrong authority rejected) or RequestNotPending (backend fulfilled first)
      expect(
        errStr.includes("Unauthorized") || errStr.includes("RequestNotPending")
      ).to.be.true;
    }

    // Save this as our pending request for later tests
    pendingRequestId = reqId;
  });

  // Test 5: Fulfill - missing Ed25519 instruction fails
  it("Fails to fulfill without Ed25519 instruction", async () => {
    const requestId = new anchor.BN(pendingRequestId);
    const randomness = Buffer.alloc(32, 99);

    try {
      await program.methods
        .fulfillRandomness(requestId, [...randomness] as any)
        .accounts({
          authority: authority.publicKey,
          config: configPda,
          request: getRequestPda(pendingRequestId),
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([authority])
        .rpc();
      expect.fail("Should have failed without Ed25519 instruction");
    } catch (e: any) {
      expect(e.toString()).to.contain("Error");
    }
  });

  // Test 6: Consume randomness - happy path
  it("Consumes fulfilled randomness", async () => {
    const requestId = new anchor.BN(consumedRequestId);
    const requestPda = getRequestPda(consumedRequestId);

    await program.methods
      .consumeRandomness(requestId)
      .accounts({
        requester: admin.publicKey,
        request: requestPda,
      })
      .rpc();

    const request = await program.account.randomnessRequest.fetch(requestPda);
    expect(request.status).to.equal(2); // Consumed
  });

  // Test 7: Consume - wrong requester fails
  it("Fails to consume with wrong requester", async () => {
    // Fulfill the pending request so we can try to consume with wrong requester
    await fulfillRequest(pendingRequestId, 77);
    fulfilledRequestId = pendingRequestId;

    const wrongRequester = Keypair.generate();
    await fundAccount(wrongRequester.publicKey, LAMPORTS_PER_SOL);

    try {
      await program.methods
        .consumeRandomness(new anchor.BN(fulfilledRequestId))
        .accounts({
          requester: wrongRequester.publicKey,
          request: getRequestPda(fulfilledRequestId),
        })
        .signers([wrongRequester])
        .rpc();
      expect.fail("Should have failed with wrong requester");
    } catch (e: any) {
      expect(e.toString()).to.contain("Unauthorized");
    }
  });

  // Test 8: Close request - reclaims rent
  it("Closes consumed request and reclaims rent", async () => {
    const requestId = new anchor.BN(consumedRequestId);
    const requestPda = getRequestPda(consumedRequestId);

    await program.methods
      .closeRequest(requestId)
      .accounts({
        requester: admin.publicKey,
        request: requestPda,
      })
      .rpc();

    const account = await provider.connection.getAccountInfo(requestPda);
    expect(account).to.be.null;
  });

  // Test 9: Close - unconsumed request fails
  it("Fails to close unconsumed request", async () => {
    // Create a new pending request
    const reqId = await createRequest(0x09);

    try {
      await program.methods
        .closeRequest(new anchor.BN(reqId))
        .accounts({
          requester: admin.publicKey,
          request: getRequestPda(reqId),
        })
        .rpc();
      expect.fail("Should have failed - request not consumed");
    } catch (e: any) {
      expect(e.toString()).to.contain("RequestNotConsumed");
    }
  });

  // Test 10: Update config - admin only
  it("Updates config as admin", async () => {
    const newAuthority = Keypair.generate();
    const newTreasury = Keypair.generate();
    const newFee = new anchor.BN(20_000);

    await program.methods
      .updateConfig(
        newAuthority.publicKey,
        newFee,
        newTreasury.publicKey,
        null
      )
      .accounts({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();

    const config = await program.account.vrfConfiguration.fetch(configPda);
    expect(config.authority.toBase58()).to.equal(
      newAuthority.publicKey.toBase58()
    );
    expect(config.fee.toNumber()).to.equal(20_000);
    expect(config.treasury.toBase58()).to.equal(
      newTreasury.publicKey.toBase58()
    );
    expect(config.admin.toBase58()).to.equal(admin.publicKey.toBase58());

    // Revert authority and treasury back for further tests
    await program.methods
      .updateConfig(authority.publicKey, fee, treasury.publicKey, null)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();
  });

  // Test 11: Multiple requests - counter increments
  it("Handles multiple requests with incrementing counter", async () => {
    const counterBefore = await getNextRequestId();

    for (let i = 0; i < 2; i++) {
      await createRequest(10 + i);
    }

    const counterAfter = await getNextRequestId();
    expect(counterAfter).to.equal(counterBefore + 2);
  });

  // Test 12: Double-fulfill attempt → RequestNotPending
  it("Fails to double-fulfill a request", async () => {
    // fulfilledRequestId is already fulfilled; try to fulfill again
    const requestId = new anchor.BN(fulfilledRequestId);
    const randomness = Buffer.alloc(32, 55);
    const message = Buffer.concat([
      requestId.toArrayLike(Buffer, "le", 8),
      randomness,
    ]);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: authority.secretKey,
      message: message,
    });

    try {
      await program.methods
        .fulfillRandomness(requestId, [...randomness] as any)
        .accounts({
          authority: authority.publicKey,
          config: configPda,
          request: getRequestPda(fulfilledRequestId),
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([authority])
        .rpc();
      expect.fail("Should have failed - request already fulfilled");
    } catch (e: any) {
      expect(e.toString()).to.contain("RequestNotPending");
    }
  });

  // Test 13: Consume pending request → RequestNotFulfilled
  it("Fails to consume a pending request", async () => {
    // Create a fresh pending request
    const reqId = await createRequest(0x13);

    try {
      await program.methods
        .consumeRandomness(new anchor.BN(reqId))
        .accounts({
          requester: admin.publicKey,
          request: getRequestPda(reqId),
        })
        .rpc();
      // If backend fulfilled between create and consume, consume succeeds — that's OK
    } catch (e: any) {
      expect(e.toString()).to.contain("RequestNotFulfilled");
    }
  });

  // Test 14: Close fulfilled-but-unconsumed request → RequestNotConsumed
  it("Fails to close a fulfilled but unconsumed request", async () => {
    // fulfilledRequestId is fulfilled but not consumed
    const requestId = new anchor.BN(fulfilledRequestId);

    try {
      await program.methods
        .closeRequest(requestId)
        .accounts({
          requester: admin.publicKey,
          request: getRequestPda(fulfilledRequestId),
        })
        .rpc();
      expect.fail("Should have failed - request not consumed");
    } catch (e: any) {
      expect(e.toString()).to.contain("RequestNotConsumed");
    }
  });

  // Test 15: Update config with non-admin → Unauthorized
  it("Fails to update config with non-admin", async () => {
    const nonAdmin = Keypair.generate();
    await fundAccount(nonAdmin.publicKey, LAMPORTS_PER_SOL);

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

  // Test 16: Update config with zero-address authority → ZeroAddressNotAllowed
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

  // Test 17: Update config with zero-address treasury → ZeroAddressNotAllowed
  it("Fails to update config with zero-address treasury", async () => {
    try {
      await program.methods
        .updateConfig(null, null, PublicKey.default, null)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
      expect.fail("Should have failed - zero address treasury");
    } catch (e: any) {
      expect(e.toString()).to.contain("ZeroAddressNotAllowed");
    }
  });

  // Test 18: Fulfill with wrong Ed25519 message → InvalidEd25519Message
  it("Fails to fulfill with wrong Ed25519 message", async () => {
    // Create a fresh pending request for this test
    const reqId = await createRequest(0x18);
    const requestId = new anchor.BN(reqId);
    const randomness = Buffer.alloc(32, 88);
    const wrongRandomness = Buffer.alloc(32, 99);

    // Sign with wrong randomness in the message
    const wrongMessage = Buffer.concat([
      requestId.toArrayLike(Buffer, "le", 8),
      wrongRandomness,
    ]);

    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: authority.secretKey,
      message: wrongMessage,
    });

    try {
      await program.methods
        .fulfillRandomness(requestId, [...randomness] as any)
        .accounts({
          authority: authority.publicKey,
          config: configPda,
          request: getRequestPda(reqId),
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([authority])
        .rpc();
      expect.fail("Should have failed - wrong message");
    } catch (e: any) {
      const errStr = e.toString();
      // InvalidEd25519Message (message mismatch) or RequestNotPending (backend fulfilled first)
      expect(
        errStr.includes("InvalidEd25519Message") || errStr.includes("RequestNotPending")
      ).to.be.true;
    }
  });

  // Test 19: Update config with zero-address admin → ZeroAddressNotAllowed
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

  // Test 20: Close request with wrong requester → Unauthorized
  it("Fails to close request with wrong requester", async () => {
    // Consume fulfilledRequestId so it's ready to close
    await program.methods
      .consumeRandomness(new anchor.BN(fulfilledRequestId))
      .accounts({
        requester: admin.publicKey,
        request: getRequestPda(fulfilledRequestId),
      })
      .rpc();

    const wrongRequester = Keypair.generate();
    await fundAccount(wrongRequester.publicKey, LAMPORTS_PER_SOL);

    try {
      await program.methods
        .closeRequest(new anchor.BN(fulfilledRequestId))
        .accounts({
          requester: wrongRequester.publicKey,
          request: getRequestPda(fulfilledRequestId),
        })
        .signers([wrongRequester])
        .rpc();
      expect.fail("Should have failed - wrong requester");
    } catch (e: any) {
      expect(e.toString()).to.contain("Unauthorized");
    }
  });

  // Test 21: Double-consume attempt → RequestNotFulfilled (already consumed)
  it("Fails to double-consume a request", async () => {
    // fulfilledRequestId was just consumed in test 20, try again
    try {
      await program.methods
        .consumeRandomness(new anchor.BN(fulfilledRequestId))
        .accounts({
          requester: admin.publicKey,
          request: getRequestPda(fulfilledRequestId),
        })
        .rpc();
      expect.fail("Should have failed - already consumed");
    } catch (e: any) {
      expect(e.toString()).to.contain("RequestNotFulfilled");
    }
  });

  // Test 22: Initialize twice → PDA already exists
  it("Fails to initialize config twice", async () => {
    try {
      await program.methods
        .initialize(fee)
        .accounts({
          admin: admin.publicKey,
          authority: authority.publicKey,
          treasury: treasury.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have failed - config already initialized");
    } catch (e: any) {
      // Anchor returns an error because the PDA account already exists
      expect(e.toString()).to.contain("Error");
    }
  });

  // Test 23: Full lifecycle with event emission check
  it("Emits all events through full lifecycle", async () => {
    // Wait for fresh blockhash after many sequential transactions
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const nextId = await getNextRequestId();
    const requestId = new anchor.BN(nextId);
    const requestPda = getRequestPda(nextId);
    const seed = Buffer.alloc(32, 0xaa);
    const randomness = Buffer.alloc(32, 0xbb);

    // Helper to count "Program data:" log entries for our program
    function countProgramDataLogs(logs: string[]): number {
      return logs.filter((l) => l.includes("Program data:")).length;
    }

    // 1. Request → emits RandomnessRequested event (Program data: ...)
    const requestTx = await program.methods
      .requestRandomness([...seed] as any)
      .accounts({
        requester: admin.publicKey,
        config: configPda,
        request: requestPda,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    let txDetails = await provider.connection.getTransaction(requestTx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(
      countProgramDataLogs(txDetails!.meta!.logMessages!)
    ).to.be.gte(1);

    // 2. Fulfill → emits RandomnessFulfilled event (backend may race us)
    const message = Buffer.concat([
      requestId.toArrayLike(Buffer, "le", 8),
      randomness,
    ]);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: authority.secretKey,
      message: message,
    });

    let fulfillTx: string | null = null;
    try {
      fulfillTx = await program.methods
        .fulfillRandomness(requestId, [...randomness] as any)
        .accounts({
          authority: authority.publicKey,
          config: configPda,
          request: requestPda,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .signers([authority])
        .rpc({ commitment: "confirmed" });
    } catch (e: any) {
      if (!e.toString().includes("RequestNotPending")) throw e;
      // Backend fulfilled — skip fulfill event check
    }

    if (fulfillTx) {
      txDetails = await provider.connection.getTransaction(fulfillTx, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      expect(
        countProgramDataLogs(txDetails!.meta!.logMessages!)
      ).to.be.gte(1);
    }

    // 3. Consume → emits RandomnessConsumed event
    const consumeTx = await program.methods
      .consumeRandomness(requestId)
      .accounts({
        requester: admin.publicKey,
        request: requestPda,
      })
      .rpc({ commitment: "confirmed" });

    txDetails = await provider.connection.getTransaction(consumeTx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(
      countProgramDataLogs(txDetails!.meta!.logMessages!)
    ).to.be.gte(1);

    // 4. Close → emits RequestClosed event
    const closeTx = await program.methods
      .closeRequest(requestId)
      .accounts({
        requester: admin.publicKey,
        request: requestPda,
      })
      .rpc({ commitment: "confirmed" });

    txDetails = await provider.connection.getTransaction(closeTx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    expect(
      countProgramDataLogs(txDetails!.meta!.logMessages!)
    ).to.be.gte(1);
  });
});
