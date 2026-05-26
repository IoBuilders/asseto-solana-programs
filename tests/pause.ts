import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { getPausableConfig } from "@solana/spl-token";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint, unpauseMint } from "./program_helpers/pause_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import { getMint } from "./program_helpers/spl_token_helper";

describe("pause", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

  // ── Happy-path test ──────────────────────────────────────────────────────────
  it("pause → unpause: correctly toggles mint pause state", async () => {
    const { mint } = await deployMint({ deployer });
    const pausableAuthority = pdaUtils.pausableAuthorityPda(mint);

    // ── Baseline: mint should NOT be paused after deployment ──────────────────
    const mintInfoInitial = await getMint(mint);
    const pausableConfigInitial = getPausableConfig(mintInfoInitial);

    assert.isNotNull(pausableConfigInitial, "pausable extension should be present on the mint");
    assert.equal(
      pausableConfigInitial!.authority.toBase58(),
      pausableAuthority.toBase58(),
      "pause authority should be the pause PDA"
    );
    assert.isFalse(pausableConfigInitial!.paused, "mint should not be paused after deployment");

    // ── Step 1: Pause the mint ─────────────────────────────────────────────────
    await pauseMint({ deployer, mint });

    const mintInfoAfterPause = await getMint(mint);
    const pausableConfigAfterPause = getPausableConfig(mintInfoAfterPause);

    assert.isTrue(pausableConfigAfterPause!.paused, "mint should be paused after calling pause");

    // ── Step 2: Unpause the mint ───────────────────────────────────────────────
    await unpauseMint({ deployer, mint });

    const mintInfoAfterUnpause = await getMint(mint);
    const pausableConfigAfterUnpause = getPausableConfig(mintInfoAfterUnpause);

    assert.isFalse(pausableConfigAfterUnpause!.paused, "mint should not be paused after calling unpause");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("pause: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint } = await deployMint({ deployer });
    const rogueKeypair = Keypair.generate();

    try {
      await pauseMint({ deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer", "error code should be UnauthorizedDeployer");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("pause: fails with Deactivated when mint has been deactivated", async () => {
    const { mint } = await deployMint({ deployer });
    await deactivateMint({ deployer, mint });

    try {
      await pauseMint({ deployer, mint });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("unpause: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint } = await deployMint({ deployer });
    const rogueKeypair = Keypair.generate();

    try {
      await pauseMint({ deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer", "error code should be UnauthorizedDeployer");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("unpause: fails with Deactivated when mint has been deactivated", async () => {
    const { mint } = await deployMint({ deployer });
    await deactivateMint({ deployer, mint });

    try {
      await unpauseMint({ deployer, mint });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
    }
  });
});
