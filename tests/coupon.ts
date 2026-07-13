import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { COUPON_PROGRAM_ID } from "./utils/address_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint } from "./program_helpers/pause/pause_instruction_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import {
  createCoupon,
  getCouponCreatedEvent,
  getCouponRateSetEvent,
  setCouponRate,
} from "./program_helpers/coupon/coupon_instruction_helper";
import {
  encodeCouponCounter,
  getCoupon,
  getCouponByPda,
  getCouponCounter,
  getCouponCounterByPda,
} from "./program_helpers/coupon/coupon_pda_helper";
import * as couponPdaUtils from "./program_helpers/coupon/coupon_pda_helper";
import { getSnapshotCounter, getSnapshotCounterByPda } from "./program_helpers/snapshot_helper";
import { getAccountInfo, getBalanceForRentExeption, surfnetSetAccount } from "./program_helpers/account_helper";
import { U64_MAX } from "./constants";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import { COUPON_CREATE_COUPON, COUPON_SET_COUPON_RATE, PAUSE_PAUSE } from "./utils/functionalities";

describe("coupon", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint({ deployer }));
    await setAssetClassVersionForMint(mint, {
      functionalities: [PAUSE_PAUSE, COUPON_CREATE_COUPON, COUPON_SET_COUPON_RATE],
    });
  });

  describe("create_coupon", async () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: creates the first coupon, takes a snapshot, and stores both PDAs", async () => {
      const couponId = new anchor.BN(1);
      const periodStartDate = new anchor.BN(1_700_000_000);
      const periodEndDate = new anchor.BN(1_750_000_000);
      const paymentDate = new anchor.BN(1_800_000_000);

      const couponPda = couponPdaUtils.couponPda(mint, couponId);
      const couponCounterPda = couponPdaUtils.couponCounterPda(mint);
      const snapshotCounterPda = pdaUtils.snapshotCounterPda(mint);

      // Sanity: nothing exists yet
      assert.isNull(await getAccountInfo(couponPda));
      assert.isNull(await getAccountInfo(couponCounterPda));
      assert.isNull(await getAccountInfo(snapshotCounterPda));

      const { signature } = await createCoupon(
        { deployer, mint },
        { periodStartDate, periodEndDate, paymentDate, couponId }
      );

      const event = await getCouponCreatedEvent(signature);

      assert.isNotNull(event, "Coupon creation event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.couponId.toString(), new anchor.BN(1).toString(), "event couponId should match the id");
      assert.equal(
        event!.periodStartDate.toString(),
        periodStartDate.toString(),
        "event periodStartDate should match the arg"
      );
      assert.equal(
        event!.periodEndDate.toString(),
        periodEndDate.toString(),
        "event periodEndDate should match the arg"
      );
      assert.equal(event!.paymentDate.toString(), paymentDate.toString(), "event paymentDate should match the arg");
      assert.isNull(event!.interestRateOverride, "event interestRateOverride should be null when not provided");
      assert.isNull(
        event!.interestRateOverrideDecimals,
        "event interestRateOverrideDecimals should be null when not provided"
      );

      // ── coupon_counter exists with count = 1 ─────────────────────────────────
      const counter = await getCouponCounterByPda(couponCounterPda);
      assert.equal(counter.count.toString(), "1", "coupon_counter.count should be 1");

      // ── snapshot_counter exists with count = 1 ───────────────────────────────
      const snapshotCounter = await getSnapshotCounterByPda(snapshotCounterPda);
      assert.equal(snapshotCounter.count.toString(), "1", "snapshot_counter.count should be 1");

      // ── coupon PDA holds the right data ──────────────────────────────────────
      const coupon = await getCouponByPda(couponPda);
      assert.equal(coupon.snapshotId.toString(), "1", "coupon.snapshot_id should match the just-taken snapshot");
      assert.equal(
        coupon.periodStartDate.toString(),
        periodStartDate.toString(),
        "coupon.period_start_date should match the arg"
      );
      assert.equal(
        coupon.periodEndDate.toString(),
        periodEndDate.toString(),
        "coupon.period_end_date should match the arg"
      );
      assert.equal(coupon.paymentDate.toString(), paymentDate.toString(), "coupon.payment_date should match the arg");

      // ── rate override is null by default ─────────────────────────────────────
      assert.isNull(coupon.interestRateOverride, "interest_rate_override should be null when not provided");
      assert.isNull(
        coupon.interestRateOverrideDecimals,
        "interest_rate_override_decimals should be null when not provided"
      );

      const couponAccountInfo = await getAccountInfo(couponPda);
      assert.equal(
        couponAccountInfo!.owner.toBase58(),
        COUPON_PROGRAM_ID.toBase58(),
        "coupon PDA should be owned by coupon"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: second call increments both counters to 2", async () => {
      // First coupon
      const couponId1 = new anchor.BN(1);
      const periodStartDate1 = new anchor.BN(1_700_000_000);
      const periodEndDate1 = new anchor.BN(1_750_000_000);
      const paymentDate1 = new anchor.BN(1_800_000_000);
      await createCoupon(
        { deployer, mint },
        {
          couponId: couponId1,
          periodStartDate: periodStartDate1,
          periodEndDate: periodEndDate1,
          paymentDate: paymentDate1,
        }
      );

      // Second coupon — period continues immediately after the first.
      const couponId2 = new anchor.BN(2);
      const periodStartDate2 = periodEndDate1;
      const periodEndDate2 = new anchor.BN(1_850_000_000);
      const paymentDate2 = new anchor.BN(1_900_000_000);
      await createCoupon(
        { deployer, mint },
        {
          couponId: couponId2,
          periodStartDate: periodStartDate2,
          periodEndDate: periodEndDate2,
          paymentDate: paymentDate2,
        }
      );

      const counter = await getCouponCounter(mint);
      assert.equal(counter.count.toString(), "2", "coupon_counter.count should be 2");

      const snapshotCounter = await getSnapshotCounter(mint);
      assert.equal(snapshotCounter.count.toString(), "2", "snapshot_counter.count should be 2");

      const coupon2 = await getCoupon(mint, couponId2);
      assert.equal(coupon2.snapshotId.toString(), "2");
      assert.equal(coupon2.periodStartDate.toString(), periodStartDate2.toString());
      assert.equal(coupon2.periodEndDate.toString(), periodEndDate2.toString());
      assert.equal(coupon2.paymentDate.toString(), paymentDate2.toString());
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: stores rate override when both fields are provided at creation", async () => {
      const couponId = new anchor.BN(1);

      // 5.275 % → interest_rate = 5275, interest_rate_decimals = 5
      const overrideRate = new anchor.BN(5275);
      const overrideDecimals = 5;

      const { signature } = await createCoupon(
        { deployer, mint },
        { couponId, interestRateOverride: overrideRate, interestRateOverrideDecimals: overrideDecimals }
      );

      const event = await getCouponCreatedEvent(signature);

      assert.isNotNull(event, "Coupon creation event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.couponId.toString(), couponId.toString(), "event couponId should match the id");
      assert.isNotNull(event!.interestRateOverride, "event interestRateOverride should be set");
      assert.equal(
        event!.interestRateOverride!.toString(),
        overrideRate.toString(),
        "event interestRateOverride should match the provided value"
      );
      assert.isNotNull(event!.interestRateOverrideDecimals, "event interestRateOverrideDecimals should be set");
      assert.equal(
        event!.interestRateOverrideDecimals!.toString(),
        overrideDecimals.toString(),
        "event interestRateOverrideDecimals should match the provided value"
      );

      const coupon = await getCoupon(mint, couponId);
      assert.isNotNull(coupon.interestRateOverride, "interest_rate_override should be set");
      assert.equal(
        (coupon.interestRateOverride as anchor.BN).toString(),
        overrideRate.toString(),
        "interest_rate_override should match the arg"
      );
      assert.isNotNull(coupon.interestRateOverrideDecimals, "interest_rate_override_decimals should be set");
      assert.equal(
        coupon.interestRateOverrideDecimals,
        overrideDecimals,
        "interest_rate_override_decimals should match the arg"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with InconsistentRateOverride when only interest_rate_override is provided", async () => {
      try {
        await createCoupon(
          { deployer, mint },
          { interestRateOverride: new anchor.BN(5275), interestRateOverrideDecimals: null }
        );
        assert.fail("Expected InconsistentRateOverride error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "InconsistentRateOverride");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with InconsistentRateOverride when only interest_rate_override_decimals is provided", async () => {
      try {
        await createCoupon({ deployer, mint }, { interestRateOverride: null, interestRateOverrideDecimals: 5 });
        assert.fail("Expected InconsistentRateOverride error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "InconsistentRateOverride");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with InvalidCouponId when supplied id does not match counter+1", async () => {
      // Try to create coupon with id=2 as the first coupon (should be 1)
      const wrongId = new anchor.BN(2);

      try {
        await createCoupon({ deployer, mint }, { couponId: wrongId });
        assert.fail("Expected InvalidCouponId error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "InvalidCouponId");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with CouponCounterOverflow when the counter is at u64::MAX", async () => {
      // Brute-forcing the counter from 0 to u64::MAX is infeasible, so we plant a
      // coupon_counter already saturated at u64::MAX via surfpool's
      // surfnet_setAccount cheatcode. The next create_coupon then hits the `else`
      // branch `counter.count.checked_add(1)` -> None -> CouponCounterOverflow.
      const [couponCounterPda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("coupon_counter"), mint.toBuffer()],
        COUPON_PROGRAM_ID
      );
      const data = await encodeCouponCounter(bump, U64_MAX);
      const lamports = await getBalanceForRentExeption(data.length);

      await surfnetSetAccount(couponCounterPda, {
        lamports,
        owner: COUPON_PROGRAM_ID.toBase58(),
        data: data.toString("hex"),
        executable: false,
        rentEpoch: 0,
      });

      // Sanity: the planted counter really is at u64::MAX.
      const planted = await getCouponCounterByPda(couponCounterPda);
      assert.equal(planted.count.toString(), U64_MAX.toString(), "coupon_counter should be planted at u64::MAX");

      // The overflow check runs before the coupon_id comparison, so the default
      // coupon_id is irrelevant — the instruction reverts on the checked_add.
      try {
        await createCoupon({ deployer, mint });
        assert.fail("Expected CouponCounterOverflow error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "CouponCounterOverflow");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with MintPaused when mint is paused", async () => {
      await pauseMint({ deployer, mint });

      try {
        await createCoupon({ deployer, mint });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "MintPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with Deactivated when mint has been deactivated", async () => {
      await deactivateMint({ deployer, mint });

      try {
        await createCoupon({ deployer, mint });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const rogueKeypair = Keypair.generate();

      try {
        await createCoupon({ payer: deployer, deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] });
        assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "UnauthorizedDeployer");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with InvalidCouponPeriod when period_end_date <= period_start_date", async () => {
      // start == end (zero-length period) — must fail.
      const sameDate = new anchor.BN(1_700_000_000);
      try {
        await createCoupon({ deployer, mint }, { periodStartDate: sameDate, periodEndDate: sameDate });
        assert.fail("Expected InvalidCouponPeriod error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "InvalidCouponPeriod");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with InvalidPaymentDate when payment_date <= period_end_date", async () => {
      // payment_date == period_end_date — must fail (strict `>` is required).
      const sameDate = new anchor.BN(1_750_000_000);
      try {
        await createCoupon({ deployer, mint }, { periodEndDate: sameDate, paymentDate: sameDate });
        assert.fail("Expected InvalidPaymentDate error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "InvalidPaymentDate");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with FunctionalityNotSupportedError when the create_coupon functionality is not enabled", async () => {
      // Re-seed the asset-class version WITHOUT the create_coupon functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await createCoupon({ deployer, mint });
        assert.fail("Expected FunctionalityNotSupportedError but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FunctionalityNotSupportedError",
          "error code should be FunctionalityNotSupportedError"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("create_coupon: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [COUPON_CREATE_COUPON],
      });

      try {
        await createCoupon({ deployer, mint });
        assert.fail("Expected AssetClassVersionNotFinalized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AssetClassVersionNotFinalized",
          "error code should be AssetClassVersionNotFinalized"
        );
      }
    });
  });

  describe("set_coupon_rate", async () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("set_coupon_rate: sets the rate override on an existing coupon that had none", async () => {
      const couponId = new anchor.BN(1);
      const couponPda = couponPdaUtils.couponPda(mint, couponId);

      // Create coupon without an override
      await createCoupon(
        { deployer, mint },
        { couponId, interestRateOverride: null, interestRateOverrideDecimals: null }
      );

      // Verify no override yet
      const before = await getCouponByPda(couponPda);
      assert.isNull(before.interestRateOverride);
      assert.isNull(before.interestRateOverrideDecimals);

      // Set the override: 3.5 % → rate = 3500, decimals = 5
      const overrideRate = new anchor.BN(3500);
      const overrideDecimals = 5;

      const { signature } = await setCouponRate(
        { deployer, mint },
        {
          couponId,
          interestRate: overrideRate,
          interestRateDecimals: overrideDecimals,
        }
      );

      const after = await getCouponByPda(couponPda);
      assert.isNotNull(after.interestRateOverride, "interest_rate_override should be set after call");
      assert.equal(
        (after.interestRateOverride as anchor.BN).toString(),
        overrideRate.toString(),
        "interest_rate_override should match the arg"
      );
      assert.equal(
        after.interestRateOverrideDecimals,
        overrideDecimals,
        "interest_rate_override_decimals should match the arg"
      );

      const event = await getCouponRateSetEvent(signature);
      assert.isNotNull(event, "Coupon rate set event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.couponId.toString(), couponId.toString(), "event couponId should match the id");
      assert.isNotNull(event!.interestRateOverride, "event interestRateOverride should be set");
      assert.equal(
        event!.interestRateOverride!.toString(),
        overrideRate.toString(),
        "event interestRateOverride should match the provided value"
      );
      assert.isNotNull(event!.interestRateOverrideDecimals, "event interestRateOverrideDecimals should be set");
      assert.equal(
        event!.interestRateOverrideDecimals!.toString(),
        overrideDecimals.toString(),
        "event interestRateOverrideDecimals should match the provided value"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_coupon_rate: replaces an existing override with a new one", async () => {
      const couponId = new anchor.BN(1);

      // Create coupon with an initial override: 5 %
      await createCoupon(
        { deployer, mint },
        { couponId, interestRateOverride: new anchor.BN(5000), interestRateOverrideDecimals: 5 }
      );

      // Replace with a lower rate: 2.5 %
      const overrideRate = new anchor.BN(2500);
      const overrideDecimals = 5;

      await setCouponRate(
        { deployer, mint },
        {
          couponId,
          interestRate: overrideRate,
          interestRateDecimals: overrideDecimals,
        }
      );

      const coupon = await getCoupon(mint, couponId);
      assert.equal(
        (coupon.interestRateOverride as anchor.BN).toString(),
        overrideRate.toString(),
        "interest_rate_override should reflect the replacement"
      );
      assert.equal(coupon.interestRateOverrideDecimals, overrideDecimals);
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_coupon_rate: clears an existing override when both args are null", async () => {
      const couponId = new anchor.BN(1);

      // Create coupon with an initial override: 5 %
      await createCoupon(
        { deployer, mint },
        { couponId, interestRateOverride: new anchor.BN(5000), interestRateOverrideDecimals: 5 }
      );

      // Clear the override — coupon reverts to the asset-level rate
      await setCouponRate(
        { deployer, mint },
        {
          couponId,
          interestRate: null,
          interestRateDecimals: null,
        }
      );

      const coupon = await getCoupon(mint, couponId);
      assert.isNull(coupon.interestRateOverride, "interest_rate_override should be cleared");
      assert.isNull(coupon.interestRateOverrideDecimals, "interest_rate_override_decimals should be cleared");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_coupon_rate: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const couponId = new anchor.BN(1);
      await createCoupon({ deployer, mint }, { couponId });
      const rogueKeypair = Keypair.generate();

      try {
        await setCouponRate({ deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] }, { couponId });
        assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "UnauthorizedDeployer");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_coupon_rate: fails with MintPaused when mint is paused", async () => {
      const couponId = new anchor.BN(1);
      await createCoupon({ deployer, mint }, { couponId });
      await pauseMint({ deployer, mint });

      try {
        await setCouponRate({ deployer, mint }, { couponId });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "MintPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_coupon_rate: fails with Deactivated when mint has been deactivated", async () => {
      const couponId = new anchor.BN(1);
      await createCoupon({ deployer, mint }, { couponId });
      await deactivateMint({ deployer, mint });

      try {
        await setCouponRate({ deployer, mint }, { couponId });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_coupon_rate: fails with FunctionalityNotSupportedError when the set_coupon_rate functionality is not enabled", async () => {
      const couponId = new anchor.BN(1);
      await createCoupon({ deployer, mint }, { couponId });

      // Re-seed the asset-class version WITH create_coupon (needed for the fixture
      // above to have already succeeded) but WITHOUT set_coupon_rate.
      await setAssetClassVersionForMint(mint, { functionalities: [COUPON_CREATE_COUPON] });

      try {
        await setCouponRate({ deployer, mint }, { couponId });
        assert.fail("Expected FunctionalityNotSupportedError but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FunctionalityNotSupportedError",
          "error code should be FunctionalityNotSupportedError"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_coupon_rate: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const couponId = new anchor.BN(1);
      await createCoupon({ deployer, mint }, { couponId });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [COUPON_SET_COUPON_RATE],
      });

      try {
        await setCouponRate({ deployer, mint }, { couponId });
        assert.fail("Expected AssetClassVersionNotFinalized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AssetClassVersionNotFinalized",
          "error code should be AssetClassVersionNotFinalized"
        );
      }
    });
  });
});
