import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint } from "./program_helpers/pause/pause_instruction_helper";
import { deactivateMint } from "./program_helpers/deactivate/deactivate_instruction_helper";
import { createCoupon } from "./program_helpers/coupon/coupon_instruction_helper";
import { createTokenAccount, getTokenAccount } from "./program_helpers/spl_token_helper";
import { mintTokens } from "./program_helpers/mint_helper";
import { burnTokens, getControllerRedemptionEvent } from "./program_helpers/burn/burn_instruction_helper";
import { getHolderBalanceSnapshotAt, getTotalSupplySnapshotAt } from "./program_helpers/snapshot_helper";
import { partiallyFreezeAccount } from "./program_helpers/freeze_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import { COUPON_CREATE_COUPON, DEACTIVATE_DEACTIVATE, OPERATIONS_BURN, PAUSE_PAUSE } from "./utils/functionalities";
import { beforeEach } from "mocha";

describe("operations", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

  describe("burn ", async () => {
    let mint: PublicKey;
    let mintOwnerPda: PublicKey;
    const MINT_DECIMALS = 6;

    beforeEach(async () => {
      ({ mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS }));
      mintOwnerPda = pdaUtils.mintOwnerPda(mint);
      await setAssetClassVersionForMint(mint, {
        functionalities: [PAUSE_PAUSE, OPERATIONS_BURN, COUPON_CREATE_COUPON, DEACTIVATE_DEACTIVATE],
      });
    });

    it("burn: removes tokens from the token account via permanent delegate", async () => {
      const mintAmount = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
      const burnAmount = new anchor.BN(100 * 10 ** MINT_DECIMALS);

      // Mint 1 000 tokens to the source account (owned by deployer wallet).
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokens({ deployer, mint, destination: source }, { amount: mintAmount });

      // ── Call burn ──────────────────────────────────────────────────────
      const { signature } = await burnTokens({ deployer, mint, tokenAccount: source }, { amount: burnAmount });

      const sourceAfter = (await getTokenAccount(source)).amount;
      assert.equal(
        sourceAfter.toString(),
        (mintAmount.toNumber() - burnAmount.toNumber()).toString(),
        "source balance should be reduced by the transfer amount"
      );

      // ── Assertions: ControllerRedemption event ─────────────────────────────────
      const event = await getControllerRedemptionEvent(signature);
      assert.isNotNull(event, "ControllerRedemption event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the burned mint");
      assert.equal(event!.controller.toBase58(), deployer.toBase58(), "controller should be the deployer");
      assert.equal(event!.from.toBase58(), source.toBase58(), "from should be the burned token account");
      assert.equal(event!.value.toString(), burnAmount.toString(), "value should match the burn amount");
    });

    it("burn: holder balance snapshot records full Token-2022 balance (ignoring partial-freeze PDA)", async () => {
      const mintAmount = new anchor.BN(10 ** MINT_DECIMALS);
      const burnAmount = new anchor.BN(3 ** MINT_DECIMALS);
      const partialFrozenAmount = new anchor.BN(5 ** MINT_DECIMALS);

      // ── Mint 1 000 tokens (no snapshot active yet → snapshot CPIs exit silently) ──
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokens({ deployer, mint, destination: source }, { amount: mintAmount });

      // ── Partially freeze 400 tokens on source ─────────────────────────────────
      await partiallyFreezeAccount({ deployer, mint, account: source }, { balance: partialFrozenAmount });

      // ── Take snapshot via create_coupon (counter 0 → 1) ──────────────────────
      const couponId = new anchor.BN(1);
      await createCoupon({ deployer, mint }, { couponId });

      // ── Burn — snapshot CPI fires and records the pre-burn balance at snapshot 1 ──
      await burnTokens({ deployer, mint, tokenAccount: source }, { amount: burnAmount });

      const holderValue = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: source },
        { snapshotId: couponId }
      );
      const totalSupplyValue = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId });

      // (1) Snapshot recorded the FULL balance — not adjusted by frozen_balance_pda.
      assert.equal(
        holderValue.toString(),
        mintAmount.toString(),
        "holder snapshot at coupon-1 must record the full Token-2022 balance (frozen + unfrozen)"
      );

      // (2) Total supply snapshot is independent of partial-freeze PDAs by definition.
      assert.equal(
        totalSupplyValue.toString(),
        mintAmount.toString(),
        "total supply snapshot must record the full minted supply, unaffected by partial-freeze PDAs"
      );
    });

    it("burn: snapshot taken before burn records holder balance at time of snapshot and is never overwritten", async () => {
      const balanceBeforeSnapshot = new anchor.BN(5 ** MINT_DECIMALS);
      const burnAmount = new anchor.BN(1 ** MINT_DECIMALS);

      // Mint tokens (no snapshot active yet → snapshot CPIs exit silently)
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokens({ deployer, mint, destination: source }, { amount: balanceBeforeSnapshot });

      // Take snapshot via create_coupon (counter 0 → 1); subsequent operations will record pre-op balances
      const couponId = new anchor.BN(1);
      await createCoupon({ deployer, mint }, { couponId });

      // First burn — snapshot CPIs fire and record pre-burn balance (= balanceBeforeSnapshot)
      await burnTokens({ deployer, mint, tokenAccount: source }, { amount: burnAmount });

      // Second burn in the same snapshot period — snapshot CPIs must be no-ops
      await burnTokens({ deployer, mint, tokenAccount: source }, { amount: burnAmount });

      // ── Assert snapshot values via get_*_snapshot_at ──────────────────────────
      const holderValue = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: source },
        { snapshotId: couponId }
      );
      const totalSupplyValue = await getTotalSupplySnapshotAt({ mint }, { snapshotId: couponId });
      assert.equal(
        holderValue.toString(),
        balanceBeforeSnapshot.toString(),
        "holder snapshot should reflect the balance before burning"
      );
      assert.equal(
        totalSupplyValue.toString(),
        balanceBeforeSnapshot.toString(),
        "total supply snapshot should v the total supply before burning"
      );
    });

    it("burn: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokens({ deployer, mint, destination: source });

      // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
      const rogueKeypair = Keypair.generate();

      try {
        await burnTokens({ deployer: rogueKeypair.publicKey, mint, tokenAccount: source, signers: [rogueKeypair] });
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

    it("burn: fails when mint is paused", async () => {
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokens({ deployer, mint, destination: source });
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

    it("burn: fails with Deactivated when mint has been deactivated", async () => {
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokens({ deployer, mint, destination: source });

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

    it("burn: fails with FunctionalityNotSupportedError when the burn functionality is not enabled", async () => {
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokens({ deployer, mint, destination: source });

      // Re-seed the asset-class version WITHOUT the burn functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await burnTokens({ deployer, mint, tokenAccount: source });
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

    it("burn: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokens({ deployer, mint, destination: source });

      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [OPERATIONS_BURN],
      });

      try {
        await burnTokens({ deployer, mint, tokenAccount: source });
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
