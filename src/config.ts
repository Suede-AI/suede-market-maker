import dotenv from "dotenv";
import path from "path";
import { SUEDE_TOKEN_DECIMALS, SUEDE_TOKEN_MINT } from "./suede";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseFloat(v);
  if (isNaN(n)) throw new Error(`${key} must be a number, got: ${v}`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(v.trim().toLowerCase());
}

const mode = (process.env.MODE ?? "hybrid").trim().toLowerCase();

export const config = {
  rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
  // Optional — if empty the bot auto-generates wallets and saves them to wallets.json
  privateKeys: (process.env.PRIVATE_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
  // How many wallets to auto-generate when none are provided
  walletCount: Math.round(num("WALLET_COUNT", 3)),
  tokenMint: process.env.TOKEN_MINT ?? SUEDE_TOKEN_MINT,
  tradeAmountSolMin: num("TRADE_AMOUNT_SOL_MIN", 0.01),
  tradeAmountSolMax: num("TRADE_AMOUNT_SOL_MAX", 0.05),
  delayMinSec: num("DELAY_MIN_SEC", 15),
  delayMaxSec: num("DELAY_MAX_SEC", 45),
  slippageBps: Math.round(num("SLIPPAGE_BPS", 300)),
  cycles: Math.round(num("CYCLES", 0)),
  priorityFeeMicrolamports: Math.round(num("PRIORITY_FEE_MICROLAMPORTS", 5000)),
  apiRetryAttempts: Math.round(num("API_RETRY_ATTEMPTS", 5)),
  apiRetryBaseDelayMs: Math.round(num("API_RETRY_BASE_DELAY_MS", 1500)),
  apiMinIntervalMs: Math.round(num("API_MIN_INTERVAL_MS", 1500)),
  apiRateLimitCooldownMs: Math.round(num("API_RATE_LIMIT_COOLDOWN_MS", 30000)),
  tokenDecimals: Math.round(num("TOKEN_DECIMALS", SUEDE_TOKEN_DECIMALS)),
  dryRun: bool("DRY_RUN", false),
  targetTokenValuePct: num("TARGET_TOKEN_VALUE_PCT", 50),
  inventoryBandPct: num("INVENTORY_BAND_PCT", 12),
  maxPriceImpactPct: num("MAX_PRICE_IMPACT_PCT", 3),
  maxConsecutiveFailures: Math.round(num("MAX_CONSECUTIVE_FAILURES", 5)),
  maxCyclesPerWallet: Math.round(num("MAX_CYCLES_PER_WALLET", 0)),
  walletCooldownSec: num("WALLET_COOLDOWN_SEC", 90),
  activeMakerCount: Math.round(num("ACTIVE_MAKER_COUNT", 0)),
  minSolReserve: num("MIN_SOL_RESERVE", 0.005),
  autoTopUpEnabled: bool("AUTO_TOP_UP_ENABLED", false),
  autoTopUpMinSol: num("AUTO_TOP_UP_MIN_SOL", 0.012),
  autoTopUpTargetSol: num("AUTO_TOP_UP_TARGET_SOL", 0.08),
  autoSweepBackEnabled: bool("AUTO_SWEEP_BACK_ENABLED", true),
  autoSweepOnStart: bool("AUTO_SWEEP_ON_START", true),
  autoSweepReserveSol: num("AUTO_SWEEP_RESERVE_SOL", num("SWEEP_WALLET_RESERVE_SOL", 0.005)),
  startupScanEnabled: bool("STARTUP_SCAN_ENABLED", false),
  ledgerPath: process.env.LEDGER_PATH ?? "trades.jsonl",
  mode,
  pulseTradePct: num("PULSE_TRADE_PCT", 25),
  useValuationQuotes: bool("USE_VALUATION_QUOTES", mode !== "pulse"),
};

if (config.tradeAmountSolMin > config.tradeAmountSolMax) {
  throw new Error("TRADE_AMOUNT_SOL_MIN must be <= TRADE_AMOUNT_SOL_MAX");
}

if (config.targetTokenValuePct <= 0 || config.targetTokenValuePct >= 100) {
  throw new Error("TARGET_TOKEN_VALUE_PCT must be greater than 0 and less than 100");
}

if (config.inventoryBandPct <= 0 || config.inventoryBandPct >= 50) {
  throw new Error("INVENTORY_BAND_PCT must be greater than 0 and less than 50");
}

if (config.tokenDecimals < 0 || config.tokenDecimals > 12) {
  throw new Error("TOKEN_DECIMALS must be between 0 and 12");
}

if (!["rebalance", "pulse", "hybrid"].includes(config.mode)) {
  throw new Error("MODE must be rebalance, pulse, or hybrid");
}

if (config.pulseTradePct <= 0 || config.pulseTradePct > 100) {
  throw new Error("PULSE_TRADE_PCT must be greater than 0 and <= 100");
}

if (config.walletCooldownSec < 0) {
  throw new Error("WALLET_COOLDOWN_SEC must be >= 0");
}

if (config.activeMakerCount < 0) {
  throw new Error("ACTIVE_MAKER_COUNT must be >= 0");
}

if (config.apiMinIntervalMs < 0) {
  throw new Error("API_MIN_INTERVAL_MS must be >= 0");
}

if (config.apiRateLimitCooldownMs < 0) {
  throw new Error("API_RATE_LIMIT_COOLDOWN_MS must be >= 0");
}

if (config.autoTopUpMinSol < 0) {
  throw new Error("AUTO_TOP_UP_MIN_SOL must be >= 0");
}

if (config.autoTopUpTargetSol <= 0) {
  throw new Error("AUTO_TOP_UP_TARGET_SOL must be > 0");
}

if (config.autoTopUpEnabled && config.autoTopUpTargetSol <= config.autoTopUpMinSol) {
  throw new Error("AUTO_TOP_UP_TARGET_SOL must be greater than AUTO_TOP_UP_MIN_SOL");
}

if (config.autoSweepReserveSol < 0) {
  throw new Error("AUTO_SWEEP_RESERVE_SOL must be >= 0");
}
