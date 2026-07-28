import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { SNAPSHOT_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "./utils/address_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { createCoupon } from "./program_helpers/coupon/coupon_instruction_helper";
import { takeSnapshot } from "./program_helpers/snapshot/snapshot_instruction_helper";
import {
  encodeSnapshotCounter,
  getSnapshotCounterByPda,
  getSnapshotMerkleRoot,
  snapshotMerkleRootPda,
  nextSnapshotId,
} from "./program_helpers/snapshot/snapshot_pda_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "./program_helpers/account_helper";
import { U64_MAX } from "./constants";
import { setAssetClassVersionForMint } from "./program_helpers/factory/factory_pda_helper";
import { COUPON_CREATE_COUPON } from "./utils/functionalities";

describe.skip("snapshot", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const authority = provider.wallet.payer;

  describe("take_snapshot", async () => {
    it("take_snapshot: rejects direct invocation with Unauthorized (auxiliary, only callable via coupon CPI)", async () => {
      const mint = Keypair.generate().publicKey;

      try {
        await takeSnapshot({ authority, mint });
        assert.fail("Expected Unauthorized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Unauthorized");
      }
    });

    it("take_snapshot: fails with SnapshotCounterOverflow when the counter is at u64::MAX", async () => {
      const { mint } = await deployMint();
      await setAssetClassVersionForMint(mint, {
        functionalities: [COUPON_CREATE_COUPON],
      });

      // take_snapshot is auxiliary (CPI-only via coupon), so we drive it through
      // create_coupon. Brute-forcing the counter to u64::MAX is infeasible, so we
      // plant a snapshot_counter already saturated at u64::MAX via surfpool's
      // surfnet_setAccount cheatcode. The CPI then hits the `else` branch
      // `counter.count.checked_add(1)` -> None -> SnapshotCounterOverflow, which
      // propagates out of create_coupon.
      const [snapshotCounterPda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("snapshot_counter"), mint.toBuffer()],
        SNAPSHOT_PROGRAM_ID
      );
      const data = await encodeSnapshotCounter(bump, U64_MAX);
      const lamports = await getBalanceForRentExeption(data.length);

      await surfnetSetAccount(snapshotCounterPda, {
        lamports,
        owner: SNAPSHOT_PROGRAM_ID.toBase58(),
        data: data.toString("hex"),
        executable: false,
        rentEpoch: 0,
      });

      // Sanity: the planted counter really is at u64::MAX.
      const planted = await getSnapshotCounterByPda(snapshotCounterPda);
      assert.equal(planted.count.toString(), U64_MAX.toString(), "snapshot_counter should be planted at u64::MAX");

      try {
        await createCoupon({ authority, mint });
        assert.fail("Expected SnapshotCounterOverflow error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "SnapshotCounterOverflow");
      }
    });

    it("take_snapshot: stores the provided merkle root in a per-snapshot PDA", async () => {
      const { mint } = await deployMint();
      await setAssetClassVersionForMint(mint, {
        functionalities: [COUPON_CREATE_COUPON],
      });

      const merkleRoot = Array.from({ length: 32 }, (_, i) => (i + 1) & 0xff);
      // take_snapshot is CPI-only; drive it through create_coupon. The counter
      // stores the next id, so the first snapshot has id 0.
      await createCoupon({ authority, mint }, { couponId: new anchor.BN(1), merkleRoot });

      const record = await getSnapshotMerkleRoot(mint, new anchor.BN(0));
      assert.deepEqual(Array.from(record.merkleRoot), merkleRoot, "stored root should match the provided root");
    });

    it("take_snapshot: each snapshot gets its own immutable root PDA (prior roots untouched)", async () => {
      const { mint } = await deployMint();
      await setAssetClassVersionForMint(mint, {
        functionalities: [COUPON_CREATE_COUPON],
      });

      const rootA = Array.from({ length: 32 }, (_, i) => (i + 1) & 0xff);
      const rootB = Array.from({ length: 32 }, (_, i) => (0xff - i) & 0xff);

      await createCoupon({ authority, mint }, { couponId: new anchor.BN(1), merkleRoot: rootA });
      await createCoupon({ authority, mint }, { couponId: new anchor.BN(2), merkleRoot: rootB });

      // Snapshot ids are 0-based (counter stores the next id): coupon 1 → id 0,
      // coupon 2 → id 1.
      const recordA = await getSnapshotMerkleRoot(mint, new anchor.BN(0));
      const recordB = await getSnapshotMerkleRoot(mint, new anchor.BN(1));

      // Snapshot 1 gets a distinct PDA with rootB, and snapshot 0's root is
      // still rootA — the address per id is unique and never overwritten.
      assert.deepEqual(Array.from(recordA.merkleRoot), rootA, "snapshot 0 root should remain rootA");
      assert.deepEqual(Array.from(recordB.merkleRoot), rootB, "snapshot 1 root should be rootB");
    });

    it("take_snapshot: succeeds even if the merkle-root PDA was pre-funded by a griefer (create-or-adopt)", async () => {
      const { mint } = await deployMint();
      await setAssetClassVersionForMint(mint, {
        functionalities: [COUPON_CREATE_COUPON],
      });

      // Attacker pre-funds the predictable PDA of the next snapshot (id 0) with
      // lamports but no data. A bare `create_account` would then fail forever
      // (AccountAlreadyInUse); Anchor's `init` adopts the pre-funded account.
      const snapshotId = await nextSnapshotId(mint); // 0 (no counter yet)
      const pda = snapshotMerkleRootPda(mint, snapshotId);
      await surfnetSetAccount(pda, {
        lamports: 1,
        owner: SYSTEM_PROGRAM_ID.toBase58(),
        data: "",
        executable: false,
        rentEpoch: 0,
      });

      const merkleRoot = Array.from({ length: 32 }, (_, i) => (i + 7) & 0xff);
      // Must still succeed thanks to create-or-adopt (top-up + allocate + assign).
      await createCoupon({ authority, mint }, { couponId: new anchor.BN(1), merkleRoot });

      const record = await getSnapshotMerkleRoot(mint, snapshotId);
      assert.deepEqual(
        Array.from(record.merkleRoot),
        merkleRoot,
        "root should be stored despite the pre-funding griefing attempt"
      );
    });
  });
});
