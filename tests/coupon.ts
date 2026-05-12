import * as anchor from "@coral-xyz/anchor";
import { AnchorError, Program } from "@coral-xyz/anchor";
import { Deploy } from "../target/types/deploy";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME     = "CMTAT Test Token";
const MINT_SYMBOL   = "CMTAT";
const MINT_URI      = "https://example.com/metadata.json";

describe("coupon", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram         = anchor.workspace.Deploy         as Program<Deploy>;
  const mintProgram           = anchor.workspace.Mint           as Program<any>;
  const metadataProgram       = anchor.workspace.MetadataUpdate as Program<any>;
  const freezeProgram         = anchor.workspace.Freeze         as Program<any>;
  const operationsProgram     = anchor.workspace.Operations     as Program<any>;
  const pauseProgram          = anchor.workspace.Pause          as Program<any>;
  const deactivateProgram     = anchor.workspace.Deactivate     as Program<any>;
  const transferHookProgram   = anchor.workspace.TransferHook   as Program<any>;
  const snapshotProgram       = anchor.workspace.Snapshot       as Program<any>;
  const couponProgram         = anchor.workspace.Coupon         as Program<any>;

  const connection = provider.connection;
  const deployer   = provider.wallet.publicKey;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint:               PublicKey;
    mintOwnerPda:       PublicKey;
    pausableAuthority:  PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint        = mintKeypair.publicKey;

    const [mintOwnerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_owner"), mint.toBuffer()],
      deployProgram.programId
    );
    const [tempMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("temp_mint_authority"), mint.toBuffer()],
      deployProgram.programId
    );
    const [mintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority"), mint.toBuffer()],
      mintProgram.programId
    );
    const [permanentDelegateAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("permanent_delegate"), mint.toBuffer()],
      operationsProgram.programId
    );
    const [metadataUpdateAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata_update_authority"), mint.toBuffer()],
      metadataProgram.programId
    );
    const [pausableAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pausable_authority"), mint.toBuffer()],
      pauseProgram.programId
    );
    const [freezeAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("freeze_authority"), mint.toBuffer()],
      freezeProgram.programId
    );
    const [transferHookAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_hook_authority"), mint.toBuffer()],
      transferHookProgram.programId
    );
    const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.toBuffer()],
      transferHookProgram.programId
    );

    const tx = await (deployProgram as any).methods
      .deployMint({
        decimals:           MINT_DECIMALS,
        name:               MINT_NAME,
        symbol:             MINT_SYMBOL,
        uri:                MINT_URI,
        additionalMetadata: [],
      })
      .accounts({
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
        transferHookProgram: transferHookProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda, pausableAuthority };
  }

  // ── Helper: derive every PDA the coupon flow needs for a given mint ────────
  function couponPdas(mint: PublicKey, couponId: anchor.BN): {
    couponAuthority:   PublicKey;
    couponCounter:     PublicKey;
    coupon:            PublicKey;
    snapshotCounter:   PublicKey;
    deactivatePda:     PublicKey;
  } {
    const [couponAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("coupon_authority"), mint.toBuffer()],
      couponProgram.programId
    );
    const [couponCounter] = PublicKey.findProgramAddressSync(
      [Buffer.from("coupon_counter"), mint.toBuffer()],
      couponProgram.programId
    );
    const [coupon] = PublicKey.findProgramAddressSync(
      [Buffer.from("coupon"), mint.toBuffer(), couponId.toArrayLike(Buffer, "le", 8)],
      couponProgram.programId
    );
    const [snapshotCounter] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_counter"), mint.toBuffer()],
      snapshotProgram.programId
    );
    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    return { couponAuthority, couponCounter, coupon, snapshotCounter, deactivatePda };
  }

  // ── Helper: build the accounts map for create_coupon ───────────────────────
  function couponAccounts(
    mint: PublicKey,
    mintOwnerPda: PublicKey,
    pdas: ReturnType<typeof couponPdas>,
    payerOverride?: PublicKey,
    deployerOverride?: PublicKey,
  ) {
    return {
      payer:             payerOverride    ?? deployer,
      deployer:          deployerOverride ?? deployer,
      mintOwnerPda,
      deactivatePda:     pdas.deactivatePda,
      mint,
      couponAuthority:   pdas.couponAuthority,
      couponCounter:     pdas.couponCounter,
      coupon:            pdas.coupon,
      snapshotCounter:   pdas.snapshotCounter,
      snapshotProgram:   snapshotProgram.programId,
      systemProgram:     anchor.web3.SystemProgram.programId,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: creates the first coupon, takes a snapshot, and stores both PDAs", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const couponId         = new anchor.BN(1);
    const periodStartDate  = new anchor.BN(1_700_000_000);
    const periodEndDate    = new anchor.BN(1_750_000_000);
    const paymentDate      = new anchor.BN(1_800_000_000);
    const pdas = couponPdas(mint, couponId);

    // Sanity: nothing exists yet
    assert.isNull(await connection.getAccountInfo(pdas.coupon, "confirmed"));
    assert.isNull(await connection.getAccountInfo(pdas.couponCounter, "confirmed"));
    assert.isNull(await connection.getAccountInfo(pdas.snapshotCounter, "confirmed"));

    const tx: string = await (couponProgram as any).methods
      .createCoupon(periodStartDate, periodEndDate, paymentDate, couponId)
      .accounts(couponAccounts(mint, mintOwnerPda, pdas))
      .rpc({ commitment: "confirmed" });

    console.log("  create_coupon tx:", tx);

    // ── coupon_counter exists with count = 1 ─────────────────────────────────
    const counter = await (couponProgram as any).account.couponCounter.fetch(pdas.couponCounter);
    assert.equal(counter.count.toString(), "1", "coupon_counter.count should be 1");

    // ── snapshot_counter exists with count = 1 ───────────────────────────────
    const snapshotCounter = await (snapshotProgram as any).account.snapshotCounter.fetch(pdas.snapshotCounter);
    assert.equal(snapshotCounter.count.toString(), "1", "snapshot_counter.count should be 1");

    // ── coupon PDA holds the right data ──────────────────────────────────────
    const coupon = await (couponProgram as any).account.coupon.fetch(pdas.coupon);
    assert.equal(coupon.snapshotId.toString(),       "1", "coupon.snapshot_id should match the just-taken snapshot");
    assert.equal(coupon.periodStartDate.toString(),  periodStartDate.toString(), "coupon.period_start_date should match the arg");
    assert.equal(coupon.periodEndDate.toString(),    periodEndDate.toString(),   "coupon.period_end_date should match the arg");
    assert.equal(coupon.paymentDate.toString(),      paymentDate.toString(),     "coupon.payment_date should match the arg");

    const couponAccountInfo = await connection.getAccountInfo(pdas.coupon, "confirmed");
    assert.equal(
      couponAccountInfo!.owner.toBase58(),
      couponProgram.programId.toBase58(),
      "coupon PDA should be owned by coupon"
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: second call increments both counters to 2", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    // First coupon
    const id1     = new anchor.BN(1);
    const start1  = new anchor.BN(1_700_000_000);
    const end1    = new anchor.BN(1_750_000_000);
    const pay1    = new anchor.BN(1_800_000_000);
    const pdas1   = couponPdas(mint, id1);
    await (couponProgram as any).methods
      .createCoupon(start1, end1, pay1, id1)
      .accounts(couponAccounts(mint, mintOwnerPda, pdas1))
      .rpc({ commitment: "confirmed" });

    // Second coupon — period continues immediately after the first.
    const id2    = new anchor.BN(2);
    const start2 = end1;
    const end2   = new anchor.BN(1_850_000_000);
    const pay2   = new anchor.BN(1_900_000_000);
    const pdas2  = couponPdas(mint, id2);
    await (couponProgram as any).methods
      .createCoupon(start2, end2, pay2, id2)
      .accounts(couponAccounts(mint, mintOwnerPda, pdas2))
      .rpc({ commitment: "confirmed" });

    const counter = await (couponProgram as any).account.couponCounter.fetch(pdas2.couponCounter);
    assert.equal(counter.count.toString(), "2", "coupon_counter.count should be 2");

    const snapshotCounter = await (snapshotProgram as any).account.snapshotCounter.fetch(pdas2.snapshotCounter);
    assert.equal(snapshotCounter.count.toString(), "2", "snapshot_counter.count should be 2");

    const coupon2 = await (couponProgram as any).account.coupon.fetch(pdas2.coupon);
    assert.equal(coupon2.snapshotId.toString(),       "2");
    assert.equal(coupon2.periodStartDate.toString(),  start2.toString());
    assert.equal(coupon2.periodEndDate.toString(),    end2.toString());
    assert.equal(coupon2.paymentDate.toString(),      pay2.toString());
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_coupon: fails with InvalidCouponId when supplied id does not match counter+1", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    // Try to create coupon with id=2 as the first coupon (should be 1)
    const wrongId = new anchor.BN(2);
    const pdas = couponPdas(mint, wrongId);

    try {
      await (couponProgram as any).methods
        .createCoupon(new anchor.BN(1_700_000_000), new anchor.BN(1_750_000_000), new anchor.BN(1_800_000_000), wrongId)
        .accounts(couponAccounts(mint, mintOwnerPda, pdas))
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

    await (pauseProgram as any).methods
      .pause()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        pausableAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    try {
      await (couponProgram as any).methods
        .createCoupon(new anchor.BN(1_700_000_000), new anchor.BN(1_750_000_000), new anchor.BN(1_800_000_000), couponId)
        .accounts(couponAccounts(mint, mintOwnerPda, pdas))
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

    await (deactivateProgram as any).methods
      .deactivate()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda: pdas.deactivatePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    try {
      await (couponProgram as any).methods
        .createCoupon(new anchor.BN(1_700_000_000), new anchor.BN(1_750_000_000), new anchor.BN(1_800_000_000), couponId)
        .accounts(couponAccounts(mint, mintOwnerPda, pdas))
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
      await (couponProgram as any).methods
        .createCoupon(new anchor.BN(1_700_000_000), new anchor.BN(1_750_000_000), new anchor.BN(1_800_000_000), couponId)
        .accounts(couponAccounts(mint, mintOwnerPda, pdas, deployer, rogue.publicKey))
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
      await (couponProgram as any).methods
        .createCoupon(sameDate, sameDate, new anchor.BN(1_800_000_000), couponId)
        .accounts(couponAccounts(mint, mintOwnerPda, pdas))
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
    const end   = new anchor.BN(1_750_000_000);
    try {
      await (couponProgram as any).methods
        .createCoupon(start, end, end, couponId)
        .accounts(couponAccounts(mint, mintOwnerPda, pdas))
        .rpc({ commitment: "confirmed" });
      assert.fail("Expected InvalidPaymentDate error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "InvalidPaymentDate");
    }
  });
});
