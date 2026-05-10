import assert from "assert";
import {
  planEvenDistribution,
  planSweepTransfers,
  SOL_LAMPORTS,
} from "./fundingMath";

function testEvenDistributionKeepsSourceReserveAndFees() {
  const plan = planEvenDistribution({
    sourceBalanceLamports: 1 * SOL_LAMPORTS,
    recipientCount: 3,
    sourceReserveLamports: 0.1 * SOL_LAMPORTS,
    feeLamportsPerTransfer: 5_000,
  });

  assert.strictEqual(plan.transferLamportsEach, 299_995_000);
  assert.strictEqual(plan.totalTransferLamports, 899_985_000);
  assert.strictEqual(plan.estimatedFeeLamports, 15_000);
  assert.strictEqual(plan.remainingSourceLamports, 100_000_000);
}

function testEvenDistributionRejectsEmptyRecipientList() {
  assert.throws(
    () =>
      planEvenDistribution({
        sourceBalanceLamports: 1 * SOL_LAMPORTS,
        recipientCount: 0,
        sourceReserveLamports: 0,
        feeLamportsPerTransfer: 5_000,
      }),
    /at least one recipient/
  );
}

function testSweepSkipsWalletsWithoutSpendableBalance() {
  const plan = planSweepTransfers({
    walletBalancesLamports: [0.2 * SOL_LAMPORTS, 0.001 * SOL_LAMPORTS],
    walletReserveLamports: 0.005 * SOL_LAMPORTS,
    feeLamportsPerTransfer: 5_000,
  });

  assert.deepStrictEqual(plan.transfers, [
    { walletIndex: 0, lamports: 194_995_000 },
  ]);
  assert.strictEqual(plan.totalTransferLamports, 194_995_000);
  assert.strictEqual(plan.estimatedFeeLamports, 5_000);
}

testEvenDistributionKeepsSourceReserveAndFees();
testEvenDistributionRejectsEmptyRecipientList();
testSweepSkipsWalletsWithoutSpendableBalance();

console.log("funding math tests passed");
