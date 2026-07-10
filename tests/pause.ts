import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getPausableConfig } from "@solana/spl-token";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import {
  getPausedEvent,
  getUnpausedEvent,
  pauseMint,
  unpauseMint,
} from "./program_helpers/pause/pause_instruction_helper";
import { pausableAuthorityPda } from "./program_helpers/pause/pause_pda_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import { getMint } from "./program_helpers/spl_token_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import { PAUSE_PAUSE, PAUSE_UNPAUSE } from "./utils/functionalities";

describe("pause", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint({ deployer }));
  });

  describe("pause", async () => {
    beforeEach(async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [PAUSE_PAUSE] });
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("correctly toggles mint pause state to paused", async () => {
      const pausableAuthority = pausableAuthorityPda(mint);

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

      // ── Pause the mint ─────────────────────────────────────────────────
      const { signature: pausedSignature } = await pauseMint({ deployer, mint });

      const mintInfoAfterPause = await getMint(mint);
      const pausableConfigAfterPause = getPausableConfig(mintInfoAfterPause);

      assert.isTrue(pausableConfigAfterPause!.paused, "mint should be paused after calling pause");

      const pausedEvent = await getPausedEvent(pausedSignature);

      assert.isNotNull(pausedEvent, "Paused event should be emitted");
      assert.equal(pausedEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(pausedEvent!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
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
        assert.equal(
          anchorErr.error.errorCode.code,
          "UnauthorizedDeployer",
          "error code should be UnauthorizedDeployer"
        );
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
    it("pause: fails with FunctionalityNotSupportedError when the pause functionality is not enabled", async () => {
      // Re-seed the asset-class version WITHOUT the pause functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await pauseMint({ deployer, mint });
        assert.fail("Expected FunctionalityNotSupportedError but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FunctionalityNotSupportedError",
          "error code should be FunctionalityNotSupportedError"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("pause: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [PAUSE_PAUSE],
      });

      try {
        await pauseMint({ deployer, mint });
        assert.fail("Expected AssetClassVersionNotFinalized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AssetClassVersionNotFinalized",
          "error code should be AssetClassVersionNotFinalized"
        );
      }
    });
  });

  describe("unpause", async () => {
    beforeEach(async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [PAUSE_PAUSE, PAUSE_UNPAUSE] });
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("correctly toggles mint pause state to unpaused", async () => {
      // ── Step 1. Pause the mint ─────────────────────────────────────────────────
      await pauseMint({ deployer, mint });

      // ── Step 2. Unpause the mint ─────────────────────────────────────────────────
      const { signature: unpausedSignature } = await unpauseMint({ deployer, mint });

      const mintInfoAfterUnpause = await getMint(mint);
      const pausableConfigAfterUnpause = getPausableConfig(mintInfoAfterUnpause);

      assert.isFalse(pausableConfigAfterUnpause!.paused, "mint should not be paused after calling unpause");

      const unpausedEvent = await getUnpausedEvent(unpausedSignature);

      assert.isNotNull(unpausedEvent, "Unpaused event should be emitted");
      assert.equal(unpausedEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(unpausedEvent!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
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
        assert.equal(
          anchorErr.error.errorCode.code,
          "UnauthorizedDeployer",
          "error code should be UnauthorizedDeployer"
        );
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

    // ────────────────────────────────────────────────────────────────────────────
    it("unpause: fails with FunctionalityNotSupportedError when the unpause functionality is not enabled", async () => {
      // Re-seed the asset-class version WITH pause but WITHOUT the unpause functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [PAUSE_PAUSE] });

      try {
        await unpauseMint({ deployer, mint });
        assert.fail("Expected FunctionalityNotSupportedError but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FunctionalityNotSupportedError",
          "error code should be FunctionalityNotSupportedError"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("unpause: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [PAUSE_PAUSE, PAUSE_UNPAUSE],
      });

      try {
        await unpauseMint({ deployer, mint });
        assert.fail("Expected AssetClassVersionNotFinalized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AssetClassVersionNotFinalized",
          "error code should be AssetClassVersionNotFinalized"
        );
      }
    });
  });
});
