/**
 * Jupiter Swap API v1 wrapper.
 * Docs: https://dev.jup.ag/docs/apis/swap-api
 */

import axios from "axios";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "./config";

const JUP_QUOTE = "https://api.jup.ag/swap/v1/quote";
const JUP_SWAP  = "https://api.jup.ag/swap/v1/swap";
const SOL_MINT  = "So11111111111111111111111111111111111111112";
let nextApiRequestAt = 0;
let rateLimitedUntil = 0;

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface SwapResult {
  signature: string;
  feeLamports: number | null;
  feeSol: number | null;
}

function retryDelayMs(attempt: number): number {
  return config.apiRetryBaseDelayMs * 2 ** attempt;
}

function retryAfterMs(err: unknown): number | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const value = err.response?.headers?.["retry-after"];
  const retryAfter = Array.isArray(value) ? value[0] : value;
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

function errorStatus(err: unknown): number | undefined {
  if (axios.isAxiosError(err)) return err.response?.status;
  return undefined;
}

function errorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const retryAfter = err.response?.headers?.["retry-after"];
    return [
      err.message,
      status ? `status=${status}` : "",
      retryAfter ? `retry-after=${retryAfter}` : "",
    ].filter(Boolean).join(" ");
  }
  return (err as Error).message;
}

async function withApiRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < config.apiRetryAttempts; attempt++) {
    try {
      await waitForApiSlot(label);
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = errorStatus(err);
      const retryable = status === 429 || status === undefined || status >= 500;
      if (!retryable || attempt >= config.apiRetryAttempts - 1) break;
      const delay = status === 429
        ? Math.max(retryDelayMs(attempt), retryAfterMs(err) ?? config.apiRateLimitCooldownMs)
        : retryDelayMs(attempt);
      if (status === 429) {
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delay);
      }
      console.warn(
        `[jupiter] ${label} failed (${errorMessage(err)}); retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw new Error(`${label} failed after ${config.apiRetryAttempts} attempt(s): ${errorMessage(lastErr)}`);
}

async function waitForApiSlot(label: string): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(rateLimitedUntil - now, nextApiRequestAt - now, 0);
  if (waitMs > 0) {
    const reason = rateLimitedUntil > now ? "rate-limit cooldown" : "quote pacing";
    console.warn(`[jupiter] waiting ${(waitMs / 1000).toFixed(1)}s before ${label} (${reason})`);
    await sleep(waitMs);
  }
  nextApiRequestAt = Date.now() + config.apiMinIntervalMs;
}

/** Fetch a Jupiter quote */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number
): Promise<QuoteResponse> {
  const { data } = await withApiRetry("quote", () =>
    axios.get(JUP_QUOTE, {
      params: {
        inputMint,
        outputMint,
        amount: amountLamports,
        slippageBps: config.slippageBps,
      },
      timeout: 10_000,
    })
  );
  return data as QuoteResponse;
}

/** Build, sign, and send a Jupiter swap transaction. Returns the tx signature. */
export async function executeSwap(
  connection: Connection,
  wallet: Keypair,
  quote: QuoteResponse
): Promise<SwapResult> {
  const { data: swapResponse } = await withApiRetry("swap", () =>
    axios.post(
      JUP_SWAP,
      {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: config.priorityFeeMicrolamports,
        dynamicComputeUnitLimit: true,
      },
      { timeout: 15_000 }
    )
  );

  const { swapTransaction } = swapResponse as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(
    Buffer.from(swapTransaction, "base64")
  );
  tx.sign([wallet]);

  return sendWithRetry(connection, tx);
}

async function sendWithRetry(
  connection: Connection,
  tx: VersionedTransaction,
  attempts = 3
): Promise<SwapResult> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      const { value: status } = await connection.confirmTransaction(
        { signature: sig, ...(await connection.getLatestBlockhash()) },
        "confirmed"
      );
      if (status?.err) {
        throw new Error(`On-chain error: ${JSON.stringify(status.err)}`);
      }
      const feeLamports = await fetchTransactionFeeLamports(connection, sig);
      return {
        signature: sig,
        feeLamports,
        feeSol: feeLamports === null ? null : feeLamports / 1e9,
      };
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(2000);
    }
  }
  throw lastErr;
}

async function fetchTransactionFeeLamports(
  connection: Connection,
  signature: string
): Promise<number | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta?.fee !== undefined) return tx.meta.fee;
    await sleep(1000);
  }
  return null;
}

/** SOL balance in SOL */
export async function getSolBalance(
  connection: Connection,
  pubkey: PublicKey
): Promise<number> {
  return (await connection.getBalance(pubkey)) / 1e9;
}

/** SPL token UI balance */
export async function getTokenBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<number> {
  const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { mint });
  if (accounts.value.length === 0) return 0;
  return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
}

export { SOL_MINT };

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
