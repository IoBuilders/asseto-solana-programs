import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAccount } from "@solana/spl-token";
import { assert } from "chai";
import { TransferControl } from "../target/types/transfer_control";
import { Pause } from "../target/types/pause";
import { Deactivate } from "../target/types/deactivate";
import { Mint } from "../target/types/mint";
import { MetadataUpdate } from "../target/types/metadata_update";
import { Freeze } from "../target/types/freeze";
import { Operations } from "../target/types/operations";
import { TransferHook } from "../target/types/transfer_hook";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";

describe("transfer-control", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const mintProgram = anchor.workspace.Mint as Program<Mint>;
  const metadataProgram = anchor.workspace.MetadataUpdate as Program<MetadataUpdate>;
  const freezeProgram = anchor.workspace.Freeze as Program<Freeze>;
  const operationsProgram = anchor.workspace.Operations as Program<Operations>;
  const pauseProgram = anchor.workspace.Pause as Program<Pause>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;
  const transferControlProgram = anchor.workspace.TransferControl as Program<TransferControl>;
  const transferHookProgram = anchor.workspace.TransferHook as Program<TransferHook>;

  const connection = provider.connection;
  const deployer = provider.wallet.publicKey;

  const MINT_AUTHORITY_PROGRAM_ID = mintProgram.programId;
  const FREEZE_AUTHORITY_PROGRAM_ID = freezeProgram.programId;
  const PERMANENT_DELEGATE_PROGRAM_ID = operationsProgram.programId;
  const METADATA_UPDATE_PROGRAM_ID = metadataProgram.programId;
  const PAUSABLE_AUTHORITY_PROGRAM_ID = pauseProgram.programId;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

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
        permanentDelegateAuthority: operationsAuthority,
        metadataUpdateAuthority,
        pausableAuthority,
        freezeAuthority,
        transferHookAuthority,
        extraAccountMetaList,
        transferHookProgram: transferHookProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda };
  }

  // 8 discriminator + 4 vec-length prefix + 1 byte per TransferMode variant + 1 bump
  function getSizeOfTransferControlModePda(numModes: number): number {
    return 8 + 4 + numModes + 1;
  }

  // ── Happy-path: set_modes creates the PDA and sets modes = [Clearing] ───────────
  it("set_modes: creates the transfer_control_mode PDA with modes = [Clearing]", async () => {
    const modes = [{ clearing: {} }];
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
    const stateBefore = await transferControlProgram.account.transferControlMode.fetchNullable(transferControlModePda);

    // ── Call set_modes({ clearing: {} }) ────────────────────────────────────
    const tx = await transferControlProgram.methods
      .setModes(modes)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log(`  set_modes(${modes}) tx:`, tx);

    // ── Fetch and verify the PDA ─────────────────────────────────────────────
    const stateAfter = await transferControlProgram.account.transferControlMode.fetch(transferControlModePda);
    const accountInfo = await connection.getAccountInfo(transferControlModePda, "confirmed");

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                        ", mint.toBase58());
    console.log("  Transfer Control Mode PDA:   ", transferControlModePda.toBase58());
    console.log("  modes:                        ", JSON.stringify(stateAfter.modes));
    console.log("  bump:                        ", stateAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    const expectedSize = getSizeOfTransferControlModePda(modes.length);

    assert.isNull(stateBefore, "transfer_control_mode PDA should not exist before set_modes");
    assert.isNotNull(stateAfter, "transfer_control_mode PDA should exist after set_modes");
    assert.deepEqual(stateAfter.modes, modes, `modes should be ${modes}`);
    assert.equal(stateAfter.bump, expectedBump, "bump should match the canonical bump");
    assert.equal(accountInfo.data.length, expectedSize, `PDA size should be ${expectedSize} bytes`);
  });

  // ── Happy-path: set_modes expands the PDA when a mode is added ────────────────────
  it("set_modes: adds mode to an existing transfer_control_mode PDA", async () => {
    const initialModes = [{ clearing: {} }];
    const newModes = [...initialModes, { whitelist: {} }];
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );

    // ── First call: create with modes = [Clearing] ────────────────────────────
    await transferControlProgram.methods
      .setModes(initialModes)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const stateAfterFirst = await transferControlProgram.account.transferControlMode.fetch(transferControlModePda);
    const accountInfoBefore = await connection.getAccountInfo(transferControlModePda, "confirmed");
    const dataSizeBefore = accountInfoBefore.data.length;
    const lamportsBefore = accountInfoBefore.lamports;
    const expectedSizeBefore = getSizeOfTransferControlModePda(initialModes.length);
    const expectedLamportsBefore = await connection.getMinimumBalanceForRentExemption(expectedSizeBefore);

    assert.deepEqual(stateAfterFirst.modes, initialModes, `modes should be ${initialModes} after first call`);
    assert.equal(dataSizeBefore, expectedSizeBefore, `PDA size before should be ${expectedSizeBefore} bytes`);
    assert.equal(
      lamportsBefore,
      expectedLamportsBefore,
      `PDA lamports should be rent-exempt for ${expectedSizeBefore} bytes`
    );

    // ── Second call: Add Whitelist to modes ──────────────────
    const updateTx = await transferControlProgram.methods
      .setModes(newModes)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log(`  set_modes(${newModes}) tx:`, updateTx);

    const stateAfterUpdate = await transferControlProgram.account.transferControlMode.fetch(transferControlModePda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                        ", mint.toBase58());
    console.log("  Transfer Control Mode PDA:   ", transferControlModePda.toBase58());
    console.log("  modes (after update):         ", JSON.stringify(stateAfterUpdate.modes));
    console.log("══════════════════════════════════════════════════════════\n");

    const accountInfoAfter = await connection.getAccountInfo(transferControlModePda, "confirmed");
    const lamportsAfter = accountInfoAfter.lamports;
    const dataSizeAfter = accountInfoAfter.data.length;
    const expectedSizeAfter = getSizeOfTransferControlModePda(newModes.length);
    const expectedLamportsAfter = await connection.getMinimumBalanceForRentExemption(expectedSizeAfter);

    assert.deepEqual(stateAfterUpdate.modes, newModes, `modes should be ${newModes} after update`);
    assert.equal(dataSizeAfter, expectedSizeAfter, `PDA size after should be ${expectedSizeAfter} bytes`);
    assert.ok(dataSizeAfter > dataSizeBefore, `PDA data size should increase (${dataSizeBefore} → ${dataSizeAfter})`);
    assert.equal(
      lamportsAfter,
      expectedLamportsAfter,
      `PDA lamports should be rent-exempt for ${expectedSizeAfter} bytes`
    );
    assert.ok(lamportsAfter > lamportsBefore, `PDA lamports should increase (${lamportsBefore} → ${lamportsAfter})`);
  });

  // ── Happy-path: set_modes shrinks the PDA when a mode is removed ──────────────
  it("set_modes: removes a mode from an existing transfer_control_mode PDA", async () => {
    const initialModes = [{ clearing: {} }, { whitelist: {} }] as any[];
    const newModes = [{ clearing: {} }];
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );

    // ── First call: create with modes = [Clearing, Whitelist] ────────────────
    await transferControlProgram.methods
      .setModes(initialModes)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const stateAfterFirst = await transferControlProgram.account.transferControlMode.fetch(transferControlModePda);
    const accountInfoBefore = await connection.getAccountInfo(transferControlModePda, "confirmed");
    const dataSizeBefore = accountInfoBefore.data.length;
    const lamportsBefore = accountInfoBefore.lamports;
    const expectedSizeBefore = getSizeOfTransferControlModePda(initialModes.length);
    const expectedLamportsBefore = await connection.getMinimumBalanceForRentExemption(expectedSizeBefore);

    assert.deepEqual(stateAfterFirst.modes, initialModes, `modes should be ${initialModes} after first call`);
    assert.equal(dataSizeBefore, expectedSizeBefore, `PDA size before should be ${expectedSizeBefore} bytes`);
    assert.equal(
      lamportsBefore,
      expectedLamportsBefore,
      `PDA lamports should be rent-exempt for ${expectedSizeBefore} bytes`
    );

    // ── Second call: remove Whitelist, keeping only [Clearing] ───────────────
    const updateTx = await transferControlProgram.methods
      .setModes(newModes)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log(`  set_modes(${newModes}) tx:`, updateTx);

    const stateAfterUpdate = await transferControlProgram.account.transferControlMode.fetch(transferControlModePda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                        ", mint.toBase58());
    console.log("  Transfer Control Mode PDA:   ", transferControlModePda.toBase58());
    console.log("  modes (after update):         ", JSON.stringify(stateAfterUpdate.modes));
    console.log("══════════════════════════════════════════════════════════\n");

    const accountInfoAfter = await connection.getAccountInfo(transferControlModePda, "confirmed");
    const dataSizeAfter = accountInfoAfter.data.length;
    const lamportsAfter = accountInfoAfter.lamports;
    const expectedSizeAfter = getSizeOfTransferControlModePda(newModes.length);
    const expectedLamportsAfter = await connection.getMinimumBalanceForRentExemption(expectedSizeAfter);

    assert.deepEqual(stateAfterUpdate.modes, newModes, "modes should be [Clearing] after removing Whitelist");
    assert.equal(dataSizeAfter, expectedSizeAfter, `PDA size after should be ${expectedSizeAfter} bytes`);
    assert.ok(dataSizeAfter < dataSizeBefore, `PDA data size should decrease (${dataSizeBefore} → ${dataSizeAfter})`);
    assert.equal(
      lamportsAfter,
      expectedLamportsAfter,
      `PDA lamports should be rent-exempt for ${expectedSizeAfter} bytes`
    );
    assert.ok(lamportsAfter < lamportsBefore, `PDA lamports should decrease (${lamportsBefore} → ${lamportsAfter})`);
  });

  // ── Happy-path: set_modes(null) removes an existing transfer_control_mode PDA ──
  it("set_modes: closes the transfer_control_mode PDA when called with empty vector", async () => {
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
    await transferControlProgram.methods
      .setModes([{ clearing: {} }])
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const stateAfterCreate = await transferControlProgram.account.transferControlMode.fetch(transferControlModePda);
    assert.isNotNull(stateAfterCreate, "transfer_control_mode PDA should exist after set_modes([{ clearing: {} }])");

    // ── Then: remove it by passing empty vector ────────────────────
    const removeTx = await transferControlProgram.methods
      .setModes([])
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  set_modes([]) tx:", removeTx);

    // ── Verify the PDA has been closed ────────────────────────────────────
    const stateAfterRemove = await transferControlProgram.account.transferControlMode.fetchNullable(
      transferControlModePda
    );

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                        ", mint.toBase58());
    console.log("  Transfer Control Mode PDA:   ", transferControlModePda.toBase58());
    console.log("  PDA after set_modes(null):    ", stateAfterRemove);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(stateAfterRemove, "transfer_control_mode PDA should not exist after set_modes([])");
  });

  // ── Happy-path: add_to_whitelist ─────────────────────────────────────────────
  it("add_to_whitelist: creates the whitelist PDA for a token account", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
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
    const stateBefore = await transferControlProgram.account.whitelistStatus.fetchNullable(whitelistPda);

    // ── Call add_to_whitelist ───────────────────────────────────────────────
    const tx = await transferControlProgram.methods
      .addToWhitelist()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        whitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  add_to_whitelist tx:", tx);

    // ── Fetch and verify the PDA ─────────────────────────────────────────────
    const stateAfter = await transferControlProgram.account.whitelistStatus.fetch(whitelistPda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:          ", mint.toBase58());
    console.log("  Token account: ", tokenAccount.toBase58());
    console.log("  Whitelist PDA: ", whitelistPda.toBase58());
    console.log("  bump:          ", stateAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(stateBefore, "whitelist PDA should not exist before add_to_whitelist");
    assert.isNotNull(stateAfter, "whitelist PDA should exist after add_to_whitelist");
    assert.equal(stateAfter.bump, expectedBump, "bump should match the canonical bump");
  });

  // ── Happy-path: remove_from_whitelist ────────────────────────────────────────
  it("remove_from_whitelist: closes the whitelist PDA for a token account", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
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
    const addTx = await transferControlProgram.methods
      .addToWhitelist()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        whitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  add_to_whitelist tx:", addTx);

    const stateAfterAdd = await transferControlProgram.account.whitelistStatus.fetch(whitelistPda);
    assert.isNotNull(stateAfterAdd, "whitelist PDA should exist after add_to_whitelist");

    // ── Then: remove from whitelist ─────────────────────────────────────────
    const removeTx = await transferControlProgram.methods
      .removeFromWhitelist()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        whitelistPda,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  remove_from_whitelist tx:", removeTx);

    // ── Verify the PDA has been closed ──────────────────────────────────────
    const stateAfterRemove = await transferControlProgram.account.whitelistStatus.fetchNullable(whitelistPda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                     ", mint.toBase58());
    console.log("  Token account:            ", tokenAccount.toBase58());
    console.log("  Whitelist PDA:            ", whitelistPda.toBase58());
    console.log("  PDA after remove:         ", stateAfterRemove);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(stateAfterRemove, "whitelist PDA should not exist after remove_from_whitelist");
  });

  // ── Error case: set_modes — UnauthorizedDeployer ──────────────────────────────
  it("set_modes: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
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
      await transferControlProgram.methods
        .setModes([{ clearing: {} }])
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          deactivatePda,
          transferControlModePda,
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

  // ── Error case: set_modes — MintPaused ────────────────────────────────────────
  it("set_modes: fails with MintPaused when mint is paused", async () => {
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

    const pauseTx = await pauseProgram.methods
      .pause()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
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
      await transferControlProgram.methods
        .setModes([{ clearing: {} }])
        .accountsStrict({
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

  // ── Error case: set_modes — Deactivated ───────────────────────────────────────
  it("set_modes: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [transferControlModePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("transfer_control_mode"), mint.toBuffer()],
      transferControlProgram.programId
    );

    const deactivateTx = await deactivateProgram.methods
      .deactivate()
      .accountsStrict({
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
      await transferControlProgram.methods
        .setModes([{ clearing: {} }])
        .accountsStrict({
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

    const payerKeypair = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
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
      await transferControlProgram.methods
        .addToWhitelist()
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account: tokenAccount,
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

    const payerKeypair = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
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

    const pauseTx = await pauseProgram.methods
      .pause()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
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
      await transferControlProgram.methods
        .addToWhitelist()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
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

    const payerKeypair = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    const deactivateTx = await deactivateProgram.methods
      .deactivate()
      .accountsStrict({
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
      await transferControlProgram.methods
        .addToWhitelist()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
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

    const payerKeypair = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    await transferControlProgram.methods
      .addToWhitelist()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
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
      await transferControlProgram.methods
        .removeFromWhitelist()
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account: tokenAccount,
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

    const payerKeypair = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
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

    await transferControlProgram.methods
      .addToWhitelist()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        whitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const pauseTx = await pauseProgram.methods
      .pause()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
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
      await transferControlProgram.methods
        .removeFromWhitelist()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
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

    const payerKeypair = (provider.wallet as any).payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [whitelistPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), mint.toBuffer(), tokenAccount.toBuffer()],
      transferControlProgram.programId
    );

    await transferControlProgram.methods
      .addToWhitelist()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        whitelistPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    const deactivateTx = await deactivateProgram.methods
      .deactivate()
      .accountsStrict({
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
      await transferControlProgram.methods
        .removeFromWhitelist()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
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
