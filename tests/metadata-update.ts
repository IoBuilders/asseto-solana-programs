import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { MetadataUpdate } from "../target/types/metadata_update";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getTokenMetadata,
} from "@solana/spl-token";
import { assert } from "chai";

// ── Initial mint parameters ────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME     = "CMTAT Test Token";
const MINT_SYMBOL   = "CMTAT";
const MINT_URI      = "https://example.com/metadata.json";

// ── Program IDs sourced from workspace (mirrors constants.rs in deploy) ──
const mintProgram        = anchor.workspace.Mint       as Program<any>;
const freezeProgram       = anchor.workspace.Freeze      as Program<any>;
const deactivateProgram     = anchor.workspace.Deactivate     as Program<any>;
const operationsProgram  = anchor.workspace.Operations as Program<any>;
const pauseProgram       = anchor.workspace.Pause      as Program<any>;
const transferHookProgram = anchor.workspace.TransferHook as Program<any>;
const snapshotProgram           = anchor.workspace.Snapshot           as Program<any>;

const MINT_AUTHORITY_PROGRAM_ID     = mintProgram.programId;
const FREEZE_AUTHORITY_PROGRAM_ID   = freezeProgram.programId;
const PERMANENT_DELEGATE_PROGRAM_ID = operationsProgram.programId;
const PAUSABLE_AUTHORITY_PROGRAM_ID = pauseProgram.programId;
const SNAPSHOT_PROGRAM_ID = snapshotProgram.programId;


