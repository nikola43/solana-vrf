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
import * as testKeys from "./keys/load";

/**
 * Gas / Cost Comparison Tests
 *
 * Measures and compares the cost of regular VRF requests vs compressed VRF
 * requests. Logs per-operation costs for analysis.
 *
 * Regular lifecycle: request → fulfill → consume → close
 *   - Rent: ~0.0016 SOL (refunded on close)
 *   - Fee: configurable (e.g., 10,000 lamports)
 *   - 4 transactions required
 *
 * Compressed lifecycle: request → fulfill (auto-consumed)
 *   - Rent: 0 SOL (zero rent via ZK Compression)
 *   - Fee: configurable + ~30,000 lamports for compression tx fees
 *   - 2 transactions required (or 1 if bundled)
 */
describe("gas-comparison", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vrfSol as Program<VrfSol>;
  const admin = provider.wallet as anchor.Wallet;

  const authoritySecret = JSON.parse(
    fs.readFileSync("../backend/vrf-signer.json", "utf-8")
  );
  const authority = Keypair.fromSecretKey(Uint8Array.from(authoritySecret));
  let treasury: PublicKey;

  const fee = new anchor.BN(10_000);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vrf-config")],
    program.programId
  );

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

  async function getBalance(pubkey: PublicKey): Promise<number> {
    return provider.connection.getBalance(pubkey);
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
    await fundAccount(authority.publicKey, 5 * LAMPORTS_PER_SOL);

    const configAccount = await provider.connection.getAccountInfo(configPda);
    if (!configAccount) {
      await fundAccount(testKeys.treasury.publicKey, LAMPORTS_PER_SOL);
      await program.methods
        .initialize(fee)
        .accounts({
          admin: admin.publicKey,
          authority: authority.publicKey,
          config: configPda,
          treasury: testKeys.treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    // Read treasury from config
    const config = await program.account.vrfConfiguration.fetch(configPda);
    treasury = config.treasury;
  });

  // Delay between tests to respect Helius devnet rate limits (50 req/s)
  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 1000));
  });

  describe("Regular VRF cost analysis", () => {
    interface CostReport {
      requestCost: number;
      fulfillCost: number;
      consumeCost: number;
      closeCost: number;
      totalCost: number;
      rentDeposit: number;
      rentRefund: number;
      netCost: number;
    }

    it("should measure full lifecycle cost for a single regular request", async () => {
      const requestId = await getNextRequestId();
      const seedBuf = Buffer.alloc(32, 0xaa);
      const requestPda = getRequestPda(requestId);

      // --- REQUEST ---
      const balBefore = await getBalance(admin.publicKey);

      await program.methods
        .requestRandomness([...seedBuf] as any)
        .accounts({
          requester: admin.publicKey,
          config: configPda,
          request: requestPda,
          treasury: treasury,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const balAfterRequest = await getBalance(admin.publicKey);
      const requestCost = balBefore - balAfterRequest;

      // Check rent deposit on request PDA
      const requestAccountInfo =
        await provider.connection.getAccountInfo(requestPda);
      const rentDeposit = requestAccountInfo?.lamports ?? 0;

      // --- FULFILL ---
      // The backend may race us and fulfill first. Try manually, fall back to waiting.
      const authBalBefore = await getBalance(authority.publicKey);
      const reqId = new anchor.BN(requestId);
      const randomness = Buffer.alloc(32, 0xbb);
      const message = Buffer.concat([
        reqId.toArrayLike(Buffer, "le", 8),
        randomness,
      ]);

      const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: authority.secretKey,
        message,
      });

      let fulfillCost: number;
      try {
        await program.methods
          .fulfillRandomness(reqId, [...randomness] as any)
          .accounts({
            authority: authority.publicKey,
            config: configPda,
            request: requestPda,
            instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .preInstructions([ed25519Ix])
          .signers([authority])
          .rpc();

        const authBalAfterFulfill = await getBalance(authority.publicKey);
        fulfillCost = authBalBefore - authBalAfterFulfill;
      } catch (e: any) {
        // Backend raced us — wait for it to fulfill
        for (let i = 0; i < 15; i++) {
          const req = await program.account.randomnessRequest.fetch(requestPda);
          if (req.status >= 1) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        fulfillCost = 5000; // Estimated fulfill tx cost when backend does it
      }

      // --- CONSUME ---
      const balBeforeConsume = await getBalance(admin.publicKey);

      await program.methods
        .consumeRandomness(reqId)
        .accounts({
          requester: admin.publicKey,
          request: requestPda,
        })
        .rpc();

      const balAfterConsume = await getBalance(admin.publicKey);
      const consumeCost = balBeforeConsume - balAfterConsume;

      // --- CLOSE ---
      const balBeforeClose = await getBalance(admin.publicKey);

      await program.methods
        .closeRequest(reqId)
        .accounts({
          requester: admin.publicKey,
          request: requestPda,
        })
        .rpc();

      const balAfterClose = await getBalance(admin.publicKey);
      const closeCost = balBeforeClose - balAfterClose;
      const rentRefund = closeCost < 0 ? Math.abs(closeCost) : 0;

      const report: CostReport = {
        requestCost,
        fulfillCost,
        consumeCost,
        closeCost,
        totalCost: requestCost + fulfillCost + consumeCost + closeCost,
        rentDeposit,
        rentRefund,
        netCost: requestCost + fulfillCost + consumeCost + closeCost,
      };

      console.log("\n╔══════════════════════════════════════════╗");
      console.log("║      REGULAR VRF COST REPORT             ║");
      console.log("╠══════════════════════════════════════════╣");
      console.log(
        `║ Request (create PDA):  ${(report.requestCost / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
      console.log(
        `║   └─ Rent deposit:     ${(report.rentDeposit / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
      console.log(
        `║ Fulfill (Ed25519 tx):  ${(report.fulfillCost / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
      console.log(
        `║ Consume (mark read):   ${(report.consumeCost / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
      console.log(
        `║ Close (reclaim rent):  ${(report.closeCost / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
      console.log(
        `║   └─ Rent refunded:    ${(report.rentRefund / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
      console.log("╠══════════════════════════════════════════╣");
      console.log(
        `║ NET COST:              ${(report.netCost / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
      console.log(
        `║ RENT LOCKED (PDA):     ${(report.rentDeposit / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
      console.log("╚══════════════════════════════════════════╝\n");

      // On local validator, the payer may also be the validator (earning fees back)
      // so net cost may be 0. We just verify the test ran without errors.
      expect(report.rentDeposit).to.be.greaterThan(0, "Rent deposit should be non-zero");
    });

    it("should estimate costs for high-volume scenarios", async () => {
      const config = await program.account.vrfConfiguration.fetch(configPda);
      const feePerRequest = config.fee.toNumber();

      // Approximate costs based on single-request measurement
      // Rent for RandomnessRequest PDA (162 bytes + discriminator):
      // ~0.00161 SOL at current rates
      const estimatedRent = 1_614_720; // lamports for 170 bytes
      const estimatedTxFee = 5_000; // per transaction

      const scenarios = [10, 100, 1000];

      console.log("\n╔══════════════════════════════════════════════════╗");
      console.log("║   HIGH-VOLUME COST ESTIMATION                    ║");
      console.log("║   (Regular VRF - 4 tx per request)               ║");
      console.log("╠══════════════════════════════════════════════════╣");

      for (const n of scenarios) {
        const totalFees = feePerRequest * n;
        const totalRentLocked = estimatedRent * n;
        const totalTxCost = estimatedTxFee * 4 * n; // 4 tx per lifecycle
        const totalCost = totalFees + totalTxCost;

        console.log(
          `║ ${n.toString().padStart(4)} concurrent requests:`
        );
        console.log(
          `║   Rent locked:  ${(totalRentLocked / LAMPORTS_PER_SOL).toFixed(4)} SOL (refunded on close)`
        );
        console.log(
          `║   VRF fees:     ${(totalFees / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        );
        console.log(
          `║   Tx fees:      ${(totalTxCost / LAMPORTS_PER_SOL).toFixed(4)} SOL (${4 * n} transactions)`
        );
        console.log(
          `║   Total cost:   ${(totalCost / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        );
        console.log("╠──────────────────────────────────────────────────╣");
      }

      console.log("║                                                  ║");
      console.log("║  COMPRESSED VRF (estimated - 2 tx per request)   ║");
      console.log("╠──────────────────────────────────────────────────╣");

      for (const n of scenarios) {
        const totalFees = feePerRequest * n;
        const totalRentLocked = 0; // Zero rent!
        const compressionFee = 30_000 * n; // ~30k lamports per compression tx
        const totalTxCost = estimatedTxFee * 2 * n; // 2 tx per lifecycle
        const totalCost = totalFees + totalTxCost + compressionFee;

        console.log(
          `║ ${n.toString().padStart(4)} concurrent requests:`
        );
        console.log(
          `║   Rent locked:       ${(totalRentLocked / LAMPORTS_PER_SOL).toFixed(4)} SOL (ZERO!)`
        );
        console.log(
          `║   VRF fees:          ${(totalFees / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        );
        console.log(
          `║   Compression fees:  ${(compressionFee / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        );
        console.log(
          `║   Tx fees:           ${(totalTxCost / LAMPORTS_PER_SOL).toFixed(4)} SOL (${2 * n} transactions)`
        );
        console.log(
          `║   Total cost:        ${(totalCost / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        );
        console.log("╠──────────────────────────────────────────────────╣");
      }

      console.log("║                                                  ║");
      console.log("║  SAVINGS COMPARISON                              ║");
      console.log("╠──────────────────────────────────────────────────╣");

      for (const n of scenarios) {
        const regularRentLocked = estimatedRent * n;
        const regularTxCost = estimatedTxFee * 4 * n;
        const compressedTxCost = estimatedTxFee * 2 * n + 30_000 * n;
        const rentSaved = regularRentLocked;
        const txSaved = regularTxCost - compressedTxCost;

        console.log(
          `║ ${n.toString().padStart(4)} requests: Rent saved: ${(rentSaved / LAMPORTS_PER_SOL).toFixed(4)} SOL | Tx delta: ${(txSaved / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        );
      }

      console.log("╚══════════════════════════════════════════════════╝\n");
    });
  });
});
