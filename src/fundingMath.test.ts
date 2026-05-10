import assert from "assert";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { assertPlainSolSourceAccount } from "./funding";
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

function testFundingSourceRejectsDataAccount() {
  const publicKey = new PublicKey("11111111111111111111111111111111");
  assert.throws(
    () =>
      assertPlainSolSourceAccount(
        publicKey,
        {
          data: Buffer.alloc(80),
          executable: false,
          lamports: 1,
          owner: SystemProgram.programId,
          rentEpoch: 0,
        },
        "Funding wallet"
      ),
    /plain wallet account with no data/
  );
}

function testFundingSourceAllowsPlainWalletAccount() {
  assert.doesNotThrow(() =>
    assertPlainSolSourceAccount(
      new PublicKey("11111111111111111111111111111111"),
      {
        data: Buffer.alloc(0),
        executable: false,
        lamports: 1,
        owner: SystemProgram.programId,
        rentEpoch: 0,
      },
      "Funding wallet"
    )
  );
}

testEvenDistributionKeepsSourceReserveAndFees();
testEvenDistributionRejectsEmptyRecipientList();
testSweepSkipsWalletsWithoutSpendableBalance();
testFundingSourceRejectsDataAccount();
testFundingSourceAllowsPlainWalletAccount();

console.log("funding math tests passed");
