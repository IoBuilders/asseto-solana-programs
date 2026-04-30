import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CmtatDeploy } from "../target/types/cmtat_deploy";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME     = "CMTAT Test Token";
const MINT_SYMBOL   = "CMTAT";
const MINT_URI      = "https://example.com/cmtat-metadata.json";

describe("cmtat-deactivate", () => {
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
    return { mint, mintOwnerPda };
  }

  // ── Happy-path test ──────────────────────────────────────────────────────────
  it("deactivate: creates the deactivate PDA for the mint", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );

    // ── Verify the deactivate PDA was created and stores the correct bump ─────
    const deactivateStatusBefore = await deactivateProgram.account.deactivateStatus.fetchNullable(deactivatePda);

    // ── Call the deactivate instruction ───────────────────────────────────────
    const tx = await deactivateProgram.methods
      .deactivate()
      .accounts({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  deactivate tx:", tx);

    // ── Verify the deactivate PDA was created and stores the correct bump ─────
    const deactivateStatusAfter = await deactivateProgram.account.deactivateStatus.fetch(deactivatePda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:           ", mint.toBase58());
    console.log("  Deactivate PDA: ", deactivatePda.toBase58());
    console.log("  PDA bump:       ", deactivateStatusAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(deactivateStatusBefore, "deactivate PDA should not exist before calling deactivate");
    assert.isNotNull(deactivateStatusAfter, "deactivate PDA should exist after calling deactivate");
    assert.equal(
      deactivateStatusAfter.bump,
      expectedBump,
      "deactivate PDA bump should match the canonical bump"
    );
  });
});
