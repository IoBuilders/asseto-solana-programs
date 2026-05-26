import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";
import { BOND_PROGRAM_ID } from "./utils/address_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import * as pdaUtils from "./utils/pda_utils";
import { pauseMint } from "./program_helpers/pause_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import { getCouponCounterByPda, UpdateBondArgs, updateBondTerms } from "./program_helpers/bond_helper";
import { getAccountInfo } from "./program_helpers/account_helper";

describe("bond", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

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
    const bondTermsPda = pdaUtils.bondTermsPda(mint);

    // PDA must not exist yet
    const before = await getAccountInfo(bondTermsPda);
    assert.isNull(before, "bond_terms PDA should not exist before update");

    await updateBondTerms({ deployer, mint }, updateArgs);

    // PDA must now exist and be owned by bond
    const after = await getAccountInfo(bondTermsPda);
    assert.isNotNull(after, "bond_terms PDA should be created by update_bond_terms");
    assert.equal(after!.owner.toBase58(), BOND_PROGRAM_ID.toBase58(), "bond_terms PDA should be owned by bond");

    // Read the PDA directly via Anchor's IDL-driven account decoder — same
    // path other on-chain programs would use through Account<'info, BondTerms>.
    const stored = await getCouponCounterByPda(bondTermsPda);

    assert.equal(stored.interestRate.toString(), updateArgs.interestRate.toString(), "interestRate mismatch");
    assert.equal(stored.interestRateDecimals, updateArgs.interestRateDecimals, "interestRateDecimals mismatch");
    assert.equal(stored.parValue.toString(), updateArgs.parValue.toString(), "parValue mismatch");
    assert.equal(stored.parValueDecimals, updateArgs.parValueDecimals, "parValueDecimals mismatch");
    assert.equal(
      stored.minimumDenomination.toString(),
      updateArgs.minimumDenomination.toString(),
      "minimumDenomination mismatch"
    );
    assert.equal(stored.issuanceDate.toString(), updateArgs.issuanceDate.toString(), "issuanceDate mismatch");
    assert.deepEqual(stored.dayCountConvention, updateArgs.dayCountConvention, "dayCountConvention mismatch");
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
