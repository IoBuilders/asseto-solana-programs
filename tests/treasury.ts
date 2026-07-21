import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError, Signer } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_PAUSER, ROLE_ADMIN, ROLE_TREASURER } from "./utils/roles";
import { pauseMint } from "./program_helpers/pause/pause_instruction_helper";
import { UpdateBondArgs, updateBondTerms } from "./program_helpers/bond/bond_instruction_helper";
import {
  createMint,
  createTokenAccount,
  getTokenAccount,
  mintTo,
  mintTokensViaSurfpool,
} from "./program_helpers/spl_token_helper";
import { getHolderBalanceSnapshotAt } from "./program_helpers/snapshot/snapshot_instruction_helper";
import {
  getCouponPaidEvent,
  getPaymentTokenSetEvent,
  payCoupon,
  setPaymentToken,
} from "./program_helpers/treasury/treasury_instruction_helper";
import {
  getCouponPaidMarker,
  getTreasuryConfigByPda,
  treasuryAuthorityPda,
} from "./program_helpers/treasury/treasury_pda_helper";
import * as treasuryPdaUtils from "./program_helpers/treasury/treasury_pda_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import {
  BOND_UPDATE_BOND_TERMS,
  COUPON_CREATE_COUPON,
  DEACTIVATE_DEACTIVATE,
  MINT_MINT,
  PAUSE_PAUSE,
  TREASURY_PAY_COUPON,
  TREASURY_SET_PAYMENT_TOKEN,
} from "./utils/functionalities";
import { beforeEach } from "mocha";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setCoupon } from "./program_helpers/coupon/coupon_pda_helper";

// ── Bond mint parameters ───────────────────────────────────────────────────────
const MINT_DECIMALS = 6;

// 1 bond at 6 decimals — keeps the math sanity test reproducible.
const BOND_HOLDER_AMOUNT = new anchor.BN(1_000_000);

// Reference bond terms used across pay_coupon tests:
//   5% interest_rate (rate=500, decimals=4),
//   $1,000.00 par value (par=100_000, decimals=2),
//   issued at unix 1_700_000_000, Actual/365.
const ISSUANCE_DATE = new anchor.BN(1_700_000_000);
// Coupon accrues over a full year, paid 2 days later (settlement lag).
const ONE_YEAR_SECS = 365 * 86_400;
const SETTLEMENT_LAG = 2 * 86_400;
const PERIOD_START = ISSUANCE_DATE;
const PERIOD_END = ISSUANCE_DATE.addn(ONE_YEAR_SECS);
const PAYMENT_DATE = PERIOD_END.addn(SETTLEMENT_LAG);

const DEFAULT_UPDATE_BOND_ARGS: UpdateBondArgs = {
  interestRate: new anchor.BN(500),
  interestRateDecimals: 4,
  parValue: new anchor.BN(100_000),
  parValueDecimals: 2,
  minimumDenomination: new anchor.BN(100),
  issuanceDate: ISSUANCE_DATE,
  dayCountConvention: { actual365: {} },
};

