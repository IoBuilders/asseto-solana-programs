import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy/deploy_instruction_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import {
  freezeAccount,
  freezeAccountPartial,
  unfreezeAccountPartial,
  unfreezeAccount,
  batchFreezeAccount,
  batchFreezeAccountPartial,
  batchUnfreezeAccount,
  batchUnfreezeAccountPartial,
  getAccountFrozenEvent,
  getAccountFrozenEvents,
  getAccountUnfrozenEvent,
  getAccountUnfrozenEvents,
  getAccountPartiallyFrozenEvent,
  getAccountPartiallyFrozenEvents,
  getAccountPartialFreezeRemovedEvent,
  getAccountPartialFreezeRemovedEvents,
} from "./program_helpers/freeze/freeze_instruction_helper";
import { getFreezeStateByPda } from "./program_helpers/freeze/freeze_pda_helper";
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
    it("freeze_account: creates the freeze_state PDA for a token account", async () => {
      // ── Create a token account to use as the freeze target ──────────────────
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // ── Verify the PDA does not exist before the instruction ────────────────
      const [freezeStatePda, expectedBump] = freezePdaUtils.freezeStatePdaWithBump(mint, tokenAccount);
      const statusBefore = await getFreezeStateByPda(freezeStatePda);

      // ── Call freeze_account ──────────────────────────────────────────────────
      const { signature } = await freezeAccount({ authority, mint, account: tokenAccount });

      // ── Verify the freeze_state PDA was created with the correct bump ──────
      const statusAfter = await getFreezeStateByPda(freezeStatePda);
      assert.isNull(statusBefore, "freeze_state PDA should not exist before freeze_account");
      assert.isNotNull(statusAfter, "freeze_state PDA should exist after freeze_account");
      assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");
      assert.isTrue(statusAfter.fullyFrozen, "fullyFrozen should be set after freeze_account");
      assert.equal(statusAfter.frozenBalance.toString(), "0", "frozenBalance should stay 0");

      const event = await getAccountFrozenEvent(signature);

      assert.isNotNull(event, "Account frozen event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58(), "event operator should match authority");
    });

    // ── Error case: freeze_account — already frozen ─────────────────────────────
    it("freeze_account: fails with AccountFrozen when account is already frozen", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // ── Freeze the account once (succeeds) ───────────────────────────────────
      await freezeAccount({ authority, mint, account: tokenAccount });

      // ── Attempt to freeze again — the full-freeze side is already set ────────
      try {
        await freezeAccount({ authority, mint, account: tokenAccount });
        assert.fail("Expected AccountFrozen error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "AccountFrozen", "error code should be AccountFrozen");
      }
    });

    // ── Happy-path: unfreeze_account ─────────────────────────────────────────────
    it("unfreeze_account: closes the freeze_state PDA for a token account", async () => {
      const { mint } = await deployMint();
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);

      // ── Create a token account to use as the freeze target ──────────────────
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // ── First: freeze the account ────────────────────────────────────────────
      const freezeStatePda = freezePdaUtils.freezeStatePda(mint, tokenAccount);
      await freezeAccount({ authority, mint, account: tokenAccount });

      const statusAfterFreeze = await getFreezeStateByPda(freezeStatePda);
      assert.isNotNull(statusAfterFreeze, "freeze_state PDA should exist after freeze_account");

      // ── Then: unfreeze the account ───────────────────────────────────────────
      const { signature } = await unfreezeAccount({ authority, mint, account: tokenAccount });

      // ── Verify the freeze_state PDA has been closed ────────────────────────
      const statusAfterUnfreeze = await getFreezeStateByPda(freezeStatePda);

      assert.isNull(statusAfterUnfreeze, "freeze_state PDA should not exist after unfreeze_account");

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

  describe("batch_freeze_account", () => {
    // ── Happy-path: batch_freeze_account ─────────────────────────────────────────────────
    it("batch_freeze_account: creates a freeze_state PDA for every account and emits one event each", async () => {
      const accountA = await createTokenAccount({ mint, owner: authority.publicKey });
      const accountB = await createTokenAccount({ mint, owner: authority.publicKey });
      const accounts = [accountA, accountB];

      const signature = await batchFreezeAccount({ authority, mint, accounts });

      for (const account of accounts) {
        const status = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
        assert.isNotNull(status, `freeze_state PDA should exist for ${account.toBase58()}`);
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

    // ── Happy-path: batch_freeze_account — griefed PDA (create-or-adopt) ────────────────
    it("batch_freeze_account: succeeds even if a freeze_state_pda was pre-funded by a griefer (create-or-adopt)", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const pda = freezePdaUtils.freezeStatePda(mint, account);

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
      await batchFreezeAccount({ authority, mint, accounts: [account] });

      const status = await getFreezeStateByPda(pda);
      assert.isNotNull(status, "freeze_state PDA should exist despite the pre-funding griefing attempt");
    });

    // ── Error case: batch_freeze_account — EmptyBatch ───────────────────────────────────
    it("batch_freeze_account: fails with EmptyBatch when no accounts are passed", async () => {
      try {
        await batchFreezeAccount({ authority, mint, accounts: [] });
        assert.fail("Expected EmptyBatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "EmptyBatch", "error code should be EmptyBatch");
      }
    });

    // ── Error case: batch_freeze_account — InvalidRemainingAccounts ─────────────────────
    it("batch_freeze_account: fails with InvalidRemainingAccounts when the remaining accounts are not paired", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });

      try {
        await batchFreezeAccount(
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

    // ── Error case: batch_freeze_account — FreezeStatePdaMismatch ─────────────────────
    it("batch_freeze_account: fails with FreezeStatePdaMismatch when a supplied PDA does not match the derived one", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const wrongPda = Keypair.generate().publicKey;

      try {
        await batchFreezeAccount(
          { authority, mint, accounts: [account] },
          {
            remainingAccounts: [
              { pubkey: account, isWritable: false, isSigner: false },
              { pubkey: wrongPda, isWritable: true, isSigner: false },
            ],
          }
        );
        assert.fail("Expected FreezeStatePdaMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FreezeStatePdaMismatch",
          "error code should be FreezeStatePdaMismatch"
        );
      }
    });

    // ── Error case: batch_freeze_account — AccountFrozen (already frozen) ───────────────
    it("batch_freeze_account: fails with AccountFrozen when an account is already frozen", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account });

      try {
        await batchFreezeAccount({ authority, mint, accounts: [account] });
        assert.fail("Expected AccountFrozen error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "AccountFrozen", "error code should be AccountFrozen");
      }
    });

    // ── Error case: batch_freeze_account — MissingRole ───────────────────────────────────
    it("batch_freeze_account: fails with MissingRole when authority doesn't have required role", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setRoles(mint, authority.publicKey, []);

      try {
        await batchFreezeAccount({ authority, mint, accounts: [account] });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: batch_freeze_account — MintPaused ───────────────────────────────────
    it("batch_freeze_account: fails with MintPaused when mint is paused", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setMintPaused(mint, true);

      try {
        await batchFreezeAccount({ authority, mint, accounts: [account] });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: batch_freeze_account — Deactivated ──────────────────────────────────
    it("batch_freeze_account: fails with Deactivated when mint has been deactivated", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setDeactivateMarker(mint);

      try {
        await batchFreezeAccount({ authority, mint, accounts: [account] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: batch_freeze_account — FunctionalityNotSupportedError ───────────────
    it("batch_freeze_account: fails with FunctionalityNotSupportedError when the freeze_account functionality is not enabled", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await batchFreezeAccount({ authority, mint, accounts: [account] });
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

  describe("batch_unfreeze_account", () => {
    // ── Happy-path: batch_unfreeze_account ───────────────────────────────────────────────
    it("batch_unfreeze_account: closes the freeze_state PDA for every account and emits one event each", async () => {
      const accountA = await createTokenAccount({ mint, owner: authority.publicKey });
      const accountB = await createTokenAccount({ mint, owner: authority.publicKey });
      const accounts = [accountA, accountB];
      await batchFreezeAccount({ authority, mint, accounts });

      const signature = await batchUnfreezeAccount({ authority, mint, accounts });

      for (const account of accounts) {
        const status = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
        assert.isNull(status, `freeze_state PDA should not exist for ${account.toBase58()}`);
      }

      const events = await getAccountUnfrozenEvents(signature);
      assert.equal(events.length, accounts.length, "one AccountUnfrozen event should be emitted per account");
      for (const account of accounts) {
        const event = events.find((e) => e.account.toBase58() === account.toBase58());
        assert.isDefined(event, `an AccountUnfrozen event should be emitted for ${account.toBase58()}`);
        assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
        assert.equal(
          event!.operator.toBase58(),
          authority.publicKey.toBase58(),
          "event operator should match authority"
        );
      }
    });

    // ── Error case: batch_unfreeze_account — EmptyBatch ─────────────────────────────────
    it("batch_unfreeze_account: fails with EmptyBatch when no accounts are passed", async () => {
      try {
        await batchUnfreezeAccount({ authority, mint, accounts: [] });
        assert.fail("Expected EmptyBatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "EmptyBatch", "error code should be EmptyBatch");
      }
    });

    // ── Error case: batch_unfreeze_account — InvalidRemainingAccounts ───────────────────
    it("batch_unfreeze_account: fails with InvalidRemainingAccounts when the remaining accounts are not paired", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccount({ authority, mint, accounts: [account] });

      try {
        await batchUnfreezeAccount(
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

    // ── Error case: batch_unfreeze_account — FreezeStatePdaMismatch ───────────────────
    it("batch_unfreeze_account: fails with FreezeStatePdaMismatch when a supplied PDA does not match the derived one", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccount({ authority, mint, accounts: [account] });
      const wrongPda = Keypair.generate().publicKey;

      try {
        await batchUnfreezeAccount(
          { authority, mint, accounts: [account] },
          {
            remainingAccounts: [
              { pubkey: account, isWritable: false, isSigner: false },
              { pubkey: wrongPda, isWritable: true, isSigner: false },
            ],
          }
        );
        assert.fail("Expected FreezeStatePdaMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FreezeStatePdaMismatch",
          "error code should be FreezeStatePdaMismatch"
        );
      }
    });

    // ── Error case: batch_unfreeze_account — AccountNotFrozen ───────────────────────────
    it("batch_unfreeze_account: fails with AccountNotFrozen when an account is not frozen", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });

      try {
        await batchUnfreezeAccount({ authority, mint, accounts: [account] });
        assert.fail("Expected AccountNotFrozen error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "AccountNotFrozen", "error code should be AccountNotFrozen");
      }
    });

    // ── Error case: batch_unfreeze_account — MissingRole ────────────────────────────────
    it("batch_unfreeze_account: fails with MissingRole when authority doesn't have required role", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccount({ authority, mint, accounts: [account] });
      await setRoles(mint, authority.publicKey, []);

      try {
        await batchUnfreezeAccount({ authority, mint, accounts: [account] });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: batch_unfreeze_account — MintPaused ─────────────────────────────────
    it("batch_unfreeze_account: fails with MintPaused when mint is paused", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccount({ authority, mint, accounts: [account] });
      await setMintPaused(mint, true);

      try {
        await batchUnfreezeAccount({ authority, mint, accounts: [account] });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: batch_unfreeze_account — Deactivated ────────────────────────────────
    it("batch_unfreeze_account: fails with Deactivated when mint has been deactivated", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccount({ authority, mint, accounts: [account] });
      await setDeactivateMarker(mint);

      try {
        await batchUnfreezeAccount({ authority, mint, accounts: [account] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: batch_unfreeze_account — FunctionalityNotSupportedError ────────────
    it("batch_unfreeze_account: fails with FunctionalityNotSupportedError when the unfreeze_account functionality is not enabled", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccount({ authority, mint, accounts: [account] });
      await setAssetClassVersionForMint(mint, { functionalities: [FREEZE_FREEZE_ACCOUNT] });

      try {
        await batchUnfreezeAccount({ authority, mint, accounts: [account] });
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

  describe("freeze_account_partial", () => {
    // ── Happy-path: freeze_account_partial ────────────────────────────────────
    it("freeze_account_partial: creates the freeze_state PDA with the given balance", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      const [freezeStatePda, expectedBump] = freezePdaUtils.freezeStatePdaWithBump(mint, tokenAccount);

      // ── Verify the PDA does not exist before the instruction ─────────────────
      const statusBefore = await getFreezeStateByPda(freezeStatePda);

      // ── Call freeze_account_partial ─────────────────────────────────────────
      const frozenBalance = new anchor.BN(500_000_000);
      const { signature } = await freezeAccountPartial(
        { authority, mint, account: tokenAccount },
        { balance: frozenBalance }
      );

      // ── Verify the freeze_state PDA was created with the correct fields ─────
      const statusAfter = await getFreezeStateByPda(freezeStatePda);

      assert.isNull(statusBefore, "freeze_state PDA should not exist before freeze_account_partial");
      assert.isNotNull(statusAfter, "freeze_state PDA should exist after freeze_account_partial");
      assert.equal(
        statusAfter.frozenBalance.toString(),
        frozenBalance.toString(),
        "balance should match the value passed to freeze_account_partial"
      );
      assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");
      assert.isFalse(statusAfter.fullyFrozen, "freeze_account_partial should not set the full-freeze side");

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

    // ── Error case: freeze_account_partial — MissingRole ──────────────────────
    it("freeze_account_partial: fails with MissingRole when authority doesn't have required role", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setRoles(mint, authority.publicKey, []);

      try {
        await freezeAccountPartial({ authority, mint, account: tokenAccount });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: freeze_account_partial — MintPaused ───────────────────────
    it("freeze_account_partial: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setMintPaused(mint, true);

      try {
        await freezeAccountPartial({ authority, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: freeze_account_partial — FunctionalityNotSupportedError ───
    it("freeze_account_partial: fails with FunctionalityNotSupportedError when the freeze_account_partial functionality is not enabled", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // Re-seed the asset-class version WITHOUT the freeze_account_partial functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await freezeAccountPartial({ authority, mint, account: tokenAccount });
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

    // ── Error case: freeze_account_partial — AssetClassVersionNotFinalized ────
    it("freeze_account_partial: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [FREEZE_PARTIALLY_FREEZE_ACCOUNT],
      });

      try {
        await freezeAccountPartial({ authority, mint, account: tokenAccount });
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

  describe("batch_freeze_account_partial", () => {
    // ── Happy-path: batch_freeze_account_partial ──────────────────────────────────────
    it("batch_freeze_account_partial: creates a freeze_state PDA with the given balance for every account", async () => {
      const accountA = await createTokenAccount({ mint, owner: authority.publicKey });
      const accountB = await createTokenAccount({ mint, owner: authority.publicKey });
      const accounts = [accountA, accountB];
      const balances = [new anchor.BN(500_000_000), new anchor.BN(300_000_000)];

      const signature = await batchFreezeAccountPartial({ authority, mint, accounts }, { balances });

      for (let i = 0; i < accounts.length; i++) {
        const status = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, accounts[i]));
        assert.isNotNull(status, `freeze_state PDA should exist for account ${i}`);
        assert.equal(status.frozenBalance.toString(), balances[i].toString(), `balance should match for account ${i}`);
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
        assert.equal(
          event!.operator.toBase58(),
          authority.publicKey.toBase58(),
          "event operator should match authority"
        );
      }
    });

    // ── Happy-path: batch_freeze_account_partial overwrites without a prior remove ────
    it("batch_freeze_account_partial: a second call on the same accounts overwrites the balance without unfreeze_account_partial", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const freezeStatePda = freezePdaUtils.freezeStatePda(mint, account);
      const FIRST_BALANCE = new anchor.BN(500_000_000);
      const SECOND_BALANCE = new anchor.BN(300_000_000);

      await batchFreezeAccountPartial({ authority, mint, accounts: [account] }, { balances: [FIRST_BALANCE] });
      const stateAfterFirst = await getFreezeStateByPda(freezeStatePda);
      assert.equal(stateAfterFirst.frozenBalance.toString(), FIRST_BALANCE.toString());

      await batchFreezeAccountPartial({ authority, mint, accounts: [account] }, { balances: [SECOND_BALANCE] });
      const stateAfterSecond = await getFreezeStateByPda(freezeStatePda);
      assert.equal(
        stateAfterSecond.frozenBalance.toString(),
        SECOND_BALANCE.toString(),
        "balance after second call should overwrite to SECOND_BALANCE"
      );
    });

    // ── Happy-path: batch_freeze_account_partial — griefed PDA (create-or-adopt) ──────
    it("batch_freeze_account_partial: succeeds even if a freeze_state_pda was pre-funded by a griefer (create-or-adopt)", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const pda = freezePdaUtils.freezeStatePda(mint, account);

      await surfnetSetAccount(pda, {
        lamports: 1,
        owner: SYSTEM_PROGRAM_ID.toBase58(),
        data: "",
        executable: false,
        rentEpoch: 0,
      });

      const balance = new anchor.BN(500_000_000);
      await batchFreezeAccountPartial({ authority, mint, accounts: [account] }, { balances: [balance] });

      const status = await getFreezeStateByPda(pda);
      assert.isNotNull(status, "freeze_state PDA should exist despite the pre-funding griefing attempt");
      assert.equal(status.frozenBalance.toString(), balance.toString());
    });

    // ── Error case: batch_freeze_account_partial — EmptyBatch ─────────────────────────
    it("batch_freeze_account_partial: fails with EmptyBatch when no accounts are passed", async () => {
      try {
        await batchFreezeAccountPartial({ authority, mint, accounts: [] }, { balances: [] });
        assert.fail("Expected EmptyBatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "EmptyBatch", "error code should be EmptyBatch");
      }
    });

    // ── Error case: batch_freeze_account_partial — InvalidRemainingAccounts ───────────
    it("batch_freeze_account_partial: fails with InvalidRemainingAccounts when the remaining accounts don't match the balances", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });

      try {
        await batchFreezeAccountPartial(
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

    // ── Error case: batch_freeze_account_partial — FreezeStatePdaMismatch ───────────
    it("batch_freeze_account_partial: fails with FreezeStatePdaMismatch when a supplied PDA does not match the derived one", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      const wrongPda = Keypair.generate().publicKey;

      try {
        await batchFreezeAccountPartial(
          { authority, mint, accounts: [account] },
          {
            remainingAccounts: [
              { pubkey: account, isWritable: false, isSigner: false },
              { pubkey: wrongPda, isWritable: true, isSigner: false },
            ],
          }
        );
        assert.fail("Expected FreezeStatePdaMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FreezeStatePdaMismatch",
          "error code should be FreezeStatePdaMismatch"
        );
      }
    });

    // ── Error case: batch_freeze_account_partial — MissingRole ────────────────────────
    it("batch_freeze_account_partial: fails with MissingRole when authority doesn't have required role", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setRoles(mint, authority.publicKey, []);

      try {
        await batchFreezeAccountPartial({ authority, mint, accounts: [account] });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: batch_freeze_account_partial — MintPaused ─────────────────────────
    it("batch_freeze_account_partial: fails with MintPaused when mint is paused", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setMintPaused(mint, true);

      try {
        await batchFreezeAccountPartial({ authority, mint, accounts: [account] });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: batch_freeze_account_partial — Deactivated ────────────────────────
    it("batch_freeze_account_partial: fails with Deactivated when mint has been deactivated", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setDeactivateMarker(mint);

      try {
        await batchFreezeAccountPartial({ authority, mint, accounts: [account] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: batch_freeze_account_partial — FunctionalityNotSupportedError ────
    it("batch_freeze_account_partial: fails with FunctionalityNotSupportedError when the freeze_account_partial functionality is not enabled", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await batchFreezeAccountPartial({ authority, mint, accounts: [account] });
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

  describe("batch_unfreeze_account_partial", () => {
    // ── Happy-path: batch_unfreeze_account_partial ─────────────────────────────────
    it("batch_unfreeze_account_partial: closes the freeze_state PDA for every account and emits one event each", async () => {
      const accountA = await createTokenAccount({ mint, owner: authority.publicKey });
      const accountB = await createTokenAccount({ mint, owner: authority.publicKey });
      const accounts = [accountA, accountB];
      await batchFreezeAccountPartial({ authority, mint, accounts });

      const signature = await batchUnfreezeAccountPartial({ authority, mint, accounts });

      for (const account of accounts) {
        const status = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
        assert.isNull(status, `freeze_state PDA should not exist for ${account.toBase58()}`);
      }

      const events = await getAccountPartialFreezeRemovedEvents(signature);
      assert.equal(
        events.length,
        accounts.length,
        "one AccountPartialFreezeRemoved event should be emitted per account"
      );
      for (const account of accounts) {
        const event = events.find((e) => e.account.toBase58() === account.toBase58());
        assert.isDefined(event, `an AccountPartialFreezeRemoved event should be emitted for ${account.toBase58()}`);
        assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
        assert.equal(
          event!.operator.toBase58(),
          authority.publicKey.toBase58(),
          "event operator should match authority"
        );
      }
    });

    // ── Error case: batch_unfreeze_account_partial — EmptyBatch ────────────────────
    it("batch_unfreeze_account_partial: fails with EmptyBatch when no accounts are passed", async () => {
      try {
        await batchUnfreezeAccountPartial({ authority, mint, accounts: [] });
        assert.fail("Expected EmptyBatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "EmptyBatch", "error code should be EmptyBatch");
      }
    });

    // ── Error case: batch_unfreeze_account_partial — InvalidRemainingAccounts ──────
    it("batch_unfreeze_account_partial: fails with InvalidRemainingAccounts when the remaining accounts are not paired", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccountPartial({ authority, mint, accounts: [account] });

      try {
        await batchUnfreezeAccountPartial(
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

    // ── Error case: batch_unfreeze_account_partial — FreezeStatePdaMismatch ──────
    it("batch_unfreeze_account_partial: fails with FreezeStatePdaMismatch when a supplied PDA does not match the derived one", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccountPartial({ authority, mint, accounts: [account] });
      const wrongPda = Keypair.generate().publicKey;

      try {
        await batchUnfreezeAccountPartial(
          { authority, mint, accounts: [account] },
          {
            remainingAccounts: [
              { pubkey: account, isWritable: false, isSigner: false },
              { pubkey: wrongPda, isWritable: true, isSigner: false },
            ],
          }
        );
        assert.fail("Expected FreezeStatePdaMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FreezeStatePdaMismatch",
          "error code should be FreezeStatePdaMismatch"
        );
      }
    });

    // ── Error case: batch_unfreeze_account_partial — AccountNotPartiallyFrozen ─────
    it("batch_unfreeze_account_partial: fails with AccountNotPartiallyFrozen when an account is not partially frozen", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });

      try {
        await batchUnfreezeAccountPartial({ authority, mint, accounts: [account] });
        assert.fail("Expected AccountNotPartiallyFrozen error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AccountNotPartiallyFrozen",
          "error code should be AccountNotPartiallyFrozen"
        );
      }
    });

    // ── Error case: batch_unfreeze_account_partial — MissingRole ───────────────────
    it("batch_unfreeze_account_partial: fails with MissingRole when authority doesn't have required role", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccountPartial({ authority, mint, accounts: [account] });
      await setRoles(mint, authority.publicKey, []);

      try {
        await batchUnfreezeAccountPartial({ authority, mint, accounts: [account] });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: batch_unfreeze_account_partial — MintPaused ────────────────────
    it("batch_unfreeze_account_partial: fails with MintPaused when mint is paused", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccountPartial({ authority, mint, accounts: [account] });
      await setMintPaused(mint, true);

      try {
        await batchUnfreezeAccountPartial({ authority, mint, accounts: [account] });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: batch_unfreeze_account_partial — Deactivated ───────────────────
    it("batch_unfreeze_account_partial: fails with Deactivated when mint has been deactivated", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccountPartial({ authority, mint, accounts: [account] });
      await setDeactivateMarker(mint);

      try {
        await batchUnfreezeAccountPartial({ authority, mint, accounts: [account] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: batch_unfreeze_account_partial — FunctionalityNotSupportedError ─
    it("batch_unfreeze_account_partial: fails with FunctionalityNotSupportedError when the unfreeze_account_partial functionality is not enabled", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await batchFreezeAccountPartial({ authority, mint, accounts: [account] });
      await setAssetClassVersionForMint(mint, { functionalities: [FREEZE_PARTIALLY_FREEZE_ACCOUNT] });

      try {
        await batchUnfreezeAccountPartial({ authority, mint, accounts: [account] });
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

  describe("unfreeze_account_partial", async () => {
    // ── Happy-path: unfreeze_account_partial ───────────────────────────────────────
    it("unfreeze_account_partial: closes the freeze_state PDA for a token account", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      const freezeStatePda = freezePdaUtils.freezeStatePda(mint, tokenAccount);

      // ── First: partially freeze the account ──────────────────────────────────
      const frozenBalance = new anchor.BN(500_000_000);
      await freezeAccountPartial({ authority, mint, account: tokenAccount }, { balance: frozenBalance });

      const statusAfterFreeze = await getFreezeStateByPda(freezeStatePda);
      assert.isNotNull(statusAfterFreeze, "freeze_state PDA should exist after freeze_account_partial");

      // ── Then: remove the partial freeze ──────────────────────────────────────
      const { signature } = await unfreezeAccountPartial({ authority, mint, account: tokenAccount });

      // ── Verify the freeze_state PDA has been closed ────────────────────────
      const statusAfterRemove = await getFreezeStateByPda(freezeStatePda);
      assert.isNull(statusAfterRemove, "freeze_state PDA should not exist after unfreeze_account_partial");

      const event = await getAccountPartialFreezeRemovedEvent(signature);

      assert.isNotNull(event, "Account partial freeze removed event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58(), "event operator should match authority");
    });

    // ── Error case: unfreeze_account_partial — MissingRole ─────────────────────────
    it("unfreeze_account_partial: fails with MissingRole when authority doesn't have required role", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // ── Partially freeze the account so freeze_state_pda exists ────────────
      await freezeAccountPartial({ authority, mint, account: tokenAccount });
      await setRoles(mint, authority.publicKey, []);

      try {
        await unfreezeAccountPartial({ authority, mint, account: tokenAccount });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    // ── Error case: unfreeze_account_partial — MintPaused ──────────────────────────
    it("unfreeze_account_partial: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccountPartial({ authority, mint, account: tokenAccount });
      await setMintPaused(mint, true);

      try {
        await unfreezeAccountPartial({ authority, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: unfreeze_account_partial — Deactivated ─────────────────────────
    it("unfreeze_account_partial: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccountPartial({ authority, mint, account: tokenAccount });
      await setDeactivateMarker(mint);

      try {
        await unfreezeAccountPartial({ authority, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── Error case: unfreeze_account_partial — FunctionalityNotSupportedError ──────
    it("unfreeze_account_partial: fails with FunctionalityNotSupportedError when the unfreeze_account_partial functionality is not enabled", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccountPartial({ authority, mint, account: tokenAccount });

      // Re-seed the asset-class version WITH freeze_account_partial (needed for the
      // fixture above) but WITHOUT unfreeze_account_partial.
      await setAssetClassVersionForMint(mint, { functionalities: [FREEZE_PARTIALLY_FREEZE_ACCOUNT] });

      try {
        await unfreezeAccountPartial({ authority, mint, account: tokenAccount });
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

    // ── Error case: unfreeze_account_partial — AssetClassVersionNotFinalized ───────
    it("unfreeze_account_partial: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccountPartial({ authority, mint, account: tokenAccount });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [FREEZE_REMOVE_PARTIAL_FREEZE],
      });

      try {
        await unfreezeAccountPartial({ authority, mint, account: tokenAccount });
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

  describe("freeze_account_partial account", async () => {
    // ── Error case: freeze_account_partial — Deactivated ──────────────────────
    it("freeze_account_partial: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setDeactivateMarker(mint);

      try {
        await freezeAccountPartial({ authority, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── freeze_account_partial overwrites without prior unfreeze ──
    it("freeze_account_partial: a second call on the same account overwrites the balance without unfreeze_account_partial", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      const [freezeStatePda, expectedBump] = freezePdaUtils.freezeStatePdaWithBump(mint, tokenAccount);
      const FIRST_BALANCE = new anchor.BN(500_000_000);
      const SECOND_BALANCE = new anchor.BN(300_000_000);

      // ── First call: creates the PDA with FIRST_BALANCE ───────────────────────
      await freezeAccountPartial({ authority, mint, account: tokenAccount }, { balance: FIRST_BALANCE });

      const stateAfterFirst = await getFreezeStateByPda(freezeStatePda);
      assert.equal(
        stateAfterFirst.frozenBalance.toString(),
        FIRST_BALANCE.toString(),
        "balance after first call should equal FIRST_BALANCE"
      );

      // ── Second call (same PDA, new value): MUST overwrite, NOT fail ──────────
      await freezeAccountPartial({ authority, mint, account: tokenAccount }, { balance: SECOND_BALANCE });
      const stateAfterSecond = await getFreezeStateByPda(freezeStatePda);

      assert.equal(
        stateAfterSecond.frozenBalance.toString(),
        SECOND_BALANCE.toString(),
        "balance after second call should overwrite to SECOND_BALANCE (not add, not keep first)"
      );
      assert.equal(stateAfterSecond.bump, expectedBump, "bump should remain the canonical bump after overwrite");
    });
  });

  // Both freeze sides live in one `freeze_state` PDA. Clearing one side must never
  // destroy the other, and the account is only closed once both are clear.
  describe("freeze_state: full and partial freeze share one account", () => {
    const PARTIAL = new anchor.BN(250_000_000);

    async function freezeBoth(account: PublicKey): Promise<void> {
      await freezeAccount({ authority, mint, account });
      await freezeAccountPartial({ authority, mint, account }, { balance: PARTIAL });
    }

    async function expectAnchorError(code: string, fn: () => Promise<unknown>): Promise<void> {
      try {
        await fn();
        assert.fail(`Expected ${code} error but instruction succeeded`);
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, code, `error code should be ${code}`);
      }
    }

    it("freeze_account then freeze_account_partial: both sides are recorded in the same PDA", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeBoth(account);

      const state = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
      assert.isTrue(state.fullyFrozen, "full-freeze side should be set");
      assert.equal(state.frozenBalance.toString(), PARTIAL.toString(), "partial balance should be kept");
    });

    it("freeze_account_partial then freeze_account: the full freeze keeps the existing partial balance", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccountPartial({ authority, mint, account }, { balance: PARTIAL });
      await freezeAccount({ authority, mint, account });

      const state = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
      assert.isTrue(state.fullyFrozen, "full-freeze side should be set");
      assert.equal(state.frozenBalance.toString(), PARTIAL.toString(), "partial balance should be untouched");
    });

    it("unfreeze_account on a fully and partially frozen account keeps the partial freeze and the PDA", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeBoth(account);

      await unfreezeAccount({ authority, mint, account });

      const state = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
      assert.isNotNull(state, "PDA must not be closed while the partial freeze is still active");
      assert.isFalse(state.fullyFrozen, "full-freeze side should be cleared");
      assert.equal(state.frozenBalance.toString(), PARTIAL.toString(), "partial balance must survive unfreeze_account");
    });

    it("unfreeze_account_partial on a fully and partially frozen account keeps the full freeze and the PDA", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeBoth(account);

      await unfreezeAccountPartial({ authority, mint, account });

      const state = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
      assert.isNotNull(state, "PDA must not be closed while the full freeze is still active");
      assert.isTrue(state.fullyFrozen, "full-freeze side must survive unfreeze_account_partial");
      assert.equal(state.frozenBalance.toString(), "0", "partial balance should be reset to 0");
    });

    it("clearing both sides (in either order) closes the PDA and refunds its rent to the authority", async () => {
      const accountA = await createTokenAccount({ mint, owner: authority.publicKey });
      const accountB = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeBoth(accountA);
      await freezeBoth(accountB);

      await unfreezeAccount({ authority, mint, account: accountA });
      await unfreezeAccountPartial({ authority, mint, account: accountA });

      const pdaB = freezePdaUtils.freezeStatePda(mint, accountB);
      await unfreezeAccountPartial({ authority, mint, account: accountB });
      const rent = await provider.connection.getBalance(pdaB, "confirmed");
      const authorityBefore = await provider.connection.getBalance(authority.publicKey, "confirmed");
      const { signature } = await unfreezeAccount({ authority, mint, account: accountB });
      const authorityAfter = await provider.connection.getBalance(authority.publicKey, "confirmed");
      const tx = await provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      assert.isNull(await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, accountA)), "PDA A should be closed");
      assert.isNull(await getFreezeStateByPda(pdaB), "PDA B should be closed");
      assert.equal(
        authorityAfter - authorityBefore,
        rent - (tx?.meta?.fee ?? 0),
        "closing the PDA should refund its rent to the authority"
      );
    });

    it("freeze_account_partial: fails with InvalidFreezeAmount when the balance is 0", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });

      await expectAnchorError("InvalidFreezeAmount", () =>
        freezeAccountPartial({ authority, mint, account }, { balance: new anchor.BN(0) })
      );
      assert.isNull(
        await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account)),
        "a rejected 0-balance partial freeze must not create the PDA"
      );
    });

    it("freeze_account_partial: a 0 balance cannot be used to wipe an existing partial freeze", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccountPartial({ authority, mint, account }, { balance: PARTIAL });

      await expectAnchorError("InvalidFreezeAmount", () =>
        freezeAccountPartial({ authority, mint, account }, { balance: new anchor.BN(0) })
      );
      const state = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
      assert.equal(state.frozenBalance.toString(), PARTIAL.toString(), "the existing partial freeze must be kept");
    });

    it("batch_freeze_account_partial: fails with InvalidFreezeAmount when any balance is 0, freezing nothing", async () => {
      const accountA = await createTokenAccount({ mint, owner: authority.publicKey });
      const accountB = await createTokenAccount({ mint, owner: authority.publicKey });

      await expectAnchorError("InvalidFreezeAmount", () =>
        batchFreezeAccountPartial(
          { authority, mint, accounts: [accountA, accountB] },
          { balances: [PARTIAL, new anchor.BN(0)] }
        )
      );
      for (const account of [accountA, accountB]) {
        assert.isNull(
          await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account)),
          "no entry of a rejected batch should be frozen"
        );
      }
    });

    it("unfreeze_account: fails with AccountNotFrozen when the account is only partially frozen", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccountPartial({ authority, mint, account }, { balance: PARTIAL });

      await expectAnchorError("AccountNotFrozen", () => unfreezeAccount({ authority, mint, account }));

      const state = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
      assert.equal(
        state.frozenBalance.toString(),
        PARTIAL.toString(),
        "the failed unfreeze must leave the partial freeze untouched"
      );
    });

    it("unfreeze_account_partial: fails with AccountNotPartiallyFrozen when the account is only fully frozen", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account });

      await expectAnchorError("AccountNotPartiallyFrozen", () => unfreezeAccountPartial({ authority, mint, account }));

      const state = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
      assert.isTrue(state.fullyFrozen, "the failed partial unfreeze must leave the full freeze untouched");
    });

    it("unfreeze_account_partial: fails with AccountNotInitialized when the account has no freeze at all", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await expectAnchorError("AccountNotInitialized", () => unfreezeAccountPartial({ authority, mint, account }));
    });

    it("batch_freeze_account: freezes an account that is already partially frozen, keeping its balance", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccountPartial({ authority, mint, account }, { balance: PARTIAL });

      await batchFreezeAccount({ authority, mint, accounts: [account] });

      const state = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
      assert.isTrue(state.fullyFrozen, "full-freeze side should be set");
      assert.equal(state.frozenBalance.toString(), PARTIAL.toString(), "partial balance should be untouched");
    });

    it("batch_freeze_account_partial: partially freezes an already frozen account, keeping the full freeze", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account });

      await batchFreezeAccountPartial({ authority, mint, accounts: [account] }, { balances: [PARTIAL] });

      const state = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, account));
      assert.isTrue(state.fullyFrozen, "full-freeze side should survive the partial freeze");
      assert.equal(state.frozenBalance.toString(), PARTIAL.toString(), "partial balance should be recorded");
    });

    it("batch_unfreeze_account: keeps the PDA of a partially frozen entry and closes the PDA of a full-only entry", async () => {
      const both = await createTokenAccount({ mint, owner: authority.publicKey });
      const fullOnly = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeBoth(both);
      await freezeAccount({ authority, mint, account: fullOnly });

      await batchUnfreezeAccount({ authority, mint, accounts: [both, fullOnly] });

      const bothState = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, both));
      assert.isNotNull(bothState, "PDA with a remaining partial freeze must not be closed");
      assert.isFalse(bothState.fullyFrozen, "full-freeze side should be cleared");
      assert.equal(bothState.frozenBalance.toString(), PARTIAL.toString(), "partial balance must survive");
      assert.isNull(
        await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, fullOnly)),
        "PDA with nothing left should be closed"
      );
    });

    it("batch_unfreeze_account_partial: keeps the PDA of a fully frozen entry and closes the PDA of a partial-only entry", async () => {
      const both = await createTokenAccount({ mint, owner: authority.publicKey });
      const partialOnly = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeBoth(both);
      await freezeAccountPartial({ authority, mint, account: partialOnly }, { balance: PARTIAL });

      await batchUnfreezeAccountPartial({ authority, mint, accounts: [both, partialOnly] });

      const bothState = await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, both));
      assert.isNotNull(bothState, "PDA with a remaining full freeze must not be closed");
      assert.isTrue(bothState.fullyFrozen, "full-freeze side must survive");
      assert.equal(bothState.frozenBalance.toString(), "0", "partial side should be cleared");
      assert.isNull(
        await getFreezeStateByPda(freezePdaUtils.freezeStatePda(mint, partialOnly)),
        "PDA with nothing left should be closed"
      );
    });

    it("batch_unfreeze_account: fails with AccountNotFrozen when an entry is only partially frozen", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccountPartial({ authority, mint, account }, { balance: PARTIAL });

      await expectAnchorError("AccountNotFrozen", () => batchUnfreezeAccount({ authority, mint, accounts: [account] }));
    });

    it("batch_unfreeze_account_partial: fails with AccountNotPartiallyFrozen when an entry is only fully frozen", async () => {
      const account = await createTokenAccount({ mint, owner: authority.publicKey });
      await freezeAccount({ authority, mint, account });

      await expectAnchorError("AccountNotPartiallyFrozen", () =>
        batchUnfreezeAccountPartial({ authority, mint, accounts: [account] })
      );
    });
  });
});
