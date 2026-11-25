import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError, Signer } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy/deploy_instruction_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_ADMIN, ROLE_TREASURER, ROLE_CORPORATE_ACTION } from "./utils/roles";
import { UpdateBondArgs, updateBondTerms } from "./program_helpers/bond/bond_instruction_helper";
import {
  createMint,
  createTokenAccount,
  getTokenAccount,
  mintTo,
  mintTokensViaSurfpool,
  setMintPaused,
} from "./program_helpers/spl_token_helper";
import { setSnapshotMerkleRoot } from "./program_helpers/snapshot/snapshot_pda_helper";
import { leafHash, nodeHash, EMPTY_PROOF } from "./program_helpers/snapshot/merkle_helper";
import {
  getCouponPaidEvent,
  getPaymentTokenSetEvent,
  payCoupon,
  setPaymentToken,
} from "./program_helpers/treasury/treasury_instruction_helper";
import {
  getCouponDistribution,
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
  COUPON_SET_COUPON_RATE,
  DEACTIVATE_DEACTIVATE,
  MINT_MINT,
  PAUSE_PAUSE,
  TREASURY_PAY_COUPON,
  TREASURY_SET_PAYMENT_TOKEN,
} from "./utils/functionalities";
import { beforeEach } from "mocha";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setCoupon } from "./program_helpers/coupon/coupon_pda_helper";
import { setCouponRate } from "./program_helpers/coupon/coupon_instruction_helper";

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
    const holder = Keypair.generate().publicKey;
    const holderTokenAccount = await createTokenAccount({ mint, owner: holder });
    await mintTokensViaSurfpool(mint, holderTokenAccount, BOND_HOLDER_AMOUNT);

    // 2. update_bond_terms
    const bondArgs = opts?.bondArgs ?? DEFAULT_UPDATE_BOND_ARGS;
    await updateBondTerms({ authority, mint }, bondArgs);

    // 3. Plant the coupon + its snapshot state (setCoupon defaults the coupon's
    //    snapshot_id to couponId), then plant the snapshot's Merkle root as a
    //    single-leaf tree over (holder, BOND_HOLDER_AMOUNT) — leaves are keyed by
    //    the owning wallet, not the bond token account.
    const couponId = new anchor.BN(1);
    const periodStartDate = opts?.periodStartDate ?? PERIOD_START;
    const periodEndDate = opts?.periodEndDate ?? PERIOD_END;
    const paymentDate = opts?.paymentDate ?? PAYMENT_DATE;
    await setCoupon(mint, couponId, { periodStartDate, periodEndDate, paymentDate });
    await setSnapshotMerkleRoot(mint, couponId, leafHash(holder, BOND_HOLDER_AMOUNT));

    // 4. Create the payment mint + the holder's payment-mint TA.
    const paymentMint = await createMint({ decimals: paymentMintDecimals });
    const holderPaymentAccount = await createTokenAccount({ mint: paymentMint, owner: holder });

    // 5. Create + fund the treasury TA (owner = treasury_authority PDA).
    const treasuryTokenAccount = await createAndFundTreasuryTokenAccount(mint, paymentMint, treasuryFunding);

    // 6. set_payment_token → caches (payment_mint, payment_mint_decimals).
    await setPaymentToken({ authority, mint, paymentMint });

    return {
      mint,
      couponId,
      holder,
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
      holder: PublicKey;
      balance: anchor.BN;
      merkleProof: number[][];
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
        holder: overrides.holder ?? base.holder,
        signers: overrides?.signers,
      },
      {
        couponId: base.couponId,
        balance: overrides.balance ?? BOND_HOLDER_AMOUNT,
        merkleProof: overrides.merkleProof ?? EMPTY_PROOF,
      }
    );
  }

  // ── Helper: replace the single-leaf root with a two-holder tree ───────────
  // Leaves are (ctx.holder, BOND_HOLDER_AMOUNT) and (holderB, BOND_HOLDER_AMOUNT);
  // in a two-leaf sorted-pair tree each holder's proof is the other leaf.
  async function plantSecondHolder(ctx: Awaited<ReturnType<typeof deployBondAndCoupon>>) {
    const holderB = Keypair.generate().publicKey;
    const leafA = leafHash(ctx.holder, BOND_HOLDER_AMOUNT);
    const leafB = leafHash(holderB, BOND_HOLDER_AMOUNT);
    await setSnapshotMerkleRoot(ctx.mint, ctx.couponId, nodeHash(leafA, leafB));
    const holderBPaymentAccount = await createTokenAccount({ mint: ctx.paymentMint, owner: holderB });
    return { holderB, holderBPaymentAccount, proofA: [leafB], proofB: [leafA] };
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
    ({ mint } = await deployMint({}, { decimals: MINT_DECIMALS }));
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        PAUSE_PAUSE,
        BOND_UPDATE_BOND_TERMS,
        TREASURY_PAY_COUPON,
        TREASURY_SET_PAYMENT_TOKEN,
        COUPON_CREATE_COUPON,
        DEACTIVATE_DEACTIVATE,
        MINT_MINT,
        COUPON_SET_COUPON_RATE,
      ],
    });
    await setRoles(mint, authority!.publicKey, [ROLE_CORPORATE_ACTION, ROLE_TREASURER]);
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

      await setMintPaused(mint, true);

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
    it("set_payment_token: succeeds while a coupon is mid-distribution, without affecting that coupon", async () => {
      const ctx = await deployBondAndCoupon();
      await payCouponInternal(ctx);

      const newPaymentMint = await createMint();
      await setPaymentToken({ authority, mint: ctx.mint, paymentMint: newPaymentMint });

      const cfg = await getTreasuryConfigByPda(treasuryPdaUtils.treasuryConfigPda(ctx.mint));
      assert.equal(cfg!.paymentMint.toBase58(), newPaymentMint.toBase58(), "config should point at the new mint");
      const dist = await getCouponDistribution(ctx.mint, ctx.couponId);
      assert.equal(
        dist!.paymentMint.toBase58(),
        ctx.paymentMint.toBase58(),
        "the open coupon must stay pinned to the mint it started with"
      );
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

      // deployBondAndCoupon plants the snapshot merkle root as the single leaf hash
      // for (holder, BOND_HOLDER_AMOUNT), so an EMPTY_PROOF verifies
      // trivially against it (see setSnapshotMerkleRoot above). pay_coupon takes
      // the holder's balance as an explicit argument and checks it against that
      // root via require_balance_proof — the payout is computed from that verified
      // balance, not read from any on-chain snapshot state.
      const holderBalance = BOND_HOLDER_AMOUNT;

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

      const marker = await getCouponPaidMarker(ctx.mint, ctx.couponId, ctx.holder);
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
      assert.equal(event!.holder.toBase58(), ctx.holder.toBase58(), "event holder should be the proven wallet");
      assert.equal(
        event!.destination.toBase58(),
        ctx.holderPaymentAccount.toBase58(),
        "event destination should be the credited payment account"
      );
      assert.equal(event!.balance.toString(), holderBalance.toString(), "event balance should be the proven balance");
      assert.equal(event!.paymentMint.toBase58(), ctx.paymentMint.toBase58(), "event payment_mint should match");
      assert.equal(event!.amount.toString(), expectedAmount.toString(), "event amount should match the payout");
      assert.equal(event!.payer.toBase58(), payer.toBase58(), "event payer should be the deployer");

      // ── Assertions: coupon_distribution pinned on first payment ──────────────
      const dist = await getCouponDistribution(ctx.mint, ctx.couponId);
      assert.isNotNull(dist, "coupon_distribution should be created by the first payment");
      assert.equal(dist!.paymentMint.toBase58(), ctx.paymentMint.toBase58());
      assert.equal(dist!.paymentMintDecimals, ctx.paymentMintDecimals);
      assert.equal(dist!.interestRate.toString(), DEFAULT_UPDATE_BOND_ARGS.interestRate.toString());
      assert.equal(dist!.interestRateDecimals, DEFAULT_UPDATE_BOND_ARGS.interestRateDecimals);
      assert.equal(dist!.parValue.toString(), DEFAULT_UPDATE_BOND_ARGS.parValue.toString());
      assert.equal(dist!.parValueDecimals, DEFAULT_UPDATE_BOND_ARGS.parValueDecimals);
      assert.equal(dist!.dayCountDays, 365);
      assert.equal(dist!.paidCount.toString(), "1");
      assert.equal(dist!.totalPaid.toString(), expectedAmount.toString());
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

      const holderBalance = BOND_HOLDER_AMOUNT;

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

      const marker = await getCouponPaidMarker(ctx.mint, ctx.couponId, ctx.holder);
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
      const holderPaymentAccountB = await createTokenAccount({
        mint: paymentMint,
        owner: ctx.holder,
      });

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
    it("pay_coupon: fails with PaymentMintMismatch when payment_mint != treasury_config.payment_mint on the first payment", async () => {
      const ctx = await deployBondAndCoupon();
      const wrongMint = await createMint();
      const wrongTreasuryTA = await createAndFundTreasuryTokenAccount(ctx.mint, wrongMint, BigInt(1_000_000_000));
      const wrongHolderTA = await createTokenAccount({ mint: wrongMint, owner: ctx.holder });

      try {
        await payCouponInternal(ctx, {
          paymentMint: wrongMint,
          treasuryTokenAccount: wrongTreasuryTA,
          holderPaymentAccount: wrongHolderTA,
        });
        assert.fail("Expected PaymentMintMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "PaymentMintMismatch");
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
      const wrongTA = await createTokenAccount({ mint: ctx.paymentMint, owner: Keypair.generate().publicKey });

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
      const wrongHolderTA = await createTokenAccount({ mint: otherMint, owner: ctx.holder });

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
    it("pay_coupon: fails on the second call for the same (coupon_id, holder) — coupon_paid PDA already in use", async () => {
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
      await setMintPaused(ctx.mint, true);

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

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: fails with PaymentDestinationMismatch when holder_payment_account is not owned by the proven holder", async () => {
      const ctx = await deployBondAndCoupon();
      const attackerTA = await createTokenAccount({ mint: ctx.paymentMint, owner: Keypair.generate().publicKey });
      const treasuryBefore = (await getTokenAccount(ctx.treasuryTokenAccount)).amount;

      try {
        await payCouponInternal(ctx, { holderPaymentAccount: attackerTA });
        assert.fail("Expected PaymentDestinationMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "PaymentDestinationMismatch");
      }

      const treasuryAfter = (await getTokenAccount(ctx.treasuryTokenAccount)).amount;
      assert.equal(treasuryAfter.toString(), treasuryBefore.toString(), "treasury must not be debited");
      assert.isNull(await getCouponPaidMarker(ctx.mint, ctx.couponId, ctx.holder), "holder must not be marked as paid");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: pays a holder that no longer has any bond token account (leaf is keyed by wallet)", async () => {
      const ctx = await deployBondAndCoupon();
      // holderB is a leaf of the snapshot tree but has no bond token account in
      // this test — equivalent to one closed after the record date.
      const { holderB, holderBPaymentAccount, proofB } = await plantSecondHolder(ctx);

      await payCouponInternal(ctx, {
        holder: holderB,
        holderPaymentAccount: holderBPaymentAccount,
        merkleProof: proofB,
      });

      const credited = (await getTokenAccount(holderBPaymentAccount)).amount;
      assert.equal(credited.toString(), "50000000", "holderB should receive the canonical 50.000000 payout");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: late payers of an open coupon keep the pinned payment mint after set_payment_token", async () => {
      const ctx = await deployBondAndCoupon();
      const { holderB, holderBPaymentAccount, proofA, proofB } = await plantSecondHolder(ctx);

      await payCouponInternal(ctx, { merkleProof: proofA });

      // Treasurer switches currency mid-distribution.
      const newMint = await createMint();
      const newTreasuryTA = await createAndFundTreasuryTokenAccount(ctx.mint, newMint, BigInt(1_000_000_000));
      const holderBNewTA = await createTokenAccount({ mint: newMint, owner: holderB });
      await setPaymentToken({ authority, mint: ctx.mint, paymentMint: newMint });

      // Paying holderB in the new mint is rejected for this coupon…
      try {
        await payCouponInternal(ctx, {
          holder: holderB,
          merkleProof: proofB,
          paymentMint: newMint,
          treasuryTokenAccount: newTreasuryTA,
          holderPaymentAccount: holderBNewTA,
        });
        assert.fail("Expected PaymentMintMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "PaymentMintMismatch");
      }

      // …and succeeds in the mint the coupon was opened with.
      await payCouponInternal(ctx, {
        holder: holderB,
        merkleProof: proofB,
        holderPaymentAccount: holderBPaymentAccount,
      });

      const paidA = (await getTokenAccount(ctx.holderPaymentAccount)).amount;
      const paidB = (await getTokenAccount(holderBPaymentAccount)).amount;
      assert.equal(paidB.toString(), paidA.toString(), "both holders paid the same amount in the same mint");

      const dist = await getCouponDistribution(ctx.mint, ctx.couponId);
      assert.equal(dist!.paidCount.toString(), "2");
      assert.equal(dist!.totalPaid.toString(), (paidA + paidB).toString());
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: set_coupon_rate after the first payment does not change the coupon's payout", async () => {
      const ctx = await deployBondAndCoupon();
      // Re-plant the coupon with a 5% override (same as the bond rate). The
      // setCoupon cheatcode sizes the account to its contents, so a `None`
      // override leaves no room for set_coupon_rate to write a `Some` later —
      // a real create_coupon allocates the full INIT_SPACE.
      await setCoupon(ctx.mint, ctx.couponId, {
        periodStartDate: PERIOD_START,
        periodEndDate: PERIOD_END,
        paymentDate: PAYMENT_DATE,
        interestRateOverride: new anchor.BN(500),
        interestRateOverrideDecimals: 4,
      });
      const { holderB, holderBPaymentAccount, proofA, proofB } = await plantSecondHolder(ctx);

      await payCouponInternal(ctx, { merkleProof: proofA });
      // 5% → 10% override, mid-distribution.
      await setCouponRate(
        { authority, mint: ctx.mint },
        { couponId: ctx.couponId, interestRate: new anchor.BN(1_000), interestRateDecimals: 4 }
      );
      await payCouponInternal(ctx, {
        holder: holderB,
        merkleProof: proofB,
        holderPaymentAccount: holderBPaymentAccount,
      });

      const paidA = (await getTokenAccount(ctx.holderPaymentAccount)).amount;
      const paidB = (await getTokenAccount(holderBPaymentAccount)).amount;
      assert.equal(paidB.toString(), paidA.toString(), "holderB must be paid at the rate pinned on the first payment");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pay_coupon: update_bond_terms after the first payment does not change the coupon's payout", async () => {
      const ctx = await deployBondAndCoupon();
      const { holderB, holderBPaymentAccount, proofA, proofB } = await plantSecondHolder(ctx);

      await payCouponInternal(ctx, { merkleProof: proofA });
      await updateBondTerms(
        { authority, mint: ctx.mint },
        {
          ...DEFAULT_UPDATE_BOND_ARGS,
          interestRate: new anchor.BN(1_000),
          parValue: new anchor.BN(200_000),
          dayCountConvention: { actual360: {} },
        }
      );
      await payCouponInternal(ctx, {
        holder: holderB,
        merkleProof: proofB,
        holderPaymentAccount: holderBPaymentAccount,
      });

      const paidA = (await getTokenAccount(ctx.holderPaymentAccount)).amount;
      const paidB = (await getTokenAccount(holderBPaymentAccount)).amount;
      assert.equal(
        paidB.toString(),
        paidA.toString(),
        "holderB must be paid with the bond terms pinned on the first payment"
      );
    });
  });
});
