import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint } from "./program_helpers/pause_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import { createCoupon } from "./program_helpers/coupon_helper";
import { createTokenAccount, getMint, getTokenAccount } from "./program_helpers/spl_token_helper";
import { mintTokens, getIssuedEvent } from "./program_helpers/mint_helper";
import { getHolderBalanceSnapshotAt, getTotalSupplySnapshotAt } from "./program_helpers/snapshot_helper";
import { setTransferControlModes, TRANSFER_CONTROL_WHITELIST } from "./program_helpers/transfer_control_helper";

const MINT_DECIMALS = 6;

describe("mint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

  it("mint: mints tokens to a destination account and updates balance correctly", async () => {
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const destination = await createTokenAccount({ mint, owner: deployer });
    const accountBefore = await getTokenAccount(destination);
    const balanceBefore = accountBefore.amount;
    const mintInfoBefore = await getMint(mint);
    const supplyBefore = mintInfoBefore.supply;
    const mintAmount = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);

    const signature = await mintTokens({ deployer, mint, destination }, { amount: mintAmount });

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
    assert.equal(issued!.operator.toBase58(), deployer.toBase58(), "event operator should be the deployer");
    assert.equal(issued!.to.toBase58(), destination.toBase58(), "event destination should match the token account");
    assert.equal(issued!.value.toString(), mintAmount.toString(), "event value should equal the minted amount");
  });

  it("mint: snapshot taken before mint records the destination balance previous to the mint and is never overwritten", async () => {
    // ── Deploy mint + create destination token account + mint an initial balance ────────────────────────
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const destination = await createTokenAccount({ mint, owner: deployer });
    const balanceBeforeSnapshot = new anchor.BN(5 ** MINT_DECIMALS);
    await mintTokens({ deployer, mint, destination }, { amount: balanceBeforeSnapshot });

    // ── Take snapshot via create_coupon (counter 0 → 1) ──────────────────────
    const couponId = new anchor.BN(1);
    await createCoupon({ deployer, mint }, { couponId });

    // ── First mint under the snapshot period — snapshot CPIs fire and record pre-mint balance ──────────
    await mintTokens({ deployer, mint, destination });

    // ── Second mint under the snapshot period — snapshot CPIs must be no-ops
    await mintTokens({ deployer, mint, destination });

    // ── Assert snapshot values ──────────────────────────
    const totalSupplyValue = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId });
    const holderValue = await getHolderBalanceSnapshotAt(
      { mint, holderTokenAccount: destination },
      { snapshotId: couponId }
    );
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
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const destination = await createTokenAccount({ mint, owner: deployer });
    await pauseMint({ deployer, mint });

    try {
      await mintTokens({ deployer, mint, destination });
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
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const destination = await createTokenAccount({ mint, owner: deployer });
    await deactivateMint({ deployer, mint });

    try {
      await mintTokens({ deployer, mint, destination });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  it("mint: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const destination = await createTokenAccount({ mint, owner: deployer });
    const rogueKeypair = Keypair.generate();

    try {
      await mintTokens({ deployer: rogueKeypair.publicKey, mint, destination, signers: [rogueKeypair] });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  it("mint: fails with NotWhitelisted when whitelist mode is active and destination is not whitelisted", async () => {
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const destination = await createTokenAccount({ mint, owner: deployer });
    await setTransferControlModes({ deployer, mint }, { modes: [TRANSFER_CONTROL_WHITELIST] });

    try {
      await mintTokens({ deployer, mint, destination });
      assert.fail("Expected NotWhitelisted error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted");
    }
  });
});
