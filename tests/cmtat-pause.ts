import * as anchor from "@coral-xyz/anchor";
import { AnchorError,Program } from "@coral-xyz/anchor";
import { CmtatDeploy } from "../target/types/cmtat_deploy";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint, getPausableConfig } from "@solana/spl-token";
import { assert } from "chai";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME     = "CMTAT Test Token";
const MINT_SYMBOL   = "CMTAT";
const MINT_URI      = "https://example.com/cmtat-metadata.json";

describe("cmtat-pause", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram   = anchor.workspace.CmtatDeploy   as Program<CmtatDeploy>;
  const mintProgram     = anchor.workspace.CmtatMint     as Program<any>;
  const metadataProgram = anchor.workspace.CmtatMetadataUpdate as Program<any>;
  const freezeProgram    = anchor.workspace.cmtatFreeze    as Program<any>;
  const operationsProgram = anchor.workspace.CmtatOperations as Program<any>;
  const pauseProgram    = anchor.workspace.CmtatPause    as Program<any>;
  const deactivateProgram     = anchor.workspace.CmtatDeactivate     as Program<any>;
  const transferHookProgram   = anchor.workspace.CmtatTransferHook   as Program<any>;

  const connection = provider.connection;
  const deployer   = provider.wallet.publicKey;

  const MINT_AUTHORITY_PROGRAM_ID     = mintProgram.programId;
  const FREEZE_AUTHORITY_PROGRAM_ID   = freezeProgram.programId;
  const PERMANENT_DELEGATE_PROGRAM_ID = operationsProgram.programId;
  const METADATA_UPDATE_PROGRAM_ID    = metadataProgram.programId;
  const PAUSABLE_AUTHORITY_PROGRAM_ID = pauseProgram.programId;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint:               PublicKey;
    mintOwnerPda:       PublicKey;
    mintAuthority:      PublicKey;
    freezeAuthority:    PublicKey;
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
    return { mint, mintOwnerPda, mintAuthority, freezeAuthority, pausableAuthority };
  }

  // ── Happy-path test ──────────────────────────────────────────────────────────
  it("pause → unpause: correctly toggles mint pause state", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();

    // ── Baseline: mint should NOT be paused after deployment ──────────────────
    const mintInfoInitial = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const pausableConfigInitial = getPausableConfig(mintInfoInitial);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Pausable authority: ", pausableAuthority.toBase58());
    console.log("  Pause authority set:", pausableConfigInitial?.authority.toBase58());
    console.log("  Paused (initial):   ", pausableConfigInitial?.paused);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNotNull(pausableConfigInitial, "pausable extension should be present on the mint");
    assert.equal(
      pausableConfigInitial!.authority.toBase58(),
      pausableAuthority.toBase58(),
      "pause authority should be the cmtat-pause PDA"
    );
    assert.isFalse(pausableConfigInitial!.paused, "mint should not be paused after deployment");

    // ── Step 1: Pause the mint ─────────────────────────────────────────────────
    const pauseTx = await pauseProgram.methods
      .pause()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        pausableAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  pause tx:           ", pauseTx);

    const mintInfoAfterPause = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const pausableConfigAfterPause = getPausableConfig(mintInfoAfterPause);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Paused (after pause):", pausableConfigAfterPause?.paused);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isTrue(pausableConfigAfterPause!.paused, "mint should be paused after calling pause");

    // ── Step 2: Unpause the mint ───────────────────────────────────────────────
    const unpauseTx = await pauseProgram.methods
      .unpause()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        pausableAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  unpause tx:         ", unpauseTx);

    const mintInfoAfterUnpause = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const pausableConfigAfterUnpause = getPausableConfig(mintInfoAfterUnpause);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Paused (after unpause):", pausableConfigAfterUnpause?.paused);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isFalse(pausableConfigAfterUnpause!.paused, "mint should not be paused after calling unpause");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("pause: fails with Deactivated when mint has been deactivated", async () => {
       const { mint, mintOwnerPda, pausableAuthority } = await deployMint();
    
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
    
        // ── Mint must now be rejected with Deactivated ─────────────────────────
        try {
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
