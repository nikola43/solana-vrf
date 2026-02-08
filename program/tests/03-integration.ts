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
} from "@solana/web3.js";

/**
 * Integration tests that verify end-to-end flow with a live backend.
 *
 * Prerequisites:
 *   - Programs deployed to devnet (Phase 1)
 *   - Backend running: cd backend && cargo run
 *
 * The backend (vrf-signer G6LW...) automatically fulfills randomness requests
 * by watching on-chain events and submitting Ed25519-signed fulfillment txs.
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

  const fee = new anchor.BN(10_000);

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

  /**
   * Poll a request PDA until its status matches the expected value.
   * @returns The fetched request account once fulfilled.
   */
  async function pollRequestStatus(
    requestId: number,
    expectedStatus: number,
    timeoutMs = 30_000,
    intervalMs = 2_000
  ) {
    const requestPda = getRequestPda(requestId);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const request =
          await vrfProgram.account.randomnessRequest.fetch(requestPda);
        if (request.status === expectedStatus) {
          return request;
        }
      } catch {
        // Account may not exist yet, keep polling
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `Timeout: request ${requestId} did not reach status ${expectedStatus} within ${timeoutMs}ms`
    );
  }

  // Track request IDs for sequential tests
  let fulfilledRequestId: number;

  before(async () => {
    // Read existing config — unit tests (01) should have initialized it
    const existingConfig = await provider.connection.getAccountInfo(configPda);

    if (!existingConfig) {
      // Initialize if not done by unit tests (standalone run)
      await vrfProgram.methods
        .initialize(fee)
        .accounts({
          admin: admin.publicKey,
          authority: AUTHORITY_PUBKEY,
          treasury: AUTHORITY_PUBKEY,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } else {
      // Update config to set live backend authority and treasury
      await vrfProgram.methods
        .updateConfig(AUTHORITY_PUBKEY, fee, AUTHORITY_PUBKEY, null)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    }

    // Verify config is correct
    const config = await vrfProgram.account.vrfConfiguration.fetch(configPda);
    expect(config.authority.toBase58()).to.equal(AUTHORITY_PUBKEY.toBase58());
    expect(config.treasury.toBase58()).to.equal(AUTHORITY_PUBKEY.toBase58());
  });

  it("Backend fulfills randomness request automatically", async () => {
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32);
    seed.writeUInt32LE(Date.now() % 0xffffffff, 0);
    const requestPda = getRequestPda(requestId);

    // Request randomness on-chain
    await vrfProgram.methods
      .requestRandomness([...seed] as any)
      .accounts({
        requester: admin.publicKey,
        config: configPda,
        request: requestPda,
        treasury: AUTHORITY_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Poll until backend fulfills it (status == 1)
    // Note: backend may fulfill before we can even read the pending status
    const fulfilled = await pollRequestStatus(requestId, 1);

    expect(fulfilled.status).to.equal(1);
    // Randomness should be non-zero
    const randomnessBytes = Buffer.from(fulfilled.randomness);
    expect(randomnessBytes.some((b) => b !== 0)).to.be.true;
    // Fulfilled slot should be > request slot
    expect(fulfilled.fulfilledSlot.toNumber()).to.be.greaterThan(
      fulfilled.requestSlot.toNumber()
    );

    fulfilledRequestId = requestId;
  });

  it("Consume backend-fulfilled randomness", async () => {
    const requestPda = getRequestPda(fulfilledRequestId);

    const sig = await vrfProgram.methods
      .consumeRandomness(new anchor.BN(fulfilledRequestId))
      .accounts({
        requester: admin.publicKey,
        request: requestPda,
      })
      .rpc({ commitment: "confirmed" });

    // Wait for confirmation before fetching
    await provider.connection.confirmTransaction(sig, "confirmed");

    const request =
      await vrfProgram.account.randomnessRequest.fetch(requestPda);
    expect(request.status).to.equal(2); // Consumed
  });

  it("Full dice roll with live backend", async () => {
    const requestId = await getNextRequestId();
    const seed = Buffer.alloc(32);
    seed.writeUInt32LE((Date.now() + 1) % 0xffffffff, 0);
    const requestPda = getRequestPda(requestId);
    const diceRollPda = getDiceRollPda(admin.publicKey, requestId);

    // Request dice roll via dice program (CPI into VRF)
    await diceProgram.methods
      .requestRoll([...seed] as any)
      .accounts({
        player: admin.publicKey,
        vrfConfig: configPda,
        vrfRequest: requestPda,
        treasury: AUTHORITY_PUBKEY,
        diceRoll: diceRollPda,
        vrfProgram: vrfProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Verify dice roll is pending
    let diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
    expect(diceRoll.result).to.equal(0);

    // Wait for backend to fulfill VRF request
    await pollRequestStatus(requestId, 1);

    // Settle the dice roll
    await diceProgram.methods
      .settleRoll(new anchor.BN(requestId))
      .accounts({
        player: admin.publicKey,
        vrfRequest: requestPda,
        diceRoll: diceRollPda,
        vrfProgram: vrfProgram.programId,
      })
      .rpc();

    diceRoll = await diceProgram.account.diceRoll.fetch(diceRollPda);
    expect(diceRoll.result).to.be.gte(1).and.lte(6);
  });

  it("Backend handles multiple concurrent requests", async () => {
    const count = 3;
    const requestIds: number[] = [];

    // Submit 3 requests
    for (let i = 0; i < count; i++) {
      const requestId = await getNextRequestId();
      const seed = Buffer.alloc(32);
      seed.writeUInt32LE((Date.now() + i + 100) % 0xffffffff, 0);
      seed[4] = i;
      const requestPda = getRequestPda(requestId);

      await vrfProgram.methods
        .requestRandomness([...seed] as any)
        .accounts({
          requester: admin.publicKey,
          config: configPda,
          request: requestPda,
          treasury: AUTHORITY_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      requestIds.push(requestId);
    }

    // Wait for all 3 to be fulfilled (poll in parallel)
    const results = await Promise.all(
      requestIds.map((id) => pollRequestStatus(id, 1, 60_000))
    );

    // Verify all fulfilled with non-zero randomness
    const randomnessValues: string[] = [];
    for (const result of results) {
      expect(result.status).to.equal(1);
      const rand = Buffer.from(result.randomness).toString("hex");
      expect(rand).to.not.equal("0".repeat(64));
      randomnessValues.push(rand);
    }

    // Verify all have distinct randomness values
    const uniqueValues = new Set(randomnessValues);
    expect(uniqueValues.size).to.equal(count);
  });
});
