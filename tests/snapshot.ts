import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { SNAPSHOT_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "./utils/address_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { createCoupon } from "./program_helpers/coupon/coupon_instruction_helper";
import { setCoupon } from "./program_helpers/coupon/coupon_pda_helper";
import { createTokenAccount, mintTokensViaSurfpool } from "./program_helpers/spl_token_helper";
import {
  getHolderBalanceSnapshotAt,
  getTotalSupplySnapshotAt,
  takeSnapshot,
  updateHolderBalanceSnapshot,
  updateTotalSupplySnapshot,
} from "./program_helpers/snapshot/snapshot_instruction_helper";
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
import { COUPON_CREATE_COUPON, MINT_MINT } from "./utils/functionalities";

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

  describe("update_totalsupply_snapshot", async () => {
    it("update_totalsupply_snapshot: rejects direct invocation with Unauthorized (auxiliary, only callable via mint/operations CPI)", async () => {
      const mint = Keypair.generate().publicKey;

      try {
        await updateTotalSupplySnapshot({ authority, mint });
        assert.fail("Expected Unauthorized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "Unauthorized");
      }
    });
  });

  describe("update_holderbalance_snapshot", async () => {
    it("update_holderbalance_snapshot: rejects direct invocation with Unauthorized (auxiliary, only callable via mint/operations/transfer-hook CPI)", async () => {
      const mint = Keypair.generate().publicKey;

      try {
        await updateHolderBalanceSnapshot({ authority, mint });
        assert.fail("Expected Unauthorized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "Unauthorized");
      }
    });
  });

  describe("get_totalsupply_snapshot_at", async () => {
    it("get_totalsupply_snapshot_at: returns live supply when no snapshot PDA exists (no coupon ever taken)", async () => {
      const { mint } = await deployMint();
      await setAssetClassVersionForMint(mint, {
        functionalities: [MINT_MINT],
      });
      const destination = await createTokenAccount({ mint, owner: authority.publicKey });
      // Mint without a prior coupon / snapshot — so that the mint has a specific supply
      const supply = new anchor.BN(1_000);
      await mintTokensViaSurfpool(mint, destination, supply);

      const result = await getTotalSupplySnapshotAt({ mint }, { snapshotId: new anchor.BN(1) });

      assert.equal(result.toString(), supply.toString());
    });

    it("get_totalsupply_snapshot_at: returns live supply when queried snapshot_id exceeds all recorded entries", async () => {
      const { mint } = await deployMint();
      await setAssetClassVersionForMint(mint, {
        functionalities: [COUPON_CREATE_COUPON, MINT_MINT],
      });
      const destination = await createTokenAccount({ mint, owner: authority.publicKey });
      const initialAmount = new anchor.BN(1_000);
      await mintTokensViaSurfpool(mint, destination, initialAmount);

      // Take snapshot 0 → next mint records pre-mint supply (= initialAmount) at key=0
      const couponId = new anchor.BN(1);
      await setCoupon(mint, couponId);
      const additionalAmount = new anchor.BN(500);
      await mintTokensViaSurfpool(mint, destination, additionalAmount);
      // History: [{key=0, value=initialAmount}]. Live supply = initialAmount + additionalAmount.

      // Query a snapshot_id beyond every recorded entry → lookup_at_or_above returns None → live fallback
      const result = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId.add(new anchor.BN(1)) });
      assert.equal(result.toString(), initialAmount.add(additionalAmount).toString());
    });

    it.skip("get_totalsupply_snapshot_at: returns value of next recorded entry when queried snapshot_id has no exact match", async () => {
      const { mint } = await deployMint();
      const destination = await createTokenAccount({ mint, owner: authority.publicKey });
      const initialAmount = new anchor.BN(1_000);
      await mintTokensViaSurfpool(mint, destination, initialAmount);

      // Take snapshot 1, entry key=1 written with value=initialAmount (pre-mint supply)
      const couponId1 = new anchor.BN(1);
      await createCoupon({ authority, mint }, { couponId: couponId1 });
      const secondAmount = new anchor.BN(500);
      await mintTokensViaSurfpool(mint, destination, secondAmount);

      // Take snapshots 2, no entry added
      const couponId2 = new anchor.BN(2);
      await createCoupon({ authority, mint }, { couponId: couponId2 });

      // Take snapshot 3, entry key=2 written with value=initialAmount+secondAmount
      const couponId3 = new anchor.BN(3);
      await createCoupon({ authority, mint }, { couponId: couponId3 });
      await mintTokensViaSurfpool(mint, destination, new anchor.BN(1));

      // History: [{key=1, value=initialAmount}, {key=3, value=initialAmount+secondAmount}].
      // Query snapshot_id=2 → no exact match → returns value from key=3 entry
      const result = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId2 });
      const expectedAmount = initialAmount.add(secondAmount);
      assert.equal(result.toString(), expectedAmount.toString());
    });
  });

  describe("get_holderbalance_snapshot_at", async () => {
    it("get_holderbalance_snapshot_at: returns 0 when token account does not exist", async () => {
      const { mint } = await deployMint();
      const nonExistentTokenAccount = Keypair.generate().publicKey;

      const result = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: nonExistentTokenAccount },
        { snapshotId: new anchor.BN(1) }
      );
      assert.equal(result.toString(), "0");
    });

    it("get_holderbalance_snapshot_at: returns live balance when no snapshot PDA exists (no coupon ever taken)", async () => {
      const { mint } = await deployMint();
      const destination = await createTokenAccount({ mint, owner: authority.publicKey });
      const mintAmount = new anchor.BN(1_000);
      // Mint without a prior coupon — snapshot CPIs exit silently, no PDA is created
      await mintTokensViaSurfpool(mint, destination, mintAmount);

      const result = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: destination },
        { snapshotId: new anchor.BN(1) }
      );
      assert.equal(result.toString(), mintAmount.toString());
    });

    it("get_holderbalance_snapshot_at: returns live balance when queried snapshot_id exceeds all recorded entries", async () => {
      const { mint } = await deployMint();
      await setAssetClassVersionForMint(mint, {
        functionalities: [COUPON_CREATE_COUPON, MINT_MINT],
      });
      const destination = await createTokenAccount({ mint, owner: authority.publicKey });
      const initialAmount = new anchor.BN(1_000);
      await mintTokensViaSurfpool(mint, destination, initialAmount);

      // Take snapshot 0 → next mint records pre-mint balance (= initialAmount) at key=0
      await setCoupon(mint, new anchor.BN(1));
      const additionalAmount = new anchor.BN(500);
      await mintTokensViaSurfpool(mint, destination, additionalAmount);

      // History: [{key=0, value=initialAmount}]. Live balance = initialAmount + additionalAmount.

      // Query a snapshot_id beyond every recorded entry → lookup_at_or_above returns None → live fallback
      const result = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: destination },
        { snapshotId: new anchor.BN(99) }
      );
      assert.equal(result.toString(), initialAmount.add(additionalAmount).toString());
    });

    it.skip("get_holderbalance_snapshot_at: returns value of next recorded entry when queried snapshot_id has no exact match", async () => {
      const { mint } = await deployMint();
      const destination = await createTokenAccount({ mint, owner: authority.publicKey });
      const initialAmount = new anchor.BN(1_000);
      await mintTokensViaSurfpool(mint, destination, initialAmount);

      // Take snapshot 1, entry key=1 written with value=initialAmount (pre-mint balance)
      const couponId1 = new anchor.BN(1);
      await createCoupon({ authority, mint }, { couponId: couponId1 });
      const secondAmount = new anchor.BN(500);
      await mintTokensViaSurfpool(mint, destination, secondAmount);

      // Take snapshot 2, no entry added
      const couponId2 = new anchor.BN(2);
      await createCoupon({ authority, mint }, { couponId: couponId2 });

      // Take snapshot 3, entry key=3 written with value=initialAmount+secondAmount
      const couponId3 = new anchor.BN(3);
      await createCoupon({ authority, mint }, { couponId: couponId3 });
      await mintTokensViaSurfpool(mint, destination, new anchor.BN(1));

      // History: [{key=1, value=initialAmount}, {key=3, value=initialAmount+secondAmount}].
      // Query snapshot_id=2 → no exact match → returns value from key=3 entry
      const result = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: destination },
        { snapshotId: couponId2 }
      );
      const expectedAmount = initialAmount.add(secondAmount);
      assert.equal(result.toString(), expectedAmount.toString());
    });
  });
});
