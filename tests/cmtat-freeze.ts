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

describe("cmtat-freeze", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram     = anchor.workspace.CmtatDeploy     as Program<CmtatDeploy>;
  const mintProgram       = anchor.workspace.CmtatMint       as Program<any>;
  const metadataProgram   = anchor.workspace.CmtatMetadataUpdate as Program<any>;
  const freezeProgram      = anchor.workspace.cmtatFreeze      as Program<any>;
  const operationsProgram = anchor.workspace.CmtatOperations as Program<any>;
  const pauseProgram      = anchor.workspace.CmtatPause      as Program<any>;
  const deactivateProgram = anchor.workspace.CmtatDeactivate as Program<any>;
  const transferHookProgram = anchor.workspace.CmtatTransferHook as Program<any>;

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

  // ── Happy-path: freeze_account ───────────────────────────────────────────────
  it("freeze_account: creates the frozen_account PDA for a token account", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    // ── Create a token account to use as the freeze target ──────────────────
    const payerKeypair      = (provider.wallet as any).payer as Keypair;
    const accountKeypair    = Keypair.generate();
    const tokenAccount      = await createAccount(
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
    const [frozenAccountPda, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_account"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Verify the PDA does not exist before the instruction ────────────────
    const statusBefore = await (freezeProgram as any).account.frozenAccountStatus.fetchNullable(frozenAccountPda);

    // ── Call freeze_account ──────────────────────────────────────────────────
    const tx = await (freezeProgram as any).methods
      .freezeAccount()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  freeze_account tx:", tx);

    // ── Verify the frozen_account PDA was created with the correct bump ──────
    const statusAfter = await (freezeProgram as any).account.frozenAccountStatus.fetch(frozenAccountPda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:              ", mint.toBase58());
    console.log("  Token account:     ", tokenAccount.toBase58());
    console.log("  Frozen account PDA:", frozenAccountPda.toBase58());
    console.log("  PDA bump:          ", statusAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(statusBefore,    "frozen_account PDA should not exist before freeze_account");
    assert.isNotNull(statusAfter,  "frozen_account PDA should exist after freeze_account");
    assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");
  });

  // ── Happy-path: unfreeze_account ─────────────────────────────────────────────
  it("unfreeze_account: closes the frozen_account PDA for a token account", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    // ── Create a token account to use as the freeze target ──────────────────
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
    const [frozenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_account"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── First: freeze the account ────────────────────────────────────────────
    const freezeTx = await (freezeProgram as any).methods
      .freezeAccount()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  freeze_account tx: ", freezeTx);

    const statusAfterFreeze = await (freezeProgram as any).account.frozenAccountStatus.fetch(frozenAccountPda);
    assert.isNotNull(statusAfterFreeze, "frozen_account PDA should exist after freeze_account");

    // ── Then: unfreeze the account ───────────────────────────────────────────
    const unfreezeTx = await (freezeProgram as any).methods
      .unfreezeAccount()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenAccountPda,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  unfreeze_account tx:", unfreezeTx);

    // ── Verify the frozen_account PDA has been closed ────────────────────────
    const statusAfterUnfreeze = await (freezeProgram as any).account.frozenAccountStatus.fetchNullable(frozenAccountPda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:              ", mint.toBase58());
    console.log("  Token account:     ", tokenAccount.toBase58());
    console.log("  Frozen account PDA:", frozenAccountPda.toBase58());
    console.log("  PDA after unfreeze:", statusAfterUnfreeze);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(statusAfterUnfreeze, "frozen_account PDA should not exist after unfreeze_account");
  });

  // ── Error case: freeze_account — UnauthorizedDeployer ───────────────────────
  it("freeze_account: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
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
    const [frozenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_account"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
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
      await (freezeProgram as any).methods
        .freezeAccount()
        .accounts({
          deployer:         rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenAccountPda,
          systemProgram:    anchor.web3.SystemProgram.programId,
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

  // ── Error case: freeze_account — MintPaused ─────────────────────────────────
  it("freeze_account: fails with MintPaused when mint is paused", async () => {
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
    const [frozenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_account"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Pause the mint ────────────────────────────────────────────────────────
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

    try {
      await (freezeProgram as any).methods
        .freezeAccount()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenAccountPda,
          systemProgram:    anchor.web3.SystemProgram.programId,
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

  // ── Error case: freeze_account — Deactivated ────────────────────────────────
  it("freeze_account: fails with Deactivated when mint has been deactivated", async () => {
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
    const [frozenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_account"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Deactivate the mint ───────────────────────────────────────────────────
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
    console.log("  Deactivate PDA:     ", deactivatePda.toBase58());
    console.log("  deactivate tx:      ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (freezeProgram as any).methods
        .freezeAccount()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenAccountPda,
          systemProgram:    anchor.web3.SystemProgram.programId,
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

  // ── Error case: unfreeze_account — UnauthorizedDeployer ─────────────────────
  it("unfreeze_account: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
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
    const [frozenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_account"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Freeze the account first ──────────────────────────────────────────────
    await (freezeProgram as any).methods
      .freezeAccount()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (freezeProgram as any).methods
        .unfreezeAccount()
        .accounts({
          deployer:         rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenAccountPda,
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

  // ── Error case: unfreeze_account — MintPaused ───────────────────────────────
  it("unfreeze_account: fails with MintPaused when mint is paused", async () => {
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
    const [frozenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_account"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Freeze the account first ──────────────────────────────────────────────
    await (freezeProgram as any).methods
      .freezeAccount()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    // ── Pause the mint ────────────────────────────────────────────────────────
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

    try {
      await (freezeProgram as any).methods
        .unfreezeAccount()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenAccountPda,
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

  // ── Error case: unfreeze_account — Deactivated ──────────────────────────────
  it("unfreeze_account: fails with Deactivated when mint has been deactivated", async () => {
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
    const [frozenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_account"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Freeze the account first ──────────────────────────────────────────────
    await (freezeProgram as any).methods
      .freezeAccount()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    // ── Deactivate the mint ───────────────────────────────────────────────────
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
    console.log("  Deactivate PDA:     ", deactivatePda.toBase58());
    console.log("  deactivate tx:      ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (freezeProgram as any).methods
        .unfreezeAccount()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenAccountPda,
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

  // ── Happy-path: partially_freeze_account ────────────────────────────────────
  it("partially_freeze_account: creates the frozen_balance PDA with the given balance", async () => {
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
    const [frozenBalancePda, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_balance"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    const FROZEN_BALANCE = new anchor.BN(500_000_000);

    // ── Verify the PDA does not exist before the instruction ─────────────────
    const statusBefore = await (freezeProgram as any).account.frozenBalance.fetchNullable(frozenBalancePda);

    // ── Call partially_freeze_account ─────────────────────────────────────────
    const tx = await (freezeProgram as any).methods
      .partiallyFreezeAccount(FROZEN_BALANCE)
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  partially_freeze_account tx:", tx);

    // ── Verify the frozen_balance PDA was created with the correct fields ─────
    const statusAfter = await (freezeProgram as any).account.frozenBalance.fetch(frozenBalancePda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                 ", mint.toBase58());
    console.log("  Token account:        ", tokenAccount.toBase58());
    console.log("  Frozen balance PDA:   ", frozenBalancePda.toBase58());
    console.log("  PDA balance:          ", statusAfter.balance.toString());
    console.log("  PDA bump:             ", statusAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(statusBefore,   "frozen_balance PDA should not exist before partially_freeze_account");
    assert.isNotNull(statusAfter, "frozen_balance PDA should exist after partially_freeze_account");
    assert.equal(
      statusAfter.balance.toString(),
      FROZEN_BALANCE.toString(),
      "balance should match the value passed to partially_freeze_account"
    );
    assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");
  });

  // ── Error case: partially_freeze_account — UnauthorizedDeployer ─────────────
  it("partially_freeze_account: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
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
    const [frozenBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_balance"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
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
      await (freezeProgram as any).methods
        .partiallyFreezeAccount(new anchor.BN(500_000_000))
        .accounts({
          deployer:         rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenBalancePda,
          systemProgram:    anchor.web3.SystemProgram.programId,
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

  // ── Error case: partially_freeze_account — MintPaused ───────────────────────
  it("partially_freeze_account: fails with MintPaused when mint is paused", async () => {
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
    const [frozenBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_balance"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Pause the mint ────────────────────────────────────────────────────────
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

    try {
      await (freezeProgram as any).methods
        .partiallyFreezeAccount(new anchor.BN(500_000_000))
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenBalancePda,
          systemProgram:    anchor.web3.SystemProgram.programId,
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

  // ── Happy-path: remove_partial_freeze ───────────────────────────────────────
  it("remove_partial_freeze: closes the frozen_balance PDA for a token account", async () => {
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
    const [frozenBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_balance"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    const FROZEN_BALANCE = new anchor.BN(500_000_000);

    // ── First: partially freeze the account ──────────────────────────────────
    const partialFreezeTx = await (freezeProgram as any).methods
      .partiallyFreezeAccount(FROZEN_BALANCE)
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  partially_freeze_account tx:", partialFreezeTx);

    const statusAfterFreeze = await (freezeProgram as any).account.frozenBalance.fetch(frozenBalancePda);
    assert.isNotNull(statusAfterFreeze, "frozen_balance PDA should exist after partially_freeze_account");

    // ── Then: remove the partial freeze ──────────────────────────────────────
    const removeFreezeTx = await (freezeProgram as any).methods
      .removePartialFreeze()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  remove_partial_freeze tx:   ", removeFreezeTx);

    // ── Verify the frozen_balance PDA has been closed ────────────────────────
    const statusAfterRemove = await (freezeProgram as any).account.frozenBalance.fetchNullable(frozenBalancePda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                 ", mint.toBase58());
    console.log("  Token account:        ", tokenAccount.toBase58());
    console.log("  Frozen balance PDA:   ", frozenBalancePda.toBase58());
    console.log("  PDA after remove:     ", statusAfterRemove);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(statusAfterRemove, "frozen_balance PDA should not exist after remove_partial_freeze");
  });

  // ── Error case: remove_partial_freeze — UnauthorizedDeployer ────────────────
  it("remove_partial_freeze: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
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
    const [frozenBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_balance"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Partially freeze the account so frozen_balance_pda exists ────────────
    await (freezeProgram as any).methods
      .partiallyFreezeAccount(new anchor.BN(500_000_000))
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram:    anchor.web3.SystemProgram.programId,
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
      await (freezeProgram as any).methods
        .removePartialFreeze()
        .accounts({
          deployer:         rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenBalancePda,
          systemProgram:    anchor.web3.SystemProgram.programId,
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

  // ── Error case: remove_partial_freeze — MintPaused ──────────────────────────
  it("remove_partial_freeze: fails with MintPaused when mint is paused", async () => {
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
    const [frozenBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_balance"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Partially freeze the account so frozen_balance_pda exists ────────────
    await (freezeProgram as any).methods
      .partiallyFreezeAccount(new anchor.BN(500_000_000))
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    // ── Pause the mint ────────────────────────────────────────────────────────
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

    try {
      await (freezeProgram as any).methods
        .removePartialFreeze()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenBalancePda,
          systemProgram:    anchor.web3.SystemProgram.programId,
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

  // ── Error case: partially_freeze_account — Deactivated ──────────────────────
  it("partially_freeze_account: fails with Deactivated when mint has been deactivated", async () => {
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
    const [frozenBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_balance"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Deactivate the mint ───────────────────────────────────────────────────
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
    console.log("  Deactivate PDA:     ", deactivatePda.toBase58());
    console.log("  deactivate tx:      ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (freezeProgram as any).methods
        .partiallyFreezeAccount(new anchor.BN(500_000_000))
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenBalancePda,
          systemProgram:    anchor.web3.SystemProgram.programId,
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

  // ── Error case: remove_partial_freeze — Deactivated ─────────────────────────
  it("remove_partial_freeze: fails with Deactivated when mint has been deactivated", async () => {
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
    const [frozenBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("frozen_balance"), mint.toBuffer(), tokenAccount.toBuffer()],
      freezeProgram.programId
    );

    // ── Partially freeze the account so frozen_balance_pda exists ────────────
    await (freezeProgram as any).methods
      .partiallyFreezeAccount(new anchor.BN(500_000_000))
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        account:          tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram:    anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    // ── Deactivate the mint ───────────────────────────────────────────────────
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
    console.log("  Deactivate PDA:     ", deactivatePda.toBase58());
    console.log("  deactivate tx:      ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (freezeProgram as any).methods
        .removePartialFreeze()
        .accounts({
          deployer,
          mintOwnerPda,
          mint,
          account:          tokenAccount,
          deactivatePda,
          frozenBalancePda,
          systemProgram:    anchor.web3.SystemProgram.programId,
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
});
