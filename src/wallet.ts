import fs from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const WALLETS_FILE = path.resolve(__dirname, "../wallets.json");

interface StoredWallet {
  publicKey: string;
  privateKey: string; // base58
  enabled?: boolean;
}

/** Load wallets from wallets.json, or generate + save fresh ones */
export function resolveWallets(
  privateKeysFromEnv: string[],
  count: number
): Keypair[] {
  // 1. Explicit keys in .env take priority
  if (privateKeysFromEnv.length > 0) {
    return privateKeysFromEnv.map((key, i) => {
      try {
        return Keypair.fromSecretKey(bs58.decode(key));
      } catch {
        throw new Error(`Invalid PRIVATE_KEYS entry at index ${i}`);
      }
    });
  }

  // 2. Saved wallet file exists → load it
  if (fs.existsSync(WALLETS_FILE)) {
    const stored: StoredWallet[] = JSON.parse(
      fs.readFileSync(WALLETS_FILE, "utf8")
    );
    const enabled = stored.filter((w) => w.enabled !== false);
    if (enabled.length === 0) {
      throw new Error("No enabled wallets in wallets.json");
    }
    return enabled.map((w) => Keypair.fromSecretKey(bs58.decode(w.privateKey)));
  }

  // 3. Generate fresh wallets and save to wallets.json
  const wallets = Array.from({ length: count }, () => Keypair.generate());
  const stored: StoredWallet[] = wallets.map((w) => ({
    publicKey: w.publicKey.toString(),
    privateKey: bs58.encode(w.secretKey),
    enabled: true,
  }));
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(stored, null, 2));
  return wallets;
}

/** Pick a random element */
export function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Random float between min and max */
export function randBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Random integer between min and max (inclusive) */
export function randIntBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}
