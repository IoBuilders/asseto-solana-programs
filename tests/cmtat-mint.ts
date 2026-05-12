import * as anchor from "@coral-xyz/anchor";
import { AnchorError, Program } from "@coral-xyz/anchor";
import { CmtatDeploy } from "../target/types/cmtat_deploy";
import { CmtatMint } from "../target/types/cmtat_mint";
import { Keypair, PublicKey, SendTransactionError, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAccount,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME     = "CMTAT Test Token";
const MINT_SYMBOL   = "CMTAT";
const MINT_URI      = "https://example.com/cmtat-metadata.json";

const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);

const operationsProgram             = anchor.workspace.CmtatOperations as Program<any>;
const pauseProgram                  = anchor.workspace.CmtatPause      as Program<any>;
const PERMANENT_DELEGATE_PROGRAM_ID = operationsProgram.programId;
const PAUSABLE_AUTHORITY_PROGRAM_ID = pauseProgram.programId;

describe("cmtat-mint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // All programs cast to `any` to avoid Anchor 0.32's strict ResolvedAccounts
  // type excluding seeded/auto-derivable accounts from the explicit accounts map.
  const deployProgram          = anchor.workspace.CmtatDeploy          as Program<CmtatDeploy>;
  const mintProgram            = anchor.workspace.CmtatMint            as Program<CmtatMint>;
  const metadataUpdateProgram  = anchor.workspace.CmtatMetadataUpdate  as Program<any>;
  const freezeProgram          = anchor.workspace.cmtatFreeze          as Program<any>;
  const deactivateProgram      = anchor.workspace.CmtatDeactivate      as Program<any>;
  const transferControlProgram = anchor.workspace.CmtatTransferControl as Program<any>;
  const transferHookProgram    = anchor.workspace.CmtatTransferHook    as Program<any>;
  const snapshotProgram        = anchor.workspace.CmtatSnapshot        as Program<any>;
  const couponProgram          = anchor.workspace.CmtatCoupon          as Program<any>;
  const connection  = provider.connection;
  const deployer    = provider.wallet.publicKey;

  const MINT_AUTHORITY_PROGRAM_ID            = mintProgram.programId;
  const METADATA_UPDATE_AUTHORITY_PROGRAM_ID = metadataUpdateProgram.programId;
  const FREEZE_AUTHORITY_PROGRAM_ID          = freezeProgram.programId;
  const SNAPSHOT_PROGRAM_ID = snapshotProgram.programId;

  // ── Helper: deploy a fresh mint ────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint:              PublicKey;
    mintOwnerPda:      PublicKey;
    mintAuthority:     PublicKey;
    freezeAuthority:   PublicKey;
    pausableAuthority: PublicKey;
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
      MINT_AUTHORITY_PROGRAM_ID
    );
    const [permanentDelegateAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("permanent_delegate"), mint.toBuffer()],
      PERMANENT_DELEGATE_PROGRAM_ID
    );
    const [metadataUpdateAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata_update_authority"), mint.toBuffer()],
      METADATA_UPDATE_AUTHORITY_PROGRAM_ID
    );
    const [pausableAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pausable_authority"), mint.toBuffer()],
      PAUSABLE_AUTHORITY_PROGRAM_ID
    );
    const [freezeAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("freeze_authority"), mint.toBuffer()],
      FREEZE_AUTHORITY_PROGRAM_ID
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
        payer:                      deployer,
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
        cmtatTransferHookProgram:   transferHookProgram.programId,
        token2022Program:           TOKEN_2022_PROGRAM_ID,
        systemProgram:              anchor.web3.SystemProgram.programId,
        rent:                       SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda, mintAuthority, freezeAuthority, pausableAuthority };
  }

  // ── Helper: all snapshot-related PDAs for a given mint ─────────────────────
  // Returns bumps too so assertions can verify them.
  function snapshotAccounts(mint: PublicKey, holderTokenAccount: PublicKey): {
    snapshotCounterPda:        PublicKey;
    totalSupplySnapshot:       PublicKey;
    totalSupplySnapshotBump:   number;
    holderBalanceSnapshot:     PublicKey;
    holderBalanceSnapshotBump: number;
  } {
    const [snapshotCounterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_counter"), mint.toBuffer()],
      SNAPSHOT_PROGRAM_ID
    );
    const [totalSupplySnapshot, totalSupplySnapshotBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_totalsupply"), mint.toBuffer()],
      snapshotProgram.programId
    );
    const [holderBalanceSnapshot, holderBalanceSnapshotBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_holderbalance"), mint.toBuffer(), holderTokenAccount.toBuffer()],
      snapshotProgram.programId
    );
    return { snapshotCounterPda, totalSupplySnapshot, totalSupplySnapshotBump, holderBalanceSnapshot, holderBalanceSnapshotBump };
  }

  // ── Helper: deterministic non-snapshot PDAs for a mint + destination pair ──
  function mintPdas(mint: PublicKey, destination: PublicKey): {
    deactivatePda:           PublicKey;
    transferControlModePda:  PublicKey;
    destinationWhitelistPda: PublicKey;
  } {
    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );
    const [destinationWhitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), destination.toBuffer()],
      transferControlProgram.programId
    );
    return { deactivatePda, transferControlModePda, destinationWhitelistPda };
  }

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: mints tokens to a destination account and updates balance correctly", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair       = (provider.wallet as any).payer as Keypair;
    await createAccount(connection, payerKeypair, mint, deployer, destinationKeypair, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const destination = destinationKeypair.publicKey;

    const accountBefore = await getAccount(connection, destination, "confirmed", TOKEN_2022_PROGRAM_ID);
    const balanceBefore = accountBefore.amount;

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Deployer:           ", deployer.toBase58());
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Mint authority PDA: ", mintAuthority.toBase58());
    console.log("  Mint owner PDA:     ", mintOwnerPda.toBase58());
    console.log("  Destination:        ", destination.toBase58());
    console.log("  Balance BEFORE:     ", balanceBefore.toString(), "(raw units)");
    console.log("──────────────────────────────────────────────────────────\n");

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot }  = snapshotAccounts(mint, destination);

    const tx = await (mintProgram as any).methods
      .mint(MINT_AMOUNT)
      .accounts({
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
        freezeProgram:    freezeProgram.programId,
        snapshotProgram:  snapshotProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  mint tx:", tx);

    const accountAfter  = await getAccount(connection, destination, "confirmed", TOKEN_2022_PROGRAM_ID);
    const balanceAfter  = accountAfter.amount;
    const humanReadable = (Number(balanceAfter) / 10 ** MINT_DECIMALS).toFixed(MINT_DECIMALS);

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Balance BEFORE:     ", balanceBefore.toString(), "(raw units)");
    console.log("  Balance AFTER:      ", balanceAfter.toString(), "(raw units)");
    console.log("  Human-readable:     ", humanReadable, MINT_SYMBOL);
    console.log("  Expected:           ", MINT_AMOUNT.toString(), "(raw units)");
    console.log("──────────────────────────────────────────────────────────\n");

    assert.equal(balanceBefore.toString(), "0",                    "destination balance should be zero before minting");
    assert.equal(balanceAfter.toString(),  MINT_AMOUNT.toString(), "destination balance should equal the minted amount");
    assert.isTrue(accountAfter.isFrozen,                           "destination account should be re-frozen after minting");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, pausableAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair       = (provider.wallet as any).payer as Keypair;
    await createAccount(connection, payerKeypair, mint, deployer, destinationKeypair, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const destination = destinationKeypair.publicKey;

    const pauseTx: string = await (pauseProgram as any).methods
      .pause()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        pausableAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:     ", mint.toBase58());
    console.log("  pause tx: ", pauseTx);
    console.log("══════════════════════════════════════════════════════════\n");

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot }  = snapshotAccounts(mint, destination);

    try {
      await (mintProgram as any).methods
        .mint(MINT_AMOUNT)
        .accounts({
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
          freezeProgram:    freezeProgram.programId,
          snapshotProgram:  snapshotProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram:    anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected mint-is-paused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const logs = (err as SendTransactionError).logs ?? [];
      console.log("  caught error:", (err as SendTransactionError).message);
      logs.forEach(log => console.log("    ", log));
      assert.isTrue(logs.some(log => log.includes("paused")), "logs should mention paused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair       = (provider.wallet as any).payer as Keypair;
    await createAccount(connection, payerKeypair, mint, deployer, destinationKeypair, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const destination = destinationKeypair.publicKey;

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot }  = snapshotAccounts(mint, destination);

    const deactivateTx = await (deactivateProgram as any).methods
      .deactivate()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:           ", mint.toBase58());
    console.log("  Deactivate PDA: ", deactivatePda.toBase58());
    console.log("  deactivate tx:  ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (mintProgram as any).methods
        .mint(MINT_AMOUNT)
        .accounts({
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
          freezeProgram:    freezeProgram.programId,
          snapshotProgram:  snapshotProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram:    anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      console.log("  caught error code:", anchorErr.error.errorCode.code);
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair       = (provider.wallet as any).payer as Keypair;
    await createAccount(connection, payerKeypair, mint, deployer, destinationKeypair, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const destination = destinationKeypair.publicKey;

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot }  = snapshotAccounts(mint, destination);

    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:          ", mint.toBase58());
    console.log("  Real deployer: ", deployer.toBase58());
    console.log("  Rogue signer:  ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (mintProgram as any).methods
        .mint(MINT_AMOUNT)
        .accounts({
          deployer:               rogueKeypair.publicKey,
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
          freezeProgram:    freezeProgram.programId,
          snapshotProgram:  snapshotProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram:    anchor.web3.SystemProgram.programId,
        })
        .signers([rogueKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      console.log("  caught error code:", anchorErr.error.errorCode.code);
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with NotWhitelisted when whitelist mode is active and destination is not whitelisted", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair       = (provider.wallet as any).payer as Keypair;
    await createAccount(connection, payerKeypair, mint, deployer, destinationKeypair, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const destination = destinationKeypair.publicKey;

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot }  = snapshotAccounts(mint, destination);

    const setModeTx = await (transferControlProgram as any).methods
      .setMode({ whitelist: {} })
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                      ", mint.toBase58());
    console.log("  Transfer Control Mode PDA: ", transferControlModePda.toBase58());
    console.log("  Destination:               ", destination.toBase58());
    console.log("  Destination whitelist PDA: ", destinationWhitelistPda.toBase58());
    console.log("  set_mode tx:               ", setModeTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (mintProgram as any).methods
        .mint(MINT_AMOUNT)
        .accounts({
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
          freezeProgram:    freezeProgram.programId,
          snapshotProgram:  snapshotProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram:    anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected NotWhitelisted error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      console.log("  caught error code:", anchorErr.error.errorCode.code);
      assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: snapshot taken before mint records destination balance of 0", async () => {
    // ── Deploy mint + create destination token account ────────────────────────
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair       = (provider.wallet as any).payer as Keypair;
    await createAccount(connection, payerKeypair, mint, deployer, destinationKeypair, { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID);
    const destination = destinationKeypair.publicKey;

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const {
      snapshotCounterPda,
      totalSupplySnapshot,
      holderBalanceSnapshot,
    } = snapshotAccounts(mint, destination);

    // ── Take snapshot via create_coupon (counter 0 → 1) ──────────────────────
    const couponId = new anchor.BN(1);
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
    const snapshotTx = await (couponProgram as any).methods
      .createCoupon(new anchor.BN(1_700_000_000), new anchor.BN(1_750_000_000), new anchor.BN(1_800_000_000), couponId)
      .accounts({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        couponAuthority,
        couponCounter,
        coupon,
        snapshotCounter:  snapshotCounterPda,
        snapshotProgram:  snapshotProgram.programId,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Mint:                  ", mint.toBase58());
    console.log("  Destination:           ", destination.toBase58());
    console.log("  totalSupplySnapshot: ", totalSupplySnapshot.toBase58());
    console.log("  holderBalanceSnapshot: ", holderBalanceSnapshot.toBase58());
    console.log("  create_coupon tx:      ", snapshotTx);
    console.log("──────────────────────────────────────────────────────────\n");

    // ── Mint tokens — snapshot CPIs fire and record pre-mint balance (= 0) ───
    const mintTx = await (mintProgram as any).methods
      .mint(MINT_AMOUNT)
      .accounts({
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
        freezeProgram:    freezeProgram.programId,
        snapshotProgram:  snapshotProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  mint tx:", mintTx);

    // ── Assert snapshot values via get_*_snapshot_at ──────────────────────────
    const totalSupplyValue: anchor.BN = await (snapshotProgram as any).methods
      .getTotalsupplySnapshotAt(new anchor.BN(1))
      .accounts({
        mint,
        totalSupplySnapshot,
      })
      .view();
    const holderValue: anchor.BN = await (snapshotProgram as any).methods
      .getHolderbalanceSnapshotAt(new anchor.BN(1))
      .accounts({
        mint,
        holderBalanceSnapshot,
        holderTokenAccount: destination,
      })
      .view();

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  holderBalanceSnapshot[1].value: ", holderValue.toString());
    console.log("  totalSupplySnapshot[1].value:   ", totalSupplyValue.toString());
    console.log("  expected value:                 ", "0");
    console.log("──────────────────────────────────────────────────────────\n");

    assert.equal(
      holderValue.toString(),
      "0",
      "holder snapshot should record the balance before minting, which is 0"
    );
    assert.equal(
      totalSupplyValue.toString(),
      "0",
      "total supply snapshot should record the balance before minting, which is 0"
    );
  });
});
