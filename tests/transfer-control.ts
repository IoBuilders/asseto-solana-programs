import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy/deploy_instruction_helper";
import {
  createTokenAccount,
  getTokenAccount,
  mintTokensViaSurfpool,
  setMintPaused,
} from "./program_helpers/spl_token_helper";
import { mintTokens } from "./program_helpers/mint/mint_instruction_helper";
import { splTransfer } from "./program_helpers/transfer_helper";
import {
  addToControlList,
  getAccountRemovedFromControlListEvent,
  getAccountAddedToControlListEvent,
  getTransferControlModeSetEvent,
  removeFromControlList,
  initializeTransferControlMode,
  TRANSFER_CONTROL_WHITELIST,
  TRANSFER_CONTROL_BLACKLIST,
} from "./program_helpers/transfer_control/transfer_control_instruction_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import {
  DEACTIVATE_DEACTIVATE,
  MINT_MINT,
  PAUSE_PAUSE,
  TRANSFER_CONTROL_ADD_TO_CONTROL_LIST,
  TRANSFER_CONTROL_REMOVE_FROM_CONTROL_LIST,
  TRANSFER_CONTROL_INITIALIZE,
  TRANSFER_HOOK_EXECUTE,
} from "./utils/functionalities";
import {
  getTransferMode,
  isInControlList,
  setControlListMarker,
  setTransferControlModeMarker,
  TRANSFER_MODE_BLACKLIST,
  TRANSFER_MODE_NONE,
  TRANSFER_MODE_WHITELIST,
} from "./program_helpers/transfer_control/transfer_control_pda_helper";
import { getAccountCompliance } from "./program_helpers/transfer_hook/transfer_hook_pda_helper";
import { setDeactivated } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_CONTROL_LIST, ROLE_ISSUER } from "./utils/roles";

