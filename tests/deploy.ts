import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Deploy } from "../target/types/deploy";
import { MetadataUpdate } from "../target/types/metadata_update";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  AccountState,
  getMint,
  getDefaultAccountState,
  getMetadataPointerState,
  getPermanentDelegate,
  getTokenMetadata,
  getPausableConfig,
} from "@solana/spl-token";
import { assert } from "chai";

// ── Test mint parameters ───────────────────────────────────────────────────────
const MINT_DECIMALS    = 6;
const MINT_NAME        = "CMTAT Test Token";
const MINT_SYMBOL      = "CMTAT";
const MINT_URI         = "https://example.com/metadata.json";
const MINT_ISIN_KEY    = "isin";
const MINT_ISIN_VALUE  = "CH0012221716";

// ── Program IDs sourced from workspace (mirrors constants.rs in deploy) ──
const mintProgram           = anchor.workspace.Mint           as Program<any>;
const metadataUpdateProgram = anchor.workspace.MetadataUpdate as Program<MetadataUpdate>;
const freezeProgram          = anchor.workspace.Freeze          as Program<any>;
const operationsProgram     = anchor.workspace.Operations     as Program<any>;
const pauseProgram          = anchor.workspace.Pause          as Program<any>;
const transferHookProgram   = anchor.workspace.TransferHook   as Program<any>;
const snapshotProgram           = anchor.workspace.Snapshot           as Program<any>;

const MINT_AUTHORITY_PROGRAM_ID            = mintProgram.programId;
const METADATA_UPDATE_AUTHORITY_PROGRAM_ID = metadataUpdateProgram.programId;
const FREEZE_AUTHORITY_PROGRAM_ID          = freezeProgram.programId;
const PERMANENT_DELEGATE_PROGRAM_ID        = operationsProgram.programId;
const PAUSABLE_AUTHORITY_PROGRAM_ID        = pauseProgram.programId;
const SNAPSHOT_PROGRAM_ID = snapshotProgram.programId;


