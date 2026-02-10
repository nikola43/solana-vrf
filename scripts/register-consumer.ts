/**
 * Register Consumer Contract — Interactive VRF subscription setup script.
 *
 * Uses Anchor's IDL-based client directly (same as the test suite).
 *
 * Walks you through:
 *   1. Select network
 *   2. Load VRF signer / admin keypair
 *   3. Enter consumer program address
 *   4. Create or reuse a subscription
 *   5. Fund the subscription
 *   6. Register the consumer program
 *
 * Usage:
 *   npx ts-node register-consumer.ts
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

// ── PDA helpers (same as tests) ──────────────────────────────────────────────

function getConfigPda(programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("coordinator-config")],
        programId
    );
    return pda;
}

function getSubscriptionPda(subId: anchor.BN, programId: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("subscription"), subId.toArrayLike(Buffer, "le", 8)],
        programId
    );
    return pda;
}

function getConsumerPda(
    subId: anchor.BN,
    consumerProgram: PublicKey,
    programId: PublicKey
): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("consumer"),
            subId.toArrayLike(Buffer, "le", 8),
            consumerProgram.toBuffer(),
        ],
        programId
    );
    return pda;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadKeypair(keypairPath: string): Keypair {
    if (!fs.existsSync(keypairPath)) {
        throw new Error(`Keypair file not found: ${keypairPath}`);
    }
    const secretKey = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function lamportsToSol(lamports: anchor.BN): string {
    return (lamports.toNumber() / LAMPORTS_PER_SOL).toFixed(4);
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

function warn(text: string): void {
    console.log(chalk.yellow(`  ${text}`));
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

function isValidPublicKey(input: string): boolean | string {
    try {
        new PublicKey(input);
        return true;
    } catch {
        return "Please enter a valid Solana public key (base58)";
    }
}

function resolvePath(p: string): string {
    return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function validateKeypairPath(input: string): boolean | string {
    return fs.existsSync(resolvePath(input))
        ? true
        : `File not found: ${resolvePath(input)}`;
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
        `\n${chalk.bold.magenta("Moirae VRF")} ${chalk.dim("— Register Consumer Contract")}\n`
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

    // ── Step 2: VRF Signer / Admin ───────────────────────────────────────────

    header("Step 2: VRF Signer / Admin");

    const defaultSignerPath = path.resolve(
        __dirname,
        "..",
        "backend",
        "vrf-signer.json"
    );
    const defaultKeypairPath = path.join(
        os.homedir(),
        ".config",
        "solana",
        "id.json"
    );

    const { signerPath } = await inquirer.prompt<{ signerPath: string }>([
        {
            type: "input",
            name: "signerPath",
            message: "Path to VRF signer / admin keypair JSON:",
            default: fs.existsSync(defaultSignerPath)
                ? defaultSignerPath
                : defaultKeypairPath,
            validate: validateKeypairPath,
        },
    ]);

    const owner = loadKeypair(resolvePath(signerPath));
    const connection = new Connection(rpcUrl, "confirmed");
    const balance = await connection.getBalance(owner.publicKey);

    info("Wallet", owner.publicKey.toBase58());
    info("Balance", `${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    if (balance === 0) {
        console.log(
            chalk.red("\n  Wallet has no SOL. Fund it before continuing.\n")
        );
        process.exit(1);
    }

    // ── Step 3: Consumer Program Address ─────────────────────────────────────

    header("Step 3: Consumer Program Address");

    const { consumerProgramIdStr } = await inquirer.prompt<{
        consumerProgramIdStr: string;
    }>([
        {
            type: "input",
            name: "consumerProgramIdStr",
            message: "Consumer program address to register:",
            validate: isValidPublicKey,
        },
    ]);

    const consumerProgramId = new PublicKey(consumerProgramIdStr);
    info("Consumer Program", consumerProgramId.toBase58());

    // ── Load Anchor program ──────────────────────────────────────────────────

    const wallet = new anchor.Wallet(owner);
    const program = loadProgram(connection, wallet);
    const configPda = getConfigPda(program.programId);

    // ── Step 4: Coordinator check ────────────────────────────────────────────

    header("Step 4: Coordinator Check");

    let config: any;
    try {
        config = await program.account.coordinatorConfig.fetch(configPda);
    } catch {
        console.log(
            chalk.red(
                "  Coordinator config not found. Is the VRF program initialized on this cluster?\n"
            )
        );
        process.exit(1);
    }

    success("Coordinator config found");
    info("Admin", config.admin.toBase58());
    info("Authority", config.authority.toBase58());
    info("Fee per word", `${lamportsToSol(config.feePerWord)} SOL`);
    info("Max words", config.maxNumWords.toString());
    info("Subscriptions", config.subscriptionCounter.toString());
    info("Requests", config.requestCounter.toString());

    // ── Step 5: Subscription ─────────────────────────────────────────────────

    header("Step 5: Subscription");

    const { subscriptionAction } = await inquirer.prompt<{
        subscriptionAction: string;
    }>([
        {
            type: "list",
            name: "subscriptionAction",
            message: "Subscription setup:",
            choices: [
                { name: "Create a new subscription", value: "create" },
                { name: "Use an existing subscription", value: "existing" },
            ],
        },
    ]);

    let subscriptionId: anchor.BN;
    let subscriptionPda: PublicKey;

    if (subscriptionAction === "existing") {
        const { subIdStr } = await inquirer.prompt<{ subIdStr: string }>([
            {
                type: "input",
                name: "subIdStr",
                message: "Subscription ID:",
                validate: (input: string) =>
                    /^\d+$/.test(input) ? true : "Please enter a numeric ID",
            },
        ]);

        subscriptionId = new anchor.BN(subIdStr);
        subscriptionPda = getSubscriptionPda(subscriptionId, program.programId);

        try {
            const sub = await program.account.subscription.fetch(subscriptionPda);
            if (!sub.owner.equals(owner.publicKey)) {
                console.log(
                    chalk.red(
                        `\n  Subscription ${subscriptionId.toString()} is owned by ${sub.owner.toBase58()}, not your wallet.\n`
                    )
                );
                process.exit(1);
            }
            success(`Subscription ${subscriptionId.toString()} found`);
            info("Owner", sub.owner.toBase58());
            info("Balance", `${lamportsToSol(sub.balance)} SOL`);
            info("Consumers", sub.consumerCount.toString());
            info("Requests", sub.reqCount.toString());
        } catch {
            console.log(
                chalk.red(
                    `\n  Subscription ${subscriptionId.toString()} not found on-chain.\n`
                )
            );
            process.exit(1);
        }
    } else {
        subscriptionId = config.subscriptionCounter;
        subscriptionPda = getSubscriptionPda(subscriptionId, program.programId);

        console.log(chalk.dim("\n  Creating subscription..."));

        const sig = await program.methods
            .createSubscription()
            .accountsPartial({
                owner: owner.publicKey,
                config: configPda,
                subscription: subscriptionPda,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        success(`Subscription created! ID: ${subscriptionId.toString()}`);
        info("Subscription PDA", subscriptionPda.toBase58());
        txLink(sig, rpcUrl);
    }

    // ── Step 6: Fund subscription ────────────────────────────────────────────

    header("Step 6: Fund Subscription");

    const { shouldFund } = await inquirer.prompt<{ shouldFund: boolean }>([
        {
            type: "confirm",
            name: "shouldFund",
            message: "Fund the subscription?",
            default: true,
        },
    ]);

    if (shouldFund) {
        const { fundAmount } = await inquirer.prompt<{ fundAmount: string }>([
            {
                type: "input",
                name: "fundAmount",
                message: "Amount to fund (SOL):",
                default: "0.1",
                validate: (input: string) => {
                    const num = parseFloat(input);
                    if (isNaN(num) || num <= 0)
                        return "Please enter a positive number";
                    if (num > balance / LAMPORTS_PER_SOL)
                        return `Insufficient balance (${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL available)`;
                    return true;
                },
            },
        ]);

        const fundAmountLamports = new anchor.BN(
            Math.round(parseFloat(fundAmount) * LAMPORTS_PER_SOL)
        );

        console.log(
            chalk.dim(`\n  Funding subscription with ${fundAmount} SOL...`)
        );

        const sig = await program.methods
            .fundSubscription(subscriptionId, fundAmountLamports)
            .accountsPartial({
                funder: owner.publicKey,
                subscription: subscriptionPda,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        const sub = await program.account.subscription.fetch(subscriptionPda);
        success("Subscription funded!");
        info("New balance", `${lamportsToSol(sub.balance)} SOL`);
        txLink(sig, rpcUrl);
    } else {
        warn("Skipping funding.");
    }

    // ── Step 7: Register consumer ────────────────────────────────────────────

    header("Step 7: Register Consumer");

    const consumerPda = getConsumerPda(
        subscriptionId,
        consumerProgramId,
        program.programId
    );

    const existingRegistration = await connection.getAccountInfo(consumerPda);
    if (existingRegistration) {
        warn(
            `Consumer is already registered on subscription ${subscriptionId.toString()}`
        );
        info("Consumer PDA", consumerPda.toBase58());
    } else {
        const { confirmRegister } = await inquirer.prompt<{
            confirmRegister: boolean;
        }>([
            {
                type: "confirm",
                name: "confirmRegister",
                message: `Register ${chalk.cyan(consumerProgramId.toBase58())} on subscription ${chalk.cyan(subscriptionId.toString())}?`,
                default: true,
            },
        ]);

        if (!confirmRegister) {
            warn("Registration cancelled.");
            process.exit(0);
        }

        console.log(chalk.dim("\n  Registering consumer..."));

        const sig = await program.methods
            .addConsumer(subscriptionId)
            .accountsPartial({
                owner: owner.publicKey,
                subscription: subscriptionPda,
                consumerProgram: consumerProgramId,
                consumerRegistration: consumerPda,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        success("Consumer registered!");
        info("Consumer PDA", consumerPda.toBase58());
        txLink(sig, rpcUrl);
    }

    // ── Summary ──────────────────────────────────────────────────────────────

    separator();
    header("Registration Complete");

    // Wait for RPC to catch up before final reads
    await sleep(2000);

    const finalSub = await program.account.subscription.fetch(subscriptionPda);

    console.log(chalk.bold("  Subscription"));
    info("ID", finalSub.id.toString());
    info("PDA", subscriptionPda.toBase58());
    info("Owner", finalSub.owner.toBase58());
    info("Balance", `${lamportsToSol(finalSub.balance)} SOL`);
    info("Consumers", finalSub.consumerCount.toString());
    info("Requests", finalSub.reqCount.toString());

    const reg = await program.account.consumerRegistration.fetch(consumerPda);

    console.log();
    console.log(chalk.bold("  Consumer Registration"));
    info("Subscription ID", reg.subscriptionId.toString());
    info("Program ID", reg.programId.toBase58());
    info("Nonce", reg.nonce.toString());
    info("PDA", consumerPda.toBase58());

    separator();
    console.log(
        `\n  ${chalk.green("Your consumer can now request VRF randomness using subscription")} ${chalk.bold.green(subscriptionId.toString())}.\n`
    );
}

main().catch((err) => {
    console.error(chalk.red(`\n  Error: ${err.message || err}\n`));
    process.exit(1);
});
