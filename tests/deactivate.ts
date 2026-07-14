import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { deactivateMint, getDeactivatedEvent } from "./program_helpers/deactivate/deactivate_instruction_helper";
import * as deactivatePdaUtils from "./program_helpers/deactivate/deactivate_pda_helper";
import { getDeactivatePda } from "./program_helpers/deactivate/deactivate_pda_helper";
import { requestAirdrop } from "./program_helpers/account_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import { DEACTIVATE_DEACTIVATE } from "./utils/functionalities";

describe("deactivate", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint({ deployer }));
    await setAssetClassVersionForMint(mint, { functionalities: [DEACTIVATE_DEACTIVATE] });
  });

  describe("deactivate", () => {
    // ── Happy-path test ──────────────────────────────────────────────────────────
    it("deactivate: creates the deactivate PDA for the mint", async () => {
      // ── Verify the deactivate PDA was created and stores the correct bump ─────
      const [deactivatePda, expectedBump] = deactivatePdaUtils.deactivatePdaWithBump(mint);
      const deactivateStatusBefore = await getDeactivatePda(deactivatePda);

      // ── Call the deactivate instruction ───────────────────────────────────────
      const { signature } = await deactivateMint({ deployer, mint });

      // ── Verify the deactivate PDA was created and stores the correct bump ─────
      const deactivateStatusAfter = await getDeactivatePda(deactivatePda);

      assert.isNull(deactivateStatusBefore, "deactivate PDA should not exist before calling deactivate");
      assert.isNotNull(deactivateStatusAfter, "deactivate PDA should exist after calling deactivate");
      assert.equal(deactivateStatusAfter.bump, expectedBump, "deactivate PDA bump should match the canonical bump");

      const event = await getDeactivatedEvent(signature);

      assert.isNotNull(event, "Deactivated event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
    });

    // ── Error case: deactivate — UnauthorizedDeployer ──
    it("deactivate: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const { mint } = await deployMint({ deployer });
      const rogueKeypair = Keypair.generate();
      await requestAirdrop(rogueKeypair.publicKey);

      // ── Call the deactivate instruction ───────────────────────────────────────
      try {
        await deactivateMint({ deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] });

        assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("deactivate: fails with FunctionalityNotSupportedError when the deactivate functionality is not enabled", async () => {
      // Re-seed the asset-class version WITHOUT the deactivate functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await deactivateMint({ deployer, mint });
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
    it("deactivate: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [DEACTIVATE_DEACTIVATE],
      });

      try {
        await deactivateMint({ deployer, mint });
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
