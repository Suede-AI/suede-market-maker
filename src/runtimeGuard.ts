import { execFileSync } from "child_process";
import path from "path";

export interface BotProcessInfo {
  pid: number;
  command: string;
}

export interface BotProcessScan {
  bot: BotProcessInfo | null;
  reliable: boolean;
}

export function describeRuntime(
  managedPid: number | null,
  externalBot: BotProcessInfo | null
) {
  const managedRunning = managedPid !== null;
  const externalRunning = externalBot !== null;

  return {
    running: managedRunning || externalRunning,
    managedRunning,
    externalRunning,
    duplicateRunning: managedRunning && externalRunning,
    runtimeSource: managedRunning && externalRunning
      ? "multiple"
      : managedRunning
        ? "dashboard"
        : externalRunning
          ? "external"
          : "none",
    pid: managedPid ?? externalBot?.pid ?? null,
    externalPid: externalBot?.pid ?? null,
  };
}

function commandRunsBot(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2 || path.basename(tokens[0]) !== "node") return false;

  return tokens.slice(1).some(
    (token) =>
      token === "dist/index.js" ||
      token.endsWith("/dist/index.js") ||
      token === "src/index.ts" ||
      token.endsWith("/src/index.ts")
  );
}

export function findExternalBotProcess(
  processList: string,
  excludedPids: number[] = []
): BotProcessInfo | null {
  const excluded = new Set(excludedPids);

  for (const line of processList.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;

    const pid = Number(match[1]);
    const command = match[2].trim();
    if (!excluded.has(pid) && commandRunsBot(command)) {
      return { pid, command };
    }
  }

  return null;
}

function readSystemProcessList(): string {
  if (process.platform === "win32") {
    throw new Error("External bot detection is not supported on Windows");
  }

  return execFileSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

export function scanExternalBotProcess(
  excludedPids: number[] = [],
  readProcessList: () => string = readSystemProcessList
): BotProcessScan {
  try {
    return {
      bot: findExternalBotProcess(readProcessList(), excludedPids),
      reliable: true,
    };
  } catch {
    return { bot: null, reliable: false };
  }
}
