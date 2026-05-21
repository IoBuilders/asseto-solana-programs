import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Pause } from "../target/types/pause";
import { Deactivate } from "../target/types/deactivate";
import { Bond } from "../target/types/bond";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import * as pdas from "./utils/pda_utils";
import { SYSTEM_PROGRAM_ID, BOND_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID } from "./utils/address_utils";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";

describe("bond", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const pauseProgram = anchor.workspace.Pause as Program<Pause>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;
  const bondProgram = anchor.workspace.Bond as Program<Bond>;

  const connection = provider.connection;
  const deployer = provider.wallet.publicKey;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
    pausableAuthority: PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    const mintOwnerPda = pdas.mintOwnerPda(mint);
    const tempMintAuthority = pdas.tempMintAuthorityPda(mint);
    const mintAuthority = pdas.mintAuthorityPda(mint);
    const permanentDelegateAuthority = pdas.permanentDelegatePda(mint);
    const metadataUpdateAuthority = pdas.metadataUpdateAuthorityPda(mint);
    const pausableAuthority = pdas.pausableAuthorityPda(mint);
    const freezeAuthority = pdas.freezeAuthorityPda(mint);
    const transferHookAuthority = pdas.transferHookAuthorityPda(mint);
    const extraAccountMetaList = pdas.extraAccountMetaListPda(mint);

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
        permanentDelegateAuthority,
        metadataUpdateAuthority,
        pausableAuthority,
        freezeAuthority,
        transferHookAuthority,
        extraAccountMetaList,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda, pausableAuthority };
  }

  // ── Helper: derive bond_terms PDA + deactivate PDA for a mint ──────────────
  function bondPdas(mint: PublicKey): { bondTerms: PublicKey; deactivatePda: PublicKey } {
    const bondTerms = pdas.bondTermsPda(mint);
    const deactivatePda = pdas.deactivatePda(mint);
    return { bondTerms, deactivatePda };
  }

  // ── Reference args used by every test ──────────────────────────────────────
  // Encodes: 5.275 % coupon, $1,000.00 par, 100-token min denomination,
  //          issued at unix 1_700_000_000, Actual/360 day-count.
  const REF_ARGS = {
    interestRate: new anchor.BN(5_275),
    interestRateDecimals: 5,
    parValue: new anchor.BN(100_000),
    parValueDecimals: 2,
    minimumDenomination: new anchor.BN(100),
    issuanceDate: new anchor.BN(1_700_000_000),
    dayCountConvention: { actual360: {} },
  };

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: creates the PDA and stores the supplied args", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const { bondTerms, deactivatePda } = bondPdas(mint);

    // PDA must not exist yet
    const before = await connection.getAccountInfo(bondTerms, "confirmed");
    assert.isNull(before, "bond_terms PDA should not exist before update");

    const tx: string = await bondProgram.methods
      .updateBondTerms(REF_ARGS)
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        bondTerms,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  update_bond_terms tx:", tx);

    // PDA must now exist and be owned by bond
    const after = await connection.getAccountInfo(bondTerms, "confirmed");
    assert.isNotNull(after, "bond_terms PDA should be created by update_bond_terms");
    assert.equal(after!.owner.toBase58(), BOND_PROGRAM_ID.toBase58(), "bond_terms PDA should be owned by bond");

    // Read the PDA directly via Anchor's IDL-driven account decoder — same
    // path other on-chain programs would use through Account<'info, BondTerms>.
    const stored = await bondProgram.account.bondTerms.fetch(bondTerms);

    console.log(
      "  stored bond_terms:",
      JSON.stringify(stored, (_, v) =>
        typeof v === "object" && v !== null && "toString" in v && v.constructor?.name === "BN" ? v.toString() : v
      )
    );

    assert.equal(stored.interestRate.toString(), REF_ARGS.interestRate.toString(), "interestRate mismatch");
    assert.equal(stored.interestRateDecimals, REF_ARGS.interestRateDecimals, "interestRateDecimals mismatch");
    assert.equal(stored.parValue.toString(), REF_ARGS.parValue.toString(), "parValue mismatch");
    assert.equal(stored.parValueDecimals, REF_ARGS.parValueDecimals, "parValueDecimals mismatch");
    assert.equal(
      stored.minimumDenomination.toString(),
      REF_ARGS.minimumDenomination.toString(),
      "minimumDenomination mismatch"
    );
    assert.equal(stored.issuanceDate.toString(), REF_ARGS.issuanceDate.toString(), "issuanceDate mismatch");
    assert.deepEqual(stored.dayCountConvention, REF_ARGS.dayCountConvention, "dayCountConvention mismatch");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();
    const { bondTerms, deactivatePda } = bondPdas(mint);

    const pauseTx: string = await pauseProgram.methods
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
      await bondProgram.methods
        .updateBondTerms(REF_ARGS)
        .accountsStrict({
          payer: deployer,
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          bondTerms,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();
    const { bondTerms, deactivatePda } = bondPdas(mint);

    const deactivateTx: string = await deactivateProgram.methods
      .deactivate()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Deactivate PDA:     ", deactivatePda.toBase58());
    console.log("  deactivate tx:      ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await bondProgram.methods
        .updateBondTerms(REF_ARGS)
        .accountsStrict({
          payer: deployer,
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          bondTerms,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
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
      await bondProgram.methods
        .updateBondTerms(REF_ARGS)
        .accountsStrict({
          payer: deployer,
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          deactivatePda,
          mint,
          bondTerms,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .signers([rogueKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer", "error code should be UnauthorizedDeployer");
    }
  });
});
