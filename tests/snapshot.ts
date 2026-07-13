import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { SNAPSHOT_PROGRAM_ID } from "./utils/address_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { createCoupon } from "./program_helpers/coupon/coupon_instruction_helper";
import { createTokenAccount } from "./program_helpers/spl_token_helper";
import { mintTokens } from "./program_helpers/mint/mint_instruction_helper";
import {
  encodeSnapshotCounter,
  getHolderBalanceSnapshotAt,
  getSnapshotCounterByPda,
  getSnapshotTriggeredEvent,
  getTotalSupplySnapshotAt,
  takeSnapshot,
  updateHolderBalanceSnapshot,
  updateTotalSupplySnapshot,
} from "./program_helpers/snapshot_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "./program_helpers/account_helper";
import { U64_MAX } from "./constants";
import { setAssetClassVersionForMint } from "./program_helpers/factory/factory_pda_helper";
import { COUPON_CREATE_COUPON, MINT_MINT } from "./utils/functionalities";

describe("snapshot", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployer = provider.wallet.publicKey;

  describe("take_snapshot", async () => {
    it("take_snapshot: rejects direct invocation with Unauthorized (auxiliary, only callable via coupon CPI)", async () => {
      const mint = Keypair.generate().publicKey;

      try {
        await takeSnapshot({ deployer, mint });
        assert.fail("Expected Unauthorized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Unauthorized");
      }
    });

    it("take_snapshot: fails with SnapshotCounterOverflow when the counter is at u64::MAX", async () => {
      const { mint } = await deployMint({ deployer });
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
        await createCoupon({ deployer, mint });
        assert.fail("Expected SnapshotCounterOverflow error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "SnapshotCounterOverflow");
      }
    });
  });

  describe("update_totalsupply_snapshot", async () => {
    it("update_totalsupply_snapshot: rejects direct invocation with Unauthorized (auxiliary, only callable via mint/operations CPI)", async () => {
      const mint = Keypair.generate().publicKey;

      try {
        await updateTotalSupplySnapshot({ deployer, mint });
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
        await updateHolderBalanceSnapshot({ deployer, mint });
        assert.fail("Expected Unauthorized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "Unauthorized");
      }
    });
  });

  describe("get_totalsupply_snapshot_at", async () => {
    it("get_totalsupply_snapshot_at: returns live supply when no snapshot PDA exists (no coupon ever taken)", async () => {
      const { mint } = await deployMint({ deployer });
      await setAssetClassVersionForMint(mint, {
        functionalities: [MINT_MINT],
      });
      const destination = await createTokenAccount({ mint, owner: deployer });
      // Mint without a prior coupon / snapshot — so that the mint has a specific supply
      const supply = new anchor.BN(1_000);
      await mintTokens({ deployer, mint, destination }, { amount: supply });

      const result = await getTotalSupplySnapshotAt({ mint }, { snapshotId: new anchor.BN(1) });

      assert.equal(result.toString(), supply.toString());
    });

    it("get_totalsupply_snapshot_at: returns live supply when queried snapshot_id exceeds all recorded entries", async () => {
      const { mint } = await deployMint({ deployer });
      await setAssetClassVersionForMint(mint, {
        functionalities: [COUPON_CREATE_COUPON, MINT_MINT],
      });
      const destination = await createTokenAccount({ mint, owner: deployer });
      const initialAmount = new anchor.BN(1_000);
      await mintTokens({ deployer, mint, destination }, { amount: initialAmount });

      // Take snapshot 1 → next mint records pre-mint supply (= initialAmount) at key=1
      const couponId = new anchor.BN(1);
      const { signature } = await createCoupon({ deployer, mint }, { couponId });
      const additionalAmount = new anchor.BN(500);
      await mintTokens({ deployer, mint, destination }, { amount: additionalAmount });
      // History: [{key=1, value=initialAmount}]. Live supply = initialAmount + additionalAmount.

      // Query a snapshot_id beyond every recorded entry → lookup_at_or_above returns None → live fallback
      const result = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId.add(new anchor.BN(1)) });
      assert.equal(result.toString(), initialAmount.add(additionalAmount).toString());

      const event = await getSnapshotTriggeredEvent(signature);

      assert.isNotNull(event, "Snapshot triggered event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.snapshotId.toString(), new anchor.BN(1).toString(), "event snapshotId should match the id");
    });

    it("get_totalsupply_snapshot_at: returns value of next recorded entry when queried snapshot_id has no exact match", async () => {
      const { mint } = await deployMint({ deployer });
      const destination = await createTokenAccount({ mint, owner: deployer });
      const initialAmount = new anchor.BN(1_000);
      await mintTokens({ deployer, mint, destination }, { amount: initialAmount });

      // Take snapshot 1, entry key=1 written with value=initialAmount (pre-mint supply)
      const couponId1 = new anchor.BN(1);
      await createCoupon({ deployer, mint }, { couponId: couponId1 });
      const secondAmount = new anchor.BN(500);
      await mintTokens({ deployer, mint, destination }, { amount: secondAmount });

      // Take snapshots 2, no entry added
      const couponId2 = new anchor.BN(2);
      await createCoupon({ deployer, mint }, { couponId: couponId2 });

      // Take snapshot 3, entry key=2 written with value=initialAmount+secondAmount
      const couponId3 = new anchor.BN(3);
      await createCoupon({ deployer, mint }, { couponId: couponId3 });
      await mintTokens({ deployer, mint, destination });

      // History: [{key=1, value=initialAmount}, {key=3, value=initialAmount+secondAmount}].
      // Query snapshot_id=2 → no exact match → returns value from key=3 entry
      const result = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId2 });
      const expectedAmount = initialAmount.add(secondAmount);
      assert.equal(result.toString(), expectedAmount.toString());
    });
  });

  describe("get_holderbalance_snapshot_at", async () => {
    it("get_holderbalance_snapshot_at: returns 0 when token account does not exist", async () => {
      const { mint } = await deployMint({ deployer });
      const nonExistentTokenAccount = Keypair.generate().publicKey;

      const result = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: nonExistentTokenAccount },
        { snapshotId: new anchor.BN(1) }
      );
      assert.equal(result.toString(), "0");
    });

    it("get_holderbalance_snapshot_at: returns live balance when no snapshot PDA exists (no coupon ever taken)", async () => {
      const { mint } = await deployMint({ deployer });
      const destination = await createTokenAccount({ mint, owner: deployer });
      const mintAmount = new anchor.BN(1_000);
      // Mint without a prior coupon — snapshot CPIs exit silently, no PDA is created
      await mintTokens({ deployer, mint, destination }, { amount: mintAmount });

      const result = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: destination },
        { snapshotId: new anchor.BN(1) }
      );
      assert.equal(result.toString(), mintAmount.toString());
    });

    it("get_holderbalance_snapshot_at: returns live balance when queried snapshot_id exceeds all recorded entries", async () => {
      const { mint } = await deployMint({ deployer });
      await setAssetClassVersionForMint(mint, {
        functionalities: [COUPON_CREATE_COUPON, MINT_MINT],
      });
      const destination = await createTokenAccount({ mint, owner: deployer });
      const initialAmount = new anchor.BN(1_000);
      await mintTokens({ deployer, mint, destination }, { amount: initialAmount });

      // Take snapshot 1 → next mint records pre-mint balance (= initialAmount) at key=1
      await createCoupon({ deployer, mint }, { couponId: new anchor.BN(1) });
      const additionalAmount = new anchor.BN(500);
      await mintTokens({ deployer, mint, destination }, { amount: additionalAmount });
      // History: [{key=1, value=initialAmount}]. Live balance = initialAmount + additionalAmount.

      // Query a snapshot_id beyond every recorded entry → lookup_at_or_above returns None → live fallback
      const result = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: destination },
        { snapshotId: new anchor.BN(99) }
      );
      assert.equal(result.toString(), initialAmount.add(additionalAmount).toString());
    });

    it("get_holderbalance_snapshot_at: returns value of next recorded entry when queried snapshot_id has no exact match", async () => {
      const { mint } = await deployMint({ deployer });
      const destination = await createTokenAccount({ mint, owner: deployer });
      const initialAmount = new anchor.BN(1_000);
      await mintTokens({ deployer, mint, destination }, { amount: initialAmount });

      // Take snapshot 1, entry key=1 written with value=initialAmount (pre-mint balance)
      const couponId1 = new anchor.BN(1);
      await createCoupon({ deployer, mint }, { couponId: couponId1 });
      const secondAmount = new anchor.BN(500);
      await mintTokens({ deployer, mint, destination }, { amount: secondAmount });

      // Take snapshot 2, no entry added
      const couponId2 = new anchor.BN(2);
      await createCoupon({ deployer, mint }, { couponId: couponId2 });

      // Take snapshot 3, entry key=3 written with value=initialAmount+secondAmount
      const couponId3 = new anchor.BN(3);
      await createCoupon({ deployer, mint }, { couponId: couponId3 });
      await mintTokens({ deployer, mint, destination });

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
