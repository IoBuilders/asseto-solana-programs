import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CmtatSnapshot } from "../target/types/cmtat_snapshot";
import { CmtatDeploy } from "../target/types/cmtat_deploy";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME     = "CMTAT Test Token";
const MINT_SYMBOL   = "CMTAT";
const MINT_URI      = "https://example.com/cmtat-metadata.json";

describe("cmtat-snapshot", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram       = anchor.workspace.CmtatDeploy       as Program<CmtatDeploy>;
  const mintProgram         = anchor.workspace.CmtatMint         as Program<any>;
  const metadataProgram     = anchor.workspace.CmtatMetadataUpdate as Program<any>;
  const freezeProgram       = anchor.workspace.CmtatFreeze       as Program<any>;
  const operationsProgram   = anchor.workspace.CmtatOperations   as Program<any>;
  const pauseProgram        = anchor.workspace.CmtatPause        as Program<any>;
  const deactivateProgram   = anchor.workspace.CmtatDeactivate   as Program<any>;
  const snapshotProgram     = anchor.workspace.CmtatSnapshot     as Program<CmtatSnapshot>;
  const transferHookProgram = anchor.workspace.CmtatTransferHook as Program<any>;

  const deployer = provider.wallet.publicKey;

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
        token2022Program:           TOKEN_2022_PROGRAM_ID,
        systemProgram:              anchor.web3.SystemProgram.programId,
        rent:                       SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda };
  }

  // ── Happy-path: first call creates PDA with count = 1 ───────────────────────
  it("take_snapshot: creates snapshot_counter PDA and sets count to 1 on first call", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [snapshotCounterPda, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_counter"), mint.toBuffer()],
      snapshotProgram.programId
    );

    // ── Confirm PDA does not exist before the call ────────────────────────────
    const counterBefore = await snapshotProgram.account.snapshotCounter.fetchNullable(
      snapshotCounterPda
    );
    assert.isNull(counterBefore, "snapshot_counter PDA should not exist before take_snapshot");

    // ── Call take_snapshot ────────────────────────────────────────────────────
    const tx = await snapshotProgram.methods
      .takeSnapshot()
      .accounts({
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        snapshotCounter: snapshotCounterPda,
        systemProgram:   anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  take_snapshot tx:", tx);

    // ── Fetch and verify the created PDA ──────────────────────────────────────
    const counterAfter = await snapshotProgram.account.snapshotCounter.fetch(snapshotCounterPda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                   ", mint.toBase58());
    console.log("  snapshot_counter PDA:   ", snapshotCounterPda.toBase58());
    console.log("  count:                  ", counterAfter.count.toString());
    console.log("  bump:                   ", counterAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNotNull(counterAfter, "snapshot_counter PDA should exist after take_snapshot");
    assert.equal(
      counterAfter.count.toNumber(),
      1,
      "count should be 1 after the first take_snapshot call"
    );
    assert.equal(
      counterAfter.bump,
      expectedBump,
      "bump should match the canonical PDA bump"
    );
  });

  // ── Happy-path: second call increments count to 2 ───────────────────────────
  it("take_snapshot: increments count to 2 on second call", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    const [snapshotCounterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_counter"), mint.toBuffer()],
      snapshotProgram.programId
    );

    const callSnapshot = () =>
      snapshotProgram.methods
        .takeSnapshot()
        .accounts({
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          snapshotCounter: snapshotCounterPda,
          systemProgram:   anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

    const tx1 = await callSnapshot();
    console.log("  take_snapshot (1st) tx:", tx1);

    const tx2 = await callSnapshot();
    console.log("  take_snapshot (2nd) tx:", tx2);

    const counterAfter = await snapshotProgram.account.snapshotCounter.fetch(snapshotCounterPda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                   ", mint.toBase58());
    console.log("  snapshot_counter PDA:   ", snapshotCounterPda.toBase58());
    console.log("  count after 2 calls:    ", counterAfter.count.toString());
    console.log("══════════════════════════════════════════════════════════\n");

    assert.equal(
      counterAfter.count.toNumber(),
      2,
      "count should be 2 after two take_snapshot calls"
    );
  });
});
