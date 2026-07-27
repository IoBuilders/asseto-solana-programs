import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_FREEZE_MANAGER } from "./utils/roles";
import {
  freezeAccount,
  partiallyFreezeAccount,
  removePartialFreeze,
} from "./program_helpers/freeze/freeze_instruction_helper";
import { getFrozenBalanceByPda } from "./program_helpers/freeze/freeze_pda_helper";
import * as freezePdaUtils from "./program_helpers/freeze/freeze_pda_helper";
import {
  burnTokensViaSurfpool,
  createTokenAccount,
  getMint,
  getTokenAccount,
  mintTokensViaSurfpool,
  setMintPaused,
} from "./program_helpers/spl_token_helper";
import { TRANSFER_CONTROL_WHITELIST } from "./program_helpers/transfer_control/transfer_control_instruction_helper";
import {
  batchTransfer,
  buildBatchVerifyTransferInstruction,
  buildVerifyTransferInstruction,
  transfer,
  verifyTransfer,
} from "./program_helpers/transfer_helper";
import { beforeEach } from "mocha";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import {
  DEACTIVATE_DEACTIVATE,
  FREEZE_FREEZE_ACCOUNT,
  FREEZE_PARTIALLY_FREEZE_ACCOUNT,
  FREEZE_REMOVE_PARTIAL_FREEZE,
  MINT_MINT,
  OPERATIONS_BURN,
  PAUSE_PAUSE,
  TRANSFER_CONTROL_ADD_TO_WHITELIST,
  TRANSFER_CONTROL_INITIALIZE,
  TRANSFER_HOOK_EXECUTE,
} from "./utils/functionalities";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import {
  setTransferControlModeMarker,
  setWhitelistMarker,
} from "./program_helpers/transfer_control/transfer_control_pda_helper";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
const TRANSFER_AMOUNT = new anchor.BN(400 * 10 ** MINT_DECIMALS);

