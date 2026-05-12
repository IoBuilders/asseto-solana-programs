import * as anchor from "@coral-xyz/anchor";
import { AnchorError, Program } from "@coral-xyz/anchor";
import { Deploy } from "../target/types/deploy";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME     = "CMTAT Test Token";
const MINT_SYMBOL   = "CMTAT";
const MINT_URI      = "https://example.com/metadata.json";

describe("bond", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram         = anchor.workspace.Deploy         as Program<Deploy>;
  const mintProgram           = anchor.workspace.Mint           as Program<any>;
  const metadataProgram       = anchor.workspace.MetadataUpdate as Program<any>;
  const freezeProgram         = anchor.workspace.Freeze         as Program<any>;
  const operationsProgram     = anchor.workspace.Operations     as Program<any>;
  const pauseProgram          = anchor.workspace.Pause          as Program<any>;
  const deactivateProgram     = anchor.workspace.Deactivate     as Program<any>;
  const transferHookProgram   = anchor.workspace.TransferHook   as Program<any>;
  const bondProgram           = anchor.workspace.Bond           as Program<any>;

  const connection = provider.connection;
  const deployer   = provider.wallet.publicKey;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint:               PublicKey;
    mintOwnerPda:       PublicKey;
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
      mintProgram.programId
    );
    const [permanentDelegateAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("permanent_delegate"), mint.toBuffer()],
      operationsProgram.programId
    );
    const [metadataUpdateAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata_update_authority"), mint.toBuffer()],
      metadataProgram.programId
    );
    const [pausableAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("pausable_authority"), mint.toBuffer()],
      pauseProgram.programId
    );
    const [freezeAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("freeze_authority"), mint.toBuffer()],
      freezeProgram.programId
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
        transferHookProgram: transferHookProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram:    anchor.web3.SystemProgram.programId,
        rent:             SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda, pausableAuthority };
  }

  // ── Helper: derive bond_terms PDA + deactivate PDA for a mint ──────────────
  function bondPdas(mint: PublicKey): { bondTerms: PublicKey; deactivatePda: PublicKey } {
    const [bondTerms] = PublicKey.findProgramAddressSync(
      [Buffer.from("bond_terms"), mint.toBuffer()],
      bondProgram.programId
    );
    const [deactivatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("deactivate"), mint.toBuffer()],
      deactivateProgram.programId
    );
    return { bondTerms, deactivatePda };
  }

  // ── Reference args used by every test ──────────────────────────────────────
  // Encodes: 5.275 % coupon, $1,000.00 par, 100-token min denomination,
  //          issued at unix 1_700_000_000, Actual/360 day-count.
  const REF_ARGS = {
    interestRate:         new anchor.BN(5_275),
    interestRateDecimals: 5,
    parValue:             new anchor.BN(100_000),
    parValueDecimals:     2,
    minimumDenomination:  new anchor.BN(100),
    issuanceDate:         new anchor.BN(1_700_000_000),
    dayCountConvention:   { actual360: {} },
  };

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: creates the PDA and stores the supplied args", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const { bondTerms, deactivatePda } = bondPdas(mint);

    // PDA must not exist yet
    const before = await connection.getAccountInfo(bondTerms, "confirmed");
    assert.isNull(before, "bond_terms PDA should not exist before update");

    const tx: string = await (bondProgram as any).methods
      .updateBondTerms(REF_ARGS)
      .accounts({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        bondTerms,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  update_bond_terms tx:", tx);

    // PDA must now exist and be owned by bond
    const after = await connection.getAccountInfo(bondTerms, "confirmed");
    assert.isNotNull(after, "bond_terms PDA should be created by update_bond_terms");
    assert.equal(
      after!.owner.toBase58(),
      bondProgram.programId.toBase58(),
      "bond_terms PDA should be owned by bond"
    );

    // Read the PDA directly via Anchor's IDL-driven account decoder — same
    // path other on-chain programs would use through Account<'info, BondTerms>.
    const stored = await (bondProgram as any).account.bondTerms.fetch(bondTerms);

    console.log("  stored bond_terms:", JSON.stringify(stored, (_, v) =>
      typeof v === "object" && v !== null && "toString" in v && v.constructor?.name === "BN"
        ? v.toString()
        : v
    ));

    assert.equal(
      stored.interestRate.toString(),
      REF_ARGS.interestRate.toString(),
      "interestRate mismatch",
    );
    assert.equal(
      stored.interestRateDecimals,
      REF_ARGS.interestRateDecimals,
      "interestRateDecimals mismatch",
    );
    assert.equal(
      stored.parValue.toString(),
      REF_ARGS.parValue.toString(),
      "parValue mismatch",
    );
    assert.equal(
      stored.parValueDecimals,
      REF_ARGS.parValueDecimals,
      "parValueDecimals mismatch",
    );
    assert.equal(
      stored.minimumDenomination.toString(),
      REF_ARGS.minimumDenomination.toString(),
      "minimumDenomination mismatch",
    );
    assert.equal(
      stored.issuanceDate.toString(),
      REF_ARGS.issuanceDate.toString(),
      "issuanceDate mismatch",
    );
    assert.deepEqual(
      stored.dayCountConvention,
      REF_ARGS.dayCountConvention,
      "dayCountConvention mismatch",
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();
    const { bondTerms, deactivatePda } = bondPdas(mint);

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
      await (bondProgram as any).methods
        .updateBondTerms(REF_ARGS)
        .accounts({
          payer: deployer,
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          bondTerms,
          systemProgram: anchor.web3.SystemProgram.programId,
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
        "error code should be MintPaused",
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const { bondTerms, deactivatePda } = bondPdas(mint);

    const deactivateTx: string = await (deactivateProgram as any).methods
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
      await (bondProgram as any).methods
        .updateBondTerms(REF_ARGS)
        .accounts({
          payer: deployer,
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          bondTerms,
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
        "error code should be Deactivated",
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const { bondTerms, deactivatePda } = bondPdas(mint);

    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await (bondProgram as any).methods
        .updateBondTerms(REF_ARGS)
        .accounts({
          payer:           deployer,
          deployer:        rogueKeypair.publicKey,
          mintOwnerPda,
          deactivatePda,
          mint,
          bondTerms,
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
        "error code should be UnauthorizedDeployer",
      );
    }
  });
});