describe("deploy", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Deploy as Program<Deploy>;
  const connection = provider.connection;

  // The wallet that signs as deployer and becomes the recorded mint owner.
  const deployer = provider.wallet.publicKey;

  it("deploy_mint: deploys a Token-2022 mint with all extensions and metadata", async () => {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    // ── Derive PDAs ────────────────────────────────────────────────────────────

    const [mintOwnerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_owner"), mint.toBuffer()],
      program.programId
    );

    const [tempMintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("temp_mint_authority"), mint.toBuffer()],
      program.programId
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

    // ── Print PDAs ─────────────────────────────────────────────────────────────
    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Deployer:                  ", deployer.toBase58());
    console.log("  Mint:                      ", mint.toBase58());
    console.log("  mintOwnerPda:              ", mintOwnerPda.toBase58());
    console.log("  tempMintAuthority:         ", tempMintAuthority.toBase58());
    console.log("  mintAuthority:             ", mintAuthority.toBase58());
    console.log("  permanentDelegateAuth:     ", permanentDelegateAuthority.toBase58());
    console.log("  metadataUpdateAuthority:   ", metadataUpdateAuthority.toBase58());
    console.log("  pausableAuthority:         ", pausableAuthority.toBase58());
    console.log("  freezeAuthority:           ", freezeAuthority.toBase58());
    console.log("──────────────────────────────────────────────────────────\n");

    // ── Send deploy_mint instruction ───────────────────────────────────────────
    const tx = await program.methods
      .deployMint({
        decimals: MINT_DECIMALS,
        name: MINT_NAME,
        symbol: MINT_SYMBOL,
        uri: MINT_URI,
        additionalMetadata: [{ key: MINT_ISIN_KEY, value: MINT_ISIN_VALUE }],
      })
      .accounts({
        payer: provider.wallet.publicKey,
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
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  Transaction signature:", tx);

    // ── Read back mint account ─────────────────────────────────────────────────
    const mintInfo = await getMint(
      connection,
      mint,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    // ── Read back mint owner PDA ───────────────────────────────────────────────
    const mintOwnerAccount = await program.account.mintOwner.fetch(mintOwnerPda, "confirmed");

    // ── Print mint state ───────────────────────────────────────────────────────
    console.log("\n── Mint Account ───────────────────────────────────────────");
    console.log("  address:          ", mintInfo.address.toBase58());
    console.log("  decimals:         ", mintInfo.decimals);
    console.log("  supply:           ", mintInfo.supply.toString());
    console.log(
      "  mintAuthority:    ",
      mintInfo.mintAuthority?.toBase58() ?? "null"
    );
    console.log(
      "  freezeAuthority:  ",
      mintInfo.freezeAuthority?.toBase58() ?? "null"
    );
    console.log("  isInitialized:    ", mintInfo.isInitialized);

    // ── Print extensions ───────────────────────────────────────────────────────
    console.log("\n── Extensions ─────────────────────────────────────────────");

    const metadataPointerState = getMetadataPointerState(mintInfo);
    console.log("  MetadataPointer:");
    console.log(
      "    authority:       ",
      metadataPointerState?.authority?.toBase58() ?? "null"
    );
    console.log(
      "    metadataAddress: ",
      metadataPointerState?.metadataAddress?.toBase58() ?? "null"
    );

    const permanentDelegateState = getPermanentDelegate(mintInfo);
    console.log("  PermanentDelegate:");
    console.log(
      "    delegate:        ",
      permanentDelegateState?.delegate?.toBase58() ?? "null"
    );

    const defaultAccountState = getDefaultAccountState(mintInfo);
    console.log("  DefaultAccountState:");
    console.log("    state:           ", defaultAccountState.state === AccountState.Frozen ? "Frozen" : defaultAccountState.state);

    const pausableState = getPausableConfig(mintInfo);
    console.log("  Pausable:");
    console.log(
      "    authority:       ",
      pausableState?.authority?.toBase58() ?? "null"
    );

    // ── Print token metadata ───────────────────────────────────────────────────
    const metadata = await getTokenMetadata(connection, mint);
    console.log("\n── Token Metadata ─────────────────────────────────────────");
    console.log("  mint:             ", metadata?.mint.toBase58());
    console.log(
      "  updateAuthority:  ",
      metadata?.updateAuthority?.toBase58() ?? "null"
    );
    console.log("  name:             ", metadata?.name);
    console.log("  symbol:           ", metadata?.symbol);
    console.log("  uri:              ", metadata?.uri);
    console.log(
      "  additionalMetadata:",
      metadata?.additionalMetadata ?? []
    );

    // ── Print mint owner PDA ───────────────────────────────────────────────────
    console.log("\n── Mint Owner PDA ─────────────────────────────────────────");
    console.log("  address:          ", mintOwnerPda.toBase58());
    console.log("  deployer:         ", mintOwnerAccount.deployer.toBase58());
    console.log("  bump:             ", mintOwnerAccount.bump);
    console.log("──────────────────────────────────────────────────────────\n");

    // ── Assertions: mint core ──────────────────────────────────────────────────
    assert.isTrue(mintInfo.isInitialized, "mint should be initialized");
    assert.equal(mintInfo.decimals, MINT_DECIMALS);
    assert.equal(mintInfo.supply.toString(), "0");
    assert.equal(
      mintInfo.freezeAuthority?.toBase58(),
      freezeAuthority.toBase58(),
      "freeze authority should be the locked PDA"
    );
    assert.equal(
      mintInfo.mintAuthority?.toBase58(),
      mintAuthority.toBase58(),
      "mint authority should be the external PDA"
    );

    // ── Assertions: MetadataPointer ────────────────────────────────────────────
    assert.equal(
      metadataPointerState?.metadataAddress?.toBase58(),
      mint.toBase58(),
      "metadata should point to the mint itself"
    );
    assert.isNull(
      metadataPointerState?.authority ?? null,
      "metadata pointer authority should be null (immutable)"
    );

    // ── Assertions: PermanentDelegate ─────────────────────────────────────────
    assert.equal(
      permanentDelegateState?.delegate?.toBase58(),
      permanentDelegateAuthority.toBase58(),
      "permanent delegate authority mismatch"
    );

    // ── Assertions: DefaultAccountState ───────────────────────────────────────
    assert.equal(
      defaultAccountState.state,
      AccountState.Frozen,
      "default account state should be Frozen"
    );

    // ── Assertions: Pausable ───────────────────────────────────────────────────
    assert.equal(
      pausableState?.authority?.toBase58(),
      pausableAuthority.toBase58(),
      "pausable authority mismatch"
    );

    // ── Assertions: Token metadata ─────────────────────────────────────────────
    assert.equal(metadata?.name, MINT_NAME);
    assert.equal(metadata?.symbol, MINT_SYMBOL);
    assert.equal(metadata?.uri, MINT_URI);
    assert.equal(
      metadata?.updateAuthority?.toBase58(),
      metadataUpdateAuthority.toBase58(),
      "metadata update authority mismatch"
    );
    assert.deepEqual(
      metadata?.additionalMetadata,
      [[MINT_ISIN_KEY, MINT_ISIN_VALUE]],
      "additional metadata should contain the ISIN field"
    );

    // ── Assertions: Mint owner PDA ─────────────────────────────────────────────
    assert.equal(
      mintOwnerAccount.deployer.toBase58(),
      deployer.toBase58(),
      "mint owner PDA should record the deployer"
    );
    // Verify the stored bump is consistent with the derived PDA address.
    const [, expectedBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_owner"), mint.toBuffer()],
      program.programId
    );
    assert.equal(
      mintOwnerAccount.bump,
      expectedBump,
      "stored bump should match the canonical PDA bump"
    );
  });
});
