import fs from "fs";
import path from "path";

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

export interface LedgerEvent {
  type: string;
  wallet?: string;
  side?: "BUY" | "SELL" | "HOLD" | "SKIP";
  cycle?: number;
  signature?: string;
  reason?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export const log = {
  info: (msg: string) =>
    console.log(`${CYAN}[${ts()}]${RESET} ${msg}`),

  success: (msg: string) =>
    console.log(`${GREEN}${BOLD}[${ts()}] ✓ ${msg}${RESET}`),

  warn: (msg: string) =>
    console.log(`${YELLOW}[${ts()}] ⚠ ${msg}${RESET}`),

  error: (msg: string) =>
    console.error(`${RED}[${ts()}] ✗ ${msg}${RESET}`),

  trade: (
    direction: "BUY " | "SELL",
    wallet: string,
    amountSol: number,
    amountToken: number,
    sig: string,
    feeSol?: number | null
  ) => {
    const arrow = direction === "BUY " ? "→" : "←";
    const color = direction === "BUY " ? GREEN : YELLOW;
    console.log(
      `${color}${BOLD}[${ts()}] ${direction}${RESET}` +
      ` wallet=${shortKey(wallet)}` +
      ` ${amountSol.toFixed(4)} SOL ${arrow} ${amountToken.toFixed(2)} $SUEDE` +
      `  sig=${sig.slice(0, 8)}…` +
      (feeSol === undefined || feeSol === null ? "" : `  fee=${feeSol.toFixed(6)} SOL`)
    );
  },

  stats: (
    cyclesDone: number,
    totalTrades: number,
    totalSolBought: number,
    totalSolSold: number,
    dryRun: boolean,
    totalFeesSol = 0
  ) => {
    console.log(
      `\n${BOLD}${CYAN}━━━ Stats ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n` +
      `  Cycles completed : ${cyclesDone}\n` +
      `  Total trades     : ${totalTrades}\n` +
      `  SOL spent buying : ${totalSolBought.toFixed(4)}\n` +
      `  SOL received sell: ${totalSolSold.toFixed(4)}\n` +
      `  SOL spent fees   : ${totalFeesSol.toFixed(6)}\n` +
      `  Mode             : ${dryRun ? "DRY RUN" : "LIVE"}\n` +
      `${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`
    );
  },

  decision: (
    side: "BUY" | "SELL" | "HOLD" | "SKIP",
    wallet: string,
    tokenPct: number,
    reason: string
  ) => {
    const color = side === "BUY" ? GREEN : side === "SELL" ? YELLOW : CYAN;
    console.log(
      `${color}[${ts()}] ${side.padEnd(4)}${RESET}` +
      ` wallet=${shortKey(wallet)}` +
      ` tokenValue=${tokenPct.toFixed(1)}%` +
      ` ${reason}`
    );
  },

  ledger: (ledgerPath: string, event: LedgerEvent) => {
    const target = path.resolve(process.cwd(), ledgerPath);
    fs.appendFileSync(
      target,
      `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`
    );
  },

  shortKey,
};
