import * as anchor from "@coral-xyz/anchor";
import { AnchorError, Program } from "@coral-xyz/anchor";
import { CmtatDeploy } from "../target/types/cmtat_deploy";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAccount } from "@solana/spl-token";
import { assert } from "chai";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME     = "CMTAT Test Token";
const MINT_SYMBOL   = "CMTAT";
const MINT_URI      = "https://example.com/cmtat-metadata.json";

describe("cmtat-transfer-control", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram          = anchor.workspace.CmtatDeploy          as Program<CmtatDeploy>;
  const mintProgram            = anchor.workspace.CmtatMint            as Program<any>;
  const metadataProgram        = anchor.workspace.CmtatMetadataUpdate  as Program<any>;
  const freezeProgram          = anchor.workspace.cmtatFreeze           as Program<any>;
  const operationsProgram      = anchor.workspace.CmtatOperations      as Program<any>;
  const pauseProgram           = anchor.workspace.CmtatPause           as Program<any>;
  const deactivateProgram      = anchor.workspace.CmtatDeactivate      as Program<any>;
  const transferControlProgram = anchor.workspace.CmtatTransferControl as Program<any>;
  const transferHookProgram    = anchor.workspace.CmtatTransferHook    as Program<any>;

  const connection = provider.connection;
  const deployer   = provider.wallet.publicKey;

  const MINT_AUTHORITY_PROGRAM_ID     = mintProgram.programId;
  const FREEZE_AUTHORITY_PROGRAM_ID   = freezeProgram.programId;
  const PERMANENT_DELEGATE_PROGRAM_ID = operationsProgram.programId;
  const METADATA_UPDATE_PROGRAM_ID    = metadataProgram.programId;
  const PAUSABLE_AUTHORITY_PROGRAM_ID = pauseProgram.programId;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint:         PublicKey;
    mintOwnerPda: PublicKey;
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
    return { mint, mintOwnerPda };
  }

  // ── Happy-path: set_mode creates the PDA and sets mode = Clearing ───────────
  it("set_mode: creates the transfer_control_mode PDA with mode = Clearing", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );

    // ── Verify the PDA does not exist before the instruction ────────────────
    const stateBefore = await (transferControlProgram as any).account.transferControlMode.fetchNullable(
      transferControlModePda
    );

    // ── Call set_mode({ clearing: {} }) ────────────────────────────────────
    const tx = await (transferControlProgram as any).methods
      .setMode({ clearing: {} })
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  set_mode({ clearing }) tx:", tx);

    // ── Fetch and verify the PDA ─────────────────────────────────────────────
    const stateAfter = await (transferControlProgram as any).account.transferControlMode.fetch(
      transferControlModePda
    );

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                        ", mint.toBase58());
    console.log("  Transfer Control Mode PDA:   ", transferControlModePda.toBase58());
    console.log("  mode:                        ", JSON.stringify(stateAfter.mode));
    console.log("  bump:                        ", stateAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(stateBefore,   "transfer_control_mode PDA should not exist before set_mode");
    assert.isNotNull(stateAfter, "transfer_control_mode PDA should exist after set_mode");
    assert.deepEqual(stateAfter.mode, { clearing: {} }, "mode should be Clearing");
    assert.equal(stateAfter.bump, expectedBump, "bump should match the canonical bump");
  });

  // ── Happy-path: set_mode updates mode on an existing PDA ────────────────────
  it("set_mode: updates mode to Whitelist on an existing transfer_control_mode PDA", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );

    // ── First call: create with mode = Clearing ────────────────────────────
    await (transferControlProgram as any).methods
      .setMode({ clearing: {} })
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const stateAfterFirst = await (transferControlProgram as any).account.transferControlMode.fetch(
      transferControlModePda
    );
    assert.deepEqual(stateAfterFirst.mode, { clearing: {} }, "mode should be Clearing after first call");

    // ── Second call: update to mode = Whitelist ─────────────────────────────
    const updateTx = await (transferControlProgram as any).methods
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

    console.log("  set_mode({ whitelist }) tx:", updateTx);

    const stateAfterUpdate = await (transferControlProgram as any).account.transferControlMode.fetch(
      transferControlModePda
    );

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                        ", mint.toBase58());
    console.log("  Transfer Control Mode PDA:   ", transferControlModePda.toBase58());
    console.log("  mode (after update):         ", JSON.stringify(stateAfterUpdate.mode));
    console.log("══════════════════════════════════════════════════════════\n");

    assert.deepEqual(stateAfterUpdate.mode, { whitelist: {} }, "mode should be Whitelist after update");
  });

  // ── Happy-path: set_mode(null) removes an existing transfer_control_mode PDA ──
  it("set_mode: closes the transfer_control_mode PDA when called with null (None)", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );

    // ── First: create the PDA with any mode ────────────────────────────────
    await (transferControlProgram as any).methods
      .setMode({ clearing: {} })
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const stateAfterCreate = await (transferControlProgram as any).account.transferControlMode.fetch(
      transferControlModePda
    );
    assert.isNotNull(stateAfterCreate, "transfer_control_mode PDA should exist after set_mode({ clearing: {} })");

    // ── Then: remove it by passing null (Option::None) ────────────────────
    const removeTx = await (transferControlProgram as any).methods
      .setMode(null)
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  set_mode(null) tx:", removeTx);

    // ── Verify the PDA has been closed ────────────────────────────────────
    const stateAfterRemove = await (transferControlProgram as any).account.transferControlMode.fetchNullable(
      transferControlModePda
    );

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                        ", mint.toBase58());
    console.log("  Transfer Control Mode PDA:   ", transferControlModePda.toBase58());
    console.log("  PDA after set_mode(null):    ", stateAfterRemove);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(stateAfterRemove, "transfer_control_mode PDA should not exist after set_mode(null)");
  });

  // ── Happy-path: add_to_whitelist ─────────────────────────────────────────────
  it("add_to_whitelist: creates the whitelist PDA for a token account", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair   = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount   = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    // ── Verify the PDA does not exist before the instruction ────────────────
    const stateBefore = await (transferControlProgram as any).account.whitelistStatus.fetchNullable(
      whitelistPda
    );

    // ── Call add_to_whitelist ───────────────────────────────────────────────
    const tx = await (transferControlProgram as any).methods
      .addToWhitelist()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:       tokenAccount,
        deactivatePda,
        whitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  add_to_whitelist tx:", tx);

    // ── Fetch and verify the PDA ─────────────────────────────────────────────
    const stateAfter = await (transferControlProgram as any).account.whitelistStatus.fetch(
      whitelistPda
    );

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:          ", mint.toBase58());
    console.log("  Token account: ", tokenAccount.toBase58());
    console.log("  Whitelist PDA: ", whitelistPda.toBase58());
    console.log("  bump:          ", stateAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(stateBefore,   "whitelist PDA should not exist before add_to_whitelist");
    assert.isNotNull(stateAfter, "whitelist PDA should exist after add_to_whitelist");
    assert.equal(stateAfter.bump, expectedBump, "bump should match the canonical bump");
  });

  // ── Happy-path: remove_from_whitelist ────────────────────────────────────────
  it("remove_from_whitelist: closes the whitelist PDA for a token account", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair   = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount   = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    // ── First: add to whitelist ─────────────────────────────────────────────
    const addTx = await (transferControlProgram as any).methods
      .addToWhitelist()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:       tokenAccount,
        deactivatePda,
        whitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  add_to_whitelist tx:", addTx);

    const stateAfterAdd = await (transferControlProgram as any).account.whitelistStatus.fetch(
      whitelistPda
    );
    assert.isNotNull(stateAfterAdd, "whitelist PDA should exist after add_to_whitelist");

    // ── Then: remove from whitelist ─────────────────────────────────────────
    const removeTx = await (transferControlProgram as any).methods
      .removeFromWhitelist()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:       tokenAccount,
        deactivatePda,
        whitelistPda,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  remove_from_whitelist tx:", removeTx);

    // ── Verify the PDA has been closed ──────────────────────────────────────
    const stateAfterRemove = await (transferControlProgram as any).account.whitelistStatus.fetchNullable(
      whitelistPda
    );

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                     ", mint.toBase58());
    console.log("  Token account:            ", tokenAccount.toBase58());
    console.log("  Whitelist PDA:            ", whitelistPda.toBase58());
    console.log("  PDA after remove:         ", stateAfterRemove);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(stateAfterRemove, "whitelist PDA should not exist after remove_from_whitelist");
  });

  // ── Error case: set_mode — UnauthorizedDeployer ──────────────────────────────
  it("set_mode: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );

    const rogueKeypair = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(rogueKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "confirmed");

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (transferControlProgram as any).methods
        .setMode({ clearing: {} })
        .accounts({
          deployer:               rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          deactivatePda,
          transferControlModePda,
          systemProgram:          anchor.web3.SystemProgram.programId,
        })
        .signers([rogueKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ── Error case: set_mode — MintPaused ────────────────────────────────────────
  it("set_mode: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [pausableAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pausable_authority"), mint.toBuffer()],
      PAUSABLE_AUTHORITY_PROGRAM_ID
    );
    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );

    const pauseTx = await (pauseProgram as any).methods
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

    try {
      await (transferControlProgram as any).methods
        .setMode({ clearing: {} })
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          deactivatePda,
          transferControlModePda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "MintPaused");
    }
  });

  // ── Error case: set_mode — Deactivated ───────────────────────────────────────
  it("set_mode: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );

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
    console.log("  Mint:               ", mint.toBase58());
    console.log("  deactivate tx:      ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (transferControlProgram as any).methods
        .setMode({ clearing: {} })
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          deactivatePda,
          transferControlModePda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  // ── Error case: add_to_whitelist — UnauthorizedDeployer ──────────────────────
  it("add_to_whitelist: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair   = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount   = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    const rogueKeypair = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(rogueKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "confirmed");

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (transferControlProgram as any).methods
        .addToWhitelist()
        .accounts({
          deployer:      rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account:       tokenAccount,
          deactivatePda,
          whitelistPda,
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
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ── Error case: add_to_whitelist — MintPaused ────────────────────────────────
  it("add_to_whitelist: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair   = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount   = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const [pausableAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pausable_authority"), mint.toBuffer()],
      PAUSABLE_AUTHORITY_PROGRAM_ID
    );
    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    const pauseTx = await (pauseProgram as any).methods
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

    try {
      await (transferControlProgram as any).methods
        .addToWhitelist()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:       tokenAccount,
          deactivatePda,
          whitelistPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "MintPaused");
    }
  });

  // ── Error case: add_to_whitelist — Deactivated ───────────────────────────────
  it("add_to_whitelist: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair   = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount   = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

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
    console.log("  Mint:               ", mint.toBase58());
    console.log("  deactivate tx:      ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (transferControlProgram as any).methods
        .addToWhitelist()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:       tokenAccount,
          deactivatePda,
          whitelistPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  // ── Error case: remove_from_whitelist — UnauthorizedDeployer ─────────────────
  it("remove_from_whitelist: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair   = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount   = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    await (transferControlProgram as any).methods
      .addToWhitelist()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:       tokenAccount,
        deactivatePda,
        whitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const rogueKeypair = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(rogueKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "confirmed");

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (transferControlProgram as any).methods
        .removeFromWhitelist()
        .accounts({
          deployer:      rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account:       tokenAccount,
          deactivatePda,
          whitelistPda,
        })
        .signers([rogueKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ── Error case: remove_from_whitelist — MintPaused ───────────────────────────
  it("remove_from_whitelist: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair   = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount   = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const [pausableAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pausable_authority"), mint.toBuffer()],
      PAUSABLE_AUTHORITY_PROGRAM_ID
    );
    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    await (transferControlProgram as any).methods
      .addToWhitelist()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:       tokenAccount,
        deactivatePda,
        whitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const pauseTx = await (pauseProgram as any).methods
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

    try {
      await (transferControlProgram as any).methods
        .removeFromWhitelist()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:       tokenAccount,
          deactivatePda,
          whitelistPda,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "MintPaused");
    }
  });

  // ── Error case: remove_from_whitelist — Deactivated ──────────────────────────
  it("remove_from_whitelist: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair   = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount   = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID,
    );

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    await (transferControlProgram as any).methods
      .addToWhitelist()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:       tokenAccount,
        deactivatePda,
        whitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

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
    console.log("  Mint:               ", mint.toBase58());
    console.log("  deactivate tx:      ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (transferControlProgram as any).methods
        .removeFromWhitelist()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:       tokenAccount,
          deactivatePda,
          whitelistPda,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });
});
