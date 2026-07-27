import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { CAP_PROGRAM_ID } from "./utils/address_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_CAP } from "./utils/roles";
import { getMaxSupplySetEvent, setMaxSupply } from "./program_helpers/cap/cap_instruction_helper";
import {
  getMaxSupply,
  maxSupplyPda,
  maxSupplyPdaWithBump,
  setMaxSupplyPda,
} from "./program_helpers/cap/cap_pda_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import { CAP_MAX_SUPPLY } from "./utils/functionalities";
import { getAccountInfo } from "./program_helpers/account_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { createTokenAccount, mintTokensViaSurfpool, setMintPaused } from "./program_helpers/spl_token_helper";

describe("cap", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const authority = provider.wallet.payer;
  let mint: PublicKey;

  // `deployMint` records config 0 / version 0 on the asset_configuration, so every test's
  // set_max_supply derives the asset-class version PDA at (0, 0). Seed it here
  // — Ready and with the cap functionality enabled — so the require_functionality
  // gate passes. The account must also exist for the precondition-error tests, as
  // Anchor loads it (via the `bump = ...load()?.bump` constraint) before the
  // handler body's checks run. Tests that need it disabled re-seed it themselves.
  beforeEach(async () => {
    ({ mint } = await deployMint());
    await setAssetClassVersionForMint(mint, { functionalities: [CAP_MAX_SUPPLY] });
    await setRoles(mint, authority.publicKey, [ROLE_CAP]);
  });

  describe("set_max_supply", async () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("set_max_supply: creates the PDA and stores the supplied max supply", async () => {
      const maxSupply = new anchor.BN(5_000_000);
      const capPda = maxSupplyPda(mint);

      // PDA must not exist yet
      const before = await getAccountInfo(capPda);
      assert.isNull(before, "max_supply PDA should not exist before set_max_supply");

      const { signature } = await setMaxSupply({ authority, mint }, { maxSupply });

      // PDA must now exist and be owned by cap
      const after = await getAccountInfo(capPda);
      assert.isNotNull(after, "max_supply PDA should be created by set_max_supply");
      assert.equal(after!.owner.toBase58(), CAP_PROGRAM_ID.toBase58(), "max_supply PDA should be owned by cap");

      // Read the PDA directly via Anchor's IDL-driven account decoder — same
      // path other on-chain programs would use through Account<'info, MaxSupply>.
      const stored = await getMaxSupply(mint);
      assert.equal(stored.maxSupply.toString(), maxSupply.toString(), "maxSupply mismatch");
      assert.equal(stored.bump, maxSupplyPdaWithBump(mint)[1], "bump mismatch");

      const setEvent = await getMaxSupplySetEvent(signature);

      assert.isNotNull(setEvent, "MaxSupplySet event should be emitted");
      assert.equal(setEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(
        setEvent!.operator.toBase58(),
        authority.publicKey.toBase58(),
        "event operator should match the authority"
      );
      assert.equal(setEvent!.maxSupply.toString(), maxSupply.toString(), "event maxSupply mismatch");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_max_supply: overwrites the stored value on a second call", async () => {
      await setMaxSupplyPda(mint, new anchor.BN(5_000_000));

      const updated = new anchor.BN(9_000_000);
      await setMaxSupply({ authority, mint }, { maxSupply: updated });

      const stored = await getMaxSupply(mint);
      assert.equal(stored.maxSupply.toString(), updated.toString(), "maxSupply should be overwritten");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_max_supply: accepts a max supply equal to the current total supply", async () => {
      const supply = new anchor.BN(1_500);
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await mintTokensViaSurfpool(mint, tokenAccount, supply);

      await setMaxSupply({ authority, mint }, { maxSupply: supply });

      const stored = await getMaxSupply(mint);
      assert.equal(stored.maxSupply.toString(), supply.toString(), "maxSupply should equal the total supply");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_max_supply: fails with MaxSupplyTooLow when max supply is zero", async () => {
      try {
        await setMaxSupply({ authority, mint }, { maxSupply: new anchor.BN(0) });
        assert.fail("Expected MaxSupplyTooLow error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MaxSupplyTooLow", "error code should be MaxSupplyTooLow");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_max_supply: fails with MaxSupplyBelowTotalSupply when max supply is below the minted supply", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      const supply = new anchor.BN(1_000);

      await mintTokensViaSurfpool(mint, tokenAccount, supply);

      try {
        await setMaxSupply({ authority, mint }, { maxSupply: supply.sub(new anchor.BN(1)) });
        assert.fail("Expected MaxSupplyBelowTotalSupply error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "MaxSupplyBelowTotalSupply",
          "error code should be MaxSupplyBelowTotalSupply"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_max_supply: fails with FunctionalityNotSupportedError when the cap functionality is not enabled", async () => {
      // Re-seed the asset-class version WITHOUT the cap functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await setMaxSupply({ authority, mint });
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
    it("set_max_supply: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [CAP_MAX_SUPPLY],
      });

      try {
        await setMaxSupply({ authority, mint });
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

    // ────────────────────────────────────────────────────────────────────────────
    it("set_max_supply: fails with MintPaused when mint is paused", async () => {
      await setMintPaused(mint, true);

      try {
        await setMaxSupply({ authority, mint });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_max_supply: fails with Deactivated when mint has been deactivated", async () => {
      await setDeactivateMarker(mint);

      try {
        await setMaxSupply({ authority, mint });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("set_max_supply: fails with MissingRole when authority doesn't have required role", async () => {
      await setRoles(mint, authority.publicKey, []);

      try {
        await setMaxSupply({ authority, mint });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole");
      }
    });
  });
});
