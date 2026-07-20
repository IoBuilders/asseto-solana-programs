import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import {
  createTokenAccount,
  getTokenAccount,
  mintTokensViaSurfpool,
  setMintPaused,
} from "./program_helpers/spl_token_helper";
import { burnTokens, getControllerRedemptionEvent } from "./program_helpers/burn/burn_instruction_helper";
import {
  getHolderBalanceSnapshotAt,
  getTotalSupplySnapshotAt,
} from "./program_helpers/snapshot/snapshot_instruction_helper";
import { setSnapshotCounter } from "./program_helpers/snapshot/snapshot_pda_helper";
import { setFrozenBalance } from "./program_helpers/freeze/freeze_pda_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import { OPERATIONS_BURN } from "./utils/functionalities";
import { beforeEach } from "mocha";
import { ROLE_ADMIN, ROLE_CONTROLLER, setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";

describe("operations", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;
  const authority = provider.wallet.publicKey;

  describe("burn ", async () => {
    let mint: PublicKey;
    let mintOwnerPda: PublicKey;
    const MINT_DECIMALS = 6;

    // A fresh mint per test (unpaused + active out of the box) plus a fresh
    // asset-class version finalized with the burn functionality. Every
    // precondition burn cares about — token balances, partial-freeze markers,
    // active snapshots, paused/deactivated state — is then planted in isolation
    // via surfpool cheatcodes, so `burn` is the only instruction each test runs.
    beforeEach(async () => {
      ({ mint } = await deployMint({ deployer }, { decimals: MINT_DECIMALS }));
      mintOwnerPda = pdaUtils.mintOwnerPda(mint);
      await setAssetClassVersionForMint(mint, { functionalities: [OPERATIONS_BURN] });
      await setRoles(mint, authority, [ROLE_CONTROLLER]);
    });

    it("burn: removes tokens from the token account via permanent delegate", async () => {
      const mintAmount = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
      const burnAmount = new anchor.BN(100 * 10 ** MINT_DECIMALS);

      // Plant 1 000 tokens on the source account (owned by the mint-owner PDA).
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokensViaSurfpool(mint, source, mintAmount);

      // ── Call burn ──────────────────────────────────────────────────────
      const { signature } = await burnTokens(
        { deployer, mint, tokenAccount: source, authority },
        { amount: burnAmount }
      );

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
      assert.equal(event!.controller.toBase58(), authority.toBase58(), "controller should be the deployer");
      assert.equal(event!.from.toBase58(), source.toBase58(), "from should be the burned token account");
      assert.equal(event!.value.toString(), burnAmount.toString(), "value should match the burn amount");
    });

    it("burn: holder balance snapshot records full Token-2022 balance (ignoring partial-freeze PDA)", async () => {
      const mintAmount = new anchor.BN(10 ** MINT_DECIMALS);
      const burnAmount = new anchor.BN(3 ** MINT_DECIMALS);
      const partialFrozenAmount = new anchor.BN(5 ** MINT_DECIMALS);

      // ── Plant the holder balance and total supply ────────────────────────────
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokensViaSurfpool(mint, source, mintAmount);

      // ── Plant a partial-freeze marker for 5^6 tokens on source ───────────────
      await setFrozenBalance(mint, source, partialFrozenAmount);

      // ── Activate snapshot id 1 directly (counter 0 → 1) ──────────────────────
      const snapshotId = new anchor.BN(1);
      await setSnapshotCounter(mint, snapshotId);

      // ── Burn — snapshot CPI fires and records the pre-burn balance at snapshot 1 ──
      await burnTokens({ deployer, mint, tokenAccount: source, authority }, { amount: burnAmount });

      const holderValue = await getHolderBalanceSnapshotAt({ mint, holderTokenAccount: source }, { snapshotId });
      const totalSupplyValue = await getTotalSupplySnapshotAt({ mint }, { snapshotId });

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

      // Plant tokens on the source account
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokensViaSurfpool(mint, source, balanceBeforeSnapshot);

      // Activate snapshot id 1 (counter 0 → 1); subsequent operations record pre-op balances
      const snapshotId = new anchor.BN(1);
      await setSnapshotCounter(mint, snapshotId);

      // First burn — snapshot CPIs fire and record pre-burn balance (= balanceBeforeSnapshot)
      await burnTokens({ deployer, mint, tokenAccount: source, authority }, { amount: burnAmount });

      // Second burn in the same snapshot period — snapshot CPIs must be no-ops
      await burnTokens({ deployer, mint, tokenAccount: source, authority }, { amount: burnAmount });

      // ── Assert snapshot values via get_*_snapshot_at ──────────────────────────
      const holderValue = await getHolderBalanceSnapshotAt({ mint, holderTokenAccount: source }, { snapshotId });
      const totalSupplyValue = await getTotalSupplySnapshotAt({ mint }, { snapshotId });
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

    it("burn: fails with MissingRole when authority does not have the controller role", async () => {
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });

      // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
      const rogueKeypair = Keypair.generate();
      await setRoles(mint, rogueKeypair.publicKey, [ROLE_ADMIN]); // rogue has admin but not controller role

      try {
        await burnTokens({
          deployer,
          mint,
          tokenAccount: source,
          authority: rogueKeypair.publicKey,
          signers: [rogueKeypair],
        });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    it("burn: fails when mint is paused", async () => {
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });
      await mintTokensViaSurfpool(mint, source, new anchor.BN(1));
      await setMintPaused(mint, true);

      // The burn CPI into Token-2022 is rejected because the mint is paused.
      // This surfaces as a SendTransactionError (Token-2022 custom error 0x43),
      // not an AnchorError, because the rejection originates inside Token-2022.
      try {
        await burnTokens({ deployer, mint, tokenAccount: source, authority });
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

      // ── Deactivate the mint ────────────────────────────────────────────────
      await setDeactivateMarker(mint);

      // ── Burn must now be rejected with Deactivated ─────────────────────────
      try {
        await burnTokens({ deployer, mint, tokenAccount: source, authority });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    it("burn: fails with FunctionalityNotSupportedError when the burn functionality is not enabled", async () => {
      const source = await createTokenAccount({ mint, owner: mintOwnerPda });

      // Re-seed the asset-class version WITHOUT the burn functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await burnTokens({ deployer, mint, tokenAccount: source, authority });
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

      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [OPERATIONS_BURN],
      });

      try {
        await burnTokens({ deployer, mint, tokenAccount: source, authority });
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
