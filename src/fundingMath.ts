export const SOL_LAMPORTS = 1_000_000_000;

export interface EvenDistributionInput {
  sourceBalanceLamports: number;
  recipientCount: number;
  sourceReserveLamports: number;
  feeLamportsPerTransfer: number;
}

export interface EvenDistributionPlan {
  transferLamportsEach: number;
  totalTransferLamports: number;
  estimatedFeeLamports: number;
  remainingSourceLamports: number;
}

export interface SweepInput {
  walletBalancesLamports: number[];
  walletReserveLamports: number;
  feeLamportsPerTransfer: number;
}

export interface SweepTransfer {
  walletIndex: number;
  lamports: number;
}

export interface SweepPlan {
  transfers: SweepTransfer[];
  totalTransferLamports: number;
  estimatedFeeLamports: number;
}

export function solToLamports(sol: number): number {
  return Math.floor(sol * SOL_LAMPORTS);
}

export function lamportsToSol(lamports: number): number {
  return lamports / SOL_LAMPORTS;
}

export function planEvenDistribution(input: EvenDistributionInput): EvenDistributionPlan {
  if (!Number.isSafeInteger(input.recipientCount) || input.recipientCount < 1) {
    throw new Error("Need at least one recipient wallet");
  }

  const estimatedFeeLamports = input.recipientCount * input.feeLamportsPerTransfer;
  const distributableLamports =
    input.sourceBalanceLamports - input.sourceReserveLamports - estimatedFeeLamports;
  const transferLamportsEach = Math.floor(distributableLamports / input.recipientCount);

  if (transferLamportsEach <= 0) {
    throw new Error("Funding wallet does not have enough spendable SOL to distribute");
  }

  const totalTransferLamports = transferLamportsEach * input.recipientCount;
  return {
    transferLamportsEach,
    totalTransferLamports,
    estimatedFeeLamports,
    remainingSourceLamports:
      input.sourceBalanceLamports - totalTransferLamports - estimatedFeeLamports,
  };
}

export function planSweepTransfers(input: SweepInput): SweepPlan {
  const transfers = input.walletBalancesLamports
    .map((balance, walletIndex) => ({
      walletIndex,
      lamports: Math.floor(
        balance - input.walletReserveLamports - input.feeLamportsPerTransfer
      ),
    }))
    .filter((transfer) => transfer.lamports > 0);

  return {
    transfers,
    totalTransferLamports: transfers.reduce((sum, transfer) => sum + transfer.lamports, 0),
    estimatedFeeLamports: transfers.length * input.feeLamportsPerTransfer,
  };
}
