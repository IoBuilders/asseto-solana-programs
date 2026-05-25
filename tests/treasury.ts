import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Mint } from "../target/types/mint";
import { Pause } from "../target/types/pause";
import { Deactivate } from "../target/types/deactivate";
import { Snapshot } from "../target/types/snapshot";
import { Bond } from "../target/types/bond";
import { Coupon } from "../target/types/coupon";
import { Treasury } from "../target/types/treasury";
import { Keypair, PublicKey, SendTransactionError, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAccount, createMint, getAccount, mintTo } from "@solana/spl-token";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import {
  SYSTEM_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
} from "./utils/address_utils";

// ── Bond mint parameters ───────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";

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

const REF_BOND_ARGS = {
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

  // All workspace programs except deploy are cast to `any` to bypass the
  // strict ResolvedAccounts typing in Anchor 0.32 (see write-tests SKILL.md).
  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const mintProgram = anchor.workspace.Mint as Program<Mint>;
  const pauseProgram = anchor.workspace.Pause as Program<Pause>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;
  const snapshotProgram = anchor.workspace.Snapshot as Program<Snapshot>;
  const bondProgram = anchor.workspace.Bond as Program<Bond>;
  const couponProgram = anchor.workspace.Coupon as Program<Coupon>;
  const treasuryProgram = anchor.workspace.Treasury as Program<Treasury>;

  const connection = provider.connection;
  const deployer = provider.wallet.publicKey;
  const payerKeypair = provider.wallet.payer!;

  // ── Helper: deploy a fresh bond mint ───────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
    mintAuthority: PublicKey;
    freezeAuthority: PublicKey;
    pausableAuthority: PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);
    const tempMintAuthority = pdaUtils.tempMintAuthorityPda(mint);
    const mintAuthority = pdaUtils.mintAuthorityPda(mint);
    const permanentDelegateAuthority = pdaUtils.permanentDelegatePda(mint);
    const metadataUpdateAuthority = pdaUtils.metadataUpdateAuthorityPda(mint);
    const pausableAuthority = pdaUtils.pausableAuthorityPda(mint);
    const freezeAuthority = pdaUtils.freezeAuthorityPda(mint);
    const transferHookAuthority = pdaUtils.transferHookAuthorityPda(mint);
    const extraAccountMetaList = pdaUtils.extraAccountMetaListPda(mint);

    const tx = await deployProgram.methods
      .deployMint({
        decimals: MINT_DECIMALS,
        name: MINT_NAME,
        symbol: MINT_SYMBOL,
        uri: MINT_URI,
        additionalMetadata: [],
      })
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        mint,
        tempMintAuthority,
        mintAuthority,
        permanentDelegateAuthority,
        metadataUpdateAuthority,
        pausableAuthority,
        freezeAuthority,
        transferHookAuthority,
        extraAccountMetaList,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda, mintAuthority, freezeAuthority, pausableAuthority };
  }

  // ── Helper: derive every treasury / pay_coupon PDA the tests need ──────────
  function treasuryPdas(mint: PublicKey, couponId: anchor.BN, holderTokenAccount: PublicKey) {
    const deactivatePda = pdaUtils.deactivatePda(mint);
    const treasuryConfig = pdaUtils.treasuryConfigPda(mint);
    const treasuryAuthority = pdaUtils.treasuryAuthorityPda(mint);
    const bondTerms = pdaUtils.bondTermsPda(mint);
    const couponAuthority = pdaUtils.couponAuthorityPda(mint);
    const couponCounter = pdaUtils.couponCounterPda(mint);
    const coupon = pdaUtils.couponPda(mint, couponId);
    const snapshotCounter = pdaUtils.snapshotCounterPda(mint);
    const holderBalanceSnapshot = pdaUtils.snapshotHolderBalancePda(mint, holderTokenAccount);
    const totalSupplySnapshot = pdaUtils.snapshotTotalSupplyPda(mint);
    const couponPaid = pdaUtils.couponPaidPda(mint, couponId, holderTokenAccount);
    return {
      deactivatePda,
      treasuryConfig,
      treasuryAuthority,
      bondTerms,
      couponAuthority,
      couponCounter,
      coupon,
      snapshotCounter,
      holderBalanceSnapshot,
      totalSupplySnapshot,
      couponPaid,
    };
  }

  // ── Helper: mint bond tokens to a brand new bond-mint token account ────────
  async function mintBondTokens(
    mint: PublicKey,
    mintOwnerPda: PublicKey,
    mintAuthority: PublicKey,
    freezeAuthority: PublicKey,
    amount: anchor.BN
  ): Promise<PublicKey> {
    const destinationKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      destinationKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destinationKeypair.publicKey;

    const deactivatePda = pdaUtils.deactivatePda(mint);
    const transferControlModePda = pdaUtils.transferControlModePda(mint);
    const destinationWhitelistPda = pdaUtils.whitelistPda(mint, destination);
    const snapshotCounterPda = pdaUtils.snapshotCounterPda(mint);
    const totalSupplySnapshot = pdaUtils.snapshotTotalSupplyPda(mint);
    const holderBalanceSnapshot = pdaUtils.snapshotHolderBalancePda(mint, destination);

    await mintProgram.methods
      .mint(amount)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        mintAuthority,
        destination,
        freezeAuthority,
        transferControlModePda,
        destinationWhitelistPda,
        snapshotCounterPda,
        totalSupplySnapshot,
        holderBalanceSnapshot,
        freezeProgram: FREEZE_PROGRAM_ID,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    return destination;
  }

  // ── Helper: create a stand-alone Token-2022 payment mint (e.g. stablecoin) ─
  // The mint authority is the local payerKeypair so the test can `mintTo` freely.
  async function createPaymentMint(decimals: number): Promise<PublicKey> {
    return await createMint(
      connection,
      payerKeypair,
      payerKeypair.publicKey, // mint authority
      null, // no freeze authority
      decimals,
      Keypair.generate(),
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
  }

  // ── Helper: build & fund the treasury's payment-mint TA (owner = PDA) ──────
  async function createAndFundTreasuryTA(
    paymentMint: PublicKey,
    treasuryAuthority: PublicKey,
    fundAmount: bigint
  ): Promise<PublicKey> {
    const taKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      paymentMint,
      treasuryAuthority, // owner = treasury_authority PDA
      taKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    if (fundAmount > BigInt(0)) {
      await mintTo(
        connection,
        payerKeypair,
        paymentMint,
        taKeypair.publicKey,
        payerKeypair,
        fundAmount,
        [],
        { commitment: "confirmed" },
        TOKEN_2022_PROGRAM_ID
      );
    }
    return taKeypair.publicKey;
  }

  // ── Helper: create a payment-mint TA owned by an arbitrary key ─────────────
  async function createPaymentTA(paymentMint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    const taKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      paymentMint,
      owner,
      taKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    return taKeypair.publicKey;
  }

  // ── Helper: end-to-end setup for pay_coupon ────────────────────────────────
  // Deploys a fresh mint, mints bond tokens to a holder TA, writes BondTerms,
  // creates coupon #1 (which CPIs take_snapshot), creates a payment mint,
  // funds the treasury TA, and calls set_payment_token. Returns every handle a
  // pay_coupon test needs.
  async function deployBondAndCoupon(opts?: {
    paymentMintDecimals?: number;
    treasuryFunding?: bigint;
    bondArgs?: typeof REF_BOND_ARGS;
    periodStartDate?: anchor.BN;
    periodEndDate?: anchor.BN;
    paymentDate?: anchor.BN;
  }) {
    const paymentMintDecimals = opts?.paymentMintDecimals ?? 6;
    const treasuryFunding = opts?.treasuryFunding ?? BigInt(1_000_000_000);
    const bondArgs = opts?.bondArgs ?? REF_BOND_ARGS;
    const periodStartDate = opts?.periodStartDate ?? PERIOD_START;
    const periodEndDate = opts?.periodEndDate ?? PERIOD_END;
    const paymentDate = opts?.paymentDate ?? PAYMENT_DATE;

    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, pausableAuthority } = await deployMint();

    // 1. Mint bond tokens to a brand-new holder bond-mint token account.
    const holderTokenAccount = await mintBondTokens(
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      BOND_HOLDER_AMOUNT
    );

    // 2. update_bond_terms
    const couponId = new anchor.BN(1);
    const pdas = treasuryPdas(mint, couponId, holderTokenAccount);
    await bondProgram.methods
      .updateBondTerms(bondArgs)
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda: pdas.deactivatePda,
        mint,
        bondTerms: pdas.bondTerms,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // 3. create_coupon (also CPIs take_snapshot → snapshot_id = 1).
    await couponProgram.methods
      .createCoupon(periodStartDate, periodEndDate, paymentDate, couponId, null, null)
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda: pdas.deactivatePda,
        mint,
        couponAuthority: pdas.couponAuthority,
        couponCounter: pdas.couponCounter,
        coupon: pdas.coupon,
        snapshotCounter: pdas.snapshotCounter,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // 4. Create the payment mint + the holder's payment-mint TA.
    const paymentMint = await createPaymentMint(paymentMintDecimals);
    const holderPaymentAccount = await createPaymentTA(paymentMint, deployer);

    // 5. Create + fund the treasury TA (owner = treasury_authority PDA).
    const treasuryTokenAccount = await createAndFundTreasuryTA(paymentMint, pdas.treasuryAuthority, treasuryFunding);

    // 6. set_payment_token → caches (payment_mint, payment_mint_decimals).
    await treasuryProgram.methods
      .setPaymentToken()
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda: pdas.deactivatePda,
        mint,
        treasuryConfig: pdas.treasuryConfig,
        paymentMint,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    return {
      mint,
      mintOwnerPda,
      pausableAuthority,
      couponId,
      holderTokenAccount,
      paymentMint,
      paymentMintDecimals,
      holderPaymentAccount,
      treasuryTokenAccount,
      pdas,
    };
  }

  // ── Helper: build a pay_coupon accounts map (override-friendly) ────────────
  function payCouponAccounts(
    base: Awaited<ReturnType<typeof deployBondAndCoupon>>,
    overrides: Partial<{
      paymentMint: PublicKey;
      treasuryTokenAccount: PublicKey;
      holderPaymentAccount: PublicKey;
      payer: PublicKey;
      deployer: PublicKey;
    }> = {}
  ) {
    return {
      payer: overrides.payer ?? deployer,
      deployer: overrides.deployer ?? deployer,
      mintOwnerPda: base.mintOwnerPda,
      deactivatePda: base.pdas.deactivatePda,
      mint: base.mint,
      treasuryConfig: base.pdas.treasuryConfig,
      treasuryAuthority: base.pdas.treasuryAuthority,
      paymentMint: overrides.paymentMint ?? base.paymentMint,
      treasuryTokenAccount: overrides.treasuryTokenAccount ?? base.treasuryTokenAccount,
      holderPaymentAccount: overrides.holderPaymentAccount ?? base.holderPaymentAccount,
      holderTokenAccount: base.holderTokenAccount,
      bondTerms: base.pdas.bondTerms,
      coupon: base.pdas.coupon,
      holderBalanceSnapshot: base.pdas.holderBalanceSnapshot,
      couponPaid: base.pdas.couponPaid,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
    };
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

  // ════════════════════════════════════════════════════════════════════════════
  // set_payment_token
  // ════════════════════════════════════════════════════════════════════════════

  it("set_payment_token: creates treasury_config with the correct payment_mint and decimals", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const couponId = new anchor.BN(1);
    const dummyHolderTA = Keypair.generate().publicKey;
    const pdas = treasuryPdas(mint, couponId, dummyHolderTA);
    const paymentDecimals = 6;
    const paymentMint = await createPaymentMint(paymentDecimals);

    const before = await connection.getAccountInfo(pdas.treasuryConfig, "confirmed");
    assert.isNull(before, "treasury_config PDA should not exist before set_payment_token");

    const tx: string = await treasuryProgram.methods
      .setPaymentToken()
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda: pdas.deactivatePda,
        mint,
        treasuryConfig: pdas.treasuryConfig,
        paymentMint,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  set_payment_token tx:", tx);

    const cfg = await treasuryProgram.account.treasuryConfig.fetch(pdas.treasuryConfig);
    assert.equal(cfg.paymentMint.toBase58(), paymentMint.toBase58(), "payment_mint should be cached");
    assert.equal(cfg.paymentMintDecimals, paymentDecimals, "payment_mint_decimals should match");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("set_payment_token: a second call overwrites the cached payment_mint and decimals", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const couponId = new anchor.BN(1);
    const dummyHolderTA = Keypair.generate().publicKey;
    const pdas = treasuryPdas(mint, couponId, dummyHolderTA);
    const firstMint = await createPaymentMint(6);
    const secondMint = await createPaymentMint(9);

    // First call.
    await treasuryProgram.methods
      .setPaymentToken()
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda: pdas.deactivatePda,
        mint,
        treasuryConfig: pdas.treasuryConfig,
        paymentMint: firstMint,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    let cfg = await treasuryProgram.account.treasuryConfig.fetch(pdas.treasuryConfig);
    assert.equal(cfg.paymentMint.toBase58(), firstMint.toBase58());
    assert.equal(cfg.paymentMintDecimals, 6);

    // Second call → overwrite.
    await treasuryProgram.methods
      .setPaymentToken()
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda: pdas.deactivatePda,
        mint,
        treasuryConfig: pdas.treasuryConfig,
        paymentMint: secondMint,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    cfg = await treasuryProgram.account.treasuryConfig.fetch(pdas.treasuryConfig);
    assert.equal(cfg.paymentMint.toBase58(), secondMint.toBase58(), "payment_mint should be overwritten");
    assert.equal(cfg.paymentMintDecimals, 9, "decimals should be overwritten");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("set_payment_token: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();
    const couponId = new anchor.BN(1);
    const dummyHolderTA = Keypair.generate().publicKey;
    const pdas = treasuryPdas(mint, couponId, dummyHolderTA);
    const paymentMint = await createPaymentMint(6);

    await pauseProgram.methods
      .pause()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda: pdas.deactivatePda,
        mint,
        pausableAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    try {
      await treasuryProgram.methods
        .setPaymentToken()
        .accountsStrict({
          payer: deployer,
          deployer,
          mintOwnerPda,
          deactivatePda: pdas.deactivatePda,
          mint,
          treasuryConfig: pdas.treasuryConfig,
          paymentMint,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "MintPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("set_payment_token: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const couponId = new anchor.BN(1);
    const dummyHolderTA = Keypair.generate().publicKey;
    const pdas = treasuryPdas(mint, couponId, dummyHolderTA);
    const paymentMint = await createPaymentMint(6);

    await deactivateProgram.methods
      .deactivate()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda: pdas.deactivatePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    try {
      await treasuryProgram.methods
        .setPaymentToken()
        .accountsStrict({
          payer: deployer,
          deployer,
          mintOwnerPda,
          deactivatePda: pdaUtils.deactivatePda(mint),
          mint,
          treasuryConfig: pdas.treasuryConfig,
          paymentMint,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("set_payment_token: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const couponId = new anchor.BN(1);
    const dummyHolderTA = Keypair.generate().publicKey;
    const pdas = treasuryPdas(mint, couponId, dummyHolderTA);
    const paymentMint = await createPaymentMint(6);

    const rogue = Keypair.generate();

    try {
      await treasuryProgram.methods
        .setPaymentToken()
        .accountsStrict({
          payer: deployer,
          deployer: rogue.publicKey,
          mintOwnerPda,
          deactivatePda: pdas.deactivatePda,
          mint,
          treasuryConfig: pdas.treasuryConfig,
          paymentMint,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .signers([rogue])
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // pay_coupon — happy path + math sanity
  // ════════════════════════════════════════════════════════════════════════════

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
    const holderBalance: anchor.BN = await snapshotProgram.methods
      .getHolderbalanceSnapshotAt(new anchor.BN(1))
      .accountsStrict({
        mint: ctx.mint,
        holderBalanceSnapshot: ctx.pdas.holderBalanceSnapshot,
        holderTokenAccount: ctx.holderTokenAccount,
      })
      .view();
    console.log("  snapshot holder_balance (raw):", holderBalance.toString());

    const expectedAmount = computeExpectedAmount({
      interestRate: REF_BOND_ARGS.interestRate,
      interestRateDecimals: REF_BOND_ARGS.interestRateDecimals,
      parValue: REF_BOND_ARGS.parValue,
      parValueDecimals: REF_BOND_ARGS.parValueDecimals,
      bondMintDecimals: MINT_DECIMALS,
      paymentMintDecimals: 6,
      holderBalance,
      elapsedSeconds: new anchor.BN(ONE_YEAR_SECS),
      dayCount: 365,
    });
    console.log("  expected amount (raw):", expectedAmount.toString());

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

    const treasuryBefore = (await getAccount(connection, ctx.treasuryTokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID))
      .amount;
    const holderBefore = (await getAccount(connection, ctx.holderPaymentAccount, "confirmed", TOKEN_2022_PROGRAM_ID))
      .amount;

    const tx: string = await treasuryProgram.methods
      .payCoupon(ctx.couponId)
      .accountsStrict(payCouponAccounts(ctx))
      .rpc({ commitment: "confirmed" });
    console.log("  pay_coupon tx:", tx);

    const treasuryAfter = (await getAccount(connection, ctx.treasuryTokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID))
      .amount;
    const holderAfter = (await getAccount(connection, ctx.holderPaymentAccount, "confirmed", TOKEN_2022_PROGRAM_ID))
      .amount;

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

    const marker = await treasuryProgram.account.couponPaidMarker.fetch(ctx.pdas.couponPaid);
    assert.equal(
      marker.amount.toString(),
      expectedAmount.toString(),
      "coupon_paid.amount should match transferred amount"
    );
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
    const ctx = await deployBondAndCoupon({
      paymentMintDecimals: 9,
      treasuryFunding: BigInt(100_000_000_000),
    });

    const holderBalance: anchor.BN = await snapshotProgram.methods
      .getHolderbalanceSnapshotAt(new anchor.BN(1))
      .accountsStrict({
        mint: ctx.mint,
        holderBalanceSnapshot: ctx.pdas.holderBalanceSnapshot,
        holderTokenAccount: ctx.holderTokenAccount,
      })
      .view();

    const expectedAmount = computeExpectedAmount({
      interestRate: REF_BOND_ARGS.interestRate,
      interestRateDecimals: REF_BOND_ARGS.interestRateDecimals,
      parValue: REF_BOND_ARGS.parValue,
      parValueDecimals: REF_BOND_ARGS.parValueDecimals,
      bondMintDecimals: MINT_DECIMALS, // 6
      paymentMintDecimals: 9,
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

    const treasuryBefore = (await getAccount(connection, ctx.treasuryTokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID))
      .amount;
    const holderBefore = (await getAccount(connection, ctx.holderPaymentAccount, "confirmed", TOKEN_2022_PROGRAM_ID))
      .amount;

    await treasuryProgram.methods
      .payCoupon(ctx.couponId)
      .accountsStrict(payCouponAccounts(ctx))
      .rpc({ commitment: "confirmed" });

    const treasuryAfter = (await getAccount(connection, ctx.treasuryTokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID))
      .amount;
    const holderAfter = (await getAccount(connection, ctx.holderPaymentAccount, "confirmed", TOKEN_2022_PROGRAM_ID))
      .amount;

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

    const marker = await treasuryProgram.account.couponPaidMarker.fetch(ctx.pdas.couponPaid);
    assert.equal(
      marker.amount.toString(),
      expectedAmount.toString(),
      "coupon_paid.amount should match transferred amount"
    );
  });

  // ════════════════════════════════════════════════════════════════════════════
  // pay_coupon — error paths
  // ════════════════════════════════════════════════════════════════════════════

  it("pay_coupon: fails with ConstraintAddress when payment_mint != treasury_config.payment_mint", async () => {
    const ctx = await deployBondAndCoupon();
    const wrongMint = await createPaymentMint(6);

    try {
      await treasuryProgram.methods
        .payCoupon(ctx.couponId)
        .accountsStrict(payCouponAccounts(ctx, { paymentMint: wrongMint }))
        .rpc({ commitment: "confirmed" });
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
    const otherMint = await createPaymentMint(6);
    const wrongTA = await createAndFundTreasuryTA(otherMint, ctx.pdas.treasuryAuthority, BigInt(1_000));

    try {
      await treasuryProgram.methods
        .payCoupon(ctx.couponId)
        .accountsStrict(payCouponAccounts(ctx, { treasuryTokenAccount: wrongTA }))
        .rpc({ commitment: "confirmed" });
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
    const wrongTA = await createPaymentTA(ctx.paymentMint, deployer);

    try {
      await treasuryProgram.methods
        .payCoupon(ctx.couponId)
        .accountsStrict(payCouponAccounts(ctx, { treasuryTokenAccount: wrongTA }))
        .rpc({ commitment: "confirmed" });
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
    const otherMint = await createPaymentMint(6);
    const wrongHolderTA = await createPaymentTA(otherMint, deployer);

    try {
      await treasuryProgram.methods
        .payCoupon(ctx.couponId)
        .accountsStrict(payCouponAccounts(ctx, { holderPaymentAccount: wrongHolderTA }))
        .rpc({ commitment: "confirmed" });
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
      await treasuryProgram.methods
        .payCoupon(ctx.couponId)
        .accountsStrict(payCouponAccounts(ctx))
        .rpc({ commitment: "confirmed" });
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
    await treasuryProgram.methods
      .payCoupon(ctx.couponId)
      .accountsStrict(payCouponAccounts(ctx))
      .rpc({ commitment: "confirmed" });

    // Second pay — Anchor's `init` constraint on `coupon_paid` should fail
    // because the PDA already exists. This surfaces from the System program as
    // "already in use" rather than as an Anchor error code, so we match on the
    // log substring (per write-tests SKILL.md guidance for non-Anchor errors).
    try {
      await treasuryProgram.methods
        .payCoupon(ctx.couponId)
        .accountsStrict(payCouponAccounts(ctx))
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected double-payment to fail but the second call succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError);
      const logs = (err as SendTransactionError).logs ?? [];
      logs.forEach((l) => console.log("    ", l));
      assert.isTrue(
        logs.some((l) => l.toLowerCase().includes("already in use")),
        "logs should mention the coupon_paid PDA being already in use"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("pay_coupon: fails with MintPaused when the bond mint is paused", async () => {
    const ctx = await deployBondAndCoupon();
    const deactivatePda = pdaUtils.deactivatePda(ctx.mint);

    await pauseProgram.methods
      .pause()
      .accountsStrict({
        deployer,
        mintOwnerPda: ctx.mintOwnerPda,
        deactivatePda,
        mint: ctx.mint,
        pausableAuthority: ctx.pausableAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    try {
      await treasuryProgram.methods
        .payCoupon(ctx.couponId)
        .accountsStrict(payCouponAccounts(ctx))
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "MintPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("pay_coupon: fails with Deactivated when the bond mint has been deactivated", async () => {
    const ctx = await deployBondAndCoupon();

    await deactivateProgram.methods
      .deactivate()
      .accountsStrict({
        deployer,
        mintOwnerPda: ctx.mintOwnerPda,
        mint: ctx.mint,
        deactivatePda: ctx.pdas.deactivatePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    try {
      await treasuryProgram.methods
        .payCoupon(ctx.couponId)
        .accountsStrict(payCouponAccounts(ctx))
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("pay_coupon: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const ctx = await deployBondAndCoupon();
    const rogue = Keypair.generate();

    try {
      await treasuryProgram.methods
        .payCoupon(ctx.couponId)
        .accountsStrict(payCouponAccounts(ctx, { deployer: rogue.publicKey }))
        .signers([rogue])
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "UnauthorizedDeployer");
    }
  });
});
