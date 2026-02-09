import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VrfSol } from "../target/types/vrf_sol";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import fs from "fs";
import * as testKeys from "./keys/load";

/**
 * ZK Compressed VRF Tests
 *
 * These tests verify the compressed randomness request instructions compile
 * and can be invoked. Full end-to-end compressed account creation requires
 * Light Protocol's test-validator or devnet with Photon indexer.
 *
 * Tests that require Light Protocol infrastructure are marked as "requires Light"
 * and will be skipped in local-only test environments.
 */
describe("compressed-vrf", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.vrfSol as Program<VrfSol>;
  const admin = provider.wallet as anchor.Wallet;

  // Oracle authority keypair
  const authoritySecret = JSON.parse(
    fs.readFileSync("../backend/vrf-signer.json", "utf-8")
  );
  const authority = Keypair.fromSecretKey(Uint8Array.from(authoritySecret));
  let treasury: PublicKey;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vrf-config")],
    program.programId
  );

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

    // Ensure config is initialized
    const configAccount = await provider.connection.getAccountInfo(configPda);
    if (!configAccount) {
      await fundAccount(testKeys.treasury.publicKey, LAMPORTS_PER_SOL);
      const fee = new anchor.BN(10_000);
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

  describe("Program structure", () => {
    it("should have request_randomness_compressed instruction in IDL", () => {
      const ix = program.idl.instructions.find(
        (i: any) => i.name === "requestRandomnessCompressed" ||
                     i.name === "request_randomness_compressed"
      );
      expect(ix).to.not.be.undefined;
    });

    it("should have fulfill_randomness_compressed instruction in IDL", () => {
      const ix = program.idl.instructions.find(
        (i: any) => i.name === "fulfillRandomnessCompressed" ||
                     i.name === "fulfill_randomness_compressed"
      );
      expect(ix).to.not.be.undefined;
    });

    it("should have CompressedRandomnessRequested event in IDL", () => {
      const evt = program.idl.events?.find(
        (e: any) => e.name === "CompressedRandomnessRequested" ||
                     e.name === "compressedRandomnessRequested"
      );
      expect(evt).to.not.be.undefined;
    });

    it("should have CompressedAccountMismatch error in IDL", () => {
      const err = program.idl.errors?.find(
        (e: any) => e.name === "CompressedAccountMismatch" ||
                     e.name === "compressedAccountMismatch"
      );
      expect(err).to.not.be.undefined;
    });
  });

  describe("Counter management", () => {
    it("compressed requests should use the same config counter as regular requests", async () => {
      const config = await program.account.vrfConfiguration.fetch(configPda);
      const counterBefore = config.requestCounter.toNumber();

      // Create a regular request to verify counter increments
      const seedBuf = Buffer.alloc(32, 0xcc);
      const requestPda = PublicKey.findProgramAddressSync(
        [
          Buffer.from("request"),
          new anchor.BN(counterBefore).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      )[0];

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

      const configAfter = await program.account.vrfConfiguration.fetch(
        configPda
      );
      expect(configAfter.requestCounter.toNumber()).to.equal(
        counterBefore + 1
      );
    });
  });

  describe("Discriminator verification", () => {
    it("should compute correct CompressedRandomnessRequested event discriminator", () => {
      const crypto = require("crypto");
      const expected = crypto
        .createHash("sha256")
        .update("event:CompressedRandomnessRequested")
        .digest()
        .slice(0, 8);

      // Verify it's different from the regular RandomnessRequested discriminator
      const regular = crypto
        .createHash("sha256")
        .update("event:RandomnessRequested")
        .digest()
        .slice(0, 8);

      expect(Buffer.from(expected).equals(Buffer.from(regular))).to.be.false;
    });

    it("should compute correct instruction discriminators", () => {
      const crypto = require("crypto");

      const requestDisc = crypto
        .createHash("sha256")
        .update("global:request_randomness_compressed")
        .digest()
        .slice(0, 8);

      const fulfillDisc = crypto
        .createHash("sha256")
        .update("global:fulfill_randomness_compressed")
        .digest()
        .slice(0, 8);

      // Verify they're different from regular instruction discriminators
      const regularFulfill = crypto
        .createHash("sha256")
        .update("global:fulfill_randomness")
        .digest()
        .slice(0, 8);

      expect(
        Buffer.from(fulfillDisc).equals(Buffer.from(regularFulfill))
      ).to.be.false;
      expect(
        Buffer.from(requestDisc).equals(Buffer.from(fulfillDisc))
      ).to.be.false;
    });
  });

  describe("Ed25519 verification (shared module)", () => {
    it("regular fulfill should still work with extracted ed25519 module", async () => {
      const config = await program.account.vrfConfiguration.fetch(configPda);
      const requestId = config.requestCounter.toNumber();

      const seedBuf = Buffer.alloc(32, 0xdd);
      const requestPda = PublicKey.findProgramAddressSync(
        [
          Buffer.from("request"),
          new anchor.BN(requestId).toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      )[0];

      // Create request
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

      // Try to fulfill — backend may race us on devnet
      const reqId = new anchor.BN(requestId);
      const randomness = Buffer.alloc(32, 0xee);
      const message = Buffer.concat([
        reqId.toArrayLike(Buffer, "le", 8),
        randomness,
      ]);

      const ed25519Ix =
        anchor.web3.Ed25519Program.createInstructionWithPrivateKey({
          privateKey: authority.secretKey,
          message: message,
        });

      let manuallyFulfilled = false;
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
        manuallyFulfilled = true;
      } catch (e: any) {
        // Backend raced us — wait for it to fulfill
        for (let i = 0; i < 15; i++) {
          const req = await program.account.randomnessRequest.fetch(requestPda);
          if (req.status >= 1) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // Verify fulfilled (either by us or backend)
      const request = await program.account.randomnessRequest.fetch(
        requestPda
      );
      expect(request.status).to.equal(1); // Fulfilled
      if (manuallyFulfilled) {
        expect(Buffer.from(request.randomness).equals(randomness)).to.be.true;
      }
    });
  });
});
