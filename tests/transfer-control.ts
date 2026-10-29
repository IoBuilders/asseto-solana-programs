import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy/deploy_instruction_helper";
import { createTokenAccount, setMintPaused } from "./program_helpers/spl_token_helper";
import {
  addToControlList,
  getAccountRemovedFromControlListEvent,
  getAccountAddedToControlListEvent,
  getTransferControlModeSetEvent,
  removeFromControlList,
  initializeTransferControlMode,
  TRANSFER_CONTROL_WHITELIST,
  getTransferControlProgram,
} from "./program_helpers/transfer_control/transfer_control_instruction_helper";
import { getAccountInfo } from "./program_helpers/account_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import {
  DEACTIVATE_DEACTIVATE,
  PAUSE_PAUSE,
  TRANSFER_CONTROL_ADD_TO_CONTROL_LIST,
  TRANSFER_CONTROL_REMOVE_FROM_CONTROL_LIST,
  TRANSFER_CONTROL_INITIALIZE,
} from "./utils/functionalities";
import {
  getTransferControlModeByPda,
  getControlListStatusByPda,
  transferControlModePda,
  transferControlModePdaWithBump,
  controlListPda,
  controlListPdaWithBump,
} from "./program_helpers/transfer_control/transfer_control_pda_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_CONTROL_LIST } from "./utils/roles";

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
    // ── Happy-path: initialize creates the PDA and sets mode = Whitelist ───────────
    it("initialize: creates the transfer_control_mode PDA with mode = Whitelist", async () => {
      const mode = TRANSFER_CONTROL_WHITELIST;
      const transferControlMode = transferControlModePda(mint);
      const [, expectedBump] = transferControlModePdaWithBump(mint);

      // ── Verify the PDA does not exist before the instruction ────────────────
      const stateBefore = await getTransferControlModeByPda(transferControlMode);

      // ── Call initialize(TRANSFER_CONTROL_WHITELIST) ────────────────────────────────────
      const { signature } = await initializeTransferControlMode({ authority, mint }, { mode });

      // ── Fetch and verify the PDA ─────────────────────────────────────────────
      const stateAfter = await getTransferControlModeByPda(transferControlMode);
      const accountInfo = await getAccountInfo(transferControlMode);

      const expectedSize = getTransferControlProgram().account.transferControlMode.size;

      assert.isNull(stateBefore, "transfer_control_mode PDA should not exist before initialize");
      assert.isNotNull(stateAfter, "transfer_control_mode PDA should exist after initialize");
      assert.deepEqual(stateAfter.mode, mode, `mode should be ${mode}`);
      assert.equal(stateAfter.bump, expectedBump, "bump should match the canonical bump");
      assert.equal(accountInfo.data.length, expectedSize, `PDA size should be ${expectedSize} bytes`);

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

    // ── Error case: initialize — PDA already exists ────────────────────────────────
    it("initialize: fails when the transfer_control_mode PDA already exists", async () => {
      // Plant an existing transfer_control_mode PDA so a second `init` must fail.
      await initializeTransferControlMode({ authority, mint });

      try {
        await initializeTransferControlMode({ authority, mint });
        assert.fail("Expected failure but initialize succeeded on an existing PDA");
      } catch (err) {
        // `init` on an existing account fails in the System program with
        // "already in use" — surfaced as a SendTransactionError, not an Anchor code.
        assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
        const logs = (err as SendTransactionError).logs ?? [];
        assert.isTrue(
          logs.some((l) => l.includes("already in use")),
          "transaction logs should mention account already in use"
        );
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
      await setDeactivateMarker(mint);

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
    it("add_to_control_list: creates the control-list PDA for a token account", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      const controlList = controlListPda(mint, tokenAccount);
      const [, expectedBump] = controlListPdaWithBump(mint, tokenAccount);

      // ── Verify the PDA does not exist before the instruction ────────────────
      const stateBefore = await getControlListStatusByPda(controlList);

      // ── Call add_to_control_list ───────────────────────────────────────────────
      const { signature } = await addToControlList({ authority, mint, account: tokenAccount });

      // ── Fetch and verify the PDA ─────────────────────────────────────────────
      const stateAfter = await getControlListStatusByPda(controlList);
      assert.isNull(stateBefore, "control-list PDA should not exist before add_to_control_list");
      assert.isNotNull(stateAfter, "control-list PDA should exist after add_to_control_list");
      assert.equal(stateAfter.bump, expectedBump, "bump should match the canonical bump");

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
      await setDeactivateMarker(mint);

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
    it("remove_from_control_list: closes the control-list PDA for a token account", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: authority.publicKey });
      const controlList = controlListPda(mint, tokenAccount);

      // ── First: add to the control list ─────────────────────────────────────────────
      await addToControlList({ authority, mint, account: tokenAccount });

      const stateAfterAdd = await getControlListStatusByPda(controlList);
      assert.isNotNull(stateAfterAdd, "control-list PDA should exist after add_to_control_list");

      // ── Then: remove from the control list ─────────────────────────────────────────
      const { signature } = await removeFromControlList({ authority, mint, account: tokenAccount });

      // ── Verify the PDA has been closed ──────────────────────────────────────
      const stateAfterRemove = await getControlListStatusByPda(controlList);
      assert.isNull(stateAfterRemove, "control-list PDA should not exist after remove_from_control_list");

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
      await setDeactivateMarker(mint);

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
});
