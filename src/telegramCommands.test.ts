import assert from "assert";
import { parseTelegramCommand, telegramHelpText } from "./telegramCommands";

assert.strictEqual(parseTelegramCommand("/start"), "help");
assert.strictEqual(parseTelegramCommand("/help"), "help");
assert.strictEqual(parseTelegramCommand("/status"), "status");
assert.strictEqual(parseTelegramCommand("/funding"), "funding");
assert.strictEqual(parseTelegramCommand("/distribute_preview"), "distribute_preview");
assert.strictEqual(parseTelegramCommand("/distribute"), "distribute");
assert.strictEqual(parseTelegramCommand("/sweep_preview"), "sweep_preview");
assert.strictEqual(parseTelegramCommand("/sweep"), "sweep");
assert.strictEqual(parseTelegramCommand("/bot_start"), "bot_start");
assert.strictEqual(parseTelegramCommand("/bot_stop"), "bot_stop");
assert.strictEqual(parseTelegramCommand("/logs"), "logs");
assert.strictEqual(parseTelegramCommand("/status@SuedeBot"), "status");
assert.strictEqual(parseTelegramCommand("status"), "unknown");
assert.strictEqual(parseTelegramCommand("/whatever"), "unknown");

const help = telegramHelpText();
assert.match(help, /\/funding/);
assert.match(help, /\/distribute_preview/);
assert.match(help, /\/sweep_preview/);
assert.match(help, /\/bot_start/);

console.log("telegram command tests passed");
