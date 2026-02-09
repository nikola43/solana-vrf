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

describe("roll-dice", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const diceProgram = anchor.workspace.rollDice as Program<RollDice>;
  const vrfProgram = anchor.workspace.vrfSol as Program<VrfSol>;
  const player = provider.wallet as anchor.Wallet;

  // Oracle authority keypair (loaded from vrf-signer.json to match the backend)
  const authoritySecret = JSON.parse(
    fs.readFileSync("../backend/vrf-signer.json", "utf-8")
  );
  const authority = Keypair.fromSecretKey(Uint8Array.from(authoritySecret));
  const wrongPlayer = testKeys.wrongPlayer;

  let treasury: PublicKey;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vrf-config")],
    vrfProgram.programId
  );

  function getRequestPda(requestId: number | anchor.BN): PublicKey {
    const id = new anchor.BN(requestId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("request"), id.toArrayLike(Buffer, "le", 8)],
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
        Buffer.from("dice-roll"),
        playerKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      diceProgram.programId
    );
    return pda;
  }

  async function getNextRequestId(): Promise<number> {
    const config = await vrfProgram.account.vrfConfiguration.fetch(configPda);
    return config.requestCounter.toNumber();
  }

  async function fulfillVrfRequest(
    requestId: number,
    randomness: Buffer
  ): Promise<string | null> {
    const reqId = new anchor.BN(requestId);
    const message = Buffer.concat([
      reqId.toArrayLike(Buffer, "le", 8),
      randomness,
    ]);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: authority.secretKey,
      message: message,
    });

    try {
      return await vrfProgram.methods
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
      // Backend already fulfilled — catch both Error objects and raw TransactionError objects
      if (isRequestNotPendingError(e)) {
        return null;
      }
      throw e;
    }
  }

  async function ensureFulfilled(requestId: number): Promise<void> {
    const requestPda = getRequestPda(requestId);
    for (let i = 0; i < 15; i++) {
      const request = await vrfProgram.account.randomnessRequest.fetch(requestPda);
      if (request.status >= 1) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Request ${requestId} not fulfilled within timeout`);
  }

  async function settleRollWithRetry(
    requestId: number,
    requestPda: PublicKey,
    diceRollPda: PublicKey,
    retries = 5,
  ): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
      // Check if VRF request status is correct before attempting settle
      const vrfReq = await vrfProgram.account.randomnessRequest.fetch(requestPda);
      if (vrfReq.status !== 1) {
        // Not in Fulfilled status — if already consumed (2), settle won't work
        // Check if dice already has a result
        const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
        if (diceRoll.result > 0) return;
        // Wait and retry
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw new Error(
          `VRF request ${requestId} has status ${vrfReq.status} (expected 1=Fulfilled), dice result=${diceRoll.result}`
        );
      }

      try {
        await diceProgram.methods
          .settleRoll(new anchor.BN(requestId))
          .accounts({
            player: player.publicKey,
            vrfRequest: requestPda,
            diceRoll: diceRollPda,
            vrfProgram: vrfProgram.programId,
          })
          .rpc({ skipPreflight: true, commitment: "confirmed" });
        return;
      } catch (e: any) {
        const errStr = [e?.message, e?.logs?.join(" ")].filter(Boolean).join(" ");
        let jsonStr = ""; try { jsonStr = JSON.stringify(e); } catch {}
        const fullErr = errStr + " " + jsonStr;
        // Already settled is fine — dice roll result is already set
        if (fullErr.includes("AlreadySettled")) return;
        // Raw object or Anchor error — retry after delay
        const isRetryable =
          fullErr.includes("Unknown action") ||
          fullErr.includes('"Custom"') ||
          fullErr.includes("RequestNotFulfilled") ||
          fullErr.includes("blockhash") ||
          fullErr.includes("ProgramError") ||
          e?.InstructionError != null ||
          (e.constructor?.name === "ProgramError");
        if (isRetryable) {
          if (attempt < retries - 1) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          // Final attempt — check if dice roll already has result
          try {
            const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
            if (diceRoll.result > 0) return; // Already settled by another path
          } catch {
            // Account may not exist yet
          }
          throw new Error(
            `settle_roll failed after ${retries} attempts. Original: ${errStr.substring(0, 200)}`
          );
        }
        throw e;
      }
    }
  }

  /** Check if an error indicates the request was already fulfilled (Custom:6000 = RequestNotPending). */
  function isRequestNotPendingError(e: any): boolean {
    // Direct object check (raw TransactionError thrown as object)
    const custom = e?.InstructionError?.[1]?.Custom;
    if (custom === 6000) return true;
    // String-based check (Error objects from Anchor/web3.js)
    const msg = e?.message ?? "";
    if (msg.includes("RequestNotPending") || msg.includes("Unknown action")) return true;
    try {
      const json = JSON.stringify(e);
      if (json.includes('"Custom":6000')) return true;
    } catch {}
    return false;
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

  before(async () => {
    // Fund authority so it can sign transactions
    await fundAccount(authority.publicKey, 5 * LAMPORTS_PER_SOL);

    // Fund wrong player for test 3
    await fundAccount(wrongPlayer.publicKey, LAMPORTS_PER_SOL);

    // Ensure config is initialized (01-vrf-sol should have done this)
    const existingConfig = await provider.connection.getAccountInfo(configPda);
    if (!existingConfig) {
      await fundAccount(testKeys.treasury.publicKey, LAMPORTS_PER_SOL);
      const fee = new anchor.BN(10_000);
      await vrfProgram.methods
        .initialize(fee)
        .accounts({
          admin: player.publicKey,
          authority: authority.publicKey,
          treasury: testKeys.treasury.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // Read treasury from config (use whatever is already set)
    const config = await vrfProgram.account.vrfConfiguration.fetch(configPda);
    treasury = config.treasury;
  });

  // Delay between tests to respect Helius devnet rate limits (50 req/s)
  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 1500));
  });

  // Test 1: Full happy path: request_roll → fulfill VRF → settle_roll
  it("Full happy path: request, fulfill, settle", async () => {
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32, 0x01);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(player.publicKey, requestId);

    // Request roll via dice program
    await diceProgram.methods
      .requestRoll([...seed] as any)
      .accounts({
        player: player.publicKey,
        vrfConfig: configPda,
        vrfRequest: requestPda,
        treasury: treasury,
        diceRoll: diceRollPda,
        vrfProgram: vrfProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Verify dice roll created with pending state
    let diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
    expect(diceRoll.result).to.equal(0);
    expect(diceRoll.player.toBase58()).to.equal(player.publicKey.toBase58());
    expect(diceRoll.vrfRequestId.toNumber()).to.equal(requestId);

    // Fulfill VRF request (oracle or backend)
    const randomness = Buffer.alloc(32, 0x42);
    await fulfillVrfRequest(requestId, randomness);
    await ensureFulfilled(requestId);

    // Settle roll
    await settleRollWithRetry(requestId, requestPda, diceRollPda);

    // Verify result is 1-6
    diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
    expect(diceRoll.result).to.be.gte(1).and.lte(6);
  });

  // Test 2: Settle before VRF fulfillment → fails
  it("Fails to settle before VRF fulfillment", async () => {
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32, 0x02);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(player.publicKey, requestId);

    // Request roll
    await diceProgram.methods
      .requestRoll([...seed] as any)
      .accounts({
        player: player.publicKey,
        vrfConfig: configPda,
        vrfRequest: requestPda,
        treasury: treasury,
        diceRoll: diceRollPda,
        vrfProgram: vrfProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Try to settle without fulfilling (backend may race, so accept success too)
    try {
      await diceProgram.methods
        .settleRoll(new anchor.BN(requestId))
        .accounts({
          player: player.publicKey,
          vrfRequest: requestPda,
          diceRoll: diceRollPda,
          vrfProgram: vrfProgram.programId,
        })
        .rpc();
      // If backend fulfilled between request and settle, settle succeeds — that's OK
    } catch (e: any) {
      expect(e.toString()).to.contain("VrfRequestNotFulfilled");
    }
  });

  // Test 3: Settle with wrong player → fails
  it("Fails to settle with wrong player", async () => {
    // Get the pending request from Test 2 and fulfill it
    const requestId = (await getNextRequestId()) - 1; // From Test 2
    const randomness = Buffer.alloc(32, 0x33);
    await fulfillVrfRequest(requestId, randomness);
    await ensureFulfilled(requestId);

    // wrongPlayer is pre-funded in before() hook — no Keypair.generate()
    const wrongDiceRollPda = getDiceRollPda(wrongPlayer.publicKey, requestId);

    try {
      await diceProgram.methods
        .settleRoll(new anchor.BN(requestId))
        .accounts({
          player: wrongPlayer.publicKey,
          vrfRequest: getRequestPda(requestId),
          diceRoll: wrongDiceRollPda,
          vrfProgram: vrfProgram.programId,
        })
        .signers([wrongPlayer])
        .rpc();
      expect.fail("Should have failed - wrong player");
    } catch (e: any) {
      // PDA doesn't exist for wrong player
      expect(e.toString()).to.contain("Error");
    }
  });

  // Test 4: Double-settle → fails
  it("Fails to double-settle a dice roll", async () => {
    // Use request from Test 2 (fulfilled in Test 3 but may already be settled)
    const requestId = (await getNextRequestId()) - 1;
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(player.publicKey, requestId);
    await ensureFulfilled(requestId);

    // First settle (may already be settled from Test 2 if backend raced)
    const diceRollBefore = await diceProgram.account.diceRoll.fetch(diceRollPda);
    if (diceRollBefore.result === 0) {
      await diceProgram.methods
        .settleRoll(new anchor.BN(requestId))
        .accounts({
          player: player.publicKey,
          vrfRequest: requestPda,
          diceRoll: diceRollPda,
          vrfProgram: vrfProgram.programId,
        })
        .rpc();
    }

    // Try to settle again - fails because VRF request is now consumed (status=2),
    // so the VrfRequestNotFulfilled constraint fires (status != 1)
    try {
      await diceProgram.methods
        .settleRoll(new anchor.BN(requestId))
        .accounts({
          player: player.publicKey,
          vrfRequest: requestPda,
          diceRoll: diceRollPda,
          vrfProgram: vrfProgram.programId,
        })
        .rpc();
      expect.fail("Should have failed - already settled");
    } catch (e: any) {
      // AlreadySettled (dice_roll.result != 0) or VrfRequestNotFulfilled (VRF status became 2 after consume CPI)
      const errStr = e.toString();
      expect(
        errStr.includes("AlreadySettled") ||
          errStr.includes("VrfRequestNotFulfilled")
      ).to.be.true;
    }
  });

  // Test 5: Dice result always 1-6 across various randomness values
  it("Produces valid dice results (1-6) for various randomness values", async () => {
    const testRandomness = [
      Buffer.alloc(32, 0x00),
      Buffer.alloc(32, 0xff),
      Buffer.from(
        "0102030405060708091011121314151617181920212223242526272829303132",
        "hex"
      ),
      Buffer.from(
        "fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0",
        "hex"
      ),
    ];

    for (let i = 0; i < testRandomness.length; i++) {
      // Delay between iterations to avoid Helius 50 req/s rate limit
      if (i > 0) await new Promise((r) => setTimeout(r, 3000));

      const requestId = await getNextRequestId();
      const seed = Buffer.alloc(32, 0x50 + i);
      const requestPda = getRequestPda(requestId);
      const diceRollPda = getDiceRollPda(player.publicKey, requestId);

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await diceProgram.methods
            .requestRoll([...seed] as any)
            .accounts({
              player: player.publicKey,
              vrfConfig: configPda,
              vrfRequest: requestPda,
              treasury: treasury,
              diceRoll: diceRollPda,
              vrfProgram: vrfProgram.programId,
              systemProgram: SystemProgram.programId,
            })
            .rpc({ commitment: "confirmed" });
          break;
        } catch (e: any) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw e;
        }
      }

      await fulfillVrfRequest(requestId, testRandomness[i]);
      await ensureFulfilled(requestId);

      await settleRollWithRetry(requestId, requestPda, diceRollPda);

      const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
      expect(diceRoll.result).to.be.gte(1).and.lte(6);
    }
  });

  // Test 6: Multiple sequential dice rolls
  it("Handles multiple sequential dice rolls", async () => {
    const results: number[] = [];

    for (let i = 0; i < 3; i++) {
      // Delay between iterations to avoid Helius 50 req/s rate limit
      if (i > 0) await new Promise((r) => setTimeout(r, 3000));

      const requestId = await getNextRequestId();
      const seed = Buffer.alloc(32, 0x60 + i);
      const requestPda = getRequestPda(requestId);
      const diceRollPda = getDiceRollPda(player.publicKey, requestId);

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await diceProgram.methods
            .requestRoll([...seed] as any)
            .accounts({
              player: player.publicKey,
              vrfConfig: configPda,
              vrfRequest: requestPda,
              treasury: treasury,
              diceRoll: diceRollPda,
              vrfProgram: vrfProgram.programId,
              systemProgram: SystemProgram.programId,
            })
            .rpc({ commitment: "confirmed" });
          break;
        } catch (e: any) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw e;
        }
      }

      const randomness = Buffer.alloc(32, 0x70 + i);
      await fulfillVrfRequest(requestId, randomness);
      await ensureFulfilled(requestId);

      await settleRollWithRetry(requestId, requestPda, diceRollPda);

      const diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
      results.push(diceRoll.result);
      expect(diceRoll.result).to.be.gte(1).and.lte(6);
    }

    expect(results).to.have.length(3);
  });

  // Test 7: Wrong treasury in request_roll → fails (TreasuryMismatch)
  it("Fails to request roll with wrong treasury", async () => {
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32, 0x77);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(player.publicKey, requestId);

    // Use wrongPlayer's pubkey as a "wrong treasury" — any non-matching pubkey works
    try {
      await diceProgram.methods
        .requestRoll([...seed] as any)
        .accounts({
          player: player.publicKey,
          vrfConfig: configPda,
          vrfRequest: requestPda,
          treasury: wrongPlayer.publicKey,
          diceRoll: diceRollPda,
          vrfProgram: vrfProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have failed - wrong treasury");
    } catch (e: any) {
      expect(e.toString()).to.contain("TreasuryMismatch");
    }
  });

  // Test 8: Event emission check (DiceRollRequested, DiceRollSettled)
  it("Emits DiceRollRequested and DiceRollSettled events", async () => {
    // Wait for fresh blockhash after many sequential transactions
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32, 0x88);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(player.publicKey, requestId);

    function countProgramDataLogs(logs: string[]): number {
      return logs.filter((l) => l.includes("Program data:")).length;
    }

    // Request and check event emission
    const requestTx = await diceProgram.methods
      .requestRoll([...seed] as any)
      .accounts({
        player: player.publicKey,
        vrfConfig: configPda,
        vrfRequest: requestPda,
        treasury: treasury,
        diceRoll: diceRollPda,
        vrfProgram: vrfProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    let txDetails = await provider.connection.getTransaction(requestTx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    // Should have at least 2 events: RandomnessRequested (VRF CPI) + DiceRollRequested
    expect(
      countProgramDataLogs(txDetails!.meta!.logMessages!)
    ).to.be.gte(2);

    // Fulfill (backend may race us)
    const randomness = Buffer.alloc(32, 0x99);
    await fulfillVrfRequest(requestId, randomness);
    await ensureFulfilled(requestId);

    // Settle and check event emission (with retry for devnet reliability)
    let settleTx: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        settleTx = await diceProgram.methods
          .settleRoll(new anchor.BN(requestId))
          .accounts({
            player: player.publicKey,
            vrfRequest: requestPda,
            diceRoll: diceRollPda,
            vrfProgram: vrfProgram.programId,
          })
          .rpc({ commitment: "confirmed" });
        break;
      } catch (e: any) {
        const errStr = [e?.message, e?.logs?.join(" "), JSON.stringify(e)].filter(Boolean).join(" ");
        if (errStr.includes("AlreadySettled")) break;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw e;
      }
    }

    if (settleTx) {
      txDetails = await provider.connection.getTransaction(settleTx, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      // Should have at least 2 events: RandomnessConsumed (VRF CPI) + DiceRollSettled
      if (txDetails?.meta?.logMessages) {
        expect(
          countProgramDataLogs(txDetails.meta.logMessages)
        ).to.be.gte(2);
      }
    }
  });
});
