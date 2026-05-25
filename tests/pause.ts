import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Pause } from "../target/types/pause";
import { Deactivate } from "../target/types/deactivate";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint, getPausableConfig } from "@solana/spl-token";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { SYSTEM_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID } from "./utils/address_utils";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";

describe("pause", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const pauseProgram = anchor.workspace.Pause as Program<Pause>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;

  const connection = provider.connection;
  const deployer = provider.wallet.publicKey;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
    mintAuthority: PublicKey;
    freezeAuthority: PublicKey;
    pausableAuthority: PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);
    const tempMintAuthority = pdaUtils.tempMintAuthorityPda(mint);
    const mintAuthority = pdaUtils.mintAuthorityPda(mint);
    const operationsAuthority = pdaUtils.permanentDelegatePda(mint);
    const metadataUpdateAuthority = pdaUtils.metadataUpdateAuthorityPda(mint);
    const pausableAuthority = pdaUtils.pausableAuthorityPda(mint);
    const freezeAuthority = pdaUtils.freezeAuthorityPda(mint);
    const transferHookAuthority = pdaUtils.transferHookAuthorityPda(mint);
    const extraAccountMetaList = pdaUtils.extraAccountMetaListPda(mint);

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
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda, mintAuthority, freezeAuthority, pausableAuthority };
  }

  // ── Happy-path test ──────────────────────────────────────────────────────────
  it("pause → unpause: correctly toggles mint pause state", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();
    const deactivatePda = pdaUtils.deactivatePda(mint);

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
      "pause authority should be the pause PDA"
    );
    assert.isFalse(pausableConfigInitial!.paused, "mint should not be paused after deployment");

    // ── Step 1: Pause the mint ─────────────────────────────────────────────────
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
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
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
  it("pause: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();
    const deactivatePda = pdaUtils.deactivatePda(mint);

    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await pauseProgram.methods
        .pause()
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          deactivatePda,
          mint,
          pausableAuthority,
          token2022Program: TOKEN_2022_PROGRAM_ID,
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

  // ────────────────────────────────────────────────────────────────────────────
  it("pause: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();

    const deactivatePda = pdaUtils.deactivatePda(mint);

    // ── Deactivate the mint ────────────────────────────────────────────────
    const deactivateTx = await deactivateProgram.methods
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

    // ── Mint must now be rejected with Deactivated ─────────────────────────
    try {
      await pauseProgram.methods
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
  it("unpause: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();
    const deactivatePda = pdaUtils.deactivatePda(mint);

    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await pauseProgram.methods
        .unpause()
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          deactivatePda,
          mint,
          pausableAuthority,
          token2022Program: TOKEN_2022_PROGRAM_ID,
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

  // ────────────────────────────────────────────────────────────────────────────
  it("unpause: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda, pausableAuthority } = await deployMint();
    const deactivatePda = pdaUtils.deactivatePda(mint);

    // ── Deactivate the mint ────────────────────────────────────────────────
    const deactivateTx = await deactivateProgram.methods
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

    // ── Unpause must now be rejected with Deactivated ──────────────────────
    try {
      await pauseProgram.methods
        .unpause()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          deactivatePda,
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
      assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
    }
  });
});
