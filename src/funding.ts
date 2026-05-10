import fs from "fs";
import path from "path";
import {
  type AccountInfo,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";
import {
  lamportsToSol,
  planEvenDistribution,
  planSweepTransfers,
  solToLamports,
} from "./fundingMath";

const ROOT = path.resolve(__dirname, "..");
const FUNDING_WALLET_PATH = path.join(ROOT, "funding-wallet.json");
const WALLETS_PATH = path.join(ROOT, "wallets.json");
const DEFAULT_FEE_LAMPORTS = 5_000;

interface StoredWallet {
  publicKey: string;
  privateKey: string;
  enabled?: boolean;
}

export interface FundingTransferResult {
  walletIndex: number;
  publicKey: string;
  lamports: number;
  sol: number;
  signature?: string;
}

export interface FundingRunResult {
  dryRun: boolean;
  sourcePublicKey: string;
  transfers: FundingTransferResult[];
  totalSol: number;
  estimatedFeeSol: number;
}

function numEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number`);
  return parsed;
}

function readStoredWallets(): StoredWallet[] {
  if (!fs.existsSync(WALLETS_PATH)) return [];
  const wallets = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
  if (!Array.isArray(wallets)) throw new Error("wallets.json must contain an array");
  return wallets.filter((wallet) => wallet?.publicKey && wallet?.privateKey);
}

function walletFromPrivateKey(privateKey: string, index: number): Keypair {
  try {
    return Keypair.fromSecretKey(bs58.decode(privateKey));
  } catch {
    throw new Error(`Invalid private key at wallet index ${index}`);
  }
}

function managedWallets(): Keypair[] {
  if (config.privateKeys.length > 0) {
    return config.privateKeys.map(walletFromPrivateKey);
  }

  const stored = readStoredWallets();
  if (stored.length === 0) {
    throw new Error("No managed wallets found. Generate wallets before funding.");
  }

  const enabled = stored.filter((wallet) => wallet.enabled !== false);
  if (enabled.length === 0) {
    throw new Error("No enabled wallets found. Enable wallets before funding.");
  }

  return enabled.map((wallet, index) => walletFromPrivateKey(wallet.privateKey, index));
}

export function assertPlainSolSourceAccount(
  publicKey: PublicKey,
  accountInfo: AccountInfo<Buffer> | null,
  label: string
) {
  if (!accountInfo) return;

  if (!accountInfo.owner.equals(SystemProgram.programId)) {
    throw new Error(
      `${label} ${publicKey.toString()} is owned by ${accountInfo.owner.toString()}, ` +
      "not the system program. Use a normal SOL wallet as the transfer source."
    );
  }

  if (accountInfo.data.length > 0) {
    throw new Error(
      `${label} ${publicKey.toString()} carries ${accountInfo.data.length} bytes of account data. ` +
      "Normal SOL transfers require the source to be a plain wallet account with no data. " +
      "Create or select a normal funding wallet and fund that address instead."
    );
  }
}

async function assertPlainSolSource(
  connection: Connection,
  publicKey: PublicKey,
  label: string
) {
  assertPlainSolSourceAccount(publicKey, await connection.getAccountInfo(publicKey), label);
}

export function resolveFundingWallet(): Keypair {
  const envPrivateKey = process.env.FUNDING_WALLET_PRIVATE_KEY?.trim();
  if (envPrivateKey) return walletFromPrivateKey(envPrivateKey, 0);

  if (fs.existsSync(FUNDING_WALLET_PATH)) {
    const stored: StoredWallet = JSON.parse(fs.readFileSync(FUNDING_WALLET_PATH, "utf8"));
    return walletFromPrivateKey(stored.privateKey, 0);
  }

  const wallet = Keypair.generate();
  const stored: StoredWallet = {
    publicKey: wallet.publicKey.toString(),
    privateKey: bs58.encode(wallet.secretKey),
  };
  fs.writeFileSync(FUNDING_WALLET_PATH, `${JSON.stringify(stored, null, 2)}\n`, {
    mode: 0o600,
  });
  return wallet;
}

export async function getFundingStatus() {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const source = resolveFundingWallet();
  const stored = readStoredWallets();
  const enabled = stored.filter((wallet) => wallet.enabled !== false);
  const balanceLamports = await connection.getBalance(source.publicKey);
  return {
    publicKey: source.publicKey.toString(),
    balanceSol: lamportsToSol(balanceLamports),
    managedWalletCount: enabled.length,
    totalWalletCount: stored.length,
    sourceReserveSol: numEnv("FUNDING_SOURCE_RESERVE_SOL", 0.01),
    sweepWalletReserveSol: numEnv("SWEEP_WALLET_RESERVE_SOL", config.minSolReserve),
  };
}

async function sendSol(
  connection: Connection,
  from: Keypair,
  to: PublicKey,
  lamports: number
): Promise<string> {
  await assertPlainSolSource(connection, from.publicKey, "Transfer source");
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports,
    })
  );
  return sendAndConfirmTransaction(connection, transaction, [from], {
    commitment: "confirmed",
  });
}

export interface TopUpResult {
  toppedUp: boolean;
  dryRun: boolean;
  wallet: string;
  sourcePublicKey: string;
  currentSol: number;
  targetSol: number;
  transferSol: number;
  signature?: string;
}

export interface FundingSpendableStatus {
  sourcePublicKey: string;
  balanceSol: number;
  reserveSol: number;
  spendableSol: number;
}

export async function getFundingSpendableStatus(
  connection: Connection
): Promise<FundingSpendableStatus> {
  const source = resolveFundingWallet();
  await assertPlainSolSource(connection, source.publicKey, "Funding wallet");
  const reserveSol = numEnv("FUNDING_SOURCE_RESERVE_SOL", 0.01);
  const sourceBalanceLamports = await connection.getBalance(source.publicKey);
  const sourceSpendableLamports =
    sourceBalanceLamports - solToLamports(reserveSol) - DEFAULT_FEE_LAMPORTS;

  return {
    sourcePublicKey: source.publicKey.toString(),
    balanceSol: lamportsToSol(sourceBalanceLamports),
    reserveSol,
    spendableSol: lamportsToSol(Math.max(0, sourceSpendableLamports)),
  };
}

export async function ensureWalletTopUp(
  connection: Connection,
  wallet: PublicKey,
  currentSol: number,
  dryRun = false,
  targetSolOverride?: number
): Promise<TopUpResult> {
  const source = resolveFundingWallet();
  await assertPlainSolSource(connection, source.publicKey, "Funding wallet");
  const targetSol = targetSolOverride ?? config.autoTopUpTargetSol;
  const transferSol = Math.max(0, targetSol - currentSol);
  const transferLamports = solToLamports(transferSol);
  const sourceReserveLamports = solToLamports(numEnv("FUNDING_SOURCE_RESERVE_SOL", 0.01));
  const sourceBalanceLamports = await connection.getBalance(source.publicKey);
  const sourceSpendableLamports =
    sourceBalanceLamports - sourceReserveLamports - DEFAULT_FEE_LAMPORTS;

  if (transferLamports <= 0) {
    return {
      toppedUp: false,
      dryRun,
      wallet: wallet.toString(),
      sourcePublicKey: source.publicKey.toString(),
      currentSol,
      targetSol,
      transferSol: 0,
    };
  }

  if (sourceSpendableLamports < transferLamports) {
    throw new Error(
      `Funding wallet needs ${transferSol.toFixed(6)} SOL for top-up, ` +
      `but only ${lamportsToSol(Math.max(0, sourceSpendableLamports)).toFixed(6)} SOL is spendable`
    );
  }

  const signature = dryRun
    ? undefined
    : await sendSol(connection, source, wallet, transferLamports);

  return {
    toppedUp: true,
    dryRun,
    wallet: wallet.toString(),
    sourcePublicKey: source.publicKey.toString(),
    currentSol,
    targetSol,
    transferSol,
    signature,
  };
}

export interface SweepBackResult {
  swept: boolean;
  dryRun: boolean;
  wallet: string;
  sourcePublicKey: string;
  balanceSol: number;
  reserveSol: number;
  sweepSol: number;
  signature?: string;
}

export async function sweepWalletBackToFunding(
  connection: Connection,
  wallet: Keypair,
  dryRun = false
): Promise<SweepBackResult> {
  const source = resolveFundingWallet();
  await assertPlainSolSource(connection, wallet.publicKey, "Sweep wallet");
  const balanceLamports = await connection.getBalance(wallet.publicKey);
  const reserveLamports = solToLamports(config.autoSweepReserveSol);
  const sweepLamports = Math.floor(balanceLamports - reserveLamports - DEFAULT_FEE_LAMPORTS);

  if (sweepLamports <= 0) {
    return {
      swept: false,
      dryRun,
      wallet: wallet.publicKey.toString(),
      sourcePublicKey: source.publicKey.toString(),
      balanceSol: lamportsToSol(balanceLamports),
      reserveSol: config.autoSweepReserveSol,
      sweepSol: 0,
    };
  }

  const signature = dryRun
    ? undefined
    : await sendSol(connection, wallet, source.publicKey, sweepLamports);

  return {
    swept: true,
    dryRun,
    wallet: wallet.publicKey.toString(),
    sourcePublicKey: source.publicKey.toString(),
    balanceSol: lamportsToSol(balanceLamports),
    reserveSol: config.autoSweepReserveSol,
    sweepSol: lamportsToSol(sweepLamports),
    signature,
  };
}

export async function distributeFunding(dryRun = false): Promise<FundingRunResult> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const source = resolveFundingWallet();
  const wallets = managedWallets();
  const sourceBalanceLamports = await connection.getBalance(source.publicKey);
  const sourceReserveLamports = solToLamports(numEnv("FUNDING_SOURCE_RESERVE_SOL", 0.01));
  const plan = planEvenDistribution({
    sourceBalanceLamports,
    recipientCount: wallets.length,
    sourceReserveLamports,
    feeLamportsPerTransfer: DEFAULT_FEE_LAMPORTS,
  });

  const transfers: FundingTransferResult[] = [];
  for (const [walletIndex, wallet] of wallets.entries()) {
    const signature = dryRun
      ? undefined
      : await sendSol(connection, source, wallet.publicKey, plan.transferLamportsEach);
    transfers.push({
      walletIndex,
      publicKey: wallet.publicKey.toString(),
      lamports: plan.transferLamportsEach,
      sol: lamportsToSol(plan.transferLamportsEach),
      signature,
    });
  }

  return {
    dryRun,
    sourcePublicKey: source.publicKey.toString(),
    transfers,
    totalSol: lamportsToSol(plan.totalTransferLamports),
    estimatedFeeSol: lamportsToSol(plan.estimatedFeeLamports),
  };
}

export async function sweepFunding(dryRun = false): Promise<FundingRunResult> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const source = resolveFundingWallet();
  const wallets = managedWallets();
  const balances = await Promise.all(
    wallets.map((wallet) => connection.getBalance(wallet.publicKey))
  );
  const plan = planSweepTransfers({
    walletBalancesLamports: balances,
    walletReserveLamports: solToLamports(numEnv("SWEEP_WALLET_RESERVE_SOL", config.minSolReserve)),
    feeLamportsPerTransfer: DEFAULT_FEE_LAMPORTS,
  });

  const transfers: FundingTransferResult[] = [];
  for (const transfer of plan.transfers) {
    const wallet = wallets[transfer.walletIndex];
    const signature = dryRun
      ? undefined
      : await sendSol(connection, wallet, source.publicKey, transfer.lamports);
    transfers.push({
      walletIndex: transfer.walletIndex,
      publicKey: wallet.publicKey.toString(),
      lamports: transfer.lamports,
      sol: lamportsToSol(transfer.lamports),
      signature,
    });
  }

  return {
    dryRun,
    sourcePublicKey: source.publicKey.toString(),
    transfers,
    totalSol: lamportsToSol(plan.totalTransferLamports),
    estimatedFeeSol: lamportsToSol(plan.estimatedFeeLamports),
  };
}

async function main() {
  const command = process.argv[2] || "status";
  const dryRun = process.argv.includes("--dry-run");

  if (command === "status" || command === "address") {
    console.log(JSON.stringify(await getFundingStatus(), null, 2));
    return;
  }

  if (command === "distribute") {
    console.log(JSON.stringify(await distributeFunding(dryRun), null, 2));
    return;
  }

  if (command === "sweep") {
    console.log(JSON.stringify(await sweepFunding(dryRun), null, 2));
    return;
  }

  throw new Error("Usage: ts-node src/funding.ts status|distribute|sweep [--dry-run]");
}

if (require.main === module) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
