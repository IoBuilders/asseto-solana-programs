import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import {
  freezeAccount,
  partiallyFreezeAccount,
  removePartialFreeze,
  unfreezeAccount,
  batchFreeze,
  batchPartiallyFreeze,
  getAccountFrozenEvent,
  getAccountFrozenEvents,
  getAccountUnfrozenEvent,
  getAccountPartiallyFrozenEvent,
  getAccountPartiallyFrozenEvents,
  getAccountPartialFreezeRemovedEvent,
} from "./program_helpers/freeze/freeze_instruction_helper";
import { getFrozenAccountStatusByPda, getFrozenBalanceByPda } from "./program_helpers/freeze/freeze_pda_helper";
import * as freezePdaUtils from "./program_helpers/freeze/freeze_pda_helper";
import { createTokenAccount, setMintPaused } from "./program_helpers/spl_token_helper";
import { surfnetSetAccount } from "./program_helpers/account_helper";
import { SYSTEM_PROGRAM_ID } from "./utils/address_utils";
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
  FREEZE_UNFREEZE_ACCOUNT,
  PAUSE_PAUSE,
} from "./utils/functionalities";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_FREEZE_MANAGER } from "./utils/roles";

describe("freeze", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const authority = provider.wallet.payer;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint());
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        PAUSE_PAUSE,
        DEACTIVATE_DEACTIVATE,
        FREEZE_FREEZE_ACCOUNT,
        FREEZE_UNFREEZE_ACCOUNT,
        FREEZE_PARTIALLY_FREEZE_ACCOUNT,
        FREEZE_REMOVE_PARTIAL_FREEZE,
      ],
    });
    await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
  });

  describe("freeze_account", () => {
    // ── Happy-path: freeze_account ───────────────────────────────────────────────
    it("freeze_account: creates the frozen_account PDA for a token account", async () => {
      // ── Create a token account to use as the freeze target ──────────────────
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // ── Verify the PDA does not exist before the instruction ────────────────
      const [frozenAccountPda, expectedBump] = freezePdaUtils.frozenAccountPdaWithBump(mint, tokenAccount);
      const statusBefore = await getFrozenAccountStatusByPda(frozenAccountPda);

      // ── Call freeze_account ──────────────────────────────────────────────────
      const { signature } = await freezeAccount({ authority, mint, account: tokenAccount });

      // ── Verify the frozen_account PDA was created with the correct bump ──────
      const statusAfter = await getFrozenAccountStatusByPda(frozenAccountPda);
      assert.isNull(statusBefore, "frozen_account PDA should not exist before freeze_account");
      assert.isNotNull(statusAfter, "frozen_account PDA should exist after freeze_account");
      assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");

      const event = await getAccountFrozenEvent(signature);

      assert.isNotNull(event, "Account frozen event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58(), "event operator should match authority");
    });

    // ── Error case: freeze_account — already frozen ─────────────────────────────
    it("freeze_account: fails when account is already frozen", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // ── Freeze the account once (succeeds) ───────────────────────────────────
      await freezeAccount({ authority, mint, account: tokenAccount });

      // ── Attempt to freeze again — frozen_account_pda already exists ──────────
      try {
        await freezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected already-in-use error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
        const sendErr = err as SendTransactionError;
        const logs = sendErr.logs ?? [];
        assert.isTrue(
          logs.some((log) => log.includes("already in use")),
          "transaction logs should mention the account is already in use"
        );
      }
    });

    // ── Happy-path: unfreeze_account ─────────────────────────────────────────────
    it("unfreeze_account: closes the frozen_account PDA for a token account", async () => {
      const { mint } = await deployMint();
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);

      // ── Create a token account to use as the freeze target ──────────────────
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // ── First: freeze the account ────────────────────────────────────────────
      const frozenAccountPda = freezePdaUtils.frozenAccountPda(mint, tokenAccount);
      await freezeAccount({ authority, mint, account: tokenAccount });

      const statusAfterFreeze = await getFrozenAccountStatusByPda(frozenAccountPda);
      assert.isNotNull(statusAfterFreeze, "frozen_account PDA should exist after freeze_account");

      // ── Then: unfreeze the account ───────────────────────────────────────────
      const { signature } = await unfreezeAccount({ authority, mint, account: tokenAccount });

      // ── Verify the frozen_account PDA has been closed ────────────────────────
      const statusAfterUnfreeze = await getFrozenAccountStatusByPda(frozenAccountPda);

      assert.isNull(statusAfterUnfreeze, "frozen_account PDA should not exist after unfreeze_account");

      const event = await getAccountUnfrozenEvent(signature);

      assert.isNotNull(event, "Account unfrozen event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58(), "event operator should match authority");
    });

    // ── Error case: freeze_account — MissingRole ────────────────────────────────
    it("freeze_account: fails with MissingRole when authority doesn't have required role", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setRoles(mint, authority.publicKey, []);

      try {
        await freezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: freeze_account — MintPaused ─────────────────────────────────
    it("freeze_account: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setMintPaused(mint, true);

      try {
        await freezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: freeze_account — Deactivated ────────────────────────────────
    it("freeze_account: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setDeactivateMarker(mint);

      try {
        await freezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: freeze_account — FunctionalityNotSupportedError ─────────────
    it("freeze_account: fails with FunctionalityNotSupportedError when the freeze_account functionality is not enabled", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // Re-seed the asset-class version WITHOUT the freeze_account functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await freezeAccount({ authority, mint, account: tokenAccount });
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

    // ── Error case: freeze_account — AssetClassVersionNotFinalized ──────────────
    it("freeze_account: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [FREEZE_FREEZE_ACCOUNT],
      });

      try {
        await freezeAccount({ authority, mint, account: tokenAccount });
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

  describe("batch_freeze", () => {
    // ── Happy-path: batch_freeze ─────────────────────────────────────────────────
    it("batch_freeze: creates a frozen_account PDA for every account and emits one event each", async () => {
      const accountA = await createTokenAccount({ mint, owner: authority.publicKey });
      const accountB = await createTokenAccount({ mint, owner: authority.publicKey });
      const accounts = [accountA, accountB];

      const signature = await batchFreeze({ authority, mint, accounts });

      for (const account of accounts) {
        const status = await getFrozenAccountStatusByPda(freezePdaUtils.frozenAccountPda(mint, account));
        assert.isNotNull(status, `frozen_account PDA should exist for ${account.toBase58()}`);
      }

      const events = await getAccountFrozenEvents(signature);
      assert.equal(events.length, accounts.length, "one AccountFrozen event should be emitted per account");
      for (const account of accounts) {
        const event = events.find((e) => e.account.toBase58() === account.toBase58());
        assert.isDefined(event, `an AccountFrozen event should be emitted for ${account.toBase58()}`);
        assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
        assert.equal(
          event!.operator.toBase58(),
          authority.publicKey.toBase58(),
          "event operator should match authority"
        );
      }
    });

    // ── Happy-path: batch_freeze — griefed PDA (create-or-adopt) ────────────────
    it("batch_freeze: succeeds even if a frozen_account_pda was pre-funded by a griefer (create-or-adopt)", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const pda = freezePdaUtils.frozenAccountPda(mint, account);

      // Attacker pre-funds the predictable PDA with lamports but no data. A bare
      // `create_account` would then fail forever (AccountAlreadyInUse);
      // create_or_adopt_pda tops up + allocates + assigns instead.
      await surfnetSetAccount(pda, {
        lamports: 1,
        owner: SYSTEM_PROGRAM_ID.toBase58(),
        data: "",
        executable: false,
        rentEpoch: 0,
      });

      // Must still succeed thanks to create-or-adopt.
      await batchFreeze({ authority, mint, accounts: [account] });

      const status = await getFrozenAccountStatusByPda(pda);
      assert.isNotNull(status, "frozen_account PDA should exist despite the pre-funding griefing attempt");
    });

    // ── Error case: batch_freeze — EmptyBatch ───────────────────────────────────
    it("batch_freeze: fails with EmptyBatch when no accounts are passed", async () => {
      try {
        await batchFreeze({ authority, mint, accounts: [] });
        assert.fail("Expected EmptyBatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "EmptyBatch", "error code should be EmptyBatch");
      }
    });

    // ── Error case: batch_freeze — InvalidRemainingAccounts ─────────────────────
    it("batch_freeze: fails with InvalidRemainingAccounts when the remaining accounts are not paired", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });

      try {
        await batchFreeze(
          { authority, mint, accounts: [account] },
          { remainingAccounts: [{ pubkey: account, isWritable: false, isSigner: false }] }
        );
        assert.fail("Expected InvalidRemainingAccounts error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "InvalidRemainingAccounts",
          "error code should be InvalidRemainingAccounts"
        );
      }
    });

    // ── Error case: batch_freeze — FrozenAccountPdaMismatch ─────────────────────
    it("batch_freeze: fails with FrozenAccountPdaMismatch when a supplied PDA does not match the derived one", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const wrongPda = Keypair.generate().publicKey;

      try {
        await batchFreeze(
          { authority, mint, accounts: [account] },
          {
            remainingAccounts: [
              { pubkey: account, isWritable: false, isSigner: false },
              { pubkey: wrongPda, isWritable: true, isSigner: false },
            ],
          }
        );
        assert.fail("Expected FrozenAccountPdaMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FrozenAccountPdaMismatch",
          "error code should be FrozenAccountPdaMismatch"
        );
      }
    });

    // ── Error case: batch_freeze — AccountFrozen (already frozen) ───────────────
    it("batch_freeze: fails with AccountFrozen when an account is already frozen", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account });

      try {
        await batchFreeze({ authority, mint, accounts: [account] });
        assert.fail("Expected AccountFrozen error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "AccountFrozen", "error code should be AccountFrozen");
      }
    });

    // ── Error case: batch_freeze — MissingRole ───────────────────────────────────
    it("batch_freeze: fails with MissingRole when authority doesn't have required role", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setRoles(mint, authority.publicKey, []);

      try {
        await batchFreeze({ authority, mint, accounts: [account] });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: batch_freeze — MintPaused ───────────────────────────────────
    it("batch_freeze: fails with MintPaused when mint is paused", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setMintPaused(mint, true);

      try {
        await batchFreeze({ authority, mint, accounts: [account] });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: batch_freeze — Deactivated ──────────────────────────────────
    it("batch_freeze: fails with Deactivated when mint has been deactivated", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setDeactivateMarker(mint);

      try {
        await batchFreeze({ authority, mint, accounts: [account] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: batch_freeze — FunctionalityNotSupportedError ───────────────
    it("batch_freeze: fails with FunctionalityNotSupportedError when the freeze_account functionality is not enabled", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await batchFreeze({ authority, mint, accounts: [account] });
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
  });

  describe("unfreeze_account", () => {
    // ── Error case: unfreeze_account — account not frozen ───────────────────────
    it("unfreeze_account: fails with AccountNotInitialized when account is not frozen", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      try {
        await unfreezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected AccountNotInitialized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AccountNotInitialized",
          "error code should be AccountNotInitialized"
        );
      }
    });

    // ── Error case: unfreeze_account — MissingRole ──────────────────────────────
    it("unfreeze_account: fails with MissingRole when authority doesn't have required role", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account: tokenAccount });
      await setRoles(mint, authority.publicKey, []);

      try {
        await unfreezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: unfreeze_account — MintPaused ───────────────────────────────
    it("unfreeze_account: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account: tokenAccount });
      await setMintPaused(mint, true);

      try {
        await unfreezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: unfreeze_account — Deactivated ──────────────────────────────
    it("unfreeze_account: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account: tokenAccount });
      await setDeactivateMarker(mint);

      try {
        await unfreezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: unfreeze_account — FunctionalityNotSupportedError ───────────
    it("unfreeze_account: fails with FunctionalityNotSupportedError when the unfreeze_account functionality is not enabled", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account: tokenAccount });

      // Re-seed the asset-class version WITH freeze_account (needed for the fixture
      // above) but WITHOUT unfreeze_account.
      await setAssetClassVersionForMint(mint, { functionalities: [FREEZE_FREEZE_ACCOUNT] });

      try {
        await unfreezeAccount({ authority, mint, account: tokenAccount });
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

    // ── Error case: unfreeze_account — AssetClassVersionNotFinalized ────────────
    it("unfreeze_account: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account: tokenAccount });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [FREEZE_UNFREEZE_ACCOUNT],
      });

      try {
        await unfreezeAccount({ authority, mint, account: tokenAccount });
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

  describe("partially_freeze_account", () => {
    // ── Happy-path: partially_freeze_account ────────────────────────────────────
    it("partially_freeze_account: creates the frozen_balance PDA with the given balance", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      const [frozenBalancePda, expectedBump] = freezePdaUtils.frozenBalancePdaWithBump(mint, tokenAccount);

      // ── Verify the PDA does not exist before the instruction ─────────────────
      const statusBefore = await getFrozenBalanceByPda(frozenBalancePda);

      // ── Call partially_freeze_account ─────────────────────────────────────────
      const frozenBalance = new anchor.BN(500_000_000);
      const { signature } = await partiallyFreezeAccount(
        { authority, mint, account: tokenAccount },
        { balance: frozenBalance }
      );

      // ── Verify the frozen_balance PDA was created with the correct fields ─────
      const statusAfter = await getFrozenBalanceByPda(frozenBalancePda);

      assert.isNull(statusBefore, "frozen_balance PDA should not exist before partially_freeze_account");
      assert.isNotNull(statusAfter, "frozen_balance PDA should exist after partially_freeze_account");
      assert.equal(
        statusAfter.balance.toString(),
        frozenBalance.toString(),
        "balance should match the value passed to partially_freeze_account"
      );
      assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");

      const event = await getAccountPartiallyFrozenEvent(signature);

      assert.isNotNull(event, "Account partially frozen event should be emitted");

      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(
        event!.frozenBalance.toString(),
        frozenBalance.toString(),
        "event frozenBalance should match the balance"
      );
      assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58(), "event operator should match authority");
    });

    // ── Error case: partially_freeze_account — MissingRole ──────────────────────
    it("partially_freeze_account: fails with MissingRole when authority doesn't have required role", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setRoles(mint, authority.publicKey, []);

      try {
        await partiallyFreezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: partially_freeze_account — MintPaused ───────────────────────
    it("partially_freeze_account: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setMintPaused(mint, true);

      try {
        await partiallyFreezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: partially_freeze_account — FunctionalityNotSupportedError ───
    it("partially_freeze_account: fails with FunctionalityNotSupportedError when the partially_freeze_account functionality is not enabled", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // Re-seed the asset-class version WITHOUT the partially_freeze_account functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await partiallyFreezeAccount({ authority, mint, account: tokenAccount });
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

    // ── Error case: partially_freeze_account — AssetClassVersionNotFinalized ────
    it("partially_freeze_account: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [FREEZE_PARTIALLY_FREEZE_ACCOUNT],
      });

      try {
        await partiallyFreezeAccount({ authority, mint, account: tokenAccount });
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

  describe("batch_partially_freeze", () => {
    // ── Happy-path: batch_partially_freeze ──────────────────────────────────────
    it("batch_partially_freeze: creates a frozen_balance PDA with the given balance for every account", async () => {
      const accountA = await createTokenAccount({ mint, owner: authority.publicKey });
      const accountB = await createTokenAccount({ mint, owner: authority.publicKey });
      const accounts = [accountA, accountB];
      const balances = [new anchor.BN(500_000_000), new anchor.BN(300_000_000)];

      const signature = await batchPartiallyFreeze({ authority, mint, accounts }, { balances });

      for (let i = 0; i < accounts.length; i++) {
        const status = await getFrozenBalanceByPda(freezePdaUtils.frozenBalancePda(mint, accounts[i]));
        assert.isNotNull(status, `frozen_balance PDA should exist for account ${i}`);
        assert.equal(status.balance.toString(), balances[i].toString(), `balance should match for account ${i}`);
      }

      const events = await getAccountPartiallyFrozenEvents(signature);
      assert.equal(events.length, accounts.length, "one AccountPartiallyFrozen event should be emitted per account");
      for (let i = 0; i < accounts.length; i++) {
        const event = events.find((e) => e.account.toBase58() === accounts[i].toBase58());
        assert.isDefined(event, `an AccountPartiallyFrozen event should be emitted for account ${i}`);
        assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
        assert.equal(
          event!.frozenBalance.toString(),
          balances[i].toString(),
          `event frozenBalance should match for account ${i}`
        );
        assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58(), "event operator should match authority");
      }
    });

    // ── Happy-path: batch_partially_freeze overwrites without a prior remove ────
    it("batch_partially_freeze: a second call on the same accounts overwrites the balance without remove_partial_freeze", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const frozenBalancePda = freezePdaUtils.frozenBalancePda(mint, account);
      const FIRST_BALANCE = new anchor.BN(500_000_000);
      const SECOND_BALANCE = new anchor.BN(300_000_000);

      await batchPartiallyFreeze({ authority, mint, accounts: [account] }, { balances: [FIRST_BALANCE] });
      const stateAfterFirst = await getFrozenBalanceByPda(frozenBalancePda);
      assert.equal(stateAfterFirst.balance.toString(), FIRST_BALANCE.toString());

      await batchPartiallyFreeze({ authority, mint, accounts: [account] }, { balances: [SECOND_BALANCE] });
      const stateAfterSecond = await getFrozenBalanceByPda(frozenBalancePda);
      assert.equal(
        stateAfterSecond.balance.toString(),
        SECOND_BALANCE.toString(),
        "balance after second call should overwrite to SECOND_BALANCE"
      );
    });

    // ── Happy-path: batch_partially_freeze — griefed PDA (create-or-adopt) ──────
    it("batch_partially_freeze: succeeds even if a frozen_balance_pda was pre-funded by a griefer (create-or-adopt)", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const pda = freezePdaUtils.frozenBalancePda(mint, account);

      await surfnetSetAccount(pda, {
        lamports: 1,
        owner: SYSTEM_PROGRAM_ID.toBase58(),
        data: "",
        executable: false,
        rentEpoch: 0,
      });

      const balance = new anchor.BN(500_000_000);
      await batchPartiallyFreeze({ authority, mint, accounts: [account] }, { balances: [balance] });

      const status = await getFrozenBalanceByPda(pda);
      assert.isNotNull(status, "frozen_balance PDA should exist despite the pre-funding griefing attempt");
      assert.equal(status.balance.toString(), balance.toString());
    });

    // ── Error case: batch_partially_freeze — EmptyBatch ─────────────────────────
    it("batch_partially_freeze: fails with EmptyBatch when no accounts are passed", async () => {
      try {
        await batchPartiallyFreeze({ authority, mint, accounts: [] }, { balances: [] });
        assert.fail("Expected EmptyBatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "EmptyBatch", "error code should be EmptyBatch");
      }
    });

    // ── Error case: batch_partially_freeze — InvalidRemainingAccounts ───────────
    it("batch_partially_freeze: fails with InvalidRemainingAccounts when the remaining accounts don't match the balances", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });

      try {
        await batchPartiallyFreeze(
          { authority, mint, accounts: [account] },
          { remainingAccounts: [{ pubkey: account, isWritable: false, isSigner: false }] }
        );
        assert.fail("Expected InvalidRemainingAccounts error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "InvalidRemainingAccounts",
          "error code should be InvalidRemainingAccounts"
        );
      }
    });

    // ── Error case: batch_partially_freeze — FrozenBalancePdaMismatch ───────────
    it("batch_partially_freeze: fails with FrozenBalancePdaMismatch when a supplied PDA does not match the derived one", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const wrongPda = Keypair.generate().publicKey;

      try {
        await batchPartiallyFreeze(
          { authority, mint, accounts: [account] },
          {
            remainingAccounts: [
              { pubkey: account, isWritable: false, isSigner: false },
              { pubkey: wrongPda, isWritable: true, isSigner: false },
            ],
          }
        );
        assert.fail("Expected FrozenBalancePdaMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FrozenBalancePdaMismatch",
          "error code should be FrozenBalancePdaMismatch"
        );
      }
    });

    // ── Error case: batch_partially_freeze — MissingRole ────────────────────────
    it("batch_partially_freeze: fails with MissingRole when authority doesn't have required role", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setRoles(mint, authority.publicKey, []);

      try {
        await batchPartiallyFreeze({ authority, mint, accounts: [account] });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: batch_partially_freeze — MintPaused ─────────────────────────
    it("batch_partially_freeze: fails with MintPaused when mint is paused", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setMintPaused(mint, true);

      try {
        await batchPartiallyFreeze({ authority, mint, accounts: [account] });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: batch_partially_freeze — Deactivated ────────────────────────
    it("batch_partially_freeze: fails with Deactivated when mint has been deactivated", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setDeactivateMarker(mint);

      try {
        await batchPartiallyFreeze({ authority, mint, accounts: [account] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: batch_partially_freeze — FunctionalityNotSupportedError ────
    it("batch_partially_freeze: fails with FunctionalityNotSupportedError when the partially_freeze_account functionality is not enabled", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await batchPartiallyFreeze({ authority, mint, accounts: [account] });
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
  });

  describe("remove_partial_freeze", async () => {
    // ── Happy-path: remove_partial_freeze ───────────────────────────────────────
    it("remove_partial_freeze: closes the frozen_balance PDA for a token account", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      const frozenBalancePda = freezePdaUtils.frozenBalancePda(mint, tokenAccount);

      // ── First: partially freeze the account ──────────────────────────────────
      const frozenBalance = new anchor.BN(500_000_000);
      await partiallyFreezeAccount({ authority, mint, account: tokenAccount }, { balance: frozenBalance });

      const statusAfterFreeze = await getFrozenBalanceByPda(frozenBalancePda);
      assert.isNotNull(statusAfterFreeze, "frozen_balance PDA should exist after partially_freeze_account");

      // ── Then: remove the partial freeze ──────────────────────────────────────
      const { signature } = await removePartialFreeze({ authority, mint, account: tokenAccount });

      // ── Verify the frozen_balance PDA has been closed ────────────────────────
      const statusAfterRemove = await getFrozenBalanceByPda(frozenBalancePda);
      assert.isNull(statusAfterRemove, "frozen_balance PDA should not exist after remove_partial_freeze");

      const event = await getAccountPartialFreezeRemovedEvent(signature);

      assert.isNotNull(event, "Account partial freeze removed event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58(), "event operator should match authority");
    });

    // ── Error case: remove_partial_freeze — MissingRole ─────────────────────────
    it("remove_partial_freeze: fails with MissingRole when authority doesn't have required role", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // ── Partially freeze the account so frozen_balance_pda exists ────────────
      await partiallyFreezeAccount({ authority, mint, account: tokenAccount });
      await setRoles(mint, authority.publicKey, []);

      try {
        await removePartialFreeze({ authority, mint, account: tokenAccount });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: remove_partial_freeze — MintPaused ──────────────────────────
    it("remove_partial_freeze: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await partiallyFreezeAccount({ authority, mint, account: tokenAccount });
      await setMintPaused(mint, true);

      try {
        await removePartialFreeze({ authority, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: remove_partial_freeze — Deactivated ─────────────────────────
    it("remove_partial_freeze: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await partiallyFreezeAccount({ authority, mint, account: tokenAccount });
      await setDeactivateMarker(mint);

      try {
        await removePartialFreeze({ authority, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: remove_partial_freeze — FunctionalityNotSupportedError ──────
    it("remove_partial_freeze: fails with FunctionalityNotSupportedError when the remove_partial_freeze functionality is not enabled", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await partiallyFreezeAccount({ authority, mint, account: tokenAccount });

      // Re-seed the asset-class version WITH partially_freeze_account (needed for the
      // fixture above) but WITHOUT remove_partial_freeze.
      await setAssetClassVersionForMint(mint, { functionalities: [FREEZE_PARTIALLY_FREEZE_ACCOUNT] });

      try {
        await removePartialFreeze({ authority, mint, account: tokenAccount });
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

    // ── Error case: remove_partial_freeze — AssetClassVersionNotFinalized ───────
    it("remove_partial_freeze: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await partiallyFreezeAccount({ authority, mint, account: tokenAccount });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [FREEZE_REMOVE_PARTIAL_FREEZE],
      });

      try {
        await removePartialFreeze({ authority, mint, account: tokenAccount });
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

  describe("partially_freeze_account account", async () => {
    // ── Error case: partially_freeze_account — Deactivated ──────────────────────
    it("partially_freeze_account: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setDeactivateMarker(mint);

      try {
        await partiallyFreezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── partially_freeze_account overwrites without prior unfreeze ──
    it("partially_freeze_account: a second call on the same account overwrites the balance without remove_partial_freeze", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      const [frozenBalancePda, expectedBump] = freezePdaUtils.frozenBalancePdaWithBump(mint, tokenAccount);
      const FIRST_BALANCE = new anchor.BN(500_000_000);
      const SECOND_BALANCE = new anchor.BN(300_000_000);

      // ── First call: creates the PDA with FIRST_BALANCE ───────────────────────
      await partiallyFreezeAccount({ authority, mint, account: tokenAccount }, { balance: FIRST_BALANCE });

      const stateAfterFirst = await getFrozenBalanceByPda(frozenBalancePda);
      assert.equal(
        stateAfterFirst.balance.toString(),
        FIRST_BALANCE.toString(),
        "balance after first call should equal FIRST_BALANCE"
      );

      // ── Second call (same PDA, new value): MUST overwrite, NOT fail ──────────
      await partiallyFreezeAccount({ authority, mint, account: tokenAccount }, { balance: SECOND_BALANCE });
      const stateAfterSecond = await getFrozenBalanceByPda(frozenBalancePda);

      assert.equal(
        stateAfterSecond.balance.toString(),
        SECOND_BALANCE.toString(),
        "balance after second call should overwrite to SECOND_BALANCE (not add, not keep first)"
      );
      assert.equal(stateAfterSecond.bump, expectedBump, "bump should remain the canonical bump after overwrite");
    });
  });
});
