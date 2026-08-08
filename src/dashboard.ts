import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { distributeFunding, getFundingStatus, sweepFunding } from "./funding";
import { SUEDE_LOGO_PATH, SUEDE_TOKEN_DECIMALS, SUEDE_TOKEN_MINT } from "./suede";

const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const DASHBOARD_TOKEN = crypto.randomBytes(24).toString("hex");
const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const DASHBOARD_CONFIG_PATH = path.join(ROOT, "dashboard-config.json");
const LEDGER_PATH = path.join(ROOT, process.env.LEDGER_PATH || "trades.jsonl");
const WALLETS_PATH = path.join(ROOT, "wallets.json");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SECRET_DISPLAY_KEYS = new Set(["RPC_URL", "PRIVATE_KEYS"]);

let bot: ChildProcessWithoutNullStreams | null = null;
let botStartedAt: string | null = null;
let botExited = true;
let logs: string[] = [];
const clients = new Set<http.ServerResponse>();

function appendLog(line: string) {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
  logs.push(clean);
  if (logs.length > 600) logs = logs.slice(-600);
  for (const client of clients) {
    client.write(`data: ${JSON.stringify(clean)}\n\n`);
  }
}

function readEnv() {
  const result: Record<string, string> = {};
  if (!fs.existsSync(ENV_PATH)) return result;

  for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return result;
}

function safeEnv() {
  const env = readEnv();
  return {
    RPC_URL: env.RPC_URL ? "(set)" : "",
    PRIVATE_KEYS: env.PRIVATE_KEYS ? `${env.PRIVATE_KEYS.split(",").filter(Boolean).length} key(s)` : "",
    TOKEN_MINT: env.TOKEN_MINT || SUEDE_TOKEN_MINT,
    TRADE_AMOUNT_SOL_MIN: env.TRADE_AMOUNT_SOL_MIN || "0.01",
    TRADE_AMOUNT_SOL_MAX: env.TRADE_AMOUNT_SOL_MAX || "0.05",
    DELAY_MIN_SEC: env.DELAY_MIN_SEC || "15",
    DELAY_MAX_SEC: env.DELAY_MAX_SEC || "45",
    SLIPPAGE_BPS: env.SLIPPAGE_BPS || "300",
    CYCLES: env.CYCLES || "0",
    DRY_RUN: env.DRY_RUN || "false",
    MODE: env.MODE || "hybrid",
    USE_VALUATION_QUOTES: env.USE_VALUATION_QUOTES || "false",
    TARGET_TOKEN_VALUE_PCT: env.TARGET_TOKEN_VALUE_PCT || "50",
    INVENTORY_BAND_PCT: env.INVENTORY_BAND_PCT || "12",
    MAX_PRICE_IMPACT_PCT: env.MAX_PRICE_IMPACT_PCT || "3",
    API_MIN_INTERVAL_MS: env.API_MIN_INTERVAL_MS || "1500",
    API_RATE_LIMIT_COOLDOWN_MS: env.API_RATE_LIMIT_COOLDOWN_MS || "30000",
    PULSE_TRADE_PCT: env.PULSE_TRADE_PCT || "25",
    WALLET_COOLDOWN_SEC: env.WALLET_COOLDOWN_SEC || "90",
    ACTIVE_MAKER_COUNT: env.ACTIVE_MAKER_COUNT || "0",
    MAX_CYCLES_PER_WALLET: env.MAX_CYCLES_PER_WALLET || "0",
    MIN_SOL_RESERVE: env.MIN_SOL_RESERVE || "0.005",
    AUTO_TOP_UP_ENABLED: env.AUTO_TOP_UP_ENABLED || "false",
    AUTO_TOP_UP_MIN_SOL: env.AUTO_TOP_UP_MIN_SOL || "0.012",
    AUTO_TOP_UP_TARGET_SOL: env.AUTO_TOP_UP_TARGET_SOL || "0.215",
    AUTO_SWEEP_BACK_ENABLED: env.AUTO_SWEEP_BACK_ENABLED || "true",
    AUTO_SWEEP_ON_START: env.AUTO_SWEEP_ON_START || "false",
    AUTO_SWEEP_RESERVE_SOL: env.AUTO_SWEEP_RESERVE_SOL || env.SWEEP_WALLET_RESERVE_SOL || "0.005",
    STARTUP_SCAN_ENABLED: env.STARTUP_SCAN_ENABLED || "false",
  };
}

function readDashboardConfig() {
  const base = safeEnv();
  if (!fs.existsSync(DASHBOARD_CONFIG_PATH)) return base;
  try {
    const stored = JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, "utf8"));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return base;
    return {
      ...base,
      ...Object.fromEntries(
        Object.entries(stored)
          .filter(([key, value]) =>
            key in base &&
            !SECRET_DISPLAY_KEYS.has(key) &&
            value !== undefined &&
            value !== null
          )
          .map(([key, value]) => [key, String(value)])
      ),
    };
  } catch {
    return base;
  }
}

function writeDashboardConfig(configValues: Record<string, string>) {
  fs.writeFileSync(
    DASHBOARD_CONFIG_PATH,
    `${JSON.stringify(runtimeEnvFromConfig(configValues), null, 2)}\n`,
    { mode: 0o600 }
  );
}

let dashboardConfig = readDashboardConfig();

function applyDashboardOverrides(overrides: Record<string, unknown>) {
  dashboardConfig = {
    ...dashboardConfig,
    ...Object.fromEntries(
      Object.entries(overrides)
        .filter(([key, value]) =>
          key in dashboardConfig &&
          !SECRET_DISPLAY_KEYS.has(key) &&
          value !== undefined &&
          value !== null
        )
        .map(([key, value]) => [key, String(value)])
    ),
  };
  writeDashboardConfig(dashboardConfig);
  return dashboardConfig;
}

function runtimeEnvFromConfig(configValues: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(configValues)
      .filter(([key, value]) =>
        !SECRET_DISPLAY_KEYS.has(key) &&
        value !== undefined &&
        value !== null
      )
      .map(([key, value]) => [key, String(value)])
  );
}

interface StoredWallet {
  publicKey: string;
  privateKey: string;
  enabled?: boolean;
}

function readStoredWallets(): StoredWallet[] {
  if (!fs.existsSync(WALLETS_PATH)) return [];
  try {
    const wallets = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
    if (!Array.isArray(wallets)) return [];
    return wallets.filter((wallet) => wallet?.publicKey && wallet?.privateKey);
  } catch {
    return [];
  }
}