describe("transfer", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sourceOwnerKeypair = Keypair.generate();
  const sourceOwner = sourceOwnerKeypair.publicKey;
  const destinationOwnerKeypair = Keypair.generate();
  const destinationOwner = destinationOwnerKeypair.publicKey;
  const authority = provider.wallet.payer;
  const payerKeypair = provider.wallet.payer!;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint());
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        PAUSE_PAUSE,
        OPERATIONS_BURN,
        TRANSFER_CONTROL_INITIALIZE,
        TRANSFER_CONTROL_ADD_TO_WHITELIST,
        DEACTIVATE_DEACTIVATE,
        FREEZE_FREEZE_ACCOUNT,
        FREEZE_PARTIALLY_FREEZE_ACCOUNT,
        FREEZE_REMOVE_PARTIAL_FREEZE,
        MINT_MINT,
        TRANSFER_HOOK_EXECUTE,
      ],
    });
  });

  describe("transfer", () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: moves tokens from source to destination", async () => {
      // Mint 1 000 tokens to the source account (owned by sourceOwner).
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });
      const supplyBefore = (await getMint(mint)).supply;

      // ── Call transfer ──────────────────────────────────────────────────────
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: TRANSFER_AMOUNT }
      );

      const sourceAfter = (await getTokenAccount(source)).amount;
      const destAfter = (await getTokenAccount(destination)).amount;
      const supplyAfter = (await getMint(mint)).supply;

      assert.equal(
        sourceAfter.toString(),
        (MINT_AMOUNT.toNumber() - TRANSFER_AMOUNT.toNumber()).toString(),
        "source balance should be reduced by the transfer amount"
      );
      assert.equal(
        destAfter.toString(),
        TRANSFER_AMOUNT.toString(),
        "destination balance should equal the transfer amount"
      );
      assert.equal(
        supplyAfter.toString(),
        supplyBefore.toString(),
        "total supply should be unchanged after a transfer"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails when there is no previous instruction", async () => {
      // Mint 1 000 tokens to the source account (owned by sourceOwner).
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      try {
        await transfer({
          mint,
          source,
          sourceOwner,
          destination,
          preInstructions: [],
          signers: [sourceOwnerKeypair],
        });
        assert.fail("Expected NoPreviousInstruction error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "NoPreviousInstruction",
          "error code should be NoPreviousInstruction"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails when previous instruction program is not verify program", async () => {
      // Mint 1 000 tokens to the source account (owned by sourceOwner).
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // ── Call transfer ──────────────────────────────────────────────────────
      const verifyIx = await buildVerifyTransferInstruction(
        { mint, source, sourceOwner, destination },
        { amount: TRANSFER_AMOUNT }
      );
      try {
        const preInstructions = [verifyIx, anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
        await transfer(
          { mint, source, sourceOwner, destination, preInstructions, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected PrevInstructionWrongProgram error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "PrevInstructionWrongProgram",
          "error code should be PrevInstructionWrongProgram"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails when previous instruction method does not have the proper input arguments", async () => {
      // Mint 1 000 tokens to the source account (owned by sourceOwner).
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      const verifyTransferAmount = TRANSFER_AMOUNT.sub(new anchor.BN(1));
      const verifyIx = await buildVerifyTransferInstruction(
        { mint, source, sourceOwner, destination },
        { amount: verifyTransferAmount }
      );
      try {
        const preInstructions = [anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx];
        await transfer(
          { mint, source, sourceOwner, destination, preInstructions, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected PrevInstructionArgumentMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "PrevInstructionArgumentMismatch",
          "error code should be PrevInstructionArgumentMismatch"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [TRANSFER_HOOK_EXECUTE],
      });

      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
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
    it("transfer: fails with FunctionalityNotSupportedError when the transfer_hook_execute functionality is not enabled", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Re-seed the asset-class version WITHOUT the transfer_hook_execute functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
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
    it("transfer: fails when signer is not token holder", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
      const rogueKeypair = Keypair.generate();

      try {
        await transfer(
          { mint, source, sourceOwner: rogueKeypair.publicKey, destination, signers: [rogueKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected owner-mismatch error but instruction succeeded");
      } catch (err) {
        // Ownership of the source token account is enforced natively by Token-2022
        // during transfer_checked (before the hook runs), so the error surfaces as
        // a Token-2022 OwnerMismatch (SendTransactionError) rather than an AnchorError.
        assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
        const sendErr = err as SendTransactionError;
        const logs = sendErr.logs ?? [];
        assert.isTrue(
          logs.some((log) => log.toLowerCase().includes("owner does not match")),
          "transaction logs should mention Token-2022 owner mismatch"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails when mint is paused", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      await setMintPaused(mint, true);

      try {
        await transfer({ mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] });
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
    it("transfer: fails with InsufficientUnfrozenBalance, then succeeds after partial freeze is updated", async () => {
      const TOTAL_AMOUNT = new anchor.BN(100 * 10 ** MINT_DECIMALS);
      const FROZEN_AMOUNT = new anchor.BN(80 * 10 ** MINT_DECIMALS); // 20 available
      const TRANSFER_AMOUNT = new anchor.BN(50 * 10 ** MINT_DECIMALS); // 50 > 20 → fails
      const UPDATED_FROZEN_AMOUNT = new anchor.BN(40 * 10 ** MINT_DECIMALS); // 60 available
      // same transfer amount retried after update — 50 <= 60 → succeeds

      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, TOTAL_AMOUNT);

      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      const frozenBalancePda = freezePdaUtils.frozenBalancePda(mint, source);

      // ── Partially freeze 80 tokens (only 20 available) ───────────────────────
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await partiallyFreezeAccount({ authority, mint, account: source }, { balance: FROZEN_AMOUNT });

      try {
        await verifyTransfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected InsufficientUnfrozenBalance error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "InsufficientUnfrozenBalance",
          "error code should be InsufficientUnfrozenBalance"
        );
      }

      // ── Update partial freeze to 40 tokens (60 now available) ────────────────
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await partiallyFreezeAccount({ authority, mint, account: source }, { balance: UPDATED_FROZEN_AMOUNT });

      const frozenBalanceAfterUpdate = await getFrozenBalanceByPda(frozenBalancePda);
      assert.equal(
        frozenBalanceAfterUpdate.balance.toString(),
        UPDATED_FROZEN_AMOUNT.toString(),
        "frozen balance PDA should reflect the updated frozen amount"
      );

      // ── Retry same transfer — succeeds (available = 60 >= 50) ────────────────
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: TRANSFER_AMOUNT }
      );

      const sourceAfter = (await getTokenAccount(source)).amount;
      const destAfter = (await getTokenAccount(destination)).amount;

      assert.equal(
        sourceAfter.toString(),
        (TOTAL_AMOUNT.toNumber() - TRANSFER_AMOUNT.toNumber()).toString(),
        "source should have 50 tokens after transferring 50"
      );
      assert.equal(destAfter.toString(), TRANSFER_AMOUNT.toString(), "destination should have received 50 tokens");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: succeeds when transfer is within unfrozen balance, then fails with InsufficientUnfrozenBalance when it exceeds it", async () => {
      const TOTAL_AMOUNT = new anchor.BN(100 * 10 ** MINT_DECIMALS);
      const FROZEN_AMOUNT = new anchor.BN(50 * 10 ** MINT_DECIMALS);
      const FIRST_TRANSFER = new anchor.BN(40 * 10 ** MINT_DECIMALS); // 50 available >= 40 ✓
      const SECOND_TRANSFER = new anchor.BN(20 * 10 ** MINT_DECIMALS); // 10 available < 20  ✗

      // ── Mint 100 tokens to source account (owned by sourceOwner) ─────────────
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, TOTAL_AMOUNT);

      // ── Create destination token account ──────────────────────────────────────
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // ── Partially freeze 50 tokens ────────────────────────────────────────────
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await partiallyFreezeAccount({ authority, mint, account: source }, { balance: FROZEN_AMOUNT });

      // ── Transfer 40 tokens — succeeds (available = 100 - 50 = 50 >= 40) ──────
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: FIRST_TRANSFER }
      );

      const sourceAfter = (await getTokenAccount(source)).amount;

      assert.equal(
        sourceAfter.toString(),
        (TOTAL_AMOUNT.toNumber() - FIRST_TRANSFER.toNumber()).toString(),
        "source balance should be 60 tokens after transferring 40"
      );

      // ── Transfer 20 tokens — fails (available = 60 - 50 = 10 < 20) ───────────
      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: SECOND_TRANSFER }
        );
        assert.fail("Expected InsufficientUnfrozenBalance error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "InsufficientUnfrozenBalance",
          "error code should be InsufficientUnfrozenBalance"
        );
      }
    });

    // ── burn × partial freeze handled correctly (no panic, transfers stay blocked) ──
    it("transfer: burning below the partial-freeze amount leaves the frozen PDA stale and blocks all outbound transfers", async () => {
      const TOTAL_AMOUNT = new anchor.BN(100 * 10 ** MINT_DECIMALS);
      const FROZEN_AMOUNT = new anchor.BN(40 * 10 ** MINT_DECIMALS);
      const BURN_AMOUNT = new anchor.BN(80 * 10 ** MINT_DECIMALS);
      const TRANSFER_ATTEMPT = new anchor.BN(10 ** MINT_DECIMALS);
      const EXPECTED_REMAINDER = TOTAL_AMOUNT.sub(BURN_AMOUNT); // 20 tokens, < FROZEN_AMOUNT (40)

      // ── Mint 100 tokens to source ─────────────────────────────────────────────
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, TOTAL_AMOUNT);

      // ── Create destination token account ──────────────────────────────────────
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      const frozenBalancePda = freezePdaUtils.frozenBalancePda(mint, source);

      // ── Partially freeze 40 tokens (available = 60 of 100) ────────────────────
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await partiallyFreezeAccount({ authority, mint, account: source }, { balance: FROZEN_AMOUNT });

      // ── Burn 80 via permanent-delegate (issuer redemption) ────────────────────
      //
      // Operations::burn doesn't read or adjust frozen_balance_pda, so afterwards
      // we have: token_account.amount = 20, frozen_balance_pda.balance = 40.
      // `require_unfrozen_balance` uses saturating_sub → available = 0.
      await burnTokensViaSurfpool(mint, source, BURN_AMOUNT);

      const sourceAfterBurn = (await getTokenAccount(source)).amount;
      const frozenAfterBurn = await getFrozenBalanceByPda(frozenBalancePda);

      // (1) Burn succeeded — balance is now below the recorded frozen amount.
      assert.equal(sourceAfterBurn.toString(), EXPECTED_REMAINDER.toString(), "burn should leave 20 tokens (100 − 80)");

      // (2) PDA is stale — burn does not adjust frozen_balance_pda by design.
      assert.equal(
        frozenAfterBurn.balance.toString(),
        FROZEN_AMOUNT.toString(),
        "frozen_balance_pda should still record the original 40 (stale, as documented)"
      );

      // (3) Any positive outbound transfer must fail — saturating_sub clamps available to 0.
      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_ATTEMPT }
        );
        assert.fail("Expected InsufficientUnfrozenBalance error but transfer succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError raised by verify_transfer");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "InsufficientUnfrozenBalance",
          "available balance must clamp to 0 via saturating_sub, blocking the transfer"
        );
      }

      // (4) Recovery path — after remove_partial_freeze, the 20 remaining tokens transact normally.
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await removePartialFreeze({ mint, authority, account: source });
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: TRANSFER_ATTEMPT }
      );

      const sourceAfterRecovery = (await getTokenAccount(source)).amount;
      assert.equal(
        sourceAfterRecovery.toString(),
        EXPECTED_REMAINDER.sub(TRANSFER_ATTEMPT).toString(),
        "after remove_partial_freeze the remaining tokens transact normally"
      );
    });
  });

  describe("verify_transfer", async () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("verify_transfer: fails with NotWhitelisted when whitelist mode is active and source is not whitelisted", async () => {
      // Mint tokens to source before activating whitelist mode
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create destination token account
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Activate whitelist mode
      await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);

      // Add destination to whitelist — source is NOT whitelisted
      await setWhitelistMarker(mint, destination);

      const sourceBefore = (await getTokenAccount(source)).amount;
      const destBefore = (await getTokenAccount(destination)).amount;

      try {
        await verifyTransfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected NotWhitelisted error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted", "error code should be NotWhitelisted");
      }

      const sourceAfter = (await getTokenAccount(source)).amount;
      const destAfter = (await getTokenAccount(destination)).amount;

      assert.equal(
        sourceAfter.toString(),
        sourceBefore.toString(),
        "source balance must be unchanged after rejected transfer"
      );
      assert.equal(
        destAfter.toString(),
        destBefore.toString(),
        "destination balance must be unchanged after rejected transfer"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("verify_transfer: fails with NotWhitelisted when whitelist mode is active and destination is not whitelisted", async () => {
      // Mint tokens to source before activating whitelist mode
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create destination token account
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Activate whitelist mode
      await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);

      // Add source to whitelist — destination is NOT whitelisted
      await setWhitelistMarker(mint, source);

      const sourceBefore = (await getTokenAccount(source)).amount;
      const destBefore = (await getTokenAccount(destination)).amount;

      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected NotWhitelisted error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted", "error code should be NotWhitelisted");
      }

      const sourceAfter = (await getTokenAccount(source)).amount;
      const destAfter = (await getTokenAccount(destination)).amount;

      assert.equal(
        sourceAfter.toString(),
        sourceBefore.toString(),
        "source balance must be unchanged after rejected transfer"
      );
      assert.equal(
        destAfter.toString(),
        destBefore.toString(),
        "destination balance must be unchanged after rejected transfer"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("verify_transfer: fails with AccountFrozen when source account has been frozen", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);
      const destination = await createTokenAccount({ mint, owner: destinationOwner });
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await freezeAccount({ authority, mint, account: source });

      // ── Transfer must now be rejected with AccountFrozen ──────────────────
      try {
        await verifyTransfer({ mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] });
        assert.fail("Expected AccountFrozen error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "AccountFrozen", "error code should be AccountFrozen");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("verify_transfer: fails with Deactivated when mint has been deactivated", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // ── Deactivate the mint ────────────────────────────────────────────────
      await setDeactivateMarker(mint);

      // ── Mint must now be rejected with Deactivated ─────────────────────────
      try {
        await verifyTransfer({ mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });
  });

  describe("batch_transfer", async () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("batch_transfer: fans tokens out from one source to many destinations", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      const destinations: PublicKey[] = [];
      for (let i = 0; i < 3; i++) {
        destinations.push(await createTokenAccount({ mint, owner: Keypair.generate().publicKey }));
      }
      const amounts = [
        new anchor.BN(100 * 10 ** MINT_DECIMALS),
        new anchor.BN(50 * 10 ** MINT_DECIMALS),
        new anchor.BN(30 * 10 ** MINT_DECIMALS),
      ];
      const total = amounts.reduce((acc, a) => acc.add(a), new anchor.BN(0));
      const supplyBefore = (await getMint(mint)).supply;

      await batchTransfer({ mint, source, sourceOwner, destinations, signers: [sourceOwnerKeypair] }, { amounts });

      const sourceAfter = (await getTokenAccount(source)).amount;
      assert.equal(
        sourceAfter.toString(),
        MINT_AMOUNT.sub(total).toString(),
        "source balance should be reduced by the sum of the batch"
      );
      for (let i = 0; i < destinations.length; i++) {
        const destAfter = (await getTokenAccount(destinations[i])).amount;
        assert.equal(destAfter.toString(), amounts[i].toString(), `destination ${i} should receive amounts[${i}]`);
      }
      assert.equal(
        (await getMint(mint)).supply.toString(),
        supplyBefore.toString(),
        "total supply should be unchanged after a batch transfer"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("batch_transfer: fails with EmptyBatch when amounts is empty", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      try {
        await batchTransfer(
          { mint, source, sourceOwner, destinations: [], signers: [sourceOwnerKeypair] },
          { amounts: [] }
        );
        assert.fail("Expected EmptyBatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "EmptyBatch", "error code should be EmptyBatch");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("batch_transfer: fails with InvalidRemainingAccounts when destination count doesn't match amounts", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);
      const d1 = await createTokenAccount({ mint, owner: destinationOwner });
      const d2 = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
      const amounts = [new anchor.BN(1), new anchor.BN(1)];

      try {
        // batch_verify passes (2 pairs), but batch_transfer is given only 1 destination for 2 amounts.
        await batchTransfer(
          { mint, source, sourceOwner, destinations: [d1, d2], signers: [sourceOwnerKeypair] },
          { amounts, transferRemainingAccounts: [{ pubkey: d1, isWritable: true, isSigner: false }] }
        );
        assert.fail("Expected InvalidRemainingAccounts error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal(
          (err as AnchorError).error.errorCode.code,
          "InvalidRemainingAccounts",
          "error code should be InvalidRemainingAccounts"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("batch_transfer: fails when N-1 is a single verify_transfer instead of batch_verify_transfer", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);
      const destination = await createTokenAccount({ mint, owner: destinationOwner });
      const amount = new anchor.BN(100 * 10 ** MINT_DECIMALS);

      // Pair the batch with the SINGULAR verify_transfer — the hook must reject it
      // because N-1 is not batch_verify_transfer.
      const singleVerifyIx = await buildVerifyTransferInstruction(
        { mint, source, sourceOwner, destination },
        { amount }
      );

      try {
        await batchTransfer(
          {
            mint,
            source,
            sourceOwner,
            destinations: [destination],
            preInstructions: [singleVerifyIx],
            signers: [sourceOwnerKeypair],
          },
          { amounts: [amount] }
        );
        assert.fail("Expected PrevInstructionNotVerifyTransfer error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal(
          (err as AnchorError).error.errorCode.code,
          "PrevInstructionNotVerifyTransfer",
          "error code should be PrevInstructionNotVerifyTransfer"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("batch_transfer: rejects a transfer batch that duplicates a leg beyond what verify declared", async () => {
      // Bypass attempt: verify a single (dest, amount) leg, but transfer it
      // twice. Per-leg matching alone would let both transfers map onto the one
      // verified leg — draining more than verify's summed balance check covered.
      // The identical-batch guard must reject it.
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);
      const destination = await createTokenAccount({ mint, owner: destinationOwner });
      const amount = new anchor.BN(100 * 10 ** MINT_DECIMALS);

      // verify declares ONE leg; batch_transfer declares the SAME leg TWICE.
      const verifyOneLegIx = await buildBatchVerifyTransferInstruction(
        { mint, source, sourceOwner, destinations: [destination], signers: [sourceOwnerKeypair] },
        { amounts: [amount] }
      );

      try {
        await batchTransfer(
          {
            mint,
            source,
            sourceOwner,
            destinations: [destination, destination],
            preInstructions: [verifyOneLegIx],
            signers: [sourceOwnerKeypair],
          },
          { amounts: [amount, amount] }
        );
        assert.fail("Expected CurrentInstructionArgumentMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal(
          (err as AnchorError).error.errorCode.code,
          "CurrentInstructionArgumentMismatch",
          "the verify/transfer batches must be identical; a duplicated transfer leg must be rejected"
        );
      }
    });
  });
});