describe("treasury", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployer = provider.wallet.publicKey;
  const payer = provider.wallet.publicKey;
  const authority = provider.wallet.payer;

  // ── Helper: build & fund the treasury's payment-mint token account (owner = PDA) ──────
  async function createAndFundTreasuryTokenAccount(
    mint: PublicKey,
    paymentMint: PublicKey,
    fundAmount: bigint
  ): Promise<PublicKey> {
    const treasuryAuthority = treasuryAuthorityPda(mint);
    const tokenAccount = await createTokenAccount({ mint: paymentMint, owner: treasuryAuthority });
    if (fundAmount > BigInt(0)) {
      await mintTo({ mint: paymentMint, tokenAccount, amount: fundAmount });
    }
    return tokenAccount;
  }

  // ── Helper: end-to-end setup for pay_coupon ────────────────────────────────
  // Deploys a fresh mint, mints bond tokens to a holder TA, writes BondTerms,
  // creates coupon #1 (which CPIs take_snapshot), creates a payment mint,
  // funds the treasury TA, and calls set_payment_token. Returns every handle a
  // pay_coupon test needs.
  async function deployBondAndCoupon(opts?: {
    paymentMintDecimals?: number;
    treasuryFunding?: bigint;
    bondArgs?: UpdateBondArgs;
    periodStartDate?: anchor.BN;
    periodEndDate?: anchor.BN;
    paymentDate?: anchor.BN;
  }) {
    const paymentMintDecimals = opts?.paymentMintDecimals ?? MINT_DECIMALS;
    const treasuryFunding = opts?.treasuryFunding ?? BigInt(1_000_000_000);

    // 1. Mint bond tokens to a brand-new holder bond-mint token account.
    const holderTokenAccount = await createTokenAccount({ mint, owner: deployer });
    await mintTokensViaSurfpool(mint, holderTokenAccount, BOND_HOLDER_AMOUNT);

    // 2. update_bond_terms
    const bondArgs = opts?.bondArgs ?? DEFAULT_UPDATE_BOND_ARGS;
    await updateBondTerms({ deployer, mint }, bondArgs);

    // 3. create_coupon (also CPIs take_snapshot → snapshot_id = 1).
    const couponId = new anchor.BN(1);
    const periodStartDate = opts?.periodStartDate ?? PERIOD_START;
    const periodEndDate = opts?.periodEndDate ?? PERIOD_END;
    const paymentDate = opts?.paymentDate ?? PAYMENT_DATE;
    await setCoupon(mint, couponId, { periodStartDate, periodEndDate, paymentDate });

    // 4. Create the payment mint + the holder's payment-mint TA.
    const paymentMint = await createMint({ decimals: paymentMintDecimals });
    const holderPaymentAccount = await createTokenAccount({ mint: paymentMint, owner: deployer });

    // 5. Create + fund the treasury TA (owner = treasury_authority PDA).
    const treasuryTokenAccount = await createAndFundTreasuryTokenAccount(mint, paymentMint, treasuryFunding);

    // 6. set_payment_token → caches (payment_mint, payment_mint_decimals).
    await setPaymentToken({ authority, mint, paymentMint });

    return {
      mint,
      couponId,
      holderTokenAccount,
      paymentMint,
      paymentMintDecimals,
      holderPaymentAccount,
      treasuryTokenAccount,
    };
  }

  // ── Helper: build a pay_coupon accounts map (override-friendly) ────────────
  async function payCouponInternal(
    base: Awaited<ReturnType<typeof deployBondAndCoupon>>,
    overrides: Partial<{
      paymentMint: PublicKey;
      treasuryTokenAccount: PublicKey;
      holderPaymentAccount: PublicKey;
      payer: PublicKey;
      authority: Keypair;
      signers: Signer[];
    }> = {}
  ) {
    return await payCoupon(
      {
        payer: overrides?.payer ?? payer,
        authority: overrides?.authority ?? authority,
        mint: base.mint,
        paymentMint: overrides.paymentMint ?? base.paymentMint,
        treasuryTokenAccount: overrides.treasuryTokenAccount ?? base.treasuryTokenAccount,
        holderPaymentAccount: overrides.holderPaymentAccount ?? base.holderPaymentAccount,
        holderTokenAccount: base.holderTokenAccount,
        signers: overrides?.signers,
      },
      { couponId: base.couponId }
    );
  }

  // ── Helper: compute expected coupon amount (mirrors Rust handler) ─────────
  // Mathematical formula:
  //   amount = (interest_rate × holder_balance × par_value × elapsed_seconds × 10^payment_dec)
  //          / (10^interest_decimals × 10^bond_dec × 10^par_value_decimals × day_count × 86_400)
  //
  // Implemented via the same algebraic simplification as the handler: the four
  // 10^… factors collapse into a single signed exponent
  // `net_power = paymentDec − (interestDec + bondDec + parDec)` applied to one
  // side. Single end-of-pipeline integer division for max precision.
  function computeExpectedAmount(args: {
    interestRate: anchor.BN;
    interestRateDecimals: number;
    parValue: anchor.BN;
    parValueDecimals: number;
    bondMintDecimals: number;
    paymentMintDecimals: number;
    holderBalance: anchor.BN;
    elapsedSeconds: anchor.BN;
    dayCount: number;
  }): anchor.BN {
    let num = args.interestRate.mul(args.holderBalance).mul(args.parValue).mul(args.elapsedSeconds);
    let den = new anchor.BN(args.dayCount).muln(86_400);

    const positiveDecs = args.interestRateDecimals + args.bondMintDecimals + args.parValueDecimals;
    const netPower = args.paymentMintDecimals - positiveDecs;

    if (netPower >= 0) {
      num = num.mul(new anchor.BN(10).pow(new anchor.BN(netPower)));
    } else {
      den = den.mul(new anchor.BN(10).pow(new anchor.BN(-netPower)));
    }
    return num.div(den);
  }

  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS }));
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        PAUSE_PAUSE,
        BOND_UPDATE_BOND_TERMS,
        TREASURY_PAY_COUPON,
        TREASURY_SET_PAYMENT_TOKEN,
        COUPON_CREATE_COUPON,
        DEACTIVATE_DEACTIVATE,
        MINT_MINT,
      ],
    });
    await setRoles(mint, authority!.publicKey, [ROLE_TREASURER]);
  });

  describe("set_payment_token", async () => {
    it("set_payment_token: creates treasury_config with the correct payment_mint and decimals", async () => {
      const treasuryConfigPda = treasuryPdaUtils.treasuryConfigPda(mint);
      const paymentDecimals = 5;
      const paymentMint = await createMint({ decimals: paymentDecimals });

      const before = await getTreasuryConfigByPda(treasuryConfigPda);
      assert.isNull(before, "treasury_config PDA should not exist before set_payment_token");

      const { signature } = await setPaymentToken({ authority, mint, paymentMint });

      const cfg = await getTreasuryConfigByPda(treasuryConfigPda);
      assert.equal(cfg.paymentMint.toBase58(), paymentMint.toBase58(), "payment_mint should be cached");
      assert.equal(cfg.paymentMintDecimals, paymentDecimals, "payment_mint_decimals should match");

      // ── Assertions: PaymentTokenSet event ─────────────────────────────────────
      const event = await getPaymentTokenSetEvent(signature);
      assert.isNotNull(event, "PaymentTokenSet event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the bond mint");
      assert.equal(event!.paymentMint.toBase58(), paymentMint.toBase58(), "event payment_mint should match");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_payment_token: a second call overwrites the cached payment_mint and decimals", async () => {
      const treasuryConfigPda = treasuryPdaUtils.treasuryConfigPda(mint);
      const firstMintDecimals = 8;
      const secondMintDecimals = 9;
      const firstMint = await createMint({ decimals: firstMintDecimals });
      const secondMint = await createMint({ decimals: 9 });

      // First call.
      await setPaymentToken({ authority, mint, paymentMint: firstMint });

      let cfg = await getTreasuryConfigByPda(treasuryConfigPda);
      assert.equal(cfg.paymentMint.toBase58(), firstMint.toBase58());
      assert.equal(cfg.paymentMintDecimals, firstMintDecimals);

      // Second call → overwrite.
      await setPaymentToken({ authority, mint, paymentMint: secondMint });

      cfg = await getTreasuryConfigByPda(treasuryConfigPda);
      assert.equal(cfg.paymentMint.toBase58(), secondMint.toBase58(), "payment_mint should be overwritten");
      assert.equal(cfg.paymentMintDecimals, secondMintDecimals, "decimals should be overwritten");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_payment_token: fails with MintPaused when mint is paused", async () => {
      const paymentMint = await createMint();
      await setRoles(mint, deployer, [ROLE_PAUSER]);
      await pauseMint({ deployer, mint });
      await setRoles(mint, authority!.publicKey, [ROLE_TREASURER]);

      try {
        await setPaymentToken({ payer, authority, mint, paymentMint });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "MintPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_payment_token: fails with Deactivated when mint has been deactivated", async () => {
      const paymentMint = await createMint();

      await setDeactivateMarker(mint);

      try {
        await setPaymentToken({ authority, mint, paymentMint });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_payment_token: fails with MissingRole when authority does not have the treasurer role", async () => {
      const paymentMint = await createMint();
      const rogueKeypair = Keypair.generate();
      await setRoles(mint, rogueKeypair.publicKey, [ROLE_ADMIN]);

      try {
        await setPaymentToken({
          payer,
          authority: rogueKeypair,
          mint,
          paymentMint,
          signers: [rogueKeypair],
        });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "MissingRole");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_payment_token: fails with AccountNotInitialized when payment_mint is not a valid mint", async () => {
      // A random keypair pubkey — not an initialised mint account.
      const invalidPaymentMint = Keypair.generate().publicKey;

      try {
        await setPaymentToken({ authority, mint, paymentMint: invalidPaymentMint });
        assert.fail("Expected error for invalid payment_mint but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_payment_token: fails with ClaimsInProgress when pay_coupon has already been called for the current coupon", async () => {
      const ctx = await deployBondAndCoupon();

      // Execute one pay_coupon — this locks treasury_config.locked_for_coupon_id = 1.
      await payCoupon(
        {
          authority,
          mint: ctx.mint,
          paymentMint: ctx.paymentMint,
          treasuryTokenAccount: ctx.treasuryTokenAccount,
          holderPaymentAccount: ctx.holderPaymentAccount,
          holderTokenAccount: ctx.holderTokenAccount,
        },
        { couponId: ctx.couponId }
      );

      // Attempting to change the payment mint now must fail.
      const newPaymentMint = await createMint();
      try {
        await setPaymentToken({ authority, mint: ctx.mint, paymentMint: newPaymentMint });
        assert.fail("Expected ClaimsInProgress error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "ClaimsInProgress");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_payment_token: fails with FunctionalityNotSupportedError when the set_payment_token functionality is not enabled", async () => {
      const paymentMint = await createMint();

      // Re-seed the asset-class version WITHOUT the set_payment_token functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await setPaymentToken({ authority, mint, paymentMint });
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
    it("set_payment_token: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const paymentMint = await createMint();

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [TREASURY_SET_PAYMENT_TOKEN],
      });

      try {
        await setPaymentToken({ authority, mint, paymentMint });
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

  describe("pay_coupon", async () => {
    it("pay_coupon: transfers the computed amount, debits the treasury, and creates the coupon_paid marker", async () => {
      const ctx = await deployBondAndCoupon();

      // The snapshot was taken inside create_coupon (before any new mints), so the
      // recorded balance at snapshot_id=1 is 0 for this brand-new holder. Snapshot
      // program falls back to the live balance when the history is empty for the
      // queried id — i.e. the current holder balance, which is BOND_HOLDER_AMOUNT.
      // (See snapshot::get_holderbalance_snapshot_at and the matching
      // assertion in mint.ts:579-591.)
      //
      // For this happy-path test we don't pin the exact snapshot semantics; we
      // recompute the expected amount from whatever balance the snapshot CPI
      // returns, by reading it off-chain via the same view.
      const holderBalance = await getHolderBalanceSnapshotAt(
        { mint: ctx.mint, holderTokenAccount: ctx.holderTokenAccount },
        { snapshotId: ctx.couponId }
      );

      const expectedAmount = computeExpectedAmount({
        interestRate: DEFAULT_UPDATE_BOND_ARGS.interestRate,
        interestRateDecimals: DEFAULT_UPDATE_BOND_ARGS.interestRateDecimals,
        parValue: DEFAULT_UPDATE_BOND_ARGS.parValue,
        parValueDecimals: DEFAULT_UPDATE_BOND_ARGS.parValueDecimals,
        bondMintDecimals: MINT_DECIMALS,
        paymentMintDecimals: ctx.paymentMintDecimals,
        holderBalance,
        elapsedSeconds: new anchor.BN(ONE_YEAR_SECS),
        dayCount: 365,
      });

      // Hardcoded ground-truth check on the TS helper itself: 5% × $1,000.00 par
      // × 1 bond (= BOND_HOLDER_AMOUNT raw units) × 1 full year (Actual/365)
      // = $50.00 = 50_000_000 raw units at 6 dp. Catches a bug in
      // `computeExpectedAmount` that would otherwise be masked by a matching
      // bug in the Rust handler.
      assert.equal(
        holderBalance.toString(),
        BOND_HOLDER_AMOUNT.toString(),
        "snapshot view should fall back to live balance for this brand-new holder"
      );
      assert.equal(
        expectedAmount.toString(),
        "50000000",
        "off-chain math should produce 50.000000 in raw units for the canonical 5% × $1,000 × 1y × 1 bond scenario"
      );

      const treasuryBefore = (await getTokenAccount(ctx.treasuryTokenAccount)).amount;
      const holderBefore = (await getTokenAccount(ctx.holderPaymentAccount)).amount;

      const { signature } = await payCouponInternal(ctx);

      const treasuryAfter = (await getTokenAccount(ctx.treasuryTokenAccount)).amount;
      const holderAfter = (await getTokenAccount(ctx.holderPaymentAccount)).amount;
      assert.equal(
        (holderAfter - holderBefore).toString(),
        expectedAmount.toString(),
        "holder TA should be credited by the computed coupon amount"
      );
      assert.equal(
        (treasuryBefore - treasuryAfter).toString(),
        expectedAmount.toString(),
        "treasury TA should be debited by the computed coupon amount"
      );

      const marker = await getCouponPaidMarker(ctx.mint, ctx.couponId, ctx.holderTokenAccount);
      assert.equal(
        marker.amount.toString(),
        expectedAmount.toString(),
        "coupon_paid.amount should match transferred amount"
      );

      // ── Assertions: CouponPaid event ──────────────────────────────────────────
      const event = await getCouponPaidEvent(signature);
      assert.isNotNull(event, "CouponPaid event should be emitted");
      assert.equal(event!.mint.toBase58(), ctx.mint.toBase58(), "event mint should match the bond mint");
      assert.equal(event!.couponId.toString(), ctx.couponId.toString(), "event coupon_id should match");
      assert.equal(
        event!.holderTokenAccount.toBase58(),
        ctx.holderTokenAccount.toBase58(),
        "event holder_token_account should match"
      );
      assert.equal(event!.paymentMint.toBase58(), ctx.paymentMint.toBase58(), "event payment_mint should match");
      assert.equal(event!.amount.toString(), expectedAmount.toString(), "event amount should match the payout");
      assert.equal(event!.payer.toBase58(), deployer.toBase58(), "event payer should be the deployer");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: pays the correct amount when bond and payment mints have different decimals", async () => {
      // Bond mint stays at 6 decimals (set by `deployMint`); payment mint uses 9.
      // Real-world payout for the canonical 5% × $1,000 × 1 bond × 1y is still
      // $50 — but in raw payment-mint units it should now be 50 × 10^9
      // = 50_000_000_000 (vs 50_000_000 when both decimals match).
      //
      // Treasury funding bumped to 100_000_000_000 (= $100 at 9 dp) so the
      // payout fits.
      const paymentMintDecimals = 9;
      const ctx = await deployBondAndCoupon({
        paymentMintDecimals,
        treasuryFunding: BigInt(100_000_000_000),
      });

      const holderBalance = await getHolderBalanceSnapshotAt(
        { mint: ctx.mint, holderTokenAccount: ctx.holderTokenAccount },
        { snapshotId: ctx.couponId }
      );

      const expectedAmount = computeExpectedAmount({
        interestRate: DEFAULT_UPDATE_BOND_ARGS.interestRate,
        interestRateDecimals: DEFAULT_UPDATE_BOND_ARGS.interestRateDecimals,
        parValue: DEFAULT_UPDATE_BOND_ARGS.parValue,
        parValueDecimals: DEFAULT_UPDATE_BOND_ARGS.parValueDecimals,
        bondMintDecimals: MINT_DECIMALS,
        paymentMintDecimals: ctx.paymentMintDecimals,
        holderBalance,
        elapsedSeconds: new anchor.BN(ONE_YEAR_SECS),
        dayCount: 365,
      });
      // $50 in 9-dp payment-mint smallest units = 50_000_000_000.
      assert.equal(
        expectedAmount.toString(),
        "50000000000",
        "off-chain math should produce 50.000_000_000 = $50 in 9-decimal units"
      );

      const treasuryBefore = (await getTokenAccount(ctx.treasuryTokenAccount)).amount;
      const holderBefore = (await getTokenAccount(ctx.holderPaymentAccount)).amount;

      await payCouponInternal(ctx);

      const treasuryAfter = (await getTokenAccount(ctx.treasuryTokenAccount)).amount;
      const holderAfter = (await getTokenAccount(ctx.holderPaymentAccount)).amount;

      assert.equal(
        (holderAfter - holderBefore).toString(),
        expectedAmount.toString(),
        "holder TA should be credited by the computed coupon amount"
      );
      assert.equal(
        (treasuryBefore - treasuryAfter).toString(),
        expectedAmount.toString(),
        "treasury TA should be debited by the computed coupon amount"
      );

      const marker = await getCouponPaidMarker(ctx.mint, ctx.couponId, ctx.holderTokenAccount);
      assert.equal(
        marker.amount.toString(),
        expectedAmount.toString(),
        "coupon_paid.amount should match transferred amount"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: uses the newly configured payment token after set_payment_token is updated", async () => {
      // deployBondAndCoupon sets mintA as the initial payment token.
      const ctx = await deployBondAndCoupon();

      // Create paymentMint with a fresh funded treasury TA and a holder payment TA.
      const paymentMint = await createMint();
      const treasuryTAB = await createAndFundTreasuryTokenAccount(ctx.mint, paymentMint, BigInt(1_000_000_000));
      const holderPaymentAccountB = await createTokenAccount({ mint: paymentMint, owner: deployer });

      // Update the config to point at paymentMint.
      await setPaymentToken({ authority, mint: ctx.mint, paymentMint: paymentMint });

      const treasuryBefore = (await getTokenAccount(treasuryTAB)).amount;
      const holderBefore = (await getTokenAccount(holderPaymentAccountB)).amount;

      // pay_coupon must succeed using paymentMint exclusively.
      await payCouponInternal(ctx, {
        paymentMint: paymentMint,
        treasuryTokenAccount: treasuryTAB,
        holderPaymentAccount: holderPaymentAccountB,
      });

      const treasuryAfter = (await getTokenAccount(treasuryTAB)).amount;
      const holderAfter = (await getTokenAccount(holderPaymentAccountB)).amount;

      assert.isTrue(treasuryAfter < treasuryBefore, "paymentMint treasury TA should be debited");
      assert.isTrue(holderAfter > holderBefore, "paymentMint holder TA should be credited");

      // Verify mintA treasury TA was untouched.
      const treasuryAAfter = (await getTokenAccount(ctx.treasuryTokenAccount)).amount;
      assert.equal(
        treasuryAAfter.toString(),
        BigInt(1_000_000_000).toString(),
        "mintA treasury TA should be untouched"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with ConstraintAddress when payment_mint != treasury_config.payment_mint", async () => {
      const ctx = await deployBondAndCoupon();
      const wrongMint = await createMint();

      try {
        await payCouponInternal(ctx, { paymentMint: wrongMint });
        assert.fail("Expected ConstraintAddress error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        // Anchor's `address = treasury_config.payment_mint` constraint violation.
        assert.equal((err as AnchorError).error.errorCode.code, "ConstraintAddress");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with ConstraintTokenMint when treasury TA is for a different mint", async () => {
      const ctx = await deployBondAndCoupon();

      // A second payment mint with its own TA owned by the same treasury_authority.
      const paymentMint = await createMint();
      const wrongTA = await createAndFundTreasuryTokenAccount(ctx.mint, paymentMint, BigInt(1_000));

      try {
        await payCouponInternal(ctx, { treasuryTokenAccount: wrongTA });
        assert.fail("Expected ConstraintTokenMint error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        // Anchor's `token::mint = payment_mint` constraint violation.
        assert.equal((err as AnchorError).error.errorCode.code, "ConstraintTokenMint");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with ConstraintTokenOwner when treasury TA owner is not the treasury_authority PDA", async () => {
      const ctx = await deployBondAndCoupon();

      // Same payment mint, but owned by an arbitrary key (not the PDA).
      const wrongTA = await createTokenAccount({ mint: ctx.paymentMint, owner: deployer });

      try {
        await payCouponInternal(ctx, { treasuryTokenAccount: wrongTA });
        assert.fail("Expected ConstraintTokenOwner error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        // Anchor's `token::authority = treasury_authority` constraint violation.
        assert.equal((err as AnchorError).error.errorCode.code, "ConstraintTokenOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with ConstraintTokenMint when holder payment TA is for a different mint", async () => {
      const ctx = await deployBondAndCoupon();

      // Different payment mint → TA mint won't match treasury_config.payment_mint.
      const otherMint = await createMint();
      const wrongHolderTA = await createTokenAccount({ mint: otherMint, owner: deployer });

      try {
        await payCouponInternal(ctx, { holderPaymentAccount: wrongHolderTA });
        assert.fail("Expected ConstraintTokenMint error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        // Anchor's `token::mint = payment_mint` constraint violation on holder_payment_account.
        assert.equal((err as AnchorError).error.errorCode.code, "ConstraintTokenMint");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with CouponNotMature when payment_date is still in the future", async () => {
      // Set the coupon's payment_date to one hour ahead of the cluster clock —
      // the maturity check should reject the call before any transfer happens.
      const futurePaymentDate = new anchor.BN(Math.floor(Date.now() / 1000) + 3_600);
      const ctx = await deployBondAndCoupon({ paymentDate: futurePaymentDate });

      try {
        await payCouponInternal(ctx);
        assert.fail("Expected CouponNotMature error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "CouponNotMature");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails on the second call for the same (coupon_id, holder_token_account) — coupon_paid PDA already in use", async () => {
      const ctx = await deployBondAndCoupon();

      // First pay — succeeds.
      await payCouponInternal(ctx);

      // Second pay — Anchor's `init` constraint on `coupon_paid` should fail
      // because the PDA already exists. This surfaces from the System program as
      // "already in use" rather than as an Anchor error code, so we match on the
      // log substring (per write-tests SKILL.md guidance for non-Anchor errors).
      try {
        await payCouponInternal(ctx);
        assert.fail("Expected double-payment to fail but the second call succeeded");
      } catch (err) {
        assert.instanceOf(err, SendTransactionError);
        const logs = (err as SendTransactionError).logs ?? [];
        assert.isTrue(
          logs.some((l) => l.toLowerCase().includes("already in use")),
          "logs should mention the coupon_paid PDA being already in use"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with MintPaused when the bond mint is paused", async () => {
      const ctx = await deployBondAndCoupon();
      await setRoles(mint, deployer, [ROLE_PAUSER]);
      await pauseMint({ deployer, mint });
      await setRoles(mint, authority!.publicKey, [ROLE_TREASURER]);

      try {
        await payCouponInternal(ctx);
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "MintPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with Deactivated when the bond mint has been deactivated", async () => {
      const ctx = await deployBondAndCoupon();
      await setDeactivateMarker(mint);

      try {
        await payCouponInternal(ctx);
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with MissingRole when signer is not the deployer", async () => {
      const ctx = await deployBondAndCoupon();
      const rogueKeypair = Keypair.generate();
      await setRoles(ctx.mint, rogueKeypair.publicKey, [ROLE_ADMIN]);

      try {
        await payCouponInternal(ctx, { authority: rogueKeypair, signers: [rogueKeypair] });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "MissingRole");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with FunctionalityNotSupportedError when the pay_coupon functionality is not enabled", async () => {
      const ctx = await deployBondAndCoupon();

      // Re-seed the asset-class version WITHOUT the pay_coupon functionality.
      await setAssetClassVersionForMint(ctx.mint, { functionalities: [] });

      try {
        await payCouponInternal(ctx);
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
    it("pay_coupon: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const ctx = await deployBondAndCoupon();

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(ctx.mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [TREASURY_PAY_COUPON],
      });

      try {
        await payCouponInternal(ctx);
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
