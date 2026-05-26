import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { deactivateMint, getDeactivatePda } from "./program_helpers/deactivate_helper";
import { requestAirdrop } from "./program_helpers/account_helper";

describe("deactivate", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

  // ── Happy-path test ──────────────────────────────────────────────────────────
  it("deactivate: creates the deactivate PDA for the mint", async () => {
    const { mint } = await deployMint({ deployer });

    // ── Verify the deactivate PDA was created and stores the correct bump ─────
    const [deactivatePda, expectedBump] = pdaUtils.deactivatePdaWithBump(mint);
    const deactivateStatusBefore = await getDeactivatePda(deactivatePda);

    // ── Call the deactivate instruction ───────────────────────────────────────
    await deactivateMint({ deployer, mint });

    // ── Verify the deactivate PDA was created and stores the correct bump ─────
    const deactivateStatusAfter = await getDeactivatePda(deactivatePda);

    assert.isNull(deactivateStatusBefore, "deactivate PDA should not exist before calling deactivate");
    assert.isNotNull(deactivateStatusAfter, "deactivate PDA should exist after calling deactivate");
    assert.equal(deactivateStatusAfter.bump, expectedBump, "deactivate PDA bump should match the canonical bump");
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
});
