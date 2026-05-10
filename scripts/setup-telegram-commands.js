const https = require("https");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");

function readEnvFile() {
  const values = {};
  if (!fs.existsSync(envPath)) return values;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return values;
}

function telegramRequest(token, method, payload) {
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
            const parsed = JSON.parse(data);
            if (!parsed.ok) {
              reject(new Error(parsed.description || `Telegram ${method} failed`));
              return;
            }
            resolve(parsed.result);
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

async function main() {
  const env = { ...readEnvFile(), ...process.env };
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || token.includes("YOUR_TELEGRAM_BOT_TOKEN")) {
    throw new Error("Set TELEGRAM_BOT_TOKEN in .env first. Create it with @BotFather.");
  }

  const shortDescription =
    "Suede Market Maker: self-hosted Solana controls, gas-fee visibility, and Telegram ops.";
  const description = [
    "Suede Market Maker by Suede Labs AI.",
    "",
    "Transparent self-hosted Solana market tooling with a web dashboard, Telegram controls, wallet rotation, funding tools, live logs, and gas-fee visibility.",
    "",
    "Defaulted for $SUEDE, configurable for your own token.",
    "Visit https://suedeai.ai",
    "Telegram: https://t.me/AISUEDE",
  ].join("\n");

  const commands = [
    { command: "status", description: "Show market maker status" },
    { command: "funding", description: "Show funding wallet and balance" },
    { command: "distribute_preview", description: "Preview wallet funding" },
    { command: "distribute", description: "Distribute SOL to wallets" },
    { command: "sweep_preview", description: "Preview SOL sweep back" },
    { command: "sweep", description: "Sweep SOL back to funding wallet" },
    { command: "bot_start", description: "Start the market maker" },
    { command: "bot_stop", description: "Stop the market maker" },
    { command: "logs", description: "Show recent bot logs" },
  ];

  await telegramRequest(token, "setMyShortDescription", { short_description: shortDescription });
  await telegramRequest(token, "setMyDescription", { description });
  await telegramRequest(token, "setMyCommands", { commands });
  const me = await telegramRequest(token, "getMe", {});
  console.log(`Telegram profile and commands registered for @${me.username}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