describe("metadata-update", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram   = anchor.workspace.Deploy as Program<Deploy>;
  const metadataProgram = anchor.workspace.MetadataUpdate as Program<MetadataUpdate>;
  const connection      = provider.connection;
  // The wallet is both payer and deployer in these tests.
  const deployer = provider.wallet.publicKey;

  // ── Helper: deploy a fresh mint, return the keys needed for metadata ops ──────
  async function deployMint(additionalMetadata: { key: string; value: string }[] = []): Promise<{
    mint:                    PublicKey;
    mintOwnerPda:            PublicKey;
    metadataUpdateAuthority: PublicKey;
    pausableAuthority:       PublicKey;
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
      metadataProgram.programId
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
      .deployMint({ decimals: MINT_DECIMALS, name: MINT_NAME, symbol: MINT_SYMBOL, uri: MINT_URI, additionalMetadata })
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
        transferHookProgram:   transferHookProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda, metadataUpdateAuthority, pausableAuthority };
  }

  // ── Helper: call update_metadata_field ────────────────────────────────────────
  // growBy: bytes the mint account must grow by (null = no growth, pass None to program).
  async function updateField(
    mint:                    PublicKey,
    mintOwnerPda:            PublicKey,
    metadataUpdateAuthority: PublicKey,
    key:                     string,
    value:                   string,
    growBy:                  number | null,
  ): Promise<void> {
    if (growBy !== null) {
      const accountInfo = await connection.getAccountInfo(mint, "confirmed");
    }

    await (metadataProgram as any).methods
      .updateMetadataField(key, value)
      .accounts({
        payer:                   deployer,
        deployer,
        mint,
        mintOwnerPda,
        metadataUpdateAuthority,
        token2022Program:        TOKEN_2022_PROGRAM_ID,
        systemProgram:           anchor.web3.SystemProgram.programId,
        rent:                    SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: "confirmed" });
  }

  // ── Helper: call remove_metadata_field ────────────────────────────────────────
  async function removeField(
    mint:                    PublicKey,
    mintOwnerPda:            PublicKey,
    metadataUpdateAuthority: PublicKey,
    key:                     string,
  ): Promise<void> {
    await (metadataProgram as any).methods
      .removeMetadataField(key, false)
      .accounts({
        payer:                   deployer,
        deployer,
        mint,
        mintOwnerPda,
        metadataUpdateAuthority,
        token2022Program:        TOKEN_2022_PROGRAM_ID,
        systemProgram:           anchor.web3.SystemProgram.programId,
        rent:                    SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: "confirmed" });
  }

  // ── Helper: print metadata state ──────────────────────────────────────────────
  async function printMetadata(label: string, mint: PublicKey): Promise<void> {
    const metadata = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    console.log(`\n── Metadata ${label} ${"─".repeat(Math.max(0, 44 - label.length))}`);
    console.log("  name:               ", metadata?.name);
    console.log("  symbol:             ", metadata?.symbol);
    console.log("  uri:                ", metadata?.uri);
    console.log("  additionalMetadata: ", JSON.stringify(metadata?.additionalMetadata ?? []));
    console.log("──────────────────────────────────────────────────────────\n");
  }

  // ────────────────────────────────────────────────────────────────────────────
  it("update_metadata_field: updates all metadata fields", async () => {
    const { mint, mintOwnerPda, metadataUpdateAuthority } = await deployMint();

    await printMetadata("BEFORE update", mint);

    // ── New values ─────────────────────────────────────────────────────────────
    // Core fields are set to shorter strings → no account growth (pass null).
    const NEW_NAME   = "Updated Token";
    const NEW_SYMBOL = "UTK";
    const NEW_URI    = "https://example.com/updated.json";
    // Custom fields are new additions → account must grow.
    const ISIN_KEY   = "isin";
    const ISIN_VALUE = "CH0012221716";
    const CTRY_KEY   = "country";
    const CTRY_VALUE = "CH";

    // Update core fields (shorter → no growth, pass null)
    await updateField(mint, mintOwnerPda, metadataUpdateAuthority, "name",   NEW_NAME,   null);
    await updateField(mint, mintOwnerPda, metadataUpdateAuthority, "symbol", NEW_SYMBOL, null);
    await updateField(mint, mintOwnerPda, metadataUpdateAuthority, "uri",    NEW_URI,    null);

    // Add new custom fields — each grows the account by 4+key.len+4+value.len bytes
    await updateField(mint, mintOwnerPda, metadataUpdateAuthority,
      ISIN_KEY, ISIN_VALUE, 4 + ISIN_KEY.length + 4 + ISIN_VALUE.length);
    await updateField(mint, mintOwnerPda, metadataUpdateAuthority,
      CTRY_KEY, CTRY_VALUE, 4 + CTRY_KEY.length + 4 + CTRY_VALUE.length);

    await printMetadata("AFTER update", mint);

    // ── Assertions ─────────────────────────────────────────────────────────────
    const metadataAfter = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);

    assert.equal(metadataAfter?.name,   NEW_NAME,   "name should be updated");
    assert.equal(metadataAfter?.symbol, NEW_SYMBOL, "symbol should be updated");
    assert.equal(metadataAfter?.uri,    NEW_URI,    "uri should be updated");
    assert.deepEqual(
      metadataAfter?.additionalMetadata,
      [[ISIN_KEY, ISIN_VALUE], [CTRY_KEY, CTRY_VALUE]],
      "custom fields should be present with correct values"
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("remove_metadata_field: removes all custom metadata fields", async () => {
    // Deploy the mint with custom fields already baked in — no update_metadata_field needed.
    const ISIN_KEY   = "isin";         const ISIN_VALUE   = "CH0012221716";
    const JURIS_KEY  = "jurisdiction"; const JURIS_VALUE  = "CH";
    const CAT_KEY    = "category";     const CAT_VALUE    = "equity";

    const { mint, mintOwnerPda, metadataUpdateAuthority } = await deployMint([
      { key: ISIN_KEY,  value: ISIN_VALUE },
      { key: JURIS_KEY, value: JURIS_VALUE },
      { key: CAT_KEY,   value: CAT_VALUE },
    ]);

    await printMetadata("BEFORE remove", mint);

    // Sanity-check that all three fields landed before we remove them
    const metadataBefore = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    assert.deepEqual(
      metadataBefore?.additionalMetadata,
      [[ISIN_KEY, ISIN_VALUE], [JURIS_KEY, JURIS_VALUE], [CAT_KEY, CAT_VALUE]],
      "all three custom fields should be present before removal"
    );

    // ── Remove all custom fields ───────────────────────────────────────────────
    await removeField(mint, mintOwnerPda, metadataUpdateAuthority, ISIN_KEY);
    await removeField(mint, mintOwnerPda, metadataUpdateAuthority, JURIS_KEY);
    await removeField(mint, mintOwnerPda, metadataUpdateAuthority, CAT_KEY);

    await printMetadata("AFTER remove", mint);

    // ── Assertions ─────────────────────────────────────────────────────────────
    const metadataAfter = await getTokenMetadata(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);

    // Core fields must be untouched by remove
    assert.equal(metadataAfter?.name,   MINT_NAME,   "name should be unchanged");
    assert.equal(metadataAfter?.symbol, MINT_SYMBOL, "symbol should be unchanged");
    assert.equal(metadataAfter?.uri,    MINT_URI,    "uri should be unchanged");

    // All custom fields must be gone
    assert.deepEqual(
      metadataAfter?.additionalMetadata,
      [],
      "all custom metadata fields should be removed"
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_metadata_field: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda, metadataUpdateAuthority, pausableAuthority } = await deployMint();

    // Pause the mint via pause
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

    // update_metadata_field must now be rejected
    try {
      await metadataProgram.methods
        .updateMetadataField("name", "Should Fail")
        .accounts({
          payer:                   deployer,
          deployer,
          mint,
          mintOwnerPda,
          metadataUpdateAuthority,
          token2022Program:        TOKEN_2022_PROGRAM_ID,
          systemProgram:           anchor.web3.SystemProgram.programId,
          rent:                    SYSVAR_RENT_PUBKEY,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(
        anchorErr.error.errorCode.code,
        "MintPaused",
        "error code should be MintPaused"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("remove_metadata_field: fails with MintPaused when mint is paused", async () => {
    const ISIN_KEY   = "isin";
    const ISIN_VALUE = "CH0012221716";

    // Deploy with a custom field present so there is something to remove
    const { mint, mintOwnerPda, metadataUpdateAuthority, pausableAuthority } =
      await deployMint([{ key: ISIN_KEY, value: ISIN_VALUE }]);

    // Pause the mint via pause
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

    // remove_metadata_field must now be rejected
    try {
      await metadataProgram.methods
        .removeMetadataField(ISIN_KEY, false)
        .accounts({
          payer:                   deployer,
          deployer,
          mint,
          mintOwnerPda,
          metadataUpdateAuthority,
          token2022Program:        TOKEN_2022_PROGRAM_ID,
          systemProgram:           anchor.web3.SystemProgram.programId,
          rent:                    SYSVAR_RENT_PUBKEY,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(
        anchorErr.error.errorCode.code,
        "MintPaused",
        "error code should be MintPaused"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_metadata_field: fails with Deactivated when mint has been deactivated", async () => {
      // ── Deploy a fresh mint ────────────────────────────────────────────────
    const { mint, mintOwnerPda, metadataUpdateAuthority } = await deployMint();
  
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
  
      try {
        await metadataProgram.methods
        .updateMetadataField("name", "Should Fail")
        .accounts({
          payer:                   deployer,
          deployer,
          mint,
          mintOwnerPda,
          metadataUpdateAuthority,
          token2022Program:        TOKEN_2022_PROGRAM_ID,
          systemProgram:           anchor.web3.SystemProgram.programId,
          rent:                    SYSVAR_RENT_PUBKEY,
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
  it("remove_metadata_field: fails with Deactivated when mint has been deactivated", async () => {
    const ISIN_KEY   = "isin";

      // ── Deploy a fresh mint ────────────────────────────────────────────────
    const { mint, mintOwnerPda, metadataUpdateAuthority } = await deployMint();
  
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
  
      try {
        await metadataProgram.methods
        .removeMetadataField(ISIN_KEY, false)
        .accounts({
          payer:                   deployer,
          deployer,
          mint,
          mintOwnerPda,
          metadataUpdateAuthority,
          token2022Program:        TOKEN_2022_PROGRAM_ID,
          systemProgram:           anchor.web3.SystemProgram.programId,
          rent:                    SYSVAR_RENT_PUBKEY,
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
  it("update_metadata_field: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda, metadataUpdateAuthority } = await deployMint();

    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (metadataProgram as any).methods
        .updateMetadataField("name", "Should Fail")
        .accounts({
          payer:                   deployer,          // wallet still pays fees
          deployer:                rogueKeypair.publicKey,
          mint,
          mintOwnerPda,
          metadataUpdateAuthority,
          token2022Program:        TOKEN_2022_PROGRAM_ID,
          systemProgram:           anchor.web3.SystemProgram.programId,
          rent:                    SYSVAR_RENT_PUBKEY,
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
  it("remove_metadata_field: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const ISIN_KEY   = "isin";
    const ISIN_VALUE = "CH0012221716";

    // Deploy with a custom field present so there is something to remove.
    const { mint, mintOwnerPda, metadataUpdateAuthority } =
      await deployMint([{ key: ISIN_KEY, value: ISIN_VALUE }]);

    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (metadataProgram as any).methods
        .removeMetadataField(ISIN_KEY, false)
        .accounts({
          payer:                   deployer,          // wallet still pays fees
          deployer:                rogueKeypair.publicKey,
          mint,
          mintOwnerPda,
          metadataUpdateAuthority,
          token2022Program:        TOKEN_2022_PROGRAM_ID,
          systemProgram:           anchor.web3.SystemProgram.programId,
          rent:                    SYSVAR_RENT_PUBKEY,
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

});
