import https from "https";
import path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import dotenv from "dotenv";
import { distributeFunding, getFundingStatus, sweepFunding, type FundingRunResult } from "./funding";
import { parseTelegramCommand, telegramHelpText, type TelegramCommand } from "./telegramCommands";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const ROOT = path.resolve(__dirname, "..");
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const allowedChatIds = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const skipPendingOnStart = ["1", "true", "yes", "on"].includes(
  (process.env.TELEGRAM_SKIP_PENDING_UPDATES ?? "false").trim().toLowerCase()
);

let offset = 0;
let botProcess: ChildProcessWithoutNullStreams | null = null;
let botStartedAt: string | null = null;
let logs: string[] = [];

const SUEDE_CTA = [
  "",
  "Brought to you courtesy of Suede Labs AI.",
  "More Suede tools: https://suedeai.ai",
  "Telegram: https://t.me/AISUEDE",
].join("\n");

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: {
      id: number;
      type: string;
      username?: string;
    };
    from?: {
      id: number;
      username?: string;
    };
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

function appendLog(line: string) {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "");
  logs.push(clean);
  if (logs.length > 200) logs = logs.slice(-200);
  console.log(clean);
}

function assertConfigured() {
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required in .env");
  }

  if (allowedChatIds.size === 0) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_IDS is required in .env");
  }
}

