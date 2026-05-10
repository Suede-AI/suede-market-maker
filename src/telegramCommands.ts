export type TelegramCommand =
  | "help"
  | "status"
  | "funding"
  | "distribute_preview"
  | "distribute"
  | "sweep_preview"
  | "sweep"
  | "bot_start"
  | "bot_stop"
  | "logs"
  | "unknown";

const commands = new Set<TelegramCommand>([
  "help",
  "status",
  "funding",
  "distribute_preview",
  "distribute",
  "sweep_preview",
  "sweep",
  "bot_start",
  "bot_stop",
  "logs",
]);

export function parseTelegramCommand(text: string): TelegramCommand {
  const first = text.trim().split(/\s+/)[0] || "";
  if (!first.startsWith("/")) return "unknown";

  const command = first.slice(1).split("@")[0];
  if (command === "start") return "help";
  return commands.has(command as TelegramCommand)
    ? (command as TelegramCommand)
    : "unknown";
}

export function telegramHelpText(): string {
  return [
    "Suede Market Maker",
    "Brought to you courtesy of Suede Labs AI.",
    "",
    "Transparent self-hosted Solana tooling with web controls, Telegram commands, wallet rotation, funding tools, and gas-fee visibility.",
    "",
    "Suede links:",
    "Website: https://suedeai.ai",
    "Telegram: https://t.me/AISUEDE",
    "X: https://x.com/AISUEDE",
    "GitHub: https://github.com/Suede-AI",
    "",
    "Commands:",
    "/status - show bot process status",
    "/funding - show funding wallet and balance",
    "/distribute_preview - preview even SOL distribution",
    "/distribute - distribute funding wallet SOL evenly",
    "/sweep_preview - preview sweeping wallet SOL back",
    "/sweep - sweep spendable SOL back to funding wallet",
    "/bot_start - start the market maker process",
    "/bot_stop - stop the market maker process",
    "/logs - show recent Telegram bot logs",
    "",
    "Need help or want more Suede tools? Visit https://suedeai.ai",
  ].join("\n");
}
