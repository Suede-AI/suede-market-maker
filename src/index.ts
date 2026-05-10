/**
 * $SUEDE Market Maker
 * ─────────────────────────────────────────────────────────────────────────────
 * Rebalances each wallet toward a target SOL/SUEDE inventory split.
 *
 * This is intentionally inventory-led:
 *   - BUY only when SUEDE value is below the lower band.
 *   - SELL only when SUEDE value is above the upper band.
 *   - In hybrid mode, pulse small alternating trades inside the band.
 *   - HOLD inside the band only when MODE=rebalance.
 *   - Skip quotes with excessive reported price impact.
 *   - Stop after repeated failures.
 *
 * Configure via .env.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { config } from "./config";
import {
  getQuote,
  executeSwap,
  getSolBalance,
  getTokenBalance,
  SOL_MINT,
  sleep,
  type QuoteResponse,
} from "./jupiter";
import { resolveWallets, randBetween, randIntBetween } from "./wallet";
import { pickRotatingWallet, nextCooldownWaitMs } from "./rotation";
import { ensureWalletTopUp, getFundingSpendableStatus, sweepWalletBackToFunding } from "./funding";
import { log } from "./logger";

const LAMPORTS_PER_SOL = 1_000_000_000;
const SELL_BACK_MIN_PENDING = 3;
const SELL_BACK_CHANCE = 0.4;

interface WalletState {
  wallet: Keypair;
  solBalance: number;
  tokenBalance: number;
  tokenValueSol: number;
  totalValueSol: number;
  tokenValuePct: number;
  autoTopUpSent?: boolean;
  plannedTradeSol?: number;
}

interface Totals {
  cyclesDone: number;
  totalTrades: number;
  totalSolBought: number;
  totalSolSold: number;
  totalFeesSol: number;
  consecutiveFailures: number;
}

type TradeSide = "BUY" | "SELL";

function tokenRawAmount(uiAmount: number): number {
  return Math.floor(uiAmount * 10 ** config.tokenDecimals);
}

function tokenUiAmount(rawAmount: string | number): number {
  return Number(rawAmount) / 10 ** config.tokenDecimals;
}

function parsePriceImpactPct(quote: QuoteResponse): number {
  const impact = Number(quote.priceImpactPct ?? 0);
  return Number.isFinite(impact) ? Math.abs(impact) : 0;
}

function quoteOutSol(quote: QuoteResponse): number {
  return Number(quote.outAmount) / LAMPORTS_PER_SOL;
}

function quoteOutToken(quote: QuoteResponse): number {
  return tokenUiAmount(quote.outAmount);
}

function targetBounds() {
  const lower = config.targetTokenValuePct - config.inventoryBandPct;
  const upper = config.targetTokenValuePct + config.inventoryBandPct;
  return { lower, upper };
}

function clampTradeSol(wallet: WalletState): number {
  const randomSol = wallet.plannedTradeSol ?? randBetween(config.tradeAmountSolMin, config.tradeAmountSolMax);
  const available = Math.max(0, wallet.solBalance - config.minSolReserve);
  return Math.min(randomSol, available);
}

function planBuyAmountSol(): number {
  return randBetween(config.tradeAmountSolMin, config.tradeAmountSolMax);
}

function topUpTargetForTrade(plannedTradeSol: number): number {
  const neededSol = plannedTradeSol + config.minSolReserve;
  return Math.min(neededSol, config.autoTopUpTargetSol);
}

function pickPendingSellBack(
  pendingSellBacks: Map<string, Keypair>,
  rng = Math.random
): [string, Keypair] | undefined {
  const entries = [...pendingSellBacks.entries()];
  if (entries.length === 0) return undefined;
  return entries[Math.floor(rng() * entries.length)];
}

function canPulseBuy(state: WalletState): boolean {
  return clampTradeSol(state) >= config.tradeAmountSolMin;
}

function canPulseSell(state: WalletState): boolean {
  return state.tokenBalance > 0;
}

async function estimateTokenValueSol(
  wallet: WalletState,
  tokenMint: PublicKey
): Promise<number> {
  if (wallet.tokenBalance <= 0) return 0;

  const rawAmount = tokenRawAmount(wallet.tokenBalance);
  if (rawAmount <= 0) return 0;

  const quote = await getQuote(config.tokenMint, SOL_MINT, rawAmount);
  const impactPct = parsePriceImpactPct(quote);
  if (impactPct > config.maxPriceImpactPct) {
    log.warn(
      `Valuation quote for ${log.shortKey(wallet.wallet.publicKey.toString())}` +
      ` has ${impactPct.toFixed(2)}% impact; using conservative 0 token value for decision`
    );
    log.ledger(config.ledgerPath, {
      type: "valuation_skip",
      wallet: wallet.wallet.publicKey.toString(),
      tokenMint: tokenMint.toString(),
      tokenBalance: wallet.tokenBalance,
      priceImpactPct: impactPct,
    });
    return 0;
  }

  return quoteOutSol(quote);
}

async function loadWalletState(
  connection: Connection,
  wallet: Keypair,
  tokenMint: PublicKey,
  useValuation = config.useValuationQuotes
): Promise<WalletState> {
  const [solBalance, tokenBalance] = await Promise.all([
    getSolBalance(connection, wallet.publicKey),
    getTokenBalance(connection, wallet.publicKey, tokenMint),
  ]);

  const partial: WalletState = {
    wallet,
    solBalance,
    tokenBalance,
    tokenValueSol: 0,
    totalValueSol: solBalance,
    tokenValuePct: 0,
  };
  const tokenValueSol = useValuation ? await estimateTokenValueSol(partial, tokenMint) : 0;
  const totalValueSol = solBalance + tokenValueSol;
  const tokenValuePct = totalValueSol > 0 ? (tokenValueSol / totalValueSol) * 100 : 0;

  return {
    ...partial,
    tokenValueSol,
    totalValueSol,
    tokenValuePct,
  };
}

async function maybeAutoTopUp(
  connection: Connection,
  state: WalletState,
  tokenMintPubkey: PublicKey
): Promise<WalletState> {
  if (!config.autoTopUpEnabled) {
    return state;
  }

  const plannedTradeSol = planBuyAmountSol();
  const targetSol = topUpTargetForTrade(plannedTradeSol);
  if (state.solBalance >= targetSol) {
    return {
      ...state,
      plannedTradeSol,
    };
  }

  const funding = await getFundingSpendableStatus(connection);
  const minimumBuyTargetSol = config.tradeAmountSolMin + config.minSolReserve;
  const affordableTargetSol = Math.min(targetSol, state.solBalance + funding.spendableSol);
  if (!config.dryRun && affordableTargetSol < minimumBuyTargetSol) {
    log.warn(
      `Funding wallet low: ${funding.spendableSol.toFixed(6)} SOL spendable; ` +
      `new BUY needs at least ${(minimumBuyTargetSol - state.solBalance).toFixed(6)} SOL`
    );
    log.ledger(config.ledgerPath, {
      type: "top_up_skip",
      reason: "funding_below_min_buy",
      wallet: state.wallet.publicKey.toString(),
      sourcePublicKey: funding.sourcePublicKey,
      fundingSpendableSol: funding.spendableSol,
      currentSol: state.solBalance,
      minimumBuyTargetSol,
      plannedTargetSol: targetSol,
    });
    return {
      ...state,
      plannedTradeSol: 0,
    };
  }

  const adjustedTradeSol = Math.max(0, affordableTargetSol - config.minSolReserve);

  const walletStr = state.wallet.publicKey.toString();
  log.info(
    `Auto top-up ${log.shortKey(walletStr)}: ` +
    `${state.solBalance.toFixed(6)} SOL below planned ${affordableTargetSol.toFixed(6)} SOL`
  );

  const result = await ensureWalletTopUp(
    connection,
    state.wallet.publicKey,
    state.solBalance,
    config.dryRun,
    config.dryRun ? targetSol : affordableTargetSol
  );

  log.ledger(config.ledgerPath, {
    type: config.dryRun ? "dry_run_top_up" : "top_up",
    wallet: result.wallet,
    sourcePublicKey: result.sourcePublicKey,
    currentSol: result.currentSol,
    targetSol: result.targetSol,
    transferSol: result.transferSol,
    signature: result.signature,
  });

  if (!result.toppedUp || config.dryRun) {
    return {
      ...state,
      autoTopUpSent: result.toppedUp,
      plannedTradeSol: config.dryRun ? plannedTradeSol : adjustedTradeSol,
    };
  }

  log.info(
    `Top-up sent ${result.transferSol.toFixed(6)} SOL to ${log.shortKey(walletStr)}` +
    ` (${result.signature})`
  );

  return {
    ...(await loadWalletState(connection, state.wallet, tokenMintPubkey)),
    autoTopUpSent: true,
    plannedTradeSol: adjustedTradeSol,
  };
}

async function sweepBackWallet(connection: Connection, wallet: Keypair): Promise<void> {
  if (!config.autoTopUpEnabled || !config.autoSweepBackEnabled) return;

  const result = await sweepWalletBackToFunding(connection, wallet, config.dryRun);
  log.ledger(config.ledgerPath, {
    type: config.dryRun ? "dry_run_sweep_back" : "sweep_back",
    wallet: result.wallet,
    sourcePublicKey: result.sourcePublicKey,
    balanceSol: result.balanceSol,
    reserveSol: result.reserveSol,
    sweepSol: result.sweepSol,
    signature: result.signature,
  });

  if (result.swept) {
    log.info(
      `Sweep back ${log.shortKey(result.wallet)} → funding wallet: ` +
      `${result.sweepSol.toFixed(6)} SOL${result.signature ? ` (${result.signature})` : ""}`
    );
  }
}

async function sweepPendingWallets(
  connection: Connection,
  pendingSweeps: Map<string, Keypair>,
  currentWallet?: Keypair
): Promise<void> {
  if (!config.autoTopUpEnabled || !config.autoSweepBackEnabled || pendingSweeps.size === 0) {
    return;
  }

  const currentKey = currentWallet?.publicKey.toString();
  for (const [walletStr, wallet] of [...pendingSweeps.entries()]) {
    if (walletStr === currentKey) continue;
    pendingSweeps.delete(walletStr);
    try {
      await sweepBackWallet(connection, wallet);
    } catch (err) {
      pendingSweeps.set(walletStr, wallet);
      log.warn(`Sweep back skipped for ${log.shortKey(walletStr)}: ${(err as Error).message}`);
      log.ledger(config.ledgerPath, {
        type: "sweep_back_error",
        wallet: walletStr,
        message: (err as Error).message,
      });
    }
  }
}

function assertQuoteSafe(quote: QuoteResponse, side: "BUY" | "SELL") {
  const impactPct = parsePriceImpactPct(quote);
  if (impactPct > config.maxPriceImpactPct) {
    throw new Error(
      `${side} quote price impact ${impactPct.toFixed(2)}% exceeds max ${config.maxPriceImpactPct}%`
    );
  }
}

async function maybeBuy(
  connection: Connection,
  state: WalletState,
  totals: Totals,
  tradeSolOverride?: number
): Promise<TradeSide | null> {
  const walletStr = state.wallet.publicKey.toString();
  const tradeSol = tradeSolOverride ?? clampTradeSol(state);
  const minTradeSol = config.tradeAmountSolMin;
  if (tradeSol < minTradeSol) {
    log.decision("SKIP", walletStr, state.tokenValuePct, "not enough SOL above reserve");
    log.ledger(config.ledgerPath, {
      type: "decision",
      side: "SKIP",
      reason: "not_enough_sol_above_reserve",
      wallet: walletStr,
      solBalance: state.solBalance,
      minSolReserve: config.minSolReserve,
    });
    return null;
  }

  const tradeLamports = Math.floor(tradeSol * LAMPORTS_PER_SOL);
  const quote = await getQuote(SOL_MINT, config.tokenMint, tradeLamports);
  assertQuoteSafe(quote, "BUY");
  const tokenReceived = quoteOutToken(quote);

  if (config.dryRun) {
    log.trade("BUY ", walletStr, tradeSol, tokenReceived, "dry-run");
    log.ledger(config.ledgerPath, {
      type: "dry_run_trade",
      side: "BUY",
      wallet: walletStr,
      solAmount: tradeSol,
      tokenAmount: tokenReceived,
      priceImpactPct: parsePriceImpactPct(quote),
    });
    return "BUY";
  }

  const swap = await executeSwap(connection, state.wallet, quote);
  const sig = swap.signature;
  totals.totalSolBought += tradeSol;
  totals.totalTrades++;
  if (swap.feeSol !== null) totals.totalFeesSol += swap.feeSol;
  log.trade("BUY ", walletStr, tradeSol, tokenReceived, sig, swap.feeSol);
  log.ledger(config.ledgerPath, {
    type: "trade",
    side: "BUY",
    wallet: walletStr,
    signature: sig,
    solAmount: tradeSol,
    tokenAmount: tokenReceived,
    feeLamports: swap.feeLamports,
    feeSol: swap.feeSol,
    priceImpactPct: parsePriceImpactPct(quote),
  });
  return "BUY";
}

async function maybeSell(
  connection: Connection,
  state: WalletState,
  totals: Totals,
  desiredSolOverride?: number,
  sellAll = false
): Promise<TradeSide | null> {
  const walletStr = state.wallet.publicKey.toString();
  if (state.tokenBalance <= 0) {
    log.decision("SKIP", walletStr, state.tokenValuePct, "no token inventory to sell");
    return null;
  }

  const desiredSol = desiredSolOverride ?? randBetween(config.tradeAmountSolMin, config.tradeAmountSolMax);
  let tokenToSell = sellAll ? state.tokenBalance : state.tokenValueSol > 0
    ? Math.min(state.tokenBalance, desiredSol / (state.tokenValueSol / state.tokenBalance))
    : state.tokenBalance;

  if (!sellAll && state.tokenValueSol <= 0) {
    const fullInventoryQuote = await getQuote(
      config.tokenMint,
      SOL_MINT,
      tokenRawAmount(state.tokenBalance)
    );
    const fullInventorySol = quoteOutSol(fullInventoryQuote);
    tokenToSell = fullInventorySol > desiredSol
      ? Math.min(state.tokenBalance, state.tokenBalance * (desiredSol / fullInventorySol))
      : state.tokenBalance;
  }
  const rawAmount = tokenRawAmount(tokenToSell);

  if (rawAmount <= 0) {
    log.decision("SKIP", walletStr, state.tokenValuePct, "sell amount rounds to zero");
    return null;
  }

  const quote = await getQuote(config.tokenMint, SOL_MINT, rawAmount);
  assertQuoteSafe(quote, "SELL");
  const solReceived = quoteOutSol(quote);
  if (desiredSolOverride !== undefined && solReceived < config.tradeAmountSolMin) {
    log.decision(
      "SKIP",
      walletStr,
      state.tokenValuePct,
      `token inventory only quotes ${solReceived.toFixed(4)} SOL; below min ${config.tradeAmountSolMin} SOL`
    );
    log.ledger(config.ledgerPath, {
      type: "decision",
      side: "SKIP",
      reason: "sell_below_min_sol",
      wallet: walletStr,
      solAmount: solReceived,
      tokenAmount: tokenToSell,
      minSol: config.tradeAmountSolMin,
      priceImpactPct: parsePriceImpactPct(quote),
    });
    return null;
  }

  if (config.dryRun) {
    log.trade("SELL", walletStr, solReceived, tokenToSell, "dry-run");
    log.ledger(config.ledgerPath, {
      type: "dry_run_trade",
      side: "SELL",
      wallet: walletStr,
      solAmount: solReceived,
      tokenAmount: tokenToSell,
      priceImpactPct: parsePriceImpactPct(quote),
    });
    return "SELL";
  }

  const swap = await executeSwap(connection, state.wallet, quote);
  const sig = swap.signature;
  totals.totalSolSold += solReceived;
  totals.totalTrades++;
  if (swap.feeSol !== null) totals.totalFeesSol += swap.feeSol;
  log.trade("SELL", walletStr, solReceived, tokenToSell, sig, swap.feeSol);
  log.ledger(config.ledgerPath, {
    type: "trade",
    side: "SELL",
    wallet: walletStr,
    signature: sig,
    solAmount: solReceived,
    tokenAmount: tokenToSell,
    feeLamports: swap.feeLamports,
    feeSol: swap.feeSol,
    priceImpactPct: parsePriceImpactPct(quote),
  });
  return "SELL";
}

function nextPulseSide(
  walletStr: string,
  state: WalletState,
  lastPulseSide: Map<string, "BUY" | "SELL">
): "BUY" | "SELL" {
  const previous = lastPulseSide.get(walletStr);
  if (previous) return previous === "BUY" ? "SELL" : "BUY";

  if (!canPulseBuy(state) && canPulseSell(state)) return "SELL";
  if (canPulseBuy(state) && !canPulseSell(state)) return "BUY";
  if (!config.useValuationQuotes) return "SELL";
  return state.tokenValuePct < config.targetTokenValuePct ? "BUY" : "SELL";
}

async function maybePulse(
  connection: Connection,
  state: WalletState,
  totals: Totals,
  lastPulseSide: Map<string, "BUY" | "SELL">
): Promise<TradeSide | null> {
  const walletStr = state.wallet.publicKey.toString();
  const side = nextPulseSide(walletStr, state, lastPulseSide);

  log.decision(side, walletStr, state.tokenValuePct, `inside band; ${config.mode} pulse`);

  let traded: TradeSide | null = null;
  if (side === "BUY") {
    if (canPulseBuy(state)) {
      traded = await maybeBuy(connection, state, totals, clampTradeSol(state));
    } else if (canPulseSell(state)) {
      log.decision("SELL", walletStr, state.tokenValuePct, "pulse BUY unavailable; falling back to SELL");
      traded = await maybeSell(connection, state, totals, randBetween(config.tradeAmountSolMin, config.tradeAmountSolMax));
    } else {
      log.decision("SKIP", walletStr, state.tokenValuePct, "pulse BUY unavailable and no token inventory");
    }
  } else {
    if (canPulseSell(state)) {
      traded = await maybeSell(connection, state, totals, randBetween(config.tradeAmountSolMin, config.tradeAmountSolMax));
      if (!traded && canPulseBuy(state)) {
        log.decision("BUY", walletStr, state.tokenValuePct, "pulse SELL below min; falling back to BUY");
        traded = await maybeBuy(connection, state, totals, clampTradeSol(state));
      }
    } else if (canPulseBuy(state)) {
      log.decision("BUY", walletStr, state.tokenValuePct, "pulse SELL unavailable; falling back to BUY");
      traded = await maybeBuy(connection, state, totals, clampTradeSol(state));
    } else {
      log.decision("SKIP", walletStr, state.tokenValuePct, "pulse SELL unavailable and not enough SOL");
    }
  }

  if (traded) {
    lastPulseSide.set(walletStr, traded);
    log.ledger(config.ledgerPath, {
      type: "pulse",
      side,
      wallet: walletStr,
      mode: config.mode,
      tokenValuePct: state.tokenValuePct,
      pulseTradePct: config.pulseTradePct,
    });
  }

  return traded;
}

async function run(): Promise<void> {
  const bounds = targetBounds();
  log.info("Starting $SUEDE market maker");
  log.info(`Token: ${config.tokenMint}`);
  log.info(`Mode: ${config.dryRun ? "DRY RUN" : "LIVE"}`);
  log.info(`Strategy: ${config.mode}`);
  log.info(
    `Target inventory: ${config.targetTokenValuePct}% SUEDE value` +
    ` (${bounds.lower}%–${bounds.upper}% no-trade band)`
  );
  log.info(
    `Trade range: ${config.tradeAmountSolMin}–${config.tradeAmountSolMax} SOL`
  );
  log.info(`Max price impact: ${config.maxPriceImpactPct}%`);
  log.info(`Valuation quotes: ${config.useValuationQuotes ? "on" : "off"}`);
  log.info(
    `Maker rotation: ${config.activeMakerCount > 0 ? `${config.activeMakerCount} active` : "all wallets"}` +
    `, ${config.walletCooldownSec}s wallet cooldown`
  );
  log.info(
    `Auto top-up: ${config.autoTopUpEnabled ? "on" : "off"}` +
    ` (${config.autoTopUpMinSol} SOL min, ${config.autoTopUpTargetSol} SOL cap)`
  );
  log.info(
    `Auto sweep back: ${config.autoSweepBackEnabled ? "on" : "off"}` +
    ` (${config.autoSweepReserveSol} SOL reserve, start sweep ${config.autoSweepOnStart ? "on" : "off"})`
  );
  log.info(`Cycles: ${config.cycles === 0 ? "∞" : config.cycles}`);
  log.info(`Ledger: ${config.ledgerPath}`);
  log.info("─".repeat(55));

  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
  });

  const wallets = resolveWallets(config.privateKeys, config.walletCount);
  const tokenMintPubkey = new PublicKey(config.tokenMint);
  const walletCycles = new Map<string, number>();
  const lastWalletUse = new Map<string, number>();
  const lastPulseSide = new Map<string, "BUY" | "SELL">();
  const pendingSweeps = new Map<string, Keypair>();
  const pendingSellBacks = new Map<string, Keypair>();

  if (config.autoTopUpEnabled && config.autoSweepBackEnabled && config.autoSweepOnStart) {
    log.info("Sweeping existing managed-wallet SOL back before start");
    for (const wallet of wallets) {
      try {
        await sweepBackWallet(connection, wallet);
      } catch (err) {
        log.warn(
          `Startup sweep skipped ${log.shortKey(wallet.publicKey.toString())}: ${(err as Error).message}`
        );
        log.ledger(config.ledgerPath, {
          type: "startup_sweep_error",
          wallet: wallet.publicKey.toString(),
          message: (err as Error).message,
        });
      }
    }
    log.info("Startup sweep complete");
  }

  if (config.startupScanEnabled) {
    for (const wallet of wallets) {
      try {
        const state = await loadWalletState(connection, wallet, tokenMintPubkey);
        const funded = state.solBalance >= config.tradeAmountSolMin + config.minSolReserve;
        const flag = funded ? "" : "  NEEDS SOL";
        log.info(
          `Wallet ${wallet.publicKey.toString()}` +
          `  SOL=${state.solBalance.toFixed(4)}` +
          `  SUEDE=${state.tokenBalance.toFixed(2)}` +
          `  tokenValue=${state.tokenValuePct.toFixed(1)}%${flag}`
        );
      } catch (err) {
        log.warn(
          `Startup scan skipped ${wallet.publicKey.toString()}: ${(err as Error).message}`
        );
        log.ledger(config.ledgerPath, {
          type: "startup_scan_error",
          wallet: wallet.publicKey.toString(),
          message: (err as Error).message,
        });
      }
    }
  } else {
    log.info(`Startup wallet scan: off (${wallets.length} wallets loaded)`);
  }
  log.info("─".repeat(55));

  let running = true;
  process.on("SIGINT", () => {
    log.warn("Interrupted; stopping after current decision");
    running = false;
  });

  const totals: Totals = {
    cyclesDone: 0,
    totalTrades: 0,
    totalSolBought: 0,
    totalSolSold: 0,
    totalFeesSol: 0,
    consecutiveFailures: 0,
  };

  while (running) {
    if (config.cycles > 0 && totals.cyclesDone >= config.cycles) {
      log.info(`Reached target of ${config.cycles} cycles. Done.`);
      break;
    }

    const nowMs = Date.now();
    const regularWallet = pickRotatingWallet(wallets, {
      nowMs,
      cooldownMs: config.walletCooldownSec * 1000,
      maxCyclesPerWallet: config.maxCyclesPerWallet,
      activeMakerCount: config.activeMakerCount,
      completed: walletCycles,
      lastUsedAt: lastWalletUse,
    });
    const shouldMixSellBack =
      pendingSellBacks.size >= SELL_BACK_MIN_PENDING && Math.random() < SELL_BACK_CHANCE;
    const queuedSellBack =
      shouldMixSellBack || !regularWallet ? pickPendingSellBack(pendingSellBacks) : undefined;
    const wallet = queuedSellBack?.[1] ?? regularWallet;

    if (!wallet) {
      const waitMs = nextCooldownWaitMs(wallets, {
        nowMs,
        cooldownMs: config.walletCooldownSec * 1000,
        maxCyclesPerWallet: config.maxCyclesPerWallet,
        activeMakerCount: config.activeMakerCount,
        completed: walletCycles,
        lastUsedAt: lastWalletUse,
      });
      if (waitMs <= 0) {
        log.warn("No eligible maker wallets remain; stopping.");
        break;
      }
      log.info(`All maker wallets cooling down; next eligible in ${(waitMs / 1000).toFixed(1)}s`);
      await sleep(Math.min(waitMs, 10_000));
      continue;
    }

    await sweepPendingWallets(connection, pendingSweeps, wallet);

    const walletStr = wallet.publicKey.toString();
    const isPendingSellBack = pendingSellBacks.has(walletStr);
    const completedForWallet = walletCycles.get(walletStr) ?? 0;
    if (
      !isPendingSellBack &&
      config.maxCyclesPerWallet > 0 &&
      completedForWallet >= config.maxCyclesPerWallet
    ) {
      log.decision("SKIP", walletStr, 0, "wallet reached MAX_CYCLES_PER_WALLET");
      await sleep(1000);
      continue;
    }

    try {
      const loadedState = await loadWalletState(connection, wallet, tokenMintPubkey);
      const state = isPendingSellBack
        ? loadedState
        : await maybeAutoTopUp(connection, loadedState, tokenMintPubkey);
      let traded: TradeSide | null = null;
      if (state.autoTopUpSent && config.autoSweepBackEnabled) {
        pendingSweeps.set(walletStr, wallet);
      }

      const outOfBandLow = state.tokenValuePct < bounds.lower;
      const outOfBandHigh = state.tokenValuePct > bounds.upper;
      const shouldRebalance = config.useValuationQuotes && config.mode !== "pulse";
      const shouldPulse = !config.useValuationQuotes || config.mode !== "rebalance";

      if (isPendingSellBack) {
        log.decision("SELL", walletStr, state.tokenValuePct, "sell-back queued after prior BUY");
        traded = await maybeSell(connection, state, totals, undefined, true);
        if (traded === "SELL") {
          pendingSellBacks.delete(walletStr);
        }
      } else if (shouldRebalance && outOfBandLow) {
        log.decision("BUY", walletStr, state.tokenValuePct, "below lower inventory band");
        traded = await maybeBuy(connection, state, totals);
      } else if (shouldRebalance && outOfBandHigh) {
        log.decision("SELL", walletStr, state.tokenValuePct, "above upper inventory band");
        traded = await maybeSell(connection, state, totals);
      } else if (shouldPulse) {
        traded = await maybePulse(connection, state, totals, lastPulseSide);
      } else {
        log.decision("HOLD", walletStr, state.tokenValuePct, "inside inventory band");
        log.ledger(config.ledgerPath, {
          type: "decision",
          side: "HOLD",
          wallet: walletStr,
          tokenValuePct: state.tokenValuePct,
          solBalance: state.solBalance,
          tokenBalance: state.tokenBalance,
          tokenValueSol: state.tokenValueSol,
          totalValueSol: state.totalValueSol,
        });
      }

      if (traded) {
        walletCycles.set(walletStr, completedForWallet + 1);
        if (traded === "BUY") {
          pendingSellBacks.set(walletStr, wallet);
        } else if (traded === "SELL") {
          pendingSellBacks.delete(walletStr);
        }
        if (config.autoTopUpEnabled && config.autoSweepBackEnabled) {
          pendingSweeps.set(walletStr, wallet);
        }
      }
      totals.cyclesDone++;
      totals.consecutiveFailures = 0;
      log.stats(
        totals.cyclesDone,
        totals.totalTrades,
        totals.totalSolBought,
        totals.totalSolSold,
        config.dryRun,
        totals.totalFeesSol
      );
    } catch (err) {
      totals.consecutiveFailures++;
      log.error(`Decision failed: ${(err as Error).message}`);
      log.ledger(config.ledgerPath, {
        type: "error",
        wallet: walletStr,
        message: (err as Error).message,
        consecutiveFailures: totals.consecutiveFailures,
      });

      if (totals.consecutiveFailures >= config.maxConsecutiveFailures) {
        log.error(
          `Stopping after ${totals.consecutiveFailures} consecutive failures`
        );
        break;
      }
    } finally {
      lastWalletUse.set(walletStr, Date.now());
    }

    if (!running) break;
    const delay = randIntBetween(
      Math.floor(config.delayMinSec * 1000),
      Math.floor(config.delayMaxSec * 1000)
    );
    log.info(`Next decision in ${(delay / 1000).toFixed(1)}s…\n`);
    await sleep(delay);
  }

  log.info("Market maker stopped.");
  log.stats(
    totals.cyclesDone,
    totals.totalTrades,
    totals.totalSolBought,
    totals.totalSolSold,
    config.dryRun,
    totals.totalFeesSol
  );
}

run().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