function telegramRequest<T>(
  method: string,
  payload: Record<string, unknown>
): Promise<TelegramResponse<T>> {
  assertConfigured();
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: "api.telegram.org",
        path: `/bot${token}/${method}`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as TelegramResponse<T>;
            if (!parsed.ok) {
              reject(new Error(parsed.description || `Telegram ${method} failed`));
              return;
            }
            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.setTimeout(35_000, () => {
      req.destroy(new Error(`Telegram ${method} timed out`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function sendMessage(chatId: number, text: string) {
  const chunks = chunkText(text, 3500);
  for (const chunk of chunks) {
    await telegramRequest("sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
}

function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks.length ? chunks : [""];
}

async function getUpdates(timeout = 2): Promise<TelegramUpdate[]> {
  const response = await telegramRequest<TelegramUpdate[]>("getUpdates", {
    offset,
    timeout,
    allowed_updates: ["message"],
  });
  return response.result;
}

async function skipPendingUpdates() {
  const response = await telegramRequest<TelegramUpdate[]>("getUpdates", {
    timeout: 0,
    allowed_updates: ["message"],
  });
  if (response.result.length === 0) return;
  offset = Math.max(...response.result.map((update) => update.update_id)) + 1;
  appendLog(`[telegram] skipped ${response.result.length} old update(s); next offset=${offset}`);
}

function authorized(chatId: number): boolean {
  return allowedChatIds.has(String(chatId));
}

function startMarketMaker(): string {
  if (botProcess && !botProcess.killed) {
    return `Market maker already running pid=${botProcess.pid}`;
  }

  logs = [];
  botStartedAt = new Date().toISOString();
  botProcess = spawn(process.execPath, ["dist/index.js"], {
    cwd: ROOT,
    env: process.env,
  });

  appendLog(`[telegram] started market maker pid=${botProcess.pid}`);
  botProcess.stdout.on("data", (chunk) => appendLog(chunk.toString().trimEnd()));
  botProcess.stderr.on("data", (chunk) => appendLog(chunk.toString().trimEnd()));
  botProcess.on("exit", (code, signal) => {
    appendLog(`[telegram] market maker exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    botProcess = null;
    botStartedAt = null;
  });

  return `Started market maker pid=${botProcess.pid}`;
}

function stopMarketMaker(): string {
  if (!botProcess || botProcess.killed) {
    return "Market maker is not running";
  }

  appendLog("[telegram] stopping market maker");
  botProcess.kill("SIGINT");
  setTimeout(() => {
    if (botProcess && !botProcess.killed) botProcess.kill("SIGTERM");
  }, 5000).unref();
  return "Stop signal sent";
}

function statusText(): string {
  return [
    botProcess && !botProcess.killed
      ? `Market maker: running pid=${botProcess.pid}`
      : "Market maker: stopped",
    botStartedAt ? `Started: ${botStartedAt}` : "",
    SUEDE_CTA,
  ].filter(Boolean).join("\n");
}

function fundingResultText(title: string, result: FundingRunResult): string {
  return [
    title,
    `Mode: ${result.dryRun ? "preview" : "live"}`,
    `Funding wallet: ${result.sourcePublicKey}`,
    `Transfers: ${result.transfers.length}`,
    `Total: ${result.totalSol.toFixed(6)} SOL`,
    `Estimated fees: ${result.estimatedFeeSol.toFixed(6)} SOL`,
    ...result.transfers.slice(0, 12).map((transfer) =>
      `#${transfer.walletIndex} ${transfer.sol.toFixed(6)} SOL -> ${shortKey(transfer.publicKey)}${transfer.signature ? ` ${transfer.signature}` : ""}`
    ),
    result.transfers.length > 12 ? `...${result.transfers.length - 12} more` : "",
    SUEDE_CTA,
  ].filter(Boolean).join("\n");
}

function shortKey(key: string): string {
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

async function handleCommand(command: TelegramCommand): Promise<string> {
  switch (command) {
    case "help":
      return telegramHelpText();
    case "status":
      return statusText();
    case "funding": {
      const status = await getFundingStatus();
      return [
        `Funding wallet: ${status.publicKey}`,
        `Balance: ${status.balanceSol.toFixed(6)} SOL`,
        `Managed wallets: ${status.managedWalletCount}`,
        `Distribution reserve: ${status.sourceReserveSol} SOL`,
        `Sweep reserve per wallet: ${status.sweepWalletReserveSol} SOL`,
        SUEDE_CTA,
      ].join("\n");
    }
    case "distribute_preview":
      return fundingResultText("Even distribution preview", await distributeFunding(true));
    case "distribute":
      return fundingResultText("Even distribution sent", await distributeFunding(false));
    case "sweep_preview":
      return fundingResultText("Sweep preview", await sweepFunding(true));
    case "sweep":
      return fundingResultText("Sweep sent", await sweepFunding(false));
    case "bot_start":
      return startMarketMaker();
    case "bot_stop":
      return stopMarketMaker();
    case "logs":
      return logs.length ? logs.slice(-40).join("\n") : "No logs yet";
    default:
      return `Unknown command.\n\n${telegramHelpText()}`;
  }
}

async function handleUpdate(update: TelegramUpdate) {
  offset = Math.max(offset, update.update_id + 1);
  const message = update.message;
  if (!message?.text) return;

  const chatId = message.chat.id;
  if (!authorized(chatId)) {
    appendLog(`[telegram] rejected chat ${chatId}`);
    await sendMessage(chatId, "This chat is not authorized for this bot.");
    return;
  }

  const command = parseTelegramCommand(message.text);
  appendLog(`[telegram] chat=${chatId} command=${command} text=${message.text}`);
  try {
    await sendMessage(chatId, await handleCommand(command));
  } catch (err) {
    appendLog(`[telegram] command failed: ${(err as Error).message}`);
    await sendMessage(chatId, `Error: ${(err as Error).message}`);
  }
}

async function run() {
  assertConfigured();
  appendLog("[telegram] control bot started");
  if (skipPendingOnStart) {
    await skipPendingUpdates();
  }
  appendLog("[telegram] ready for new commands");
  while (true) {
    try {
      const updates = await getUpdates();
      if (updates.length > 0) {
        appendLog(`[telegram] received ${updates.length} update(s)`);
      }
      for (const update of updates) {
        await handleUpdate(update);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      appendLog(`[telegram] ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

process.on("SIGINT", () => {
  stopMarketMaker();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  appendLog(`[telegram] uncaught exception: ${(err as Error).stack || (err as Error).message}`);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  appendLog(`[telegram] unhandled rejection: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});

if (require.main === module) {
  run().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
