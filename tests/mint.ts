import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint } from "./program_helpers/pause_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import { createCoupon } from "./program_helpers/coupon_helper";
import { createTokenAccount, getMint, getTokenAccount } from "./program_helpers/spl_token_helper";
import { mintTokens } from "./program_helpers/mint_helper";
import { getHolderBalanceSnapshotAt, getTotalSupplySnapshotAt } from "./program_helpers/snapshot_helper";
import { setTransferControlModes, TRANSFER_CONTROL_WHITELIST } from "./program_helpers/transfer_control_helper";

const MINT_DECIMALS = 6;
const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);

describe("mint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: mints tokens to a destination account and updates balance correctly", async () => {
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const destination = await createTokenAccount({ mint, owner: deployer });
    const accountBefore = await getTokenAccount(destination);
    const balanceBefore = accountBefore.amount;
    const mintInfoBefore = await getMint(mint);
    const supplyBefore = mintInfoBefore.supply;

    await mintTokens({ deployer, mint, destination }, { amount: MINT_AMOUNT });

    const accountAfter = await getTokenAccount(destination);
    const balanceAfter = accountAfter.amount;
    const mintInfoAfter = await getMint(mint);
    const supplyAfter = mintInfoAfter.supply;

    assert.equal(balanceBefore.toString(), "0", "destination balance should be zero before minting");
    assert.equal(balanceAfter.toString(), MINT_AMOUNT.toString(), "destination balance should equal the minted amount");
    assert.equal(supplyBefore.toString(), "0", "total supply should be zero before minting");
    assert.equal(supplyAfter.toString(), MINT_AMOUNT.toString(), "total supply should equal the minted amount");
    assert.isTrue(accountAfter.isFrozen, "destination account should be re-frozen after minting");
  });

  // ────────────────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────────────────
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

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: snapshot taken before mint records destination balance of 0", async () => {
    // ── Deploy mint + create destination token account ────────────────────────
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });

    const destination = await createTokenAccount({ mint, owner: deployer });

    // ── Take snapshot via create_coupon (counter 0 → 1) ──────────────────────
    const couponId = new anchor.BN(1);
    await createCoupon({ deployer, mint }, { couponId });

    // ── Mint tokens — snapshot CPIs fire and record pre-mint balance (= 0) ───
    await mintTokens({ deployer, mint, destination });

    // ── Assert snapshot values via get_*_snapshot_at ──────────────────────────
    const totalSupplyValue = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId });
    const holderValue = await getHolderBalanceSnapshotAt(
      { mint, holderTokenAccount: destination },
      { snapshotId: couponId }
    );

    assert.equal(holderValue.toString(), "0", "holder snapshot should record the balance before minting, which is 0");
    assert.equal(
      totalSupplyValue.toString(),
      "0",
      "total supply snapshot should record the balance before minting, which is 0"
    );
  });
});
