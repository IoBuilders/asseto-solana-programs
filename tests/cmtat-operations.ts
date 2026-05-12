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

const MINT_AMOUNT     = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
const BURN_AMOUNT = new anchor.BN(300  * 10 ** MINT_DECIMALS);

describe("cmtat-operations", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sourceOwnerKeypair = Keypair.generate();

  const deployProgram     = anchor.workspace.CmtatDeploy     as Program<CmtatDeploy>;
  const mintProgram       = anchor.workspace.CmtatMint       as Program<CmtatMint>;
  const metadataProgram   = anchor.workspace.CmtatMetadataUpdate as Program<any>;
  const freezeProgram      = anchor.workspace.cmtatFreeze      as Program<any>;
  const operationsProgram = anchor.workspace.CmtatOperations as Program<any>;
  const pauseProgram      = anchor.workspace.CmtatPause      as Program<any>;
  const deactivateProgram     = anchor.workspace.CmtatDeactivate     as Program<any>;
  const transferHookProgram   = anchor.workspace.CmtatTransferHook   as Program<any>;
  const snapshotProgram         = anchor.workspace.CmtatSnapshot         as Program<any>;
  const transferControlProgram  = anchor.workspace.CmtatTransferControl  as Program<any>;
  const couponProgram           = anchor.workspace.CmtatCoupon           as Program<any>;
  const connection        = provider.connection;
  const deployer          = provider.wallet.publicKey;
  const sourceOwner = sourceOwnerKeypair.publicKey;
  const payerKeypair      = (provider.wallet as any).payer as Keypair;

  const MINT_AUTHORITY_PROGRAM_ID     = mintProgram.programId;
  const FREEZE_AUTHORITY_PROGRAM_ID   = freezeProgram.programId;
  const PERMANENT_DELEGATE_PROGRAM_ID = operationsProgram.programId;
  const METADATA_UPDATE_PROGRAM_ID    = metadataProgram.programId;
  const PAUSABLE_AUTHORITY_PROGRAM_ID = pauseProgram.programId;
  const SNAPSHOT_PROGRAM_ID = snapshotProgram.programId;

  // ── Helper: derive snapshot-related PDAs for a given mint ─────────────────
  // PDAs are keyed only by mint (+ token account for holder balance); the full
  // snapshot history is stored in a single account per key.
  function snapshotAccounts(mint: PublicKey, holderTokenAccount: PublicKey): {
    snapshotCounterPda:        PublicKey;
    totalSupplySnapshot:       PublicKey;
    holderBalanceSnapshot:     PublicKey;
    holderBalanceSnapshotBump: number;
  } {
    const [snapshotCounterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_counter"), mint.toBuffer()],
      snapshotProgram.programId
    );
    const [totalSupplySnapshot] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_totalsupply"), mint.toBuffer()],
      snapshotProgram.programId
    );
    const [holderBalanceSnapshot, holderBalanceSnapshotBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_holderbalance"), mint.toBuffer(), holderTokenAccount.toBuffer()],
      snapshotProgram.programId
    );
    return { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot, holderBalanceSnapshotBump };
  }

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint:                 PublicKey;
    mintOwnerPda:         PublicKey;
    mintAuthority:        PublicKey;
    freezeAuthority:      PublicKey;
    operationsAuthority:  PublicKey;
    pausableAuthority:    PublicKey;
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
    const [operationsAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("permanent_delegate"), mint.toBuffer()],
      PERMANENT_DELEGATE_PROGRAM_ID
    );
    const [metadataUpdateAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata_update_authority"), mint.toBuffer()],
      METADATA_UPDATE_PROGRAM_ID
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

    const tx = await deployProgram.methods
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
        permanentDelegateAuthority: operationsAuthority,
        metadataUpdateAuthority,
        pausableAuthority,
        freezeAuthority,
        transferHookAuthority,
        extraAccountMetaList,
        cmtatTransferHookProgram:   transferHookProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority, pausableAuthority };
  }

  // ── Helper: mint tokens to a fresh token account ────────────────────────────
  async function mintTokens(
    mint:            PublicKey,
    mintOwnerPda:    PublicKey,
    mintAuthority:   PublicKey,
    freezeAuthority: PublicKey,
    amount:          anchor.BN,
  ): Promise<PublicKey> {
    const destinationKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      sourceOwner,
      destinationKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );
    const destination = destinationKeypair.publicKey;

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

    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, destination);

    const tx = await (mintProgram as any).methods
      .mint(amount)
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
    return destination;
  }

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: removes tokens from source via permanent delegate", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority } =
      await deployMint();

    // Mint 1 000 tokens to the source account (owned by deployer wallet).
    const source = await mintTokens(
      mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT
    );

    const sourceBefore = (await getAccount(connection, source,      "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Deployer:           ", deployer.toBase58());
    console.log("  Mint:                 ", mint.toBase58());
    console.log("  Operations authority: ", operationsAuthority.toBase58());
    console.log("  Mint owner PDA:     ", mintOwnerPda.toBase58());
    console.log("  Source:               ", source.toBase58());
    console.log("  Source balance BEFORE:", sourceBefore.toString(), "(raw)");
    console.log("──────────────────────────────────────────────────────────\n");

    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, source);

    // ── Call burn ──────────────────────────────────────────────────────
    const tx = await operationsProgram.methods
      .burn(BURN_AMOUNT)
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        tokenAccount:  source,
        operationsAuthority,
        freezeAuthority,
        snapshotCounterPda,
        totalSupplySnapshot,
        holderBalanceSnapshot,
        freezeProgram: freezeProgram.programId,
        snapshotProgram: snapshotProgram.programId,
        token2022Program:     TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  burn tx:", tx);

    const sourceAfter = (await getAccount(connection, source,      "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Source balance AFTER: ", sourceAfter.toString(), "(raw)");
    console.log("──────────────────────────────────────────────────────────\n");

    assert.equal(sourceAfter.toString(), (MINT_AMOUNT.toNumber() - BURN_AMOUNT.toNumber()).toString(),
      "source balance should be reduced by the transfer amount");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority } =
      await deployMint();

    const source = await mintTokens(
      mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT
    );

    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, source);

    try {
      await (operationsProgram as any).methods
        .burn(BURN_AMOUNT)
        .accounts({
          deployer:            rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          tokenAccount:        source,
          operationsAuthority,
          freezeAuthority,
          snapshotCounterPda,
          totalSupplySnapshot,
          holderBalanceSnapshot,
          freezeProgram:        freezeProgram.programId,
          snapshotProgram:      snapshotProgram.programId,
          token2022Program:    TOKEN_2022_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rogueKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(
        anchorErr.error.errorCode.code,
        "UnauthorizedDeployer",
        "error code should be UnauthorizedDeployer"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: fails when mint is paused", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority, pausableAuthority } =
      await deployMint();

    const source = await mintTokens(
      mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT
    );

    // Pause the mint via cmtat-pause
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
    console.log("  Mint:               ", mint.toBase58());
    console.log("  pause tx:           ", pauseTx);
    console.log("══════════════════════════════════════════════════════════\n");

    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, source);

    // The burn CPI into Token-2022 is rejected because the mint is paused.
    // This surfaces as a SendTransactionError (Token-2022 custom error 0x43),
    // not an AnchorError, because the rejection originates inside Token-2022.
    try {
      await (operationsProgram as any).methods
        .burn(BURN_AMOUNT)
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          tokenAccount:        source,
          operationsAuthority,
          freezeAuthority,
          snapshotCounterPda,
          totalSupplySnapshot,
          holderBalanceSnapshot,
          freezeProgram:        freezeProgram.programId,
          snapshotProgram:      snapshotProgram.programId,
          token2022Program:    TOKEN_2022_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected mint-is-paused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const sendErr = err as SendTransactionError;
      const logs = sendErr.logs ?? [];

      console.log("  caught error:       ", sendErr.message);
      console.log("  transaction logs:");
      logs.forEach(log => console.log("    ", log));

      assert.isTrue(
        logs.some(log => log.includes("paused")),
        "transaction logs should mention the mint is paused"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: fails with Deactivated when mint has been deactivated", async () => {
      // ── Deploy a fresh mint ────────────────────────────────────────────────
      const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority, pausableAuthority } =
      await deployMint();

    const source = await mintTokens(
      mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT
    );

      const [deactivatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("deactivate"), mint.toBuffer()],
        deactivateProgram.programId
      );

      // ── Deactivate the mint ────────────────────────────────────────────────
      const deactivateTx = await deactivateProgram.methods
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
      console.log("  Mint:               ", mint.toBase58());
      console.log("  Deactivate PDA:     ", deactivatePda.toBase58());
      console.log("  deactivate tx:      ", deactivateTx);
      console.log("══════════════════════════════════════════════════════════\n");

      const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, source);

      // ── Mint must now be rejected with Deactivated ─────────────────────────
      try {
        await (operationsProgram as any).methods
        .burn(BURN_AMOUNT)
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          tokenAccount:        source,
          operationsAuthority,
          freezeAuthority,
          snapshotCounterPda,
          totalSupplySnapshot,
          holderBalanceSnapshot,
          freezeProgram:        freezeProgram.programId,
          snapshotProgram:      snapshotProgram.programId,
          token2022Program:    TOKEN_2022_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        console.log("  caught error code:  ", anchorErr.error.errorCode.code);
        console.log("  caught error msg:   ", anchorErr.error.errorMessage);
        assert.equal(
          anchorErr.error.errorCode.code,
          "Deactivated",
          "error code should be Deactivated"
        );
      }
    });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: snapshot taken before burn records holder balance at time of snapshot", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority } =
      await deployMint();

    // Mint MINT_AMOUNT tokens (no snapshot active yet → snapshot CPIs exit silently)
    const source = await mintTokens(
      mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT
    );

    const {
      snapshotCounterPda,
      totalSupplySnapshot,
      holderBalanceSnapshot,
    } = snapshotAccounts(mint, source);

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );

    // Take snapshot via create_coupon (counter 0 → 1); subsequent operations will record pre-op balances
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
    console.log("  Source:                ", source.toBase58());
    console.log("  holderBalanceSnapshot: ", holderBalanceSnapshot.toBase58());
    console.log("  create_coupon tx:      ", snapshotTx);
    console.log("──────────────────────────────────────────────────────────\n");

    // Burn — snapshot CPI fires and records pre-burn balance (= MINT_AMOUNT)
    const burnTx = await operationsProgram.methods
      .burn(BURN_AMOUNT)
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        tokenAccount:  source,
        operationsAuthority,
        freezeAuthority,
        snapshotCounterPda,
        totalSupplySnapshot,
        holderBalanceSnapshot,
        freezeProgram:   freezeProgram.programId,
        snapshotProgram: snapshotProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram:   anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  burn tx:", burnTx);

    // ── Assert snapshot values via get_*_snapshot_at ──────────────────────────
    const holderValue: anchor.BN = await (snapshotProgram as any).methods
      .getHolderbalanceSnapshotAt(new anchor.BN(1))
      .accounts({
        mint,
        holderBalanceSnapshot,
        holderTokenAccount: source,
      })
      .view();
    const totalSupplyValue: anchor.BN = await (snapshotProgram as any).methods
      .getTotalsupplySnapshotAt(new anchor.BN(1))
      .accounts({
        mint,
        totalSupplySnapshot,
      })
      .view();

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  holderBalanceSnapshot[1].value: ", holderValue.toString());
    console.log("  totalSupplySnapshot[1].value:   ", totalSupplyValue.toString());
    console.log("  expected value:                 ", MINT_AMOUNT.toString());
    console.log("──────────────────────────────────────────────────────────\n");

    assert.equal(
      holderValue.toString(),
      MINT_AMOUNT.toString(),
      "holder snapshot should record the balance before burning, which equals MINT_AMOUNT"
    );
    assert.equal(
      totalSupplyValue.toString(),
      MINT_AMOUNT.toString(),
      "total supply snapshot should record the total supply before burning, which equals MINT_AMOUNT"
    );
  });
});
