import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_ADMIN, ROLE_ISSUER } from "./utils/roles";
import { setCoupon } from "./program_helpers/coupon/coupon_pda_helper";
import { createTokenAccount, getMint, getTokenAccount, setMintPaused } from "./program_helpers/spl_token_helper";
import { mintTokens, getIssuedEvent } from "./program_helpers/mint/mint_instruction_helper";
import {
  getHolderBalanceSnapshotAt,
  getTotalSupplySnapshotAt,
} from "./program_helpers/snapshot/snapshot_instruction_helper";
import { TRANSFER_CONTROL_WHITELIST } from "./program_helpers/transfer_control/transfer_control_instruction_helper";
import { beforeEach } from "mocha";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import {
  COUPON_CREATE_COUPON,
  DEACTIVATE_DEACTIVATE,
  MINT_MINT,
  PAUSE_PAUSE,
  TRANSFER_CONTROL_INITIALIZE,
} from "./utils/functionalities";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setTransferControlModeMarker } from "./program_helpers/transfer_control/transfer_control_pda_helper";

describe("mint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;
  const authority = provider.wallet.payer;
  const MINT_DECIMALS = 6;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint({ deployer }));
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        PAUSE_PAUSE,
        TRANSFER_CONTROL_INITIALIZE,
        COUPON_CREATE_COUPON,
        DEACTIVATE_DEACTIVATE,
        MINT_MINT,
      ],
    });
    await setRoles(mint, authority!.publicKey, [ROLE_ISSUER]);
  });

  it("mint: mints tokens to a destination account and updates balance correctly", async () => {
    const destination = await createTokenAccount({ mint, owner: deployer });
    const accountBefore = await getTokenAccount(destination);
    const balanceBefore = accountBefore.amount;
    const mintInfoBefore = await getMint(mint);
    const supplyBefore = mintInfoBefore.supply;
    const mintAmount = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);

    const signature = await mintTokens({ deployer, mint, destination, authority }, { amount: mintAmount });

    const accountAfter = await getTokenAccount(destination);
    const balanceAfter = accountAfter.amount;
    const mintInfoAfter = await getMint(mint);
    const supplyAfter = mintInfoAfter.supply;

    assert.equal(balanceBefore.toString(), "0", "destination balance should be zero before minting");
    assert.equal(balanceAfter.toString(), mintAmount.toString(), "destination balance should equal the minted amount");
    assert.equal(supplyBefore.toString(), "0", "total supply should be zero before minting");
    assert.equal(supplyAfter.toString(), mintAmount.toString(), "total supply should equal the minted amount");
    assert.isTrue(accountAfter.isFrozen, "destination account should be re-frozen after minting");

    const issued = await getIssuedEvent(signature);
    assert.isNotNull(issued, "an Issued event should be emitted");
    assert.equal(issued!.mint.toBase58(), mint.toBase58(), "event mint should match the minted mint");
    assert.equal(issued!.operator.toBase58(), authority!.publicKey.toBase58(), "event operator should be the deployer");
    assert.equal(issued!.to.toBase58(), destination.toBase58(), "event destination should match the token account");
    assert.equal(issued!.value.toString(), mintAmount.toString(), "event value should equal the minted amount");
  });

  it("mint: snapshot taken before mint records the destination balance previous to the mint and is never overwritten", async () => {
    // ── Create destination token account + mint an initial balance ────────────────────────
    const destination = await createTokenAccount({ mint, owner: deployer });
    const balanceBeforeSnapshot = new anchor.BN(5 ** MINT_DECIMALS);
    await mintTokens({ deployer, mint, destination, authority }, { amount: balanceBeforeSnapshot });

    // ── Take snapshot via a planted coupon (snapshot counter 0 → 1) ──────────
    const couponId = new anchor.BN(1);
    await setCoupon(mint, couponId);

    // ── First mint under the snapshot period — snapshot CPIs fire and record pre-mint balance ──────────
    await mintTokens({ deployer, mint, destination, authority });

    // ── Second mint under the snapshot period — snapshot CPIs must be no-ops
    await mintTokens({ deployer, mint, destination, authority });

    // ── Assert snapshot values ──────────────────────────
    // snapshot id is 0-based: coupon N triggers snapshot N-1.
    const snapshotId = couponId.sub(new anchor.BN(1));
    const totalSupplyValue = await getTotalSupplySnapshotAt({ mint }, { snapshotId });
    const holderValue = await getHolderBalanceSnapshotAt({ mint, holderTokenAccount: destination }, { snapshotId });
    assert.equal(
      totalSupplyValue.toString(),
      balanceBeforeSnapshot.toString(),
      "total supply snapshot should reflect the pre-first-mint value"
    );
    assert.equal(
      holderValue.toString(),
      balanceBeforeSnapshot.toString(),
      "holder balance snapshot should reflect the pre-first-mint value"
    );
  });

  it("mint: fails with MintPaused when mint is paused", async () => {
    const destination = await createTokenAccount({ mint, owner: deployer });
    await setMintPaused(mint, true);

    try {
      await mintTokens({ deployer, mint, destination, authority });
      assert.fail("Expected mint-is-paused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const logs = (err as SendTransactionError).logs ?? [];
      assert.isTrue(
        logs.some((log) => log.includes("paused")),
        "logs should mention paused"
      );
    }
  });

  it("mint: fails with Deactivated when mint has been deactivated", async () => {
    const destination = await createTokenAccount({ mint, owner: deployer });
    await setDeactivateMarker(mint);

    try {
      await mintTokens({ deployer, mint, destination, authority });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  it("mint: fails with MissingRole when authority does not have the issuer role", async () => {
    const destination = await createTokenAccount({ mint, owner: deployer });
    const rogueKeypair = Keypair.generate();
    await setRoles(mint, rogueKeypair.publicKey, [ROLE_ADMIN]); // rogue has admin but not issuer role

    try {
      await mintTokens({ deployer, mint, destination, authority: rogueKeypair, signers: [rogueKeypair] });
      assert.fail("Expected MissingRole error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MissingRole");
    }
  });

  it("mint: fails with NotWhitelisted when whitelist mode is active and destination is not whitelisted", async () => {
    const destination = await createTokenAccount({ mint, owner: deployer });
    await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);

    try {
      await mintTokens({ deployer, mint, destination, authority });
      assert.fail("Expected NotWhitelisted error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with FunctionalityNotSupportedError when the mint functionality is not enabled", async () => {
    const destination = await createTokenAccount({ mint, owner: deployer });

    // Re-seed the asset-class version WITHOUT the mint functionality.
    await setAssetClassVersionForMint(mint, { functionalities: [] });

    try {
      await mintTokens({ deployer, mint, destination, authority });
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
  it("mint: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
    const destination = await createTokenAccount({ mint, owner: deployer });

    // Re-seed the asset-class version WITHOUT finalizing it.
    await setAssetClassVersionForMint(mint, {
      state: ASSET_CLASS_VERSION_STATE_DRAFT,
      functionalities: [MINT_MINT],
    });

    try {
      await mintTokens({ deployer, mint, destination, authority });
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