describe("transfer-control", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const authority = provider.wallet.payer;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint());
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        PAUSE_PAUSE,
        TRANSFER_CONTROL_INITIALIZE,
        TRANSFER_CONTROL_ADD_TO_CONTROL_LIST,
        TRANSFER_CONTROL_REMOVE_FROM_CONTROL_LIST,
        DEACTIVATE_DEACTIVATE,
      ],
    });
    await setRoles(mint, authority.publicKey, [ROLE_CONTROL_LIST]);
  });

  describe("initialize", async () => {
    // ── Happy-path: initialize sets MintCompliance.transfer_mode = Whitelist ───────
    it("initialize: sets the mint's transfer mode to Whitelist", async () => {
      const mode = TRANSFER_CONTROL_WHITELIST;
      assert.equal(await getTransferMode(mint), TRANSFER_MODE_NONE, "no mode should be set before initialize");

      const { signature } = await initializeTransferControlMode({ authority, mint }, { mode });

      assert.equal(await getTransferMode(mint), TRANSFER_MODE_WHITELIST, "mode should be Whitelist");

      const modeSetEvent = await getTransferControlModeSetEvent(signature);
      assert.isNotNull(modeSetEvent, "TransferControlModesSet event should be emitted");
      assert.equal(modeSetEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(
        modeSetEvent!.operator.toBase58(),
        authority.publicKey.toBase58(),
        "event operator should match authority"
      );
      assert.deepEqual(modeSetEvent!.mode, mode, `event mode should be ${mode}`);
    });

    // ── Happy-path: initialize with mode = Blacklist ──────────────────────────────
    it("initialize: sets the mint's transfer mode to Blacklist", async () => {
      const mode = TRANSFER_CONTROL_BLACKLIST;

      const { signature } = await initializeTransferControlMode({ authority, mint }, { mode });

      assert.equal(await getTransferMode(mint), TRANSFER_MODE_BLACKLIST, "mode should be Blacklist");

      const modeSetEvent = await getTransferControlModeSetEvent(signature);
      assert.isNotNull(modeSetEvent, "TransferControlModeSet event should be emitted");
      assert.deepEqual(modeSetEvent!.mode, mode, "event mode should be Blacklist");
    });

    // ── Error case: initialize — mode is immutable once set ───────────────────────
    it("initialize: fails with TransferModeAlreadySet and cannot switch Blacklist to Whitelist", async () => {
      await initializeTransferControlMode({ authority, mint }, { mode: TRANSFER_CONTROL_BLACKLIST });

      try {
        await initializeTransferControlMode({ authority, mint }, { mode: TRANSFER_CONTROL_WHITELIST });
        assert.fail("Expected TransferModeAlreadySet but initialize overwrote the existing mode");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "TransferModeAlreadySet");
      }

      assert.equal(await getTransferMode(mint), TRANSFER_MODE_BLACKLIST, "mode should still be Blacklist");
    });

    // ── Error case: initialize — same mode twice ──────────────────────────────────
    it("initialize: fails with TransferModeAlreadySet when called twice with the same mode", async () => {
      await initializeTransferControlMode({ authority, mint });

      try {
        await initializeTransferControlMode({ authority, mint });
        assert.fail("Expected TransferModeAlreadySet but initialize succeeded twice");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "TransferModeAlreadySet");
      }
    });

    // ── Error case: initialize — MissingRole ──────────────────────────────
    it("initialize: fails with MissingRole when authority doesn't have required role", async () => {
      await setRoles(mint, authority.publicKey, []);

      try {
        await initializeTransferControlMode({ authority, mint });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole");
      }
    });

    // ── Error case: initialize — MintPaused ────────────────────────────────────────
    it("initialize: fails with MintPaused when mint is paused", async () => {
      await setMintPaused(mint, true);

      try {
        await initializeTransferControlMode({ authority, mint });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused");
      }
    });

    // ── Error case: initialize — Deactivated ───────────────────────────────────────
    it("initialize: fails with Deactivated when mint has been deactivated", async () => {
      await setDeactivated(mint);

      try {
        await initializeTransferControlMode({ authority, mint });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated");
      }
    });

    // ── Error case: initialize — FunctionalityNotSupportedError ────────────────────
    it("initialize: fails with FunctionalityNotSupportedError when the initialize functionality is not enabled", async () => {
      // Re-seed the asset-class version WITHOUT the initialize functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await initializeTransferControlMode({ authority, mint });
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

    // ── Error case: initialize — AssetClassVersionNotFinalized ─────────────────────
    it("initialize: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [TRANSFER_CONTROL_INITIALIZE],
      });

      try {
        await initializeTransferControlMode({ authority, mint });
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

  describe("add_to_control_list", async () => {
    // ── Happy-path: add_to_control_list ─────────────────────────────────────────────
    it("add_to_control_list: sets the account's in_control_list flag, creating its AccountCompliance", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      assert.isNull(
        await getAccountCompliance(mint, tokenAccount),
        "no record should exist before add_to_control_list"
      );

      const { signature } = await addToControlList({ authority, mint, account: tokenAccount });

      const record = await getAccountCompliance(mint, tokenAccount);
      assert.isNotNull(record, "AccountCompliance should exist after add_to_control_list");
      assert.equal(record!.inControlList, 1, "in_control_list should be set");
      assert.equal(record!.tokenAccount.toBase58(), tokenAccount.toBase58(), "record should belong to the account");
      assert.equal(record!.fullyFrozen, 0, "other fields should stay clear");

      const addedEvent = await getAccountAddedToControlListEvent(signature);
      assert.isNotNull(addedEvent, "AccountAddedToControlList event should be emitted");
      assert.equal(addedEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(
        addedEvent!.account.toBase58(),
        tokenAccount.toBase58(),
        "event account should match the listed token account"
      );
      assert.equal(
        addedEvent!.operator.toBase58(),
        authority.publicKey.toBase58(),
        "event operator should match authority"
      );
    });

    // ── add_to_control_list is idempotent ───────────────────────────────────────
    it("add_to_control_list: succeeds when the account is already in the control list", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await addToControlList({ authority, mint, account: tokenAccount });

      await addToControlList({ authority, mint, account: tokenAccount });

      assert.isTrue(await isInControlList(mint, tokenAccount), "account should still be in the control list");
    });

    // ── Error case: add_to_control_list — MissingRole ──────────────────────
    it("add_to_control_list: fails with MissingRole when authority doesn't have required role", async () => {
      await setRoles(mint, authority.publicKey, []);

      try {
        await initializeTransferControlMode({ authority, mint });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole");
      }
    });

    // ── Error case: add_to_control_list — MintPaused ────────────────────────────────
    it("add_to_control_list: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setMintPaused(mint, true);

      try {
        await addToControlList({ authority, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused");
      }
    });

    // ── Error case: add_to_control_list — Deactivated ───────────────────────────────
    it("add_to_control_list: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await setDeactivated(mint);

      try {
        await addToControlList({ authority, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated");
      }
    });

    // ── Error case: add_to_control_list — FunctionalityNotSupportedError ─────────────
    it("add_to_control_list: fails with FunctionalityNotSupportedError when the add_to_control_list functionality is not enabled", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // Re-seed the asset-class version WITHOUT the add_to_control_list functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await addToControlList({ authority, mint, account: tokenAccount });
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

    // ── Error case: add_to_control_list — AssetClassVersionNotFinalized ──────────────
    it("add_to_control_list: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [TRANSFER_CONTROL_ADD_TO_CONTROL_LIST],
      });

      try {
        await addToControlList({ authority, mint, account: tokenAccount });
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

  describe("remove_from_control_list", async () => {
    // ── Happy-path: remove_from_control_list ────────────────────────────────────────
    it("remove_from_control_list: clears the in_control_list flag, keeping the record", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      await addToControlList({ authority, mint, account: tokenAccount });
      assert.isTrue(await isInControlList(mint, tokenAccount), "account should be in the control list after add");

      const { signature } = await removeFromControlList({ authority, mint, account: tokenAccount });

      const record = await getAccountCompliance(mint, tokenAccount);
      assert.isNotNull(record, "AccountCompliance is never closed");
      assert.equal(record!.inControlList, 0, "in_control_list should be cleared");

      const accountRemovedFromControlListEvent = await getAccountRemovedFromControlListEvent(signature);
      assert.isNotNull(accountRemovedFromControlListEvent, "AccountRemovedFromControlList event should be emitted");
      assert.equal(
        accountRemovedFromControlListEvent!.mint.toBase58(),
        mint.toBase58(),
        "event mint should match the deployed mint"
      );
      assert.equal(
        accountRemovedFromControlListEvent!.account.toBase58(),
        tokenAccount.toBase58(),
        "event account should match the token account removed from the control list"
      );
      assert.equal(
        accountRemovedFromControlListEvent!.operator.toBase58(),
        authority.publicKey.toBase58(),
        "event operator should match authority"
      );
    });

    // ── Error case: remove_from_control_list — not in the control list ───────────
    it("remove_from_control_list: fails with AccountNotInControlList when the account is not listed", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });

      try {
        await removeFromControlList({ authority, mint, account: tokenAccount });
        assert.fail("Expected AccountNotInControlList but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInControlList");
      }
    });

    // ── Error case: remove_from_control_list — MissingRole ─────────────────
    it("remove_from_control_list: fails with MissingRole when authority doesn't have required role", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await addToControlList({ authority, mint, account: tokenAccount });
      await setRoles(mint, authority.publicKey, []);

      try {
        await removeFromControlList({ authority, mint, account: tokenAccount });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole");
      }
    });

    // ── Error case: remove_from_control_list — MintPaused ───────────────────────────
    it("remove_from_control_list: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await addToControlList({ authority, mint, account: tokenAccount });
      await setMintPaused(mint, true);

      try {
        await removeFromControlList({ authority, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused");
      }
    });

    // ── Error case: remove_from_control_list — Deactivated ──────────────────────────
    it("remove_from_control_list: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await addToControlList({ authority, mint, account: tokenAccount });
      await setDeactivated(mint);

      try {
        await removeFromControlList({ authority, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated");
      }
    });

    // ── Error case: remove_from_control_list — FunctionalityNotSupportedError ────────
    it("remove_from_control_list: fails with FunctionalityNotSupportedError when the remove_from_control_list functionality is not enabled", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await addToControlList({ authority, mint, account: tokenAccount });

      // Re-seed the asset-class version WITH add_to_control_list (needed to have set up the
      // fixture above) but WITHOUT the remove_from_control_list functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [TRANSFER_CONTROL_ADD_TO_CONTROL_LIST] });

      try {
        await removeFromControlList({ authority, mint, account: tokenAccount });
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

    // ── Error case: remove_from_control_list — AssetClassVersionNotFinalized ─────────
    it("remove_from_control_list: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      await addToControlList({ authority, mint, account: tokenAccount });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [TRANSFER_CONTROL_REMOVE_FROM_CONTROL_LIST],
      });

      try {
        await removeFromControlList({ authority, mint, account: tokenAccount });
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

  // verify_transfer_control_mode is a linked-in check, so it is exercised through its
  // enforcement call sites: mint::mint (receive) and transfer-hook::execute (send/receive).
  describe("verify_transfer_control_mode", async () => {
    const MINT_AMOUNT = new anchor.BN(1_000);
    const TRANSFER_AMOUNT = new anchor.BN(400);
    const sourceOwnerKeypair = Keypair.generate();
    const sourceOwner = sourceOwnerKeypair.publicKey;
    const destinationOwner = Keypair.generate().publicKey;

    beforeEach(async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [MINT_MINT, TRANSFER_HOOK_EXECUTE] });
      await setRoles(mint, authority.publicKey, [ROLE_ISSUER]);
    });

    async function fundedSourceAndDestination(): Promise<{ source: PublicKey; destination: PublicKey }> {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);
      const destination = await createTokenAccount({ mint, owner: destinationOwner });
      return { source, destination };
    }

    async function transfer(source: PublicKey, destination: PublicKey): Promise<void> {
      await splTransfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: TRANSFER_AMOUNT }
      );
    }

    async function assertFailsWith(code: string, fn: () => Promise<unknown>): Promise<void> {
      try {
        await fn();
        assert.fail(`Expected ${code} but instruction succeeded`);
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, code, `error code should be ${code}`);
      }
    }

    async function balance(account: PublicKey): Promise<string> {
      return (await getTokenAccount(account)).amount.toString();
    }

    describe("Blacklist mode", async () => {
      beforeEach(async () => {
        await setTransferControlModeMarker(mint, TRANSFER_CONTROL_BLACKLIST);
      });

      it("mint: succeeds to a destination that is not in the control list", async () => {
        const destination = await createTokenAccount({ mint, owner: destinationOwner });

        await mintTokens({ mint, destination, authority }, { amount: MINT_AMOUNT });

        assert.equal(await balance(destination), MINT_AMOUNT.toString());
      });

      it("mint: fails with Blacklisted when the destination is in the control list", async () => {
        const destination = await createTokenAccount({ mint, owner: destinationOwner });
        await setControlListMarker(mint, destination);

        await assertFailsWith("Blacklisted", () => mintTokens({ mint, destination, authority }));

        assert.equal(await balance(destination), "0", "blocked destination must not receive tokens");
      });

      it("transfer: succeeds when neither source nor destination is in the control list", async () => {
        const { source, destination } = await fundedSourceAndDestination();

        await transfer(source, destination);

        assert.equal(await balance(source), MINT_AMOUNT.sub(TRANSFER_AMOUNT).toString());
        assert.equal(await balance(destination), TRANSFER_AMOUNT.toString());
      });

      it("transfer: fails with Blacklisted when the source is in the control list", async () => {
        const { source, destination } = await fundedSourceAndDestination();
        await setControlListMarker(mint, source);

        await assertFailsWith("Blacklisted", () => transfer(source, destination));

        assert.equal(await balance(source), MINT_AMOUNT.toString(), "source balance must be unchanged");
        assert.equal(await balance(destination), "0", "destination balance must be unchanged");
      });

      it("transfer: fails with Blacklisted when the destination is in the control list", async () => {
        const { source, destination } = await fundedSourceAndDestination();
        await setControlListMarker(mint, destination);

        await assertFailsWith("Blacklisted", () => transfer(source, destination));

        assert.equal(await balance(source), MINT_AMOUNT.toString(), "source balance must be unchanged");
        assert.equal(await balance(destination), "0", "destination balance must be unchanged");
      });
    });

    describe("Whitelist mode (regression)", async () => {
      beforeEach(async () => {
        await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);
      });

      it("mint: succeeds to a destination in the control list", async () => {
        const destination = await createTokenAccount({ mint, owner: destinationOwner });
        await setControlListMarker(mint, destination);

        await mintTokens({ mint, destination, authority }, { amount: MINT_AMOUNT });

        assert.equal(await balance(destination), MINT_AMOUNT.toString());
      });

      it("mint: fails with NotWhitelisted when the destination is not in the control list", async () => {
        const destination = await createTokenAccount({ mint, owner: destinationOwner });

        await assertFailsWith("NotWhitelisted", () => mintTokens({ mint, destination, authority }));
      });

      it("transfer: succeeds when source and destination are both in the control list", async () => {
        const { source, destination } = await fundedSourceAndDestination();
        await setControlListMarker(mint, source);
        await setControlListMarker(mint, destination);

        await transfer(source, destination);

        assert.equal(await balance(destination), TRANSFER_AMOUNT.toString());
      });

      it("transfer: fails with NotWhitelisted when the destination is not in the control list", async () => {
        const { source, destination } = await fundedSourceAndDestination();
        await setControlListMarker(mint, source);

        await assertFailsWith("NotWhitelisted", () => transfer(source, destination));

        assert.equal(await balance(source), MINT_AMOUNT.toString(), "source balance must be unchanged");
      });
    });
  });
});
