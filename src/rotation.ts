export interface RotationWallet {
  publicKey: string | { toString(): string };
}

export interface RotationOptions {
  nowMs: number;
  cooldownMs: number;
  maxCyclesPerWallet: number;
  activeMakerCount: number;
  completed: Map<string, number>;
  lastUsedAt: Map<string, number>;
}

export function activeMakerPool<T extends RotationWallet>(
  wallets: T[],
  activeMakerCount: number,
  random = Math.random
): T[] {
  if (activeMakerCount <= 0 || activeMakerCount >= wallets.length) return wallets;

  const shuffled = [...wallets];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, activeMakerCount);
}

function walletKey(wallet: RotationWallet): string {
  return wallet.publicKey.toString();
}

export function eligibleRotationWallets<T extends RotationWallet>(
  wallets: T[],
  options: RotationOptions,
  random = Math.random
): T[] {
  const active = activeMakerPool(wallets, options.activeMakerCount, random);
  return active.filter((wallet) => {
    const key = walletKey(wallet);
    const completed = options.completed.get(key) ?? 0;
    if (options.maxCyclesPerWallet > 0 && completed >= options.maxCyclesPerWallet) {
      return false;
    }

    const lastUsedAt = options.lastUsedAt.get(key) ?? 0;
    return options.nowMs - lastUsedAt >= options.cooldownMs;
  });
}

export function nextCooldownWaitMs<T extends RotationWallet>(
  wallets: T[],
  options: RotationOptions
): number {
  const waits = wallets
    .filter((wallet) => {
      const completed = options.completed.get(walletKey(wallet)) ?? 0;
      return options.maxCyclesPerWallet <= 0 || completed < options.maxCyclesPerWallet;
    })
    .map((wallet) => {
      const lastUsedAt = options.lastUsedAt.get(walletKey(wallet)) ?? 0;
      return Math.max(0, options.cooldownMs - (options.nowMs - lastUsedAt));
    });

  return waits.length ? Math.min(...waits) : 0;
}

export function pickRotatingWallet<T extends RotationWallet>(
  wallets: T[],
  options: RotationOptions,
  random = Math.random
): T | null {
  const eligible = eligibleRotationWallets(wallets, options, random);
  if (eligible.length === 0) return null;
  return eligible[Math.floor(random() * eligible.length)];
}
