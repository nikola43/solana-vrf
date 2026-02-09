import { Keypair } from "@solana/web3.js";
import fs from "fs";

const KEYS_DIR = "tests/keys";

function loadKeypair(name: string): Keypair {
  const secret = JSON.parse(
    fs.readFileSync(`${KEYS_DIR}/${name}.json`, "utf-8")
  );
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/** Fixed treasury keypair (shared across all tests). */
export const treasury = loadKeypair("treasury");

/** Fixed wrong-player keypair (for negative tests). */
export const wrongPlayer = loadKeypair("wrong-player");

/** Fixed wrong-authority keypair (for negative tests). */
export const wrongAuthority = loadKeypair("wrong-authority");

/** Fixed new-authority keypair (for updateConfig tests). */
export const newAuthority = loadKeypair("new-authority");

/** Fixed new-treasury keypair (for updateConfig tests). */
export const newTreasury = loadKeypair("new-treasury");

/** Fixed non-admin keypair (for admin-only negative tests). */
export const nonAdmin = loadKeypair("non-admin");
