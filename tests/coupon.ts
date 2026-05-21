import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Pause } from "../target/types/pause";
import { Deactivate } from "../target/types/deactivate";
import { Snapshot } from "../target/types/snapshot";
import { Coupon } from "../target/types/coupon";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import {
  SYSTEM_PROGRAM_ID,
  COUPON_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
} from "./utils/address_utils";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";

describe("coupon", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const pauseProgram = anchor.workspace.Pause as Program<Pause>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;
  const snapshotProgram = anchor.workspace.Snapshot as Program<Snapshot>;
  const couponProgram = anchor.workspace.Coupon as Program<Coupon>;

  const connection = provider.connection;
  const deployer = provider.wallet.publicKey;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
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
    return { mint, mintOwnerPda, pausableAuthority };
  }

  // ── Helper: derive every PDA the coupon flow needs for a given mint ────────
  function couponPdas(
    mint: PublicKey,
    couponId: anchor.BN
  ): {
    couponAuthority: PublicKey;
    couponCounter: PublicKey;
    coupon: PublicKey;
    snapshotCounter: PublicKey;
    deactivatePda: PublicKey;
  } {
    const couponAuthority = pdaUtils.couponAuthorityPda(mint);
    const couponCounter = pdaUtils.couponCounterPda(mint);
    const coupon = pdaUtils.couponPda(mint, couponId);
    const snapshotCounter = pdaUtils.snapshotCounterPda(mint);
    const deactivatePda = pdaUtils.deactivatePda(mint);
    return { couponAuthority, couponCounter, coupon, snapshotCounter, deactivatePda };
  }

  // ── Helper: build the accounts map for create_coupon ───────────────────────
  function couponAccounts(
    mint: PublicKey,
    mintOwnerPda: PublicKey,
    pdas: ReturnType<typeof couponPdas>,
    payerOverride?: PublicKey,
    deployerOverride?: PublicKey
  ) {
    return {
      payer: payerOverride ?? deployer,
      deployer: deployerOverride ?? deployer,
      mintOwnerPda,
      deactivatePda: pdas.deactivatePda,
      mint,
      couponAuthority: pdas.couponAuthority,
      couponCounter: pdas.couponCounter,
      coupon: pdas.coupon,
      snapshotCounter: pdas.snapshotCounter,
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: creates the first coupon, takes a snapshot, and stores both PDAs", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const couponId = new anchor.BN(1);
    const periodStartDate = new anchor.BN(1_700_000_000);
    const periodEndDate = new anchor.BN(1_750_000_000);
    const paymentDate = new anchor.BN(1_800_000_000);
    const pdas = couponPdas(mint, couponId);

    // Sanity: nothing exists yet
    assert.isNull(await connection.getAccountInfo(pdas.coupon, "confirmed"));
    assert.isNull(await connection.getAccountInfo(pdas.couponCounter, "confirmed"));
    assert.isNull(await connection.getAccountInfo(pdas.snapshotCounter, "confirmed"));

    const tx: string = await couponProgram.methods
      .createCoupon(periodStartDate, periodEndDate, paymentDate, couponId)
      .accountsStrict(couponAccounts(mint, mintOwnerPda, pdas))
      .rpc({ commitment: "confirmed" });

    console.log("  create_coupon tx:", tx);

    // ── coupon_counter exists with count = 1 ─────────────────────────────────
    const counter = await couponProgram.account.couponCounter.fetch(pdas.couponCounter);
    assert.equal(counter.count.toString(), "1", "coupon_counter.count should be 1");

    // ── snapshot_counter exists with count = 1 ───────────────────────────────
    const snapshotCounter = await snapshotProgram.account.snapshotCounter.fetch(pdas.snapshotCounter);
    assert.equal(snapshotCounter.count.toString(), "1", "snapshot_counter.count should be 1");

    // ── coupon PDA holds the right data ──────────────────────────────────────
    const coupon = await couponProgram.account.coupon.fetch(pdas.coupon);
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

    const couponAccountInfo = await connection.getAccountInfo(pdas.coupon, "confirmed");
    assert.equal(
      couponAccountInfo!.owner.toBase58(),
      COUPON_PROGRAM_ID.toBase58(),
      "coupon PDA should be owned by coupon"
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: second call increments both counters to 2", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    // First coupon
    const id1 = new anchor.BN(1);
    const start1 = new anchor.BN(1_700_000_000);
    const end1 = new anchor.BN(1_750_000_000);
    const pay1 = new anchor.BN(1_800_000_000);
    const pdas1 = couponPdas(mint, id1);
    await couponProgram.methods
      .createCoupon(start1, end1, pay1, id1)
      .accountsStrict(couponAccounts(mint, mintOwnerPda, pdas1))
      .rpc({ commitment: "confirmed" });

    // Second coupon — period continues immediately after the first.
    const id2 = new anchor.BN(2);
    const start2 = end1;
    const end2 = new anchor.BN(1_850_000_000);
    const pay2 = new anchor.BN(1_900_000_000);
    const pdas2 = couponPdas(mint, id2);
    await couponProgram.methods
      .createCoupon(start2, end2, pay2, id2)
      .accountsStrict(couponAccounts(mint, mintOwnerPda, pdas2))
      .rpc({ commitment: "confirmed" });

    const counter = await couponProgram.account.couponCounter.fetch(pdas2.couponCounter);
    assert.equal(counter.count.toString(), "2", "coupon_counter.count should be 2");

    const snapshotCounter = await snapshotProgram.account.snapshotCounter.fetch(pdas2.snapshotCounter);
    assert.equal(snapshotCounter.count.toString(), "2", "snapshot_counter.count should be 2");

    const coupon2 = await couponProgram.account.coupon.fetch(pdas2.coupon);
    assert.equal(coupon2.snapshotId.toString(), "2");
    assert.equal(coupon2.periodStartDate.toString(), start2.toString());
    assert.equal(coupon2.periodEndDate.toString(), end2.toString());
    assert.equal(coupon2.paymentDate.toString(), pay2.toString());
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: fails with InvalidCouponId when supplied id does not match counter+1", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    // Try to create coupon with id=2 as the first coupon (should be 1)
    const wrongId = new anchor.BN(2);
    const pdas = couponPdas(mint, wrongId);

    try {
      await couponProgram.methods
        .createCoupon(new anchor.BN(1_700_000_000), new anchor.BN(1_750_000_000), new anchor.BN(1_800_000_000), wrongId)
        .accountsStrict(couponAccounts(mint, mintOwnerPda, pdas))
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected InvalidCouponId error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      assert.equal(anchorErr.error.errorCode.code, "InvalidCouponId");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();
    const couponId = new anchor.BN(1);
    const pdas = couponPdas(mint, couponId);

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
      await couponProgram.methods
        .createCoupon(
          new anchor.BN(1_700_000_000),
          new anchor.BN(1_750_000_000),
          new anchor.BN(1_800_000_000),
          couponId
        )
        .accountsStrict(couponAccounts(mint, mintOwnerPda, pdas))
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "MintPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const couponId = new anchor.BN(1);
    const pdas = couponPdas(mint, couponId);

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
      await couponProgram.methods
        .createCoupon(
          new anchor.BN(1_700_000_000),
          new anchor.BN(1_750_000_000),
          new anchor.BN(1_800_000_000),
          couponId
        )
        .accountsStrict(couponAccounts(mint, mintOwnerPda, pdas))
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const couponId = new anchor.BN(1);
    const pdas = couponPdas(mint, couponId);

    const rogue = Keypair.generate();

    try {
      await couponProgram.methods
        .createCoupon(
          new anchor.BN(1_700_000_000),
          new anchor.BN(1_750_000_000),
          new anchor.BN(1_800_000_000),
          couponId
        )
        .accountsStrict(couponAccounts(mint, mintOwnerPda, pdas, deployer, rogue.publicKey))
        .signers([rogue])
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: fails with InvalidCouponPeriod when period_end_date <= period_start_date", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const couponId = new anchor.BN(1);
    const pdas = couponPdas(mint, couponId);

    // start == end (zero-length period) — must fail.
    const sameDate = new anchor.BN(1_700_000_000);
    try {
      await couponProgram.methods
        .createCoupon(sameDate, sameDate, new anchor.BN(1_800_000_000), couponId)
        .accountsStrict(couponAccounts(mint, mintOwnerPda, pdas))
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected InvalidCouponPeriod error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "InvalidCouponPeriod");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: fails with InvalidPaymentDate when payment_date <= period_end_date", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const couponId = new anchor.BN(1);
    const pdas = couponPdas(mint, couponId);

    // payment_date == period_end_date — must fail (strict `>` is required).
    const start = new anchor.BN(1_700_000_000);
    const end = new anchor.BN(1_750_000_000);
    try {
      await couponProgram.methods
        .createCoupon(start, end, end, couponId)
        .accountsStrict(couponAccounts(mint, mintOwnerPda, pdas))
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected InvalidPaymentDate error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "InvalidPaymentDate");
    }
  });
});
