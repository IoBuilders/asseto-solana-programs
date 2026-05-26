import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint } from "./program_helpers/pause_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import { createCoupon } from "./program_helpers/coupon_helper";
import { createTokenAccount, getTokenAccount } from "./program_helpers/spl_token_helper";
import { mintTokens } from "./program_helpers/mint_helper";
import { burnTokens } from "./program_helpers/operations_helper";
import { getHolderBalanceSnapshotAt, getTotalSupplySnapshotAt } from "./program_helpers/snapshot_helper";
import { partiallyFreezeAccount } from "./program_helpers/freeze_helper";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
const BURN_AMOUNT = new anchor.BN(300 * 10 ** MINT_DECIMALS);

describe("operations", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: removes tokens from source via permanent delegate", async () => {
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);

    // Mint 1 000 tokens to the source account (owned by deployer wallet).
    const source = await createTokenAccount({ mint, owner: mintOwnerPda });
    await mintTokens({ deployer, mint, destination: source }, { amount: MINT_AMOUNT });

    // ── Call burn ──────────────────────────────────────────────────────
    await burnTokens({ deployer, mint, tokenAccount: source }, { amount: BURN_AMOUNT });

    const sourceAfter = (await getTokenAccount(source)).amount;
    assert.equal(
      sourceAfter.toString(),
      (MINT_AMOUNT.toNumber() - BURN_AMOUNT.toNumber()).toString(),
      "source balance should be reduced by the transfer amount"
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);

    const source = await createTokenAccount({ mint, owner: mintOwnerPda });
    await mintTokens({ deployer, mint, destination: source }, { amount: MINT_AMOUNT });

    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    try {
      await burnTokens({ deployer: rogueKeypair.publicKey, mint, tokenAccount: source, signers: [rogueKeypair] });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer", "error code should be UnauthorizedDeployer");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: fails when mint is paused", async () => {
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);

    const source = await createTokenAccount({ mint, owner: mintOwnerPda });
    await mintTokens({ deployer, mint, destination: source }, { amount: MINT_AMOUNT });
    await pauseMint({ deployer, mint });

    // The burn CPI into Token-2022 is rejected because the mint is paused.
    // This surfaces as a SendTransactionError (Token-2022 custom error 0x43),
    // not an AnchorError, because the rejection originates inside Token-2022.
    try {
      await burnTokens({ deployer, mint, tokenAccount: source });
      assert.fail("Expected mint-is-paused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const sendErr = err as SendTransactionError;
      const logs = sendErr.logs ?? [];
      assert.isTrue(
        logs.some((log) => log.includes("paused")),
        "transaction logs should mention the mint is paused"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: fails with Deactivated when mint has been deactivated", async () => {
    // ── Deploy a fresh mint ────────────────────────────────────────────────
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);

    const source = await createTokenAccount({ mint, owner: mintOwnerPda });
    await mintTokens({ deployer, mint, destination: source }, { amount: MINT_AMOUNT });

    // ── Deactivate the mint ────────────────────────────────────────────────
    await deactivateMint({ deployer, mint });

    // ── Mint must now be rejected with Deactivated ─────────────────────────
    try {
      await burnTokens({ deployer, mint, tokenAccount: source });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: snapshot taken before burn records holder balance at time of snapshot", async () => {
    const { mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS });
    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);

    // Mint MINT_AMOUNT tokens (no snapshot active yet → snapshot CPIs exit silently)
    const source = await createTokenAccount({ mint, owner: mintOwnerPda });
    await mintTokens({ deployer, mint, destination: source }, { amount: MINT_AMOUNT });

    // Take snapshot via create_coupon (counter 0 → 1); subsequent operations will record pre-op balances
    const couponId = new anchor.BN(1);
    await createCoupon({ deployer, mint }, { couponId });

    // Burn — snapshot CPI fires and records pre-burn balance (= MINT_AMOUNT)
    await burnTokens({ deployer, mint, tokenAccount: source }, { amount: BURN_AMOUNT });

    // ── Assert snapshot values via get_*_snapshot_at ──────────────────────────
    const holderValue = await getHolderBalanceSnapshotAt(
      { mint, holderTokenAccount: source },
      { snapshotId: couponId }
    );
    const totalSupplyValue = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId });

    assert.equal(
      holderValue.toString(),
      MINT_AMOUNT.toString(),
      "holder snapshot should record the balance before burning, which equals MINT_AMOUNT"
    );
    assert.equal(
      totalSupplyValue.toString(),
      MINT_AMOUNT.toString(),
      "total supply snapshot should record the total supply before burning, which equals MINT_AMOUNT"
    );
  });

  // ── coupon snapshot captures full balance, ignoring partial-freeze PDA ──
  it("burn: holder balance snapshot records full Token-2022 balance (ignoring partial-freeze PDA)", async () => {
    const { mint } = await deployMint({ deployer });
    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);

    const PARTIAL_FROZEN = new anchor.BN(400 * 10 ** MINT_DECIMALS); // 40 % locked
    // Expected unfrozen amount at snapshot time — used only as a wrong-answer guard.
    const UNFROZEN_AT_SNAPSHOT = MINT_AMOUNT.sub(PARTIAL_FROZEN); // 600 tokens

    // ── Mint 1 000 tokens (no snapshot active yet → snapshot CPIs exit silently) ──
    const source = await createTokenAccount({ mint, owner: mintOwnerPda });
    await mintTokens({ deployer, mint, destination: source }, { amount: MINT_AMOUNT });

    // ── Partially freeze 400 tokens on source ─────────────────────────────────
    await partiallyFreezeAccount({ deployer, mint, account: source }, { balance: PARTIAL_FROZEN });

    // ── Take snapshot via create_coupon (counter 0 → 1) ──────────────────────
    const couponId = new anchor.BN(1);
    await createCoupon({ deployer, mint }, { couponId });

    // ── Burn — snapshot CPI fires and records the pre-burn balance at snapshot 1 ──
    await burnTokens({ deployer, mint, tokenAccount: source }, { amount: BURN_AMOUNT });

    const holderValue = await getHolderBalanceSnapshotAt(
      { mint, holderTokenAccount: source },
      { snapshotId: couponId }
    );
    const totalSupplyValue = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId });

    // (1) Snapshot recorded the FULL balance — not adjusted by frozen_balance_pda.
    assert.equal(
      holderValue.toString(),
      MINT_AMOUNT.toString(),
      "holder snapshot at coupon-1 must record the full Token-2022 balance (frozen + unfrozen)"
    );
    assert.notEqual(
      holderValue.toString(),
      UNFROZEN_AT_SNAPSHOT.toString(),
      "holder snapshot must NOT be adjusted by frozen_balance_pda (would yield the unfrozen-only value)"
    );

    // (2) Total supply snapshot is independent of partial-freeze PDAs by definition.
    assert.equal(
      totalSupplyValue.toString(),
      MINT_AMOUNT.toString(),
      "total supply snapshot must record the full minted supply, unaffected by partial-freeze PDAs"
    );
  });
});