function readWallets() {
  return readStoredWallets().map((wallet, index) => ({
    index,
    publicKey: wallet.publicKey,
    enabled: wallet.enabled !== false,
  }));
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function associatedTokenAddress(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

async function getMultipleAccounts(connection: Connection, keys: PublicKey[]) {
  const accounts = [];
  for (const batch of chunks(keys, 100)) {
    accounts.push(...await connection.getMultipleAccountsInfo(batch, "confirmed"));
  }
  return accounts;
}

function parseTokenAccountBalance(data: Buffer, decimals: number) {
  if (data.length < 72) return 0;
  return Number(data.readBigUInt64LE(64)) / (10 ** decimals);
}

async function readWalletBalances() {
  const env = safeEnv();
  const connection = new Connection(readEnv().RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const tokenMint = new PublicKey(env.TOKEN_MINT);
  const tokenDecimals = Number(readEnv().TOKEN_DECIMALS || SUEDE_TOKEN_DECIMALS);
  const wallets = readWallets();
  const walletPublicKeys = wallets.map((wallet) => new PublicKey(wallet.publicKey));
  const tokenAccounts = walletPublicKeys.map((wallet) => associatedTokenAddress(wallet, tokenMint));

  const [solAccounts, tokenAccountInfos] = await Promise.all([
    getMultipleAccounts(connection, walletPublicKeys),
    getMultipleAccounts(connection, tokenAccounts),
  ]);

  const rows = wallets.map((wallet, index) => {
    try {
      return {
        ...wallet,
        solBalance: (solAccounts[index]?.lamports ?? 0) / 1e9,
        tokenBalance: tokenAccountInfos[index]
          ? parseTokenAccountBalance(tokenAccountInfos[index].data, tokenDecimals)
          : 0,
      };
    } catch (err) {
      return {
        ...wallet,
        solBalance: null,
        tokenBalance: null,
        error: (err as Error).message,
      };
    }
  });

  const totals = rows.reduce(
    (acc, wallet) => {
      if (typeof wallet.solBalance === "number") acc.solBalance += wallet.solBalance;
      if (typeof wallet.tokenBalance === "number") acc.tokenBalance += wallet.tokenBalance;
      if (wallet.enabled) {
        if (typeof wallet.solBalance === "number") acc.enabledSolBalance += wallet.solBalance;
        if (typeof wallet.tokenBalance === "number") acc.enabledTokenBalance += wallet.tokenBalance;
      }
      return acc;
    },
    {
      solBalance: 0,
      tokenBalance: 0,
      enabledSolBalance: 0,
      enabledTokenBalance: 0,
    }
  );

  return { wallets: rows, totals };
}

async function enableFundedWallets() {
  const balances = await readWalletBalances();
  const stored = readStoredWallets();
  const env = safeEnv();
  const usableSolFloor = Number(env.MIN_SOL_RESERVE) + Number(env.TRADE_AMOUNT_SOL_MIN);
  let enabledCount = 0;

  const updated = stored.map((wallet, index) => {
    const balance = balances.wallets[index];
    const hasTokenInventory = Number(balance?.tokenBalance || 0) > 0;
    const hasUsableSol = Number(balance?.solBalance || 0) >= usableSolFloor;
    const enabled = hasTokenInventory || hasUsableSol;
    if (enabled) enabledCount += 1;
    return { ...wallet, enabled };
  });

  writeStoredWallets(updated);
  appendLog(`[wallets] enabled ${enabledCount} funded wallet(s); disabled ${stored.length - enabledCount} empty wallet(s)`);
  return {
    enabled: enabledCount,
    disabled: stored.length - enabledCount,
    wallets: readWallets(),
    balances: await readWalletBalances(),
  };
}

function writeStoredWallets(wallets: StoredWallet[]) {
  fs.writeFileSync(WALLETS_PATH, `${JSON.stringify(wallets, null, 2)}\n`, {
    mode: 0o600,
  });
}

function backupWalletsFile() {
  if (!fs.existsSync(WALLETS_PATH)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(ROOT, `wallets.backup-${stamp}.json`);
  fs.copyFileSync(WALLETS_PATH, backupPath);
  return backupPath;
}

function setWalletEnabled(index: number, enabled: boolean) {
  const wallets = readStoredWallets();
  if (!Number.isSafeInteger(index) || index < 0 || index >= wallets.length) {
    throw new Error("Wallet index not found");
  }
  wallets[index] = { ...wallets[index], enabled };
  writeStoredWallets(wallets);
  appendLog(`[wallets] ${enabled ? "enabled" : "disabled"} wallet #${index}`);
  return readWallets();
}

function setAllWalletsEnabled(enabled: boolean) {
  const wallets = readStoredWallets().map((wallet) => ({ ...wallet, enabled }));
  writeStoredWallets(wallets);
  appendLog(`[wallets] ${enabled ? "enabled" : "disabled"} all wallets`);
  return readWallets();
}

function removeDisabledWallets() {
  const wallets = readStoredWallets();
  const disabled = wallets.filter((wallet) => wallet.enabled === false);
  if (disabled.length === 0) {
    return { removed: 0, backupPath: null, wallets: readWallets() };
  }
  const backupPath = backupWalletsFile();
  const kept = wallets.filter((wallet) => wallet.enabled !== false);
  writeStoredWallets(kept);
  appendLog(`[wallets] removed ${disabled.length} disabled wallet(s); backup=${backupPath}`);
  return { removed: disabled.length, backupPath, wallets: readWallets() };
}

function minRecommendedSol() {
  const env = safeEnv();
  const reserve = Number(env.MIN_SOL_RESERVE || 0.005);
  const maxTrade = Number(env.TRADE_AMOUNT_SOL_MAX || 0.05);
  return {
    bareMinimum: reserve + maxTrade,
    recommended: reserve + maxTrade + 0.02,
  };
}

function addWallets(count: number) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new Error("Wallet count must be between 1 and 100");
  }

  const existing = readStoredWallets();
  const created = Array.from({ length: count }, () => {
    const wallet = Keypair.generate();
    return {
      publicKey: wallet.publicKey.toString(),
      privateKey: bs58.encode(wallet.secretKey),
      enabled: true,
    };
  });

  writeStoredWallets([...existing, ...created]);

  appendLog(`[dashboard] added ${count} wallet(s) to wallets.json`);
  return created.map((wallet, index) => ({
    index: existing.length + index,
    publicKey: wallet.publicKey,
  }));
}

function summarizeFunding(action: string, result: Awaited<ReturnType<typeof distributeFunding>>) {
  const mode = result.dryRun ? "dry-run " : "";
  appendLog(
    `[funding] ${mode}${action}: ${result.transfers.length} transfer(s), ` +
    `${result.totalSol.toFixed(6)} SOL total, est fee ${result.estimatedFeeSol.toFixed(6)} SOL`
  );
}

function readLedger(limit = 80) {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  return fs
    .readFileSync(LEDGER_PATH, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}

function feePayload() {
  const entries = readLedger(10_000);
  const trades = entries.filter((entry) => entry.type === "trade");
  const trackedTrades = trades.filter((entry) => typeof entry.feeSol === "number");
  const totalFeeSol = trackedTrades.reduce((sum, entry) => sum + Number(entry.feeSol || 0), 0);
  const totalBuySol = trades
    .filter((entry) => entry.side === "BUY")
    .reduce((sum, entry) => sum + Number(entry.solAmount || 0), 0);
  const totalSellSol = trades
    .filter((entry) => entry.side === "SELL")
    .reduce((sum, entry) => sum + Number(entry.solAmount || 0), 0);

  return {
    totalFeeSol,
    trackedTrades: trackedTrades.length,
    untrackedTrades: trades.length - trackedTrades.length,
    totalTrades: trades.length,
    totalBuySol,
    totalSellSol,
    netTradeSol: totalSellSol - totalBuySol,
  };
}

function statusPayload() {
  return {
    running: Boolean(bot && !botExited),
    pid: bot?.pid || null,
    startedAt: botStartedAt,
    config: dashboardConfig,
    wallets: readWallets(),
    funding: minRecommendedSol(),
    logs: logs.slice(-120),
  };
}

function json(res: http.ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function requireBotStopped(res: http.ServerResponse, action: string): boolean {
  if (bot && !botExited) {
    json(res, { error: `Stop the bot before ${action}` }, 409);
    return true;
  }
  return false;
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function startBot(overrides: Record<string, string>) {
  if (bot && !botExited) {
    throw new Error("Bot is already running");
  }

  const activeConfig = applyDashboardOverrides(overrides);

  const env = {
    ...process.env,
    ...runtimeEnvFromConfig(activeConfig),
  };

  logs = [];
  botExited = false;
  botStartedAt = new Date().toISOString();
  bot = spawn(process.execPath, ["dist/index.js"], {
    cwd: ROOT,
    env,
  });

  appendLog(`[dashboard] started bot pid=${bot.pid}`);
  bot.stdout.on("data", (chunk) => appendLog(chunk.toString().trimEnd()));
  bot.stderr.on("data", (chunk) => appendLog(chunk.toString().trimEnd()));
  bot.on("exit", (code, signal) => {
    appendLog(`[dashboard] bot exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    botExited = true;
    bot = null;
    botStartedAt = null;
  });
}

function waitForBotExit(timeoutMs = 8_000) {
  if (!bot || botExited) return Promise.resolve();
  const currentBot = bot;
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), timeoutMs);
    currentBot.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function stopBot() {
  if (!bot || botExited) return false;
  appendLog("[dashboard] stopping bot");
  bot.kill("SIGINT");
  setTimeout(() => {
    if (bot && !botExited) bot.kill("SIGTERM");
  }, 5000).unref();
  return true;
}

const html = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Suede Market Maker | Jason Colapietro</title>
  <meta name="description" content="The Suede Labs AI market maker control desk, built by Jason Colapietro." />
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b0f;
      --panel: #10151d;
      --panel-2: #141b25;
      --panel-3: #0c1118;
      --line: #273244;
      --text: #eef3f8;
      --muted: #91a0b5;
      --green: #33d69f;
      --red: #ff6961;
      --yellow: #f4c95d;
      --blue: #6cb8ff;
      --focus: #9ad7ff;
      --shadow: 0 18px 50px rgba(0, 0, 0, .28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-body, "Avenir Next", "Segoe UI", sans-serif);
      letter-spacing: 0;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 5;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(9, 11, 15, 0.94);
      backdrop-filter: blur(12px);
    }
    h1 { margin: 0; font-size: 18px; font-weight: 700; }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .brand img {
      width: 124px;
      height: 31px;
      object-fit: contain;
      flex: 0 0 auto;
      filter: drop-shadow(0 0 16px rgba(24, 163, 255, .26));
    }
    .brand-lock {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid #275f50;
      border-radius: 999px;
      padding: 0 9px;
      color: #8ff1cf;
      background: rgba(51, 214, 159, .1);
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }
    .nav {
      display: flex;
      gap: 6px;
      overflow: auto;
      max-width: min(48vw, 520px);
      padding-bottom: 1px;
    }
    .nav a {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      color: var(--muted);
      text-decoration: none;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
      background: rgba(255,255,255,.025);
    }
    .nav a:hover { color: var(--text); border-color: #3b4a62; }
    .summary {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
      max-width: 1400px;
      margin: 0 auto;
      padding: 12px 14px 0;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.015));
      padding: 10px 12px;
      min-width: 0;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .metric strong {
      display: block;
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 16px;
    }
    .suede-band {
      max-width: 1400px;
      margin: 0 auto;
      padding: 10px 14px 0;
    }
    .suede-band-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border: 1px solid #275f50;
      border-radius: 8px;
      background: linear-gradient(90deg, rgba(51, 214, 159, .14), rgba(108, 184, 255, .07));
      color: #d8fff0;
      padding: 10px 12px;
      font-size: 12px;
      font-weight: 800;
    }
    .suede-band a,
    .suede-footer a {
      color: #8fdcff;
      text-decoration: none;
      font-weight: 900;
    }
    .suede-band a:hover,
    .suede-footer a:hover {
      text-decoration: underline;
    }
    .suede-band code {
      color: #eef3f8;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 50vw;
    }
    .suede-link-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 30px;
      border: 1px solid rgba(143, 220, 255, .45);
      border-radius: 6px;
      background: rgba(24, 163, 255, .14);
      color: #dff6ff;
      padding: 0 10px;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 900;
      text-decoration: none;
    }
    .suede-link-button:hover {
      background: rgba(24, 163, 255, .22);
      text-decoration: none;
    }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(360px, .85fr);
      gap: 14px;
      padding: 14px;
      max-width: 1400px;
      margin: 0 auto;
    }
    .suede-footer {
      max-width: 1400px;
      margin: 0 auto 18px;
      padding: 0 14px;
    }
    .suede-footer-inner {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 14px;
      border: 1px solid #263348;
      border-radius: 8px;
      background: linear-gradient(90deg, rgba(16, 24, 34, .96), rgba(11, 17, 24, .96));
      padding: 13px 14px;
      color: var(--muted);
      box-shadow: var(--shadow);
    }
    .suede-footer img {
      width: 116px;
      height: 29px;
      object-fit: contain;
      filter: drop-shadow(0 0 14px rgba(24, 163, 255, .2));
    }
    .suede-footer strong {
      display: block;
      color: #eff6ff;
      font-size: 13px;
      margin-bottom: 2px;
    }
    .suede-footer span {
      font-size: 12px;
      line-height: 1.4;
    }
    .suede-footer .footer-links {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      white-space: nowrap;
      font-size: 12px;
    }
    section {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: var(--shadow);
      scroll-margin-top: 76px;
    }
    section h2 {
      margin: 0;
      padding: 12px 14px;
      font-size: 13px;
      border-bottom: 1px solid var(--line);
      color: #cbd7e6;
      text-transform: uppercase;
    }
    .body { padding: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .action-dock {
      display: grid;
      grid-template-columns: minmax(190px, .62fr) minmax(0, 1.38fr);
      align-items: stretch;
      gap: 10px;
      margin-bottom: 14px;
      border: 1px solid #344258;
      border-radius: 8px;
      background: linear-gradient(180deg, #121a24, #0c121a);
      padding: 10px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    }
    .action-copy {
      display: grid;
      align-content: center;
      gap: 4px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }
    .action-copy strong {
      color: #eaf2fb;
      font-size: 13px;
    }
    .button-cluster {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      align-content: center;
    }
    .button-cluster.two {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .button-cluster.five {
      grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
    }
    .control-groups {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .control-group {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,.02);
      padding: 12px;
    }
    .control-group h3 {
      margin: 0 0 10px;
      color: #d7e4f2;
      font-size: 12px;
      line-height: 1.2;
      text-transform: uppercase;
    }
    .control-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
    input, select {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
    button {
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 6px;
      min-height: 38px;
      padding: 0 12px;
      font-weight: 700;
      cursor: pointer;
      transition: border-color .15s ease, background .15s ease, transform .15s ease;
    }
    button:hover { border-color: #526982; transform: translateY(-1px); }
    button.primary { background: #0d6b4e; border-color: #14805f; }
    button.danger { background: #70201f; border-color: #95312f; }
    button.warning { background: #6f5514; border-color: #92701d; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .button-quiet { background: transparent; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--muted);
    }
    .dot { width: 9px; height: 9px; border-radius: 999px; background: var(--red); }
    .dot.on { background: var(--green); }
    .stack { display: grid; gap: 14px; }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
    }
    .panel-head h2 {
      padding: 0;
      border: 0;
    }
    .panel-head .muted { font-size: 12px; white-space: nowrap; }
    .wallets, .trades { display: grid; gap: 8px; }
    .wallets {
      grid-template-columns: 1fr;
      align-items: start;
      max-height: 390px;
      overflow: auto;
      padding-right: 4px;
    }
    .wallet-row {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr) minmax(150px, auto) auto auto;
      align-items: center;
      gap: 8px;
      min-height: 44px;
    }
    .wallet-key {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #dce9f7;
    }
    .wallet-index {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 24px;
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
    }
    .wallet-card-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-end;
    }
    .wallet-card-actions button {
      min-height: 30px;
      padding: 0 9px;
      font-size: 11px;
    }
    .wallet-balances {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      color: var(--text);
      font-size: 12px;
      white-space: nowrap;
    }
    .wallet-balances span {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      min-height: 28px;
      border: 1px solid #314158;
      border-radius: 6px;
      background: #131d29;
      padding: 0 8px;
    }
    .wallet-balances b {
      color: var(--text);
      font-weight: 800;
    }
    .wallet-balances small {
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
    }
    .wallet-balances.error { color: var(--red); }
    .wallet-row code {
      max-width: 100%;
      font-size: 11px;
    }
    .wallet-disabled {
      opacity: .55;
      border-color: #5a3440;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 0 8px;
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }
    .pill.on { color: var(--green); border-color: #22795d; }
    .pill.off { color: var(--red); border-color: #7a3939; }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255,255,255,.025);
      font-size: 12px;
    }
    .wallet-row.row {
      display: grid;
      padding: 8px;
    }
    .address-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: end;
    }
    .result-box {
      display: none;
      margin-top: 12px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255,255,255,.025);
      color: #cfe3f7;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    pre {
      margin: 0;
      min-height: 360px;
      max-height: calc(100vh - 190px);
      overflow: auto;
      white-space: pre-wrap;
      padding: 14px;
      background: var(--panel-3);
      color: #cfe3f7;
      font-size: 12px;
      line-height: 1.45;
    }
    .logs-panel {
      position: sticky;
      top: 68px;
      align-self: start;
    }
    .muted { color: var(--muted); }
    .wallet-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .wallet-totals {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin: 0 0 12px;
    }
    .wallet-total-card {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: rgba(255,255,255,.025);
      padding: 9px 10px;
    }
    .wallet-total-card span {
      display: block;
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .wallet-total-card strong {
      display: block;
      margin-top: 3px;
      font-size: 14px;
    }
    .wallet-warning {
      display: none;
      margin: 0 0 12px;
      border: 1px solid #92701d;
      border-radius: 6px;
      background: rgba(111, 85, 20, .24);
      color: #ffe4a3;
      padding: 10px;
      font-size: 12px;
      line-height: 1.4;
    }
    .tabs { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--line); }
    .tabs button { min-height: 32px; font-size: 12px; }
    .wallet-tools {
      display: grid;
      grid-template-columns: minmax(190px, .75fr) minmax(0, 1.25fr);
      gap: 10px;
      align-items: end;
      margin-bottom: 12px;
    }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
      .logs-panel { position: static; }
      .address-row { grid-template-columns: 1fr; }
      .control-groups { grid-template-columns: 1fr; }
      .action-dock { grid-template-columns: 1fr; }
      .button-cluster.five { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .suede-footer-inner { grid-template-columns: 1fr; }
      .suede-footer .footer-links { justify-content: flex-start; flex-wrap: wrap; }
      .wallet-tools { grid-template-columns: 1fr; }
      .wallets { max-height: 340px; }
      pre { min-height: 240px; max-height: 340px; }
      .nav { max-width: 100%; }
      header { align-items: flex-start; flex-direction: column; }
      .topbar { width: 100%; justify-content: space-between; }
    }
    @media (max-width: 560px) {
      .grid { grid-template-columns: 1fr; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .control-grid { grid-template-columns: 1fr; }
      .button-cluster,
      .button-cluster.two,
      .button-cluster.five { grid-template-columns: 1fr; }
      .actions button { flex: 1 1 130px; }
      .wallet-row { grid-template-columns: 36px minmax(0, 1fr) auto; }
      .wallet-balances { grid-column: 1 / -1; justify-content: flex-start; flex-wrap: wrap; }
      .wallet-card-actions { grid-column: 1 / -1; justify-content: stretch; }
      .wallet-card-actions button { flex: 1; }
      .wallet-totals { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    /* Suede control desk: retro-technical product register */
    :root {
      --color-surface-base: oklch(0.115 0.016 250);
      --color-surface-elevated: oklch(0.155 0.018 250);
      --color-surface-overlay: oklch(0.195 0.022 250);
      --color-border-subtle: oklch(0.92 0.01 250 / .14);
      --color-border-strong: oklch(0.72 0.14 246 / .62);
      --color-text-primary: oklch(0.955 0.012 245);
      --color-text-secondary: oklch(0.74 0.025 245);
      --color-text-disabled: oklch(0.58 0.018 245);
      --color-brand: oklch(0.7 0.16 246);
      --color-brand-soft: oklch(0.7 0.16 246 / .14);
      --color-live: oklch(0.83 0.17 150);
      --color-danger: oklch(0.68 0.18 25);
      --color-warning: oklch(0.82 0.14 82);
      --font-display: "Avenir Next Condensed", "DIN Condensed", sans-serif;
      --font-body: "Avenir Next", "Segoe UI", sans-serif;
      --font-utility: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --bg: var(--color-surface-base);
      --panel: var(--color-surface-elevated);
      --panel-2: var(--color-surface-overlay);
      --panel-3: oklch(0.095 0.014 250);
      --line: var(--color-border-subtle);
      --text: var(--color-text-primary);
      --muted: var(--color-text-secondary);
      --green: var(--color-live);
      --red: var(--color-danger);
      --yellow: var(--color-warning);
      --blue: var(--color-brand);
      --focus: oklch(0.82 0.13 246);
      --shadow: none;
    }
    html { scroll-behavior: smooth; }
    body {
      min-width: 320px;
      min-height: 100vh;
      background: var(--color-surface-base);
      color: var(--color-text-primary);
      font-family: var(--font-body);
    }
    ::selection { background: var(--color-brand); color: var(--color-surface-base); }
    .masthead {
      position: sticky;
      top: 0;
      z-index: 20;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      grid-template-areas:
        "brand status founder"
        "nav nav nav";
      align-items: center;
      gap: 10px 18px;
      padding: 10px max(16px, calc((100vw - 1400px) / 2 + 14px)) 0;
      border-bottom: 1px solid var(--color-border-strong);
      background: oklch(0.105 0.018 250 / .97);
      backdrop-filter: none;
    }
    .brand {
      grid-area: brand;
      gap: 14px;
    }
    .brand img {
      width: 54px;
      height: 54px;
      border: 1px solid var(--color-border-strong);
      border-radius: 10px;
      object-fit: cover;
      filter: none;
    }
    .brand-copy { display: grid; gap: 1px; min-width: 0; }
    .brand-kicker,
    .brand-subtitle,
    .founder-mark span,
    .manifest-kicker,
    .token-seal span {
      color: var(--color-text-secondary);
      font-family: var(--font-utility);
      font-size: 10px;
      font-weight: 700;
      line-height: 1.3;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-family: var(--font-display);
      font-size: clamp(1.65rem, 1.35rem + 1vw, 2.35rem);
      font-weight: 800;
      line-height: 1;
    }
    .masthead .status {
      grid-area: status;
      min-height: 36px;
      border: 1px solid var(--color-border-subtle);
      border-radius: 8px;
      padding: 0 12px;
      background: var(--color-surface-elevated);
      font-family: var(--font-utility);
      font-size: 11px;
    }
    .dot {
      width: 8px;
      height: 8px;
      box-shadow: 0 0 0 3px oklch(0.68 0.18 25 / .12);
    }
    .dot.on { box-shadow: 0 0 0 3px oklch(0.83 0.17 150 / .12); }
    .founder-mark {
      grid-area: founder;
      display: grid;
      min-width: 206px;
      border-left: 1px solid var(--color-border-strong);
      padding: 3px 0 3px 16px;
      color: var(--color-text-primary);
      text-decoration: none;
    }
    .founder-mark strong {
      font-family: var(--font-display);
      font-size: clamp(1.1rem, 1rem + .35vw, 1.35rem);
      line-height: 1.15;
    }
    .founder-mark:hover strong { color: var(--color-brand); }
    .nav {
      grid-area: nav;
      width: 100%;
      max-width: none;
      gap: 0;
      padding: 0;
      border-top: 1px solid var(--color-border-subtle);
    }
    .nav a {
      min-height: 34px;
      border: 0;
      border-right: 1px solid var(--color-border-subtle);
      border-radius: 0;
      padding: 0 14px;
      background: transparent;
      color: var(--color-text-secondary);
      font-family: var(--font-utility);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .nav a:first-child { border-left: 1px solid var(--color-border-subtle); }
    .nav a:hover,
    .nav a:focus-visible {
      border-color: var(--color-border-subtle);
      background: var(--color-brand-soft);
      color: var(--color-text-primary);
    }
    .suede-band { padding-top: 18px; }
    .suede-band-inner {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(250px, .65fr);
      gap: 20px;
      overflow: hidden;
      border: 1px solid var(--color-border-strong);
      border-radius: 12px;
      background: var(--color-surface-elevated);
      color: var(--color-text-primary);
      padding: 22px;
    }
    .manifest { position: relative; z-index: 1; max-width: 760px; }
    .manifest h2 {
      margin: 8px 0 10px;
      max-width: 18ch;
      color: var(--color-text-primary);
      font-family: var(--font-display);
      font-size: clamp(2rem, 1.5rem + 2vw, 3.5rem);
      font-weight: 800;
      line-height: 1.02;
    }
    .manifest p {
      max-width: 68ch;
      margin: 0;
      color: var(--color-text-secondary);
      font-size: clamp(.9rem, .86rem + .18vw, 1rem);
      line-height: 1.55;
    }
    .creator-credit {
      position: relative;
      z-index: 1;
      display: grid;
      align-content: center;
      border-top: 3px solid var(--color-brand);
      background: var(--color-surface-overlay);
      padding: 16px;
    }
    .creator-credit > span,
    .creator-credit .creator-role {
      color: var(--color-text-secondary);
      font-family: var(--font-utility);
      font-size: 10px;
      text-transform: uppercase;
    }
    .creator-credit strong {
      margin: 3px 0;
      font-family: var(--font-display);
      font-size: clamp(1.65rem, 1.3rem + 1.1vw, 2.35rem);
      line-height: 1;
    }
    .creator-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .creator-links a,
    .suede-link-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      border: 1px solid var(--color-border-strong);
      border-radius: 6px;
      background: transparent;
      color: var(--color-text-primary);
      padding: 0 10px;
      font-family: var(--font-utility);
      font-size: 10px;
      font-weight: 700;
      text-decoration: none;
      text-transform: uppercase;
    }
    .creator-links a:hover,
    .suede-link-button:hover { background: var(--color-brand-soft); text-decoration: none; }
    .token-seal {
      position: relative;
      z-index: 1;
      display: grid;
      grid-column: 1 / -1;
      grid-template-columns: auto auto minmax(0, 1fr);
      align-items: center;
      gap: 12px;
      border-top: 1px solid var(--color-border-subtle);
      padding-top: 14px;
    }
    .token-seal strong { color: var(--color-live); font-family: var(--font-utility); }
    .token-seal code {
      max-width: none;
      color: var(--color-text-secondary);
      text-align: right;
    }
    .summary {
      gap: 0;
      padding-top: 12px;
    }
    .metric {
      min-height: 68px;
      border: 1px solid var(--color-border-subtle);
      border-right: 0;
      border-radius: 0;
      background: var(--color-surface-elevated);
      padding: 11px 12px;
    }
    .metric:first-child { border-radius: 8px 0 0 8px; }
    .metric:last-child { border-right: 1px solid var(--color-border-subtle); border-radius: 0 8px 8px 0; }
    .metric span {
      color: var(--color-text-secondary);
      font-family: var(--font-utility);
      font-size: 9px;
      letter-spacing: 0;
    }
    .metric strong {
      margin-top: 7px;
      font-family: var(--font-display);
      font-size: clamp(1rem, .9rem + .35vw, 1.3rem);
    }
    main { grid-template-columns: minmax(0, 1.22fr) minmax(360px, .78fr); }
    section {
      border-color: var(--color-border-subtle);
      border-radius: 10px;
      background: var(--color-surface-elevated);
      box-shadow: none;
    }
    section h2,
    .control-group h3 {
      color: var(--color-text-primary);
      font-family: var(--font-display);
      font-weight: 700;
      text-transform: none;
    }
    section h2 { font-size: clamp(.95rem, .9rem + .22vw, 1.1rem); }
    .action-dock {
      border: 1px solid var(--color-border-strong);
      border-radius: 8px;
      background: var(--color-surface-base);
      box-shadow: none;
    }
    .action-copy strong { color: var(--color-text-primary); }
    .control-groups { gap: 0 18px; }
    .control-group {
      border: 0;
      border-top: 1px solid var(--color-border-subtle);
      border-radius: 0;
      background: transparent;
      padding: 16px 0;
    }
    .control-group h3 { font-size: clamp(.85rem, .8rem + .18vw, .98rem); }
    label { color: var(--color-text-secondary); font-family: var(--font-utility); font-size: 10px; }
    input,
    select {
      border-color: var(--color-border-subtle);
      border-radius: 6px;
      background: var(--color-surface-base);
      color: var(--color-text-primary);
      font-family: var(--font-utility);
      font-size: 12px;
    }
    input:hover,
    select:hover { border-color: var(--color-border-strong); }
    input:focus-visible,
    select:focus-visible,
    button:focus-visible,
    a:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
    button {
      border-color: var(--color-border-subtle);
      border-radius: 6px;
      background: var(--color-surface-overlay);
      color: var(--color-text-primary);
      font-family: var(--font-utility);
      font-size: 11px;
      transition: background .22s cubic-bezier(.16, 1, .3, 1), border-color .22s cubic-bezier(.16, 1, .3, 1), transform .22s cubic-bezier(.16, 1, .3, 1);
    }
    button:hover { border-color: var(--color-border-strong); background: var(--color-brand-soft); transform: translate3d(0, -1px, 0); }
    button.primary { border-color: var(--color-live); background: var(--color-live); color: var(--color-surface-base); }
    button.primary:hover { background: oklch(0.88 0.17 150); }
    button.danger { border-color: var(--color-danger); background: oklch(0.42 0.12 25); }
    button.warning { border-color: var(--color-warning); background: oklch(0.34 0.08 82); }
    button:disabled { color: var(--color-text-disabled); transform: none; }
    .row,
    .wallet-total-card,
    .result-box {
      border-color: var(--color-border-subtle);
      background: var(--color-surface-base);
    }
    .wallet-total-card { border-radius: 6px; }
    .wallet-index,
    .wallet-balances span { background: var(--color-surface-overlay); }
    .logs-panel { top: 112px; }
    pre { background: oklch(0.08 0.014 250); color: oklch(0.84 0.05 212); }
    .suede-footer-inner {
      border-color: var(--color-border-strong);
      border-radius: 10px;
      background: var(--color-surface-elevated);
      box-shadow: none;
    }
    .suede-footer img {
      width: 58px;
      height: 58px;
      border: 1px solid var(--color-border-strong);
      border-radius: 8px;
      object-fit: cover;
      filter: none;
    }
    .suede-footer strong {
      color: var(--color-text-primary);
      font-family: var(--font-display);
      font-size: clamp(1.05rem, .95rem + .35vw, 1.3rem);
    }
    .suede-footer a { color: var(--color-brand); }
    @media (max-width: 900px) {
      .masthead {
        grid-template-columns: minmax(0, 1fr) auto;
        grid-template-areas:
          "brand status"
          "founder founder"
          "nav nav";
      }
      .founder-mark {
        min-width: 0;
        border-top: 1px solid var(--color-border-subtle);
        border-left: 0;
        padding: 8px 0 0;
      }
      .suede-band-inner { grid-template-columns: 1fr; }
      .token-seal { grid-template-columns: auto 1fr; }
      .token-seal code { grid-column: 1 / -1; text-align: left; }
      main { grid-template-columns: 1fr; }
      .logs-panel { position: static; }
    }
    @media (max-width: 560px) {
      .masthead { padding-inline: 12px; }
      .brand img { width: 44px; height: 44px; }
      .brand-kicker { display: none; }
      .brand-subtitle { max-width: 24ch; white-space: normal; }
      .masthead .status { min-height: 32px; padding: 0 9px; }
      .founder-mark strong { font-size: 1.1rem; }
      .nav { overflow-x: auto; }
      .nav a { flex: 0 0 auto; min-height: 44px; padding: 0 12px; }
      .suede-band { padding: 12px 12px 0; }
      .suede-band-inner { gap: 14px; padding: 16px; }
      .manifest h2 { font-size: clamp(1.8rem, 1.55rem + 1vw, 2.1rem); }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-inline: 12px; }
      .metric,
      .metric:first-child,
      .metric:last-child { border: 1px solid var(--color-border-subtle); border-radius: 0; }
      .metric:nth-child(1) { border-radius: 8px 0 0 0; }
      .metric:nth-child(2) { border-radius: 0 8px 0 0; }
      .metric:nth-last-child(2) { border-radius: 0 0 0 8px; }
      .metric:last-child { border-radius: 0 0 8px 0; }
      main { padding: 12px; }
      .control-groups { grid-template-columns: 1fr; }
      .creator-links a { flex: 1 1 120px; }
      button,
      input,
      select,
      .creator-links a { min-height: 44px; }
      .wallet-card-actions button { min-height: 44px; }
      .suede-footer { padding-inline: 12px; }
    }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
      *, *::before, *::after { animation-duration: 0ms !important; transition-duration: 0ms !important; }
    }
  </style>
</head>
<body>
  <header class="masthead">
    <div class="brand">
      <img src="https://raw.githubusercontent.com/JasonColapietro/suede-creator-skills/5101ac66214193608b97a2ca314772c7037693de/docs/assets/suede-ai-logo-transparent.png" alt="Suede Labs AI mark" />
      <div class="brand-copy">
        <span class="brand-kicker">Suede Labs AI / Market Infrastructure</span>
        <h1>Market Maker</h1>
        <span class="brand-subtitle">Solana execution desk for $SUEDE</span>
      </div>
    </div>
    <div class="status" aria-live="polite"><span id="dot" class="dot"></span><span id="status">Loading</span></div>
    <a class="founder-mark" href="https://suedeai.ai/founder" target="_blank" rel="noreferrer">
      <span>Founder &amp; builder</span>
      <strong>Jason Colapietro</strong>
    </a>
    <nav class="nav" aria-label="Dashboard sections">
      <a href="#controls">Run Bot</a>
      <a href="#walletPanel">Manage Wallets</a>
      <a href="#fundingPanel">Move Funds</a>
      <a href="#logsPanel">Read Logs</a>
      <a href="https://suedeai.ai" target="_blank" rel="noreferrer">Suede Labs AI</a>
    </nav>
  </header>
  <div class="suede-band">
    <div class="suede-band-inner">
      <div class="manifest">
        <span class="manifest-kicker">Local control desk // transparent execution</span>
        <h2>Operate the market. See every move.</h2>
        <p>Self-hosted market infrastructure from Suede Labs AI. Control wallet rotation, funding, strategy, trades, and fees from one auditable desk.</p>
      </div>
      <aside class="creator-credit" aria-label="Creator credit">
        <span>Designed and built by</span>
        <strong>Jason Colapietro</strong>
        <span class="creator-role">Founder, Suede Labs AI</span>
        <div class="creator-links">
          <a href="https://suedeai.ai/founder" target="_blank" rel="noreferrer">Founder profile</a>
          <a href="https://x.com/johnnysuede" target="_blank" rel="noreferrer">@johnnysuede</a>
        </div>
      </aside>
      <div class="token-seal">
        <span>Default asset</span>
        <strong>$SUEDE</strong>
        <code>${SUEDE_TOKEN_MINT}</code>
      </div>
    </div>
  </div>
  <div class="summary" aria-label="Live Suede market operations tape">
    <div class="metric"><span>Bot</span><strong id="summaryStatus">Stopped</strong></div>
    <div class="metric"><span>Mode</span><strong id="summaryMode">-</strong></div>
    <div class="metric"><span>Rotation</span><strong id="summaryRotation">-</strong></div>
    <div class="metric"><span>Wallets</span><strong id="summaryWallets">0 / 0</strong></div>
    <div class="metric"><span>Funding</span><strong id="summaryFunding">-</strong></div>
    <div class="metric"><span>Fees</span><strong id="summaryFees">-</strong></div>
  </div>
  <main>
    <div class="stack">
      <section id="controls">
        <h2>Controls</h2>
        <div class="body">
          <div class="action-dock">
            <div class="action-copy">
              <strong>Run controls</strong>
              <span>Start uses the current values below. Stop leaves the dashboard open.</span>
            </div>
            <div class="button-cluster">
              <button class="primary" id="start">Start</button>
              <button class="danger" id="stop">Stop</button>
              <button id="refresh">Refresh</button>
            </div>
          </div>
          <div class="control-groups">
            <div class="control-group">
              <h3>Strategy</h3>
              <div class="control-grid">
                <label>Mode
                  <select id="MODE">
                    <option value="hybrid">hybrid</option>
                    <option value="rebalance">rebalance</option>
                    <option value="pulse">pulse</option>
                  </select>
                </label>
                <label>Dry Run
                  <select id="DRY_RUN">
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </label>
                <label>Valuation Quotes
                  <select id="USE_VALUATION_QUOTES">
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                </label>
                <label>Cycles
                  <input id="CYCLES" inputmode="numeric" />
                </label>
              </div>
            </div>
            <div class="control-group">
              <h3>Trade Size</h3>
              <div class="control-grid">
                <label>Min SOL
                  <input id="TRADE_AMOUNT_SOL_MIN" inputmode="decimal" />
                </label>
                <label>Max SOL
                  <input id="TRADE_AMOUNT_SOL_MAX" inputmode="decimal" />
                </label>
                <label>Pulse %
                  <input id="PULSE_TRADE_PCT" inputmode="decimal" />
                </label>
                <label>SOL Reserve
                  <input id="MIN_SOL_RESERVE" inputmode="decimal" />
                </label>
              </div>
            </div>
            <div class="control-group">
              <h3>Inventory Guardrails</h3>
              <div class="control-grid">
                <label>Target SUEDE %
                  <input id="TARGET_TOKEN_VALUE_PCT" inputmode="decimal" />
                </label>
                <label>Band %
                  <input id="INVENTORY_BAND_PCT" inputmode="decimal" />
                </label>
                <label>Max Impact %
                  <input id="MAX_PRICE_IMPACT_PCT" inputmode="decimal" />
                </label>
              </div>
            </div>
            <div class="control-group">
              <h3>Timing &amp; Addresses</h3>
              <div class="control-grid">
                <label>Delay Min Sec
                  <input id="DELAY_MIN_SEC" inputmode="decimal" />
                </label>
                <label>Delay Max Sec
                  <input id="DELAY_MAX_SEC" inputmode="decimal" />
                </label>
                <label>Address Cooldown Sec
                  <input id="WALLET_COOLDOWN_SEC" inputmode="decimal" />
                </label>
                <label>Active Addresses
                  <input id="ACTIVE_MAKER_COUNT" inputmode="numeric" />
                </label>
                <label>Max Cycles Per Address
                  <input id="MAX_CYCLES_PER_WALLET" inputmode="numeric" />
                </label>
                <label>Auto Top-Up
                  <select id="AUTO_TOP_UP_ENABLED">
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </label>
                <label>Top-Up Min SOL
                  <input id="AUTO_TOP_UP_MIN_SOL" inputmode="decimal" />
                </label>
                <label>Top-Up Cap SOL
                  <input id="AUTO_TOP_UP_TARGET_SOL" inputmode="decimal" />
                </label>
                <label>Sweep Back
                  <select id="AUTO_SWEEP_BACK_ENABLED">
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </label>
                <label>Sweep On Start
                  <select id="AUTO_SWEEP_ON_START">
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                </label>
                <label>Sweep Reserve SOL
                  <input id="AUTO_SWEEP_RESERVE_SOL" inputmode="decimal" />
                </label>
                <label>Startup Scan
                  <select id="STARTUP_SCAN_ENABLED">
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                </label>
                <label>API Min Ms
                  <input id="API_MIN_INTERVAL_MS" inputmode="numeric" />
                </label>
                <label>429 Cooldown Ms
                  <input id="API_RATE_LIMIT_COOLDOWN_MS" inputmode="numeric" />
                </label>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section id="walletPanel">
        <div class="panel-head">
          <h2>Wallets</h2>
          <span class="muted" id="walletPanelHint">Idle edits only</span>
        </div>
        <div class="body">
          <div class="action-dock">
            <div class="action-copy">
              <strong>Wallet actions</strong>
              <span>Generate, refresh, enable, disable, and clean up addresses from one place.</span>
            </div>
            <div class="button-cluster five">
              <button id="addWallets">Generate</button>
              <button id="refreshBalances">Refresh Balances</button>
              <button class="primary" id="useFundedWallets">Use Funded</button>
              <button id="disableAllWallets">Disable All</button>
              <button class="warning" id="removeDisabledWallets">Remove Disabled</button>
            </div>
          </div>
          <div class="wallet-summary">
            <span id="walletTotal">0 wallets</span>
            <span id="walletEnabledTotal">0 enabled</span>
          </div>
          <div class="wallet-totals">
            <div class="wallet-total-card"><span>All SOL</span><strong id="walletSolTotal">checking...</strong></div>
            <div class="wallet-total-card"><span>All SUEDE</span><strong id="walletTokenTotal">checking...</strong></div>
            <div class="wallet-total-card"><span>Enabled SOL</span><strong id="enabledSolTotal">checking...</strong></div>
            <div class="wallet-total-card"><span>Enabled SUEDE</span><strong id="enabledTokenTotal">checking...</strong></div>
          </div>
          <div class="wallet-warning" id="walletWarning"></div>
          <div class="wallet-tools">
            <div class="grid">
              <label>Add Wallets
                <input id="walletCount" inputmode="numeric" value="1" />
              </label>
              <label>Recommended SOL
                <input id="fundingGuide" disabled />
              </label>
            </div>
            <div class="button-cluster two">
              <button id="enableAllWallets">Enable All</button>
              <button id="copyFundingAddress">Copy Funding Address</button>
            </div>
          </div>
          <p class="muted">Enabled wallets receive funding and participate in address rotation. Disabled wallets stay in local <code>wallets.json</code> until removed.</p>
          <div class="wallets" id="wallets"></div>
        </div>
      </section>
      <section id="fundingPanel">
        <h2>Funding</h2>
        <div class="body">
          <div class="action-dock">
            <div class="action-copy">
              <strong>Funding actions</strong>
              <span>Check balance, preview movement, distribute, or sweep back from one toolbar.</span>
            </div>
            <div class="button-cluster five">
              <button id="fundRefresh">Refresh</button>
              <button id="copyFundingAddressAlt">Copy Address</button>
              <button id="fundDistributeDry">Preview Fund</button>
              <button class="primary" id="fundDistribute">Distribute</button>
              <button class="danger" id="fundSweep">Sweep Back</button>
            </div>
          </div>
          <div class="address-row">
            <label>Funding Wallet
              <input id="fundingAddress" readonly />
            </label>
            <button id="fundSweepDry">Preview Sweep</button>
          </div>
          <div class="grid" style="margin-top:10px">
            <label>Funding Balance
              <input id="fundingBalance" disabled />
            </label>
            <label>Managed Wallets
              <input id="fundingWalletCount" disabled />
            </label>
          </div>
          <div class="result-box" id="fundingResult"></div>
          <p class="muted">Send SOL to the funding wallet, then distribute evenly to all managed wallets. Sweep sends spendable SOL back to the same funding wallet.</p>
        </div>
      </section>
      <section>
        <h2>Recent Trades</h2>
        <div class="body">
          <div class="wallet-totals">
            <div class="wallet-total-card"><span>Tracked Fees</span><strong id="feeTotal">checking...</strong></div>
            <div class="wallet-total-card"><span>Tracked Trades</span><strong id="feeTrades">checking...</strong></div>
            <div class="wallet-total-card"><span>Buy SOL</span><strong id="feeBuySol">checking...</strong></div>
            <div class="wallet-total-card"><span>Sell SOL</span><strong id="feeSellSol">checking...</strong></div>
          </div>
          <p class="muted" id="feeNote"></p>
          <div class="trades" id="trades"></div>
        </div>
      </section>
    </div>
    <section class="logs-panel" id="logsPanel">
      <div class="tabs">
        <button id="logsTab">Logs</button>
        <button id="clearLogs">Clear</button>
      </div>
      <pre id="logs"></pre>
    </section>
  </main>
  <footer class="suede-footer">
    <div class="suede-footer-inner">
      <img src="https://raw.githubusercontent.com/JasonColapietro/suede-creator-skills/5101ac66214193608b97a2ca314772c7037693de/docs/assets/suede-ai-logo-transparent.png" alt="Suede Labs AI mark" />
      <div>
        <strong>Suede Labs AI × Jason Colapietro</strong>
        <span>Transparent, self-hosted market infrastructure. Defaulted for $SUEDE and configurable for your own token.</span>
      </div>
      <div class="footer-links">
        <a href="https://suedeai.ai" target="_blank" rel="noreferrer">suedeai.ai</a>
        <a href="https://suedeai.ai/founder" target="_blank" rel="noreferrer">Jason Colapietro</a>
        <a href="https://t.me/AISUEDE" target="_blank" rel="noreferrer">@AISUEDE</a>
      </div>
    </div>
  </footer>
  <script>
    const DASHBOARD_TOKEN = "${DASHBOARD_TOKEN}";
    const keys = [
      "MODE", "DRY_RUN", "USE_VALUATION_QUOTES", "CYCLES", "PULSE_TRADE_PCT", "TRADE_AMOUNT_SOL_MIN",
      "TRADE_AMOUNT_SOL_MAX", "DELAY_MIN_SEC", "DELAY_MAX_SEC",
      "TARGET_TOKEN_VALUE_PCT", "INVENTORY_BAND_PCT", "MAX_PRICE_IMPACT_PCT",
      "API_MIN_INTERVAL_MS", "API_RATE_LIMIT_COOLDOWN_MS",
      "WALLET_COOLDOWN_SEC", "ACTIVE_MAKER_COUNT", "MAX_CYCLES_PER_WALLET",
      "MIN_SOL_RESERVE", "AUTO_TOP_UP_ENABLED", "AUTO_TOP_UP_MIN_SOL",
      "AUTO_TOP_UP_TARGET_SOL", "AUTO_SWEEP_BACK_ENABLED", "AUTO_SWEEP_ON_START",
      "AUTO_SWEEP_RESERVE_SOL", "STARTUP_SCAN_ENABLED"
    ];
    const logs = document.getElementById("logs");
    const newline = String.fromCharCode(10);
    let latestStatus = null;
    const dirtyKeys = new Set();

    function values() {
      return Object.fromEntries(keys.map((key) => [key, document.getElementById(key).value]));
    }

    function append(line) {
      if (logs.textContent && !logs.textContent.endsWith(newline)) {
        logs.textContent += newline;
      }
      logs.textContent += line + newline;
      logs.scrollTop = logs.scrollHeight;
    }

    function lines(parts) {
      return parts.join(newline);
    }

    function shortKey(key) {
      if (!key || key.length < 12) return key || "";
      return key.slice(0, 5) + "..." + key.slice(-5);
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function formatAmount(value, decimals) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
      return Number(value).toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
      });
    }

    async function api(path, options) {
      const opts = options || {};
      const headers = Object.assign({ "x-dashboard-token": DASHBOARD_TOKEN }, opts.headers || {});
      const res = await fetch(path, Object.assign({}, opts, { headers }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    function paintStatus(status) {
      latestStatus = status;
      document.getElementById("dot").classList.toggle("on", status.running);
      document.getElementById("status").textContent = status.running
        ? "Running pid " + status.pid
        : "Stopped";
      document.getElementById("summaryStatus").textContent = status.running ? "Running" : "Stopped";
      document.getElementById("start").textContent = status.running ? "Apply & Restart" : "Start";
      document.getElementById("summaryMode").textContent = status.config.MODE || "-";
      const activeMakerCount = Number(status.config.ACTIVE_MAKER_COUNT || 0);
      const cooldownSec = Number(status.config.WALLET_COOLDOWN_SEC || 0);
      document.getElementById("summaryRotation").textContent =
        (activeMakerCount > 0 ? activeMakerCount + " active" : "all enabled") +
        " / " + cooldownSec + "s";
      document.getElementById("walletPanelHint").textContent = status.running ? "Stop bot to edit" : "Ready to edit";
      for (const key of keys) {
        const el = document.getElementById(key);
        if (el && status.config[key] !== undefined && !dirtyKeys.has(key)) el.value = status.config[key];
      }
      document.getElementById("walletTotal").textContent = status.wallets.length + (status.wallets.length === 1 ? " wallet" : " wallets");
      const enabledCount = status.wallets.filter((w) => w.enabled).length;
      document.getElementById("walletEnabledTotal").textContent = enabledCount + " enabled";
      document.getElementById("summaryWallets").textContent = enabledCount + " / " + status.wallets.length;
      document.getElementById("fundingGuide").value = '~' + Number(status.funding.recommended).toFixed(3) + ' SOL each';
    }

    async function refreshStatus() {
      try {
        paintStatus(await api("/api/status"));
      } catch (err) {
        append("[dashboard] status refresh failed: " + err.message);
      }
    }

    async function load() {
      const status = await api("/api/status");
      paintStatus(status);
      document.getElementById("walletSolTotal").textContent = "checking...";
      document.getElementById("walletTokenTotal").textContent = "checking...";
      document.getElementById("enabledSolTotal").textContent = "checking...";
      document.getElementById("enabledTokenTotal").textContent = "checking...";
      document.getElementById("walletWarning").style.display = "none";
      document.getElementById("wallets").innerHTML = status.wallets.length
        ? status.wallets.map((w) => {
            const enabled = w.enabled !== false;
            const publicKey = escapeHtml(w.publicKey);
            return '<div class="row wallet-row ' + (enabled ? '' : 'wallet-disabled') + '">' +
              '<span class="wallet-index">#' + w.index + '</span>' +
              '<code class="wallet-key" title="' + publicKey + '">' + shortKey(w.publicKey) + '</code>' +
              '<div class="wallet-balances" id="walletBalance-' + w.index + '">checking...</div>' +
              '<span class="pill ' + (enabled ? 'on' : 'off') + '">' + (enabled ? 'enabled' : 'disabled') + '</span>' +
              '<div class="wallet-card-actions">' +
                '<button class="button-quiet" data-wallet-copy="' + publicKey + '">Copy</button>' +
                '<button data-wallet-toggle="' + w.index + '" data-enabled="' + (!enabled) + '">' + (enabled ? 'Disable' : 'Enable') + '</button>' +
              '</div>' +
            '</div>';
          }).join("")
        : '<div class="muted">No managed wallets yet. Choose a wallet count above, then select Add Wallets.</div>';
      logs.textContent = (status.logs || []).join(newline);
      if (logs.textContent) logs.textContent += newline;
      logs.scrollTop = logs.scrollHeight;
      await loadFunding();
      await loadFees();
      await loadTrades();
      loadWalletBalances();
    }

    async function loadWalletBalances() {
      try {
        const data = await api("/api/wallets/balances");
        for (const wallet of data.wallets) {
          const el = document.getElementById("walletBalance-" + wallet.index);
          if (!el) continue;
          if (wallet.error) {
            el.classList.add("error");
            el.textContent = "balance unavailable";
            el.title = wallet.error;
            continue;
          }
          el.classList.remove("error");
          el.innerHTML = '<span><b>' + formatAmount(wallet.solBalance, 4) + '</b><small>SOL</small></span>' +
            '<span><b>' + formatAmount(wallet.tokenBalance, 2) + '</b><small>SUEDE</small></span>';
        }
        if (data.totals) {
          document.getElementById("walletSolTotal").textContent =
            formatAmount(data.totals.solBalance, 4) + " SOL";
          document.getElementById("walletTokenTotal").textContent =
            formatAmount(data.totals.tokenBalance, 2) + " SUEDE";
          document.getElementById("enabledSolTotal").textContent =
            formatAmount(data.totals.enabledSolBalance, 4) + " SOL";
          document.getElementById("enabledTokenTotal").textContent =
            formatAmount(data.totals.enabledTokenBalance, 2) + " SUEDE";

          const disabledTokenBalance = data.totals.tokenBalance - data.totals.enabledTokenBalance;
          const warning = document.getElementById("walletWarning");
          if (latestStatus?.running && data.totals.enabledTokenBalance < 1 && disabledTokenBalance > 1) {
            warning.style.display = "block";
            warning.textContent = "Bot is running, but the SUEDE is mostly in disabled wallets. The enabled wallets have almost no SUEDE, so the bot is skipping decisions. Stop the bot, enable funded wallets or fund enabled wallets, then start again.";
          } else if (latestStatus?.running && data.totals.enabledSolBalance < 1) {
            warning.style.display = "block";
            warning.textContent = "Bot is running, but enabled wallets are lightly funded. If logs show NEEDS SOL, add SOL to enabled wallets or lower trade sizing before expecting trades.";
          } else {
            warning.style.display = "none";
          }
        }
      } catch (err) {
        append("[wallets] balance check failed: " + err.message);
        document.getElementById("walletSolTotal").textContent = "unavailable";
        document.getElementById("walletTokenTotal").textContent = "unavailable";
        document.getElementById("enabledSolTotal").textContent = "unavailable";
        document.getElementById("enabledTokenTotal").textContent = "unavailable";
      }
    }

    async function loadFunding() {
      try {
        const funding = await api("/api/funding/status");
        document.getElementById("fundingAddress").value = funding.publicKey;
        document.getElementById("fundingBalance").value = Number(funding.balanceSol).toFixed(6) + " SOL";
        document.getElementById("fundingWalletCount").value = funding.managedWalletCount + " wallets";
        document.getElementById("summaryFunding").textContent = Number(funding.balanceSol).toFixed(4) + " SOL";
      } catch (err) {
        document.getElementById("fundingAddress").value = err.message;
        document.getElementById("fundingBalance").value = "";
        document.getElementById("fundingWalletCount").value = "";
        document.getElementById("summaryFunding").textContent = "Unavailable";
      }
    }

    async function copyFundingAddress() {
      const input = document.getElementById("fundingAddress");
      const address = input.value;
      if (!address) return;
      try {
        await navigator.clipboard.writeText(address);
        append("[funding] copied funding address");
        showFundingResult(lines(["Funding address copied:", address]));
      } catch {
        input.focus();
        input.select();
        append("[funding] funding address selected");
        showFundingResult(lines(["Funding address selected:", address]));
      }
    }

    function showFundingResult(text) {
      const box = document.getElementById("fundingResult");
      box.style.display = "block";
      box.textContent = text;
    }

    async function loadTrades() {
      try {
        const data = await api("/api/trades");
        document.getElementById("trades").innerHTML = data.trades.length
          ? data.trades.slice(-20).reverse().map((t) => {
              const side = escapeHtml(t.side || t.type || "-");
              const amount = t.solAmount ? Number(t.solAmount).toFixed(4) + " SOL" : "";
              const fee = typeof t.feeSol === "number" ? " fee " + Number(t.feeSol).toFixed(6) + " SOL" : "";
              const wallet = t.wallet ? shortKey(t.wallet) : "";
              return '<div class="row"><span>' + side + ' ' + amount + fee + '</span><code>' + wallet + '</code></div>';
            }).join("")
          : '<div class="muted">No trades logged yet. Start the bot in dry-run or live mode to populate the ledger.</div>';
      } catch (err) {
        document.getElementById("trades").innerHTML = '<div class="muted">Trades unavailable. Refresh when the dashboard is ready.</div>';
      }
    }

    async function loadFees() {
      try {
        const data = await api("/api/fees");
        document.getElementById("summaryFees").textContent = Number(data.totalFeeSol).toFixed(6) + " SOL";
        document.getElementById("feeTotal").textContent = Number(data.totalFeeSol).toFixed(6) + " SOL";
        document.getElementById("feeTrades").textContent = data.trackedTrades + " / " + data.totalTrades;
        document.getElementById("feeBuySol").textContent = Number(data.totalBuySol).toFixed(4) + " SOL";
        document.getElementById("feeSellSol").textContent = Number(data.totalSellSol).toFixed(4) + " SOL";
        document.getElementById("feeNote").textContent = data.untrackedTrades > 0
          ? data.untrackedTrades + " older trade(s) happened before fee tracking was added."
          : "";
      } catch (err) {
        document.getElementById("summaryFees").textContent = "Unavailable";
        document.getElementById("feeTotal").textContent = "unavailable";
        document.getElementById("feeTrades").textContent = "unavailable";
        document.getElementById("feeBuySol").textContent = "unavailable";
        document.getElementById("feeSellSol").textContent = "unavailable";
      }
    }

    document.getElementById("start").onclick = async () => {
      try {
        await api("/api/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(values()),
        });
        dirtyKeys.clear();
        await load();
      } catch (err) {
        append("[dashboard] " + err.message);
      }
    };
    document.getElementById("stop").onclick = async () => {
      try {
        await api("/api/stop", { method: "POST" });
        await load();
      } catch (err) {
        append("[dashboard] " + err.message);
      }
    };
    document.getElementById("refresh").onclick = load;
    document.getElementById("refreshBalances").onclick = loadWalletBalances;
    document.getElementById("fundRefresh").onclick = loadFunding;
    document.getElementById("copyFundingAddress").onclick = copyFundingAddress;
    document.getElementById("copyFundingAddressAlt").onclick = copyFundingAddress;
    document.getElementById("clearLogs").onclick = () => { logs.textContent = ""; };
    document.getElementById("addWallets").onclick = async () => {
      try {
        const count = Number(document.getElementById("walletCount").value || 1);
        const data = await api("/api/wallets/add", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ count }),
        });
        append("[dashboard] added " + data.created.length + " wallet(s)");
        await load();
      } catch (err) {
        append("[dashboard] " + err.message);
      }
    };
    document.getElementById("wallets").onclick = async (event) => {
      const copy = event.target.closest("[data-wallet-copy]");
      if (copy) {
        const key = copy.getAttribute("data-wallet-copy");
        try {
          await navigator.clipboard.writeText(key);
          append("[wallets] copied " + key);
        } catch {
          append("[wallets] " + key);
        }
        return;
      }
      const toggle = event.target.closest("[data-wallet-toggle]");
      if (toggle) {
        try {
          await api("/api/wallets/enabled", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              index: Number(toggle.getAttribute("data-wallet-toggle")),
              enabled: toggle.getAttribute("data-enabled") === "true",
            }),
          });
          await load();
        } catch (err) {
          append("[wallets] " + err.message);
        }
      }
    };
    document.getElementById("enableAllWallets").onclick = async () => {
      try {
        await api("/api/wallets/enabled-all", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        });
        await load();
      } catch (err) {
        append("[wallets] " + err.message);
      }
    };
    document.getElementById("useFundedWallets").onclick = async () => {
      try {
        const status = await api("/api/status");
        if (status.running) {
          append("[wallets] stopping bot before changing enabled wallets");
          await api("/api/stop", { method: "POST" });
        }
        const result = await api("/api/wallets/enable-funded", { method: "POST" });
        append("[wallets] enabled " + result.enabled + " funded wallet(s), disabled " + result.disabled + " empty wallet(s)");
        await load();
      } catch (err) {
        append("[wallets] " + err.message);
      }
    };
    document.getElementById("disableAllWallets").onclick = async () => {
      try {
        await api("/api/wallets/enabled-all", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        });
        await load();
      } catch (err) {
        append("[wallets] " + err.message);
      }
    };
    document.getElementById("removeDisabledWallets").onclick = async () => {
      try {
        const result = await api("/api/wallets/remove-disabled", { method: "POST" });
        append("[wallets] removed " + result.removed + " disabled wallet(s)" + (result.backupPath ? "; backup saved" : ""));
        await load();
      } catch (err) {
        append("[wallets] " + err.message);
      }
    };
    async function fundingAction(path, dryRun) {
      try {
        const data = await api(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dryRun }),
        });
        const prefix = data.dryRun ? "preview" : "sent";
        const summary = prefix + " " + data.transfers.length + " transfer(s), " + Number(data.totalSol).toFixed(6) + " SOL total";
        append("[funding] " + summary);
        showFundingResult(lines([
          summary,
          "Funding wallet: " + data.sourcePublicKey,
          "Estimated fees: " + Number(data.estimatedFeeSol).toFixed(6) + " SOL",
        ]));
        await loadFunding();
      } catch (err) {
        append("[funding] " + err.message);
        showFundingResult(err.message);
      }
    }
    document.getElementById("fundDistributeDry").onclick = () => fundingAction("/api/funding/distribute", true);
    document.getElementById("fundDistribute").onclick = () => fundingAction("/api/funding/distribute", false);
    document.getElementById("fundSweepDry").onclick = () => fundingAction("/api/funding/sweep", true);
    document.getElementById("fundSweep").onclick = () => fundingAction("/api/funding/sweep", false);

    const stream = new EventSource("/api/logs");
    stream.onmessage = (event) => {
      const line = JSON.parse(event.data);
      append(line);
      if (line.includes("started bot") || line.includes("bot exited")) {
        refreshStatus();
      }
    };
    for (const key of keys) {
      const el = document.getElementById(key);
      if (el) el.addEventListener("input", () => dirtyKeys.add(key));
      if (el) el.addEventListener("change", () => dirtyKeys.add(key));
    }
    setInterval(refreshStatus, 3000);
    setInterval(loadTrades, 5000);
    setInterval(loadFees, 5000);
    load().catch((err) => append("[dashboard] " + err.message));
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && req.headers["x-dashboard-token"] !== DASHBOARD_TOKEN) {
      json(res, { error: "Missing or invalid dashboard token" }, 401);
      return;
    }

    if (req.method === "GET" && url.pathname === "/suede-logo.png") {
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600",
      });
      fs.createReadStream(SUEDE_LOGO_PATH).pipe(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, statusPayload());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/trades") {
      json(res, { trades: readLedger() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/fees") {
      json(res, feePayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/wallets/add") {
      if (requireBotStopped(res, "adding wallets")) return;
      const body = await readBody(req);
      const count = Number(body.count || 1);
      json(res, { created: addWallets(count), wallets: readWallets() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/wallets/enabled") {
      if (requireBotStopped(res, "changing wallets")) return;
      const body = await readBody(req);
      json(res, {
        wallets: setWalletEnabled(Number(body.index), body.enabled === true || body.enabled === "true"),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/wallets/enabled-all") {
      if (requireBotStopped(res, "changing wallets")) return;
      const body = await readBody(req);
      json(res, {
        wallets: setAllWalletsEnabled(body.enabled === true || body.enabled === "true"),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/wallets/enable-funded") {
      if (requireBotStopped(res, "changing wallets")) return;
      json(res, await enableFundedWallets());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/wallets/remove-disabled") {
      if (requireBotStopped(res, "removing wallets")) return;
      json(res, removeDisabledWallets());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/wallets/balances") {
      const balances = await readWalletBalances();
      const safeWallets = balances.wallets.map((row) => {
        const { privateKey: _privateKey, ...safe } = row as Record<string, unknown>;
        return safe;
      });
      json(res, { ...balances, wallets: safeWallets });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/funding/status") {
      json(res, await getFundingStatus());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/funding/distribute") {
      if (requireBotStopped(res, "distributing SOL")) return;
      const body = await readBody(req);
      const result = await distributeFunding(body.dryRun === true || body.dryRun === "true");
      summarizeFunding("distribute", result);
      json(res, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/funding/sweep") {
      if (requireBotStopped(res, "sweeping SOL")) return;
      const body = await readBody(req);
      const result = await sweepFunding(body.dryRun === true || body.dryRun === "true");
      summarizeFunding("sweep", result);
      json(res, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      req.on("close", () => clients.delete(res));
      res.write(`data: ${JSON.stringify("[dashboard] log stream connected")}\n\n`);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      const body = await readBody(req);
      if (bot && !botExited) {
        stopBot();
        await waitForBotExit();
      }
      startBot(
        Object.fromEntries(
          Object.entries(body).map(([key, value]) => [key, String(value)])
        )
      );
      json(res, statusPayload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      const stopped = stopBot();
      json(res, { stopped, ...statusPayload() });
      return;
    }

    json(res, { error: "Not found" }, 404);
  } catch (err) {
    json(res, { error: (err as Error).message }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  appendLog(`[dashboard] listening on http://localhost:${PORT}`);
  console.log(`Dashboard listening on http://localhost:${PORT}`);
  console.log(`Dashboard token: ${DASHBOARD_TOKEN}`);
});

process.on("SIGINT", () => {
  stopBot();
  server.close(() => process.exit(0));
});
