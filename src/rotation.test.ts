import assert from "assert";
import {
  activeMakerPool,
  eligibleRotationWallets,
  nextCooldownWaitMs,
  pickRotatingWallet,
} from "./rotation";

const wallets = [
  { publicKey: "maker-1" },
  { publicKey: "maker-2" },
  { publicKey: "maker-3" },
];

assert.deepStrictEqual(activeMakerPool(wallets, 0), wallets);
assert.deepStrictEqual(
  activeMakerPool(wallets, 2, () => 0).map((wallet) => wallet.publicKey),
  ["maker-2", "maker-3"]
);

const completed = new Map<string, number>([["maker-3", 2]]);
const lastUsedAt = new Map<string, number>([["maker-1", 9_000]]);

const eligible = eligibleRotationWallets(wallets, {
  nowMs: 10_000,
  cooldownMs: 5_000,
  maxCyclesPerWallet: 2,
  activeMakerCount: 0,
  completed,
  lastUsedAt,
});
assert.deepStrictEqual(eligible.map((wallet) => wallet.publicKey), ["maker-2"]);

assert.strictEqual(
  nextCooldownWaitMs(wallets, {
    nowMs: 10_000,
    cooldownMs: 5_000,
    maxCyclesPerWallet: 2,
    activeMakerCount: 1,
    completed,
    lastUsedAt,
  }),
  0
);

assert.strictEqual(
  pickRotatingWallet(
    wallets,
    {
      nowMs: 10_000,
      cooldownMs: 0,
      maxCyclesPerWallet: 0,
      activeMakerCount: 1,
      completed: new Map(),
      lastUsedAt: new Map(),
    },
    () => 0
  )?.publicKey,
  "maker-2"
);

assert.strictEqual(
  pickRotatingWallet(wallets, {
    nowMs: 10_000,
    cooldownMs: 5_000,
    maxCyclesPerWallet: 2,
    activeMakerCount: 0,
    completed,
    lastUsedAt,
  })?.publicKey,
  "maker-2"
);

console.log("rotation tests passed");
