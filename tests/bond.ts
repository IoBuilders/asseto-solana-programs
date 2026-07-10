import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";
import { BOND_PROGRAM_ID } from "./utils/address_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint } from "./program_helpers/pause_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import {
  getBondTermsUpdatedEvent,
  UpdateBondArgs,
  updateBondTerms,
} from "./program_helpers/bond/bond_instruction_helper";
import { bondTermsPda, getBondTerms } from "./program_helpers/bond/bond_pda_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  ASSET_CLASS_VERSION_STATE_FINALIZED,
  setAssetClassVersion,
} from "./program_helpers/factory/factory_pda_helper";
import { BOND_UPDATE_BOND_TERMS } from "./utils/functionalities";
import { getAccountInfo } from "./program_helpers/account_helper";

describe("bond", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

  // `deployMint` records config 0 / version 0 on the mint_owner, so every test's
  // update_bond_terms derives the asset-class version PDA at (0, 0). Seed it here
  // — Ready and with the bond functionality enabled — so the require_functionality
  // gate passes. The account must also exist for the precondition-error tests, as
  // Anchor loads it (via the `bump = ...load()?.bump` constraint) before the
  // handler body's checks run. Tests that need it disabled re-seed it themselves.
  beforeEach(async () => {
    await setAssetClassVersion(new anchor.BN(0), new anchor.BN(0), {
      state: ASSET_CLASS_VERSION_STATE_FINALIZED,
      functionalities: [BOND_UPDATE_BOND_TERMS],
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: creates the PDA and stores the supplied args", async () => {
    const { mint } = await deployMint({ deployer });
    // ── Reference args ──────────────────────────────────────
    // Encodes: 5.275 % coupon, $1,000.00 par, 100-token min denomination,
    //          issued at unix 1_700_000_000, Actual/360 day-count.
    const updateArgs: UpdateBondArgs = {
      interestRate: new anchor.BN(5_275),
      interestRateDecimals: 5,
      parValue: new anchor.BN(100_000),
      parValueDecimals: 2,
      minimumDenomination: new anchor.BN(100),
      issuanceDate: new anchor.BN(1_700_000_000),
      dayCountConvention: { actual360: {} },
    };
    const bondPda = bondTermsPda(mint);

    // PDA must not exist yet
    const before = await getAccountInfo(bondPda);
    assert.isNull(before, "bond_terms PDA should not exist before update");

    const { signature } = await updateBondTerms({ deployer, mint }, updateArgs);

    // PDA must now exist and be owned by bond
    const after = await getAccountInfo(bondPda);
    assert.isNotNull(after, "bond_terms PDA should be created by update_bond_terms");
    assert.equal(after!.owner.toBase58(), BOND_PROGRAM_ID.toBase58(), "bond_terms PDA should be owned by bond");

    // Read the PDA directly via Anchor's IDL-driven account decoder — same
    // path other on-chain programs would use through Account<'info, BondTerms>.
    const stored = await getBondTerms(mint);

    assert.equal(stored.interestRate.toString(), updateArgs.interestRate?.toString(), "interestRate mismatch");
    assert.equal(stored.interestRateDecimals, updateArgs.interestRateDecimals, "interestRateDecimals mismatch");
    assert.equal(stored.parValue.toString(), updateArgs.parValue?.toString(), "parValue mismatch");
    assert.equal(stored.parValueDecimals, updateArgs.parValueDecimals, "parValueDecimals mismatch");
    assert.equal(
      stored.minimumDenomination.toString(),
      updateArgs.minimumDenomination?.toString(),
      "minimumDenomination mismatch"
    );
    assert.equal(stored.issuanceDate.toString(), updateArgs.issuanceDate?.toString(), "issuanceDate mismatch");
    assert.deepEqual(stored.dayCountConvention, updateArgs.dayCountConvention, "dayCountConvention mismatch");

    const updatedEvent = await getBondTermsUpdatedEvent(signature);

    assert.isNotNull(updatedEvent, "BondTermsUpdated event should be emitted");
    assert.equal(updatedEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
    assert.equal(updatedEvent!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
    assert.equal(
      updatedEvent!.interestRate.toString(),
      updateArgs.interestRate?.toString(),
      "event interestRate mismatch"
    );
    assert.equal(
      updatedEvent!.interestRateDecimals,
      updateArgs.interestRateDecimals,
      "event interestRateDecimals mismatch"
    );
    assert.equal(updatedEvent!.parValue.toString(), updateArgs.parValue?.toString(), "event parValue mismatch");
    assert.equal(updatedEvent!.parValueDecimals, updateArgs.parValueDecimals, "event parValueDecimals mismatch");
    assert.equal(
      updatedEvent!.minimumDenomination.toString(),
      updateArgs.minimumDenomination?.toString(),
      "event minimumDenomination mismatch"
    );
    assert.equal(
      updatedEvent!.issuanceDate.toString(),
      updateArgs.issuanceDate?.toString(),
      "event issuanceDate mismatch"
    );
    assert.deepEqual(
      updatedEvent!.dayCountConvention,
      updateArgs.dayCountConvention,
      "event dayCountConvention mismatch"
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: fails with FunctionalityNotSupportedError when the bond functionality is not enabled", async () => {
    const { mint } = await deployMint({ deployer });
    // Re-seed the asset-class version WITHOUT the bond functionality.
    await setAssetClassVersion(new anchor.BN(0), new anchor.BN(0), {
      state: ASSET_CLASS_VERSION_STATE_FINALIZED,
      functionalities: [],
    });

    try {
      await updateBondTerms({ deployer, mint });
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
  it("update_bond_terms: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
    const { mint } = await deployMint({ deployer });
    // Re-seed the asset-class version WITHOUT finalizing it.
    await setAssetClassVersion(new anchor.BN(0), new anchor.BN(0), {
      state: ASSET_CLASS_VERSION_STATE_DRAFT,
      functionalities: [BOND_UPDATE_BOND_TERMS],
    });

    try {
      await updateBondTerms({ deployer, mint });
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
  it("update_bond_terms: fails with MintPaused when mint is paused", async () => {
    const { mint } = await deployMint({ deployer });
    await pauseMint({ deployer, mint });

    try {
      await updateBondTerms({ deployer, mint });
      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: fails with Deactivated when mint has been deactivated", async () => {
    const { mint } = await deployMint({ deployer });
    await deactivateMint({ deployer, mint });

    try {
      await updateBondTerms({ deployer, mint });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("update_bond_terms: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint } = await deployMint({ deployer });
    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    try {
      await updateBondTerms({ payer: deployer, deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] });

      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer", "error code should be UnauthorizedDeployer");
    }
  });
});
