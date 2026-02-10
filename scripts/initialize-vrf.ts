/**
 * Initialize VRF Program — Interactive coordinator setup script.
 *
 * Uses Anchor's IDL-based client directly (same as the test suite).
 *
 * Creates the singleton CoordinatorConfig PDA with:
 *   - Admin key (the initializer)
 *   - Authority key (oracle signer for VRF fulfillments)
 *   - Fee per word (lamports charged per random word)
 *   - Max num words (upper limit per request)
 *
 * Usage:
 *   npx ts-node initialize-vrf.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import type { VrfSol } from "../program/target/types/vrf_sol";
import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import chalk from "chalk";
import inquirer from "inquirer";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── IDL & Program setup ─────────────────────────────────────────────────────

const IDL_PATH = path.resolve(__dirname, "..", "program", "target", "idl", "vrf_sol.json");

function loadProgram(connection: Connection, wallet: anchor.Wallet): Program<VrfSol> {
    const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: "confirmed",
    });
    return new Program<VrfSol>(idl, provider);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getConfigPda(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("coordinator-config")],
        programId
    );
    return pda;
}

function loadKeypair(keypairPath: string): Keypair {
    if (!fs.existsSync(keypairPath)) {
        throw new Error(`Keypair file not found: ${keypairPath}`);
    }
    const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function lamportsToSol(lamports: number | anchor.BN): string {
    const n = typeof lamports === "number" ? lamports : lamports.toNumber();
    return (n / LAMPORTS_PER_SOL).toFixed(4);
}

function separator(): void {
    console.log(chalk.gray("─".repeat(60)));
}

function header(text: string): void {
    console.log(`\n${chalk.bold.cyan(text)}\n`);
}

function info(label: string, value: string): void {
    console.log(`  ${chalk.gray(label.padEnd(20))} ${chalk.white(value)}`);
}

function success(text: string): void {
    console.log(chalk.green(`  ${text}`));
}

function txLink(sig: string, rpcUrl: string): void {
    const cluster = rpcUrl.includes("devnet")
        ? "?cluster=devnet"
        : rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")
          ? "?cluster=custom&customUrl=" + encodeURIComponent(rpcUrl)
          : "";
    console.log(
        `  ${chalk.dim("Tx:")} ${chalk.underline(`https://solscan.io/tx/${sig}${cluster}`)}`
    );
}

function resolvePath(p: string): string {
    return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function validateKeypairPath(input: string): boolean | string {
    return fs.existsSync(resolvePath(input))
        ? true
        : `File not found: ${resolvePath(input)}`;
}

function isValidPublicKey(input: string): boolean | string {
    try {
        new PublicKey(input);
        return true;
    } catch {
        return "Please enter a valid Solana public key (base58)";
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KNOWN_RPCS: Record<string, string> = {
    Devnet: "https://api.devnet.solana.com",
    "Mainnet-Beta": "https://api.mainnet-beta.solana.com",
    Localhost: "http://localhost:8899",
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(
        `\n${chalk.bold.magenta("Moirae VRF")} ${chalk.dim("— Initialize Coordinator")}\n`
    );
    separator();

    // ── Step 1: Network ──────────────────────────────────────────────────────

    header("Step 1: Network Configuration");

    const { network } = await inquirer.prompt<{ network: string }>([
        {
            type: "list",
            name: "network",
            message: "Select Solana network:",
            choices: [
                ...Object.entries(KNOWN_RPCS).map(([name, url]) => ({
                    name: `${name} ${chalk.dim(`(${url})`)}`,
                    value: url,
                })),
                new inquirer.Separator(),
                { name: "Custom RPC URL", value: "__custom__" },
            ],
            default: KNOWN_RPCS["Devnet"],
        },
    ]);

    let rpcUrl = network;
    if (network === "__custom__") {
        const { customRpc } = await inquirer.prompt<{ customRpc: string }>([
            {
                type: "input",
                name: "customRpc",
                message: "Enter custom RPC URL:",
                validate: (input: string) =>
                    input.startsWith("http://") || input.startsWith("https://")
                        ? true
                        : "URL must start with http:// or https://",
            },
        ]);
        rpcUrl = customRpc;
    }

    info("RPC URL", rpcUrl);

    // ── Step 2: Admin keypair ────────────────────────────────────────────────

    header("Step 2: Admin Keypair");

    const defaultKeypairPath = path.join(
        os.homedir(),
        ".config",
        "solana",
        "id.json"
    );

    const { adminPath } = await inquirer.prompt<{ adminPath: string }>([
        {
            type: "input",
            name: "adminPath",
            message: "Path to admin keypair JSON:",
            default: defaultKeypairPath,
            validate: validateKeypairPath,
        },
    ]);

    const admin = loadKeypair(resolvePath(adminPath));
    const connection = new Connection(rpcUrl, "confirmed");
    const balance = await connection.getBalance(admin.publicKey);

    info("Admin", admin.publicKey.toBase58());
    info("Balance", `${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    if (balance === 0) {
        console.log(
            chalk.red("\n  Admin wallet has no SOL. Fund it before continuing.\n")
        );
        process.exit(1);
    }

    // ── Step 3: VRF Authority ────────────────────────────────────────────────

    header("Step 3: VRF Authority (Oracle Signer)");

    const defaultSignerPath = path.resolve(
        __dirname,
        "..",
        "backend",
        "vrf-signer.json"
    );

    const { authoritySource } = await inquirer.prompt<{
        authoritySource: string;
    }>([
        {
            type: "list",
            name: "authoritySource",
            message: "How to provide the oracle authority?",
            choices: [
                {
                    name: "Load from keypair file (will extract public key)",
                    value: "file",
                },
                {
                    name: "Enter public key directly",
                    value: "pubkey",
                },
            ],
        },
    ]);

    let authorityPubkey: PublicKey;

    if (authoritySource === "file") {
        const { authorityPath } = await inquirer.prompt<{
            authorityPath: string;
        }>([
            {
                type: "input",
                name: "authorityPath",
                message: "Path to VRF authority keypair JSON:",
                default: fs.existsSync(defaultSignerPath)
                    ? defaultSignerPath
                    : undefined,
                validate: validateKeypairPath,
            },
        ]);

        const authorityKeypair = loadKeypair(resolvePath(authorityPath));
        authorityPubkey = authorityKeypair.publicKey;
    } else {
        const { authorityPubkeyStr } = await inquirer.prompt<{
            authorityPubkeyStr: string;
        }>([
            {
                type: "input",
                name: "authorityPubkeyStr",
                message: "Oracle authority public key:",
                validate: isValidPublicKey,
            },
        ]);
        authorityPubkey = new PublicKey(authorityPubkeyStr);
    }

    info("Authority", authorityPubkey.toBase58());

    // ── Step 4: VRF Parameters ───────────────────────────────────────────────

    header("Step 4: VRF Parameters");

    const { feePerWordStr } = await inquirer.prompt<{
        feePerWordStr: string;
    }>([
        {
            type: "input",
            name: "feePerWordStr",
            message: "Fee per random word (lamports):",
            default: "10000",
            validate: (input: string) =>
                /^\d+$/.test(input) && parseInt(input, 10) >= 0
                    ? true
                    : "Must be a non-negative integer",
        },
    ]);

    const feePerWord = new anchor.BN(feePerWordStr);

    const { maxNumWordsStr } = await inquirer.prompt<{
        maxNumWordsStr: string;
    }>([
        {
            type: "input",
            name: "maxNumWordsStr",
            message: "Max random words per request:",
            default: "10",
            validate: (input: string) =>
                /^\d+$/.test(input) && parseInt(input, 10) > 0
                    ? true
                    : "Must be a positive integer",
        },
    ]);

    const maxNumWords = parseInt(maxNumWordsStr, 10);

    info("Fee per word", `${feePerWordStr} lamports (${lamportsToSol(feePerWord)} SOL)`);
    info("Max words", maxNumWordsStr);

    // ── Check existing config ────────────────────────────────────────────────

    const wallet = new anchor.Wallet(admin);
    const program = loadProgram(connection, wallet);
    const configPda = getConfigPda(program.programId);

    header("Step 5: Pre-flight Check");

    info("Program ID", program.programId.toBase58());
    info("Config PDA", configPda.toBase58());

    const existingConfig = await connection.getAccountInfo(configPda);
    if (existingConfig) {
        const config = await program.account.coordinatorConfig.fetch(configPda);
        console.log(
            chalk.yellow("\n  Coordinator is already initialized:\n")
        );
        info("Admin", config.admin.toBase58());
        info("Authority", config.authority.toBase58());
        info("Fee per word", `${config.feePerWord.toString()} lamports`);
        info("Max words", config.maxNumWords.toString());
        info("Subscriptions", config.subscriptionCounter.toString());
        info("Requests", config.requestCounter.toString());

        console.log(
            chalk.yellow(
                "\n  Cannot re-initialize. Use update_config to change parameters.\n"
            )
        );
        process.exit(0);
    }

    success("Config PDA does not exist yet — ready to initialize");

    // ── Confirm & initialize ─────────────────────────────────────────────────

    header("Step 6: Initialize");

    separator();
    console.log(chalk.bold("  Review configuration:\n"));
    info("Admin", admin.publicKey.toBase58());
    info("Authority", authorityPubkey.toBase58());
    info("Fee per word", `${feePerWordStr} lamports`);
    info("Max words", maxNumWordsStr);
    info("Config PDA", configPda.toBase58());
    console.log();
    separator();

    const { confirmInit } = await inquirer.prompt<{ confirmInit: boolean }>([
        {
            type: "confirm",
            name: "confirmInit",
            message: "Initialize the VRF coordinator with these parameters?",
            default: true,
        },
    ]);

    if (!confirmInit) {
        console.log(chalk.yellow("\n  Initialization cancelled.\n"));
        process.exit(0);
    }

    console.log(chalk.dim("\n  Initializing coordinator..."));

    const sig = await program.methods
        .initialize(feePerWord, maxNumWords)
        .accountsPartial({
            admin: admin.publicKey,
            authority: authorityPubkey,
            config: configPda,
            systemProgram: SystemProgram.programId,
        })
        .rpc();

    success("Coordinator initialized!");
    txLink(sig, rpcUrl);

    // ── Verification ─────────────────────────────────────────────────────────

    separator();
    header("Initialization Complete");

    await sleep(2000);

    const config = await program.account.coordinatorConfig.fetch(configPda);

    info("Admin", config.admin.toBase58());
    info("Authority", config.authority.toBase58());
    info("Fee per word", `${config.feePerWord.toString()} lamports (${lamportsToSol(config.feePerWord)} SOL)`);
    info("Max words", config.maxNumWords.toString());
    info("Subscriptions", config.subscriptionCounter.toString());
    info("Requests", config.requestCounter.toString());
    info("Config PDA", configPda.toBase58());

    separator();
    console.log(
        `\n  ${chalk.green("VRF coordinator is ready. Next step: register consumers with")} ${chalk.bold.green("register-consumer.ts")}.\n`
    );
}

main().catch((err) => {
    console.error(chalk.red(`\n  Error: ${err.message || err}\n`));
    process.exit(1);
});
