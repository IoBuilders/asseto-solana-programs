import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { FACTORY_PROGRAM_ID } from "./utils/address_utils";
import { getAccountInfo, requestAirdrop } from "./program_helpers/account_helper";
import {
  acceptAssetClassOwnership,
  acceptNomination,
  areFunctionalitiesEnabled,
  cancelAssetClassOwnership,
  cancelNomination,
  createAssetClass,
  disableAssetClassVersionFunctionalities,
  enableAssetClassVersionFunctionalities,
  finalizeAssetClassVersion,
  initAssetClassVersion,
  initializeFactory,
  isFunctionalityEnabled,
  nominateAssetClassOwner,
  nominateManager,
  pauseFactory,
  unpauseFactory,
} from "./program_helpers/factory/factory_instruction_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  assetClassOwnershipPda,
  assetClassOwnershipPdaWithBump,
  assetClassPendingOwnerPda,
  assetClassPendingOwnerPdaWithBump,
  assetClassVersionPda,
  assetClassVersionPdaWithBump,
  clearAssetClassOwnership,
  clearAssetClassPendingOwner,
  clearAssetClassVersion,
  clearFactory,
  clearFactoryPendingManager,
  factoryPda,
  factoryPdaWithBump,
  factoryPendingManagerPda,
  factoryPendingManagerPdaWithBump,
  FUNCTIONALITIES_BITS_MASK,
  getAssetClassOwnership,
  getAssetClassPendingOwner,
  getAssetClassVersion,
  getFactory,
  getFactoryPendingManager,
  setAssetClassOwnership,
  setAssetClassPendingOwner,
  setAssetClassVersion,
  setFactory,
  setFactoryPendingManager,
} from "./program_helpers/factory/factory_pda_helper";

describe("factory", () => {
  const provider = anchor.AnchorProvider.env();
  const FACTORY_MANAGER = Keypair.generate();
  const ASSET_CLASS_CONFIG_ID = new anchor.BN(1);
  const ASSET_CLASS_VERSION = new anchor.BN(1);
  const ASSET_CLASS_OWNER = Keypair.generate();
  anchor.setProvider(provider);

  before(async () => {
    await requestAirdrop(FACTORY_MANAGER.publicKey);
    await requestAirdrop(ASSET_CLASS_OWNER.publicKey);
  });

  beforeEach(async () => {
    // Set the factory's owner and pausable=false
    await setFactory(FACTORY_MANAGER.publicKey, false);
  });

  describe("initialize", () => {
    beforeEach(async () => {
      await clearFactory();
    });

    it("creates the factory PDA and stores manager, pause=false and bump", async () => {
      // Always runs the instruction — on a fresh validator the singleton PDA does
      // not exist yet, so this both creates it and exercises the handler.
      // `manager` is a required signer, so it must be passed in `signers`.
      await initializeFactory({ manager: FACTORY_MANAGER });

      const stored = await getFactory();
      assert.equal(stored.manager.toBase58(), FACTORY_MANAGER.publicKey.toBase58(), "manager mismatch");
      assert.equal(stored.pause, false, "pause should default to false");
      assert.equal(stored.bump, factoryPdaWithBump()[1], "bump mismatch");

      // PDA must now exist and be owned by factory.
      const info = await getAccountInfo(factoryPda());
      assert.isNotNull(info, "factory PDA should be created by initialize");
      assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "factory PDA should be owned by factory");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when the manager does not sign the transaction", async () => {
      try {
        // `manager` is a required `Signer`, but we deliberately omit its keypair
        // from `signers`. The transaction is therefore missing a required
        // signature and is rejected before it ever reaches the cluster.
        await initializeFactory({ manager: FACTORY_MANAGER, signers: [] });

        assert.fail("Expected failure but initialize succeeded without the manager's signature");
      } catch (err) {
        const message = (err as Error).message ?? "";
        assert.match(message, /signature/i, "error should reference the missing manager signature");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when the factory PDA already exists", async () => {
      // Plant an existing factory so a second `init` must fail.
      await setFactory(FACTORY_MANAGER.publicKey, false);

      try {
        // Fully sign the transaction so it reaches the cluster — the failure must
        // come from `init` (PDA already exists), not from a missing signature.
        await initializeFactory({ manager: FACTORY_MANAGER });

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
  });

  describe("nominate_manager", () => {
    afterEach(async () => {
      await clearFactoryPendingManager();
    });

    it("fails with FactoryPaused when the factory is paused", async () => {
      // Paused factory owned by `manager` (the manager check would pass, so we
      // isolate the pause precondition).
      await setFactory(FACTORY_MANAGER.publicKey, true);

      try {
        await nominateManager({ currentManager: FACTORY_MANAGER }, { newManager: Keypair.generate().publicKey });
        assert.fail("Expected FactoryPaused error but nominate_manager succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await nominateManager({ currentManager: rogue }, { newManager: Keypair.generate().publicKey });
        assert.fail("Expected NotManager error but nominate_manager succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("creates the pending PDA when none exists", async () => {
      const nominee = Keypair.generate().publicKey;
      assert.isNull(
        await getAccountInfo(factoryPendingManagerPda()),
        "precondition: pending PDA should not exist before nomination"
      );

      await nominateManager({ currentManager: FACTORY_MANAGER }, { newManager: nominee });

      const pending = await getFactoryPendingManager();
      assert.equal(pending.pendingManager.toBase58(), nominee.toBase58(), "pending manager mismatch");
      assert.equal(pending.bump, factoryPendingManagerPdaWithBump()[1], "bump mismatch");

      const info = await getAccountInfo(factoryPendingManagerPda());
      assert.isNotNull(info, "pending PDA should be created");
      assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "pending PDA should be owned by factory");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("replaces the pending manager when a nomination already exists", async () => {
      const oldNominee = Keypair.generate().publicKey;
      const newNominee = Keypair.generate().publicKey;
      // Force-create the pending PDA with an existing nominee via surfpool.
      await setFactoryPendingManager(oldNominee);
      assert.equal(
        (await getFactoryPendingManager()).pendingManager.toBase58(),
        oldNominee.toBase58(),
        "precondition: old nominee should be planted"
      );

      await nominateManager({ currentManager: FACTORY_MANAGER }, { newManager: newNominee });

      const pending = await getFactoryPendingManager();
      assert.equal(pending.pendingManager.toBase58(), newNominee.toBase58(), "pending manager should be replaced");
    });
  });

  describe("cancel_nomination", () => {
    afterEach(async () => {
      await clearFactoryPendingManager();
    });

    it("fails with FactoryPaused when the factory is paused", async () => {
      // Paused factory + an existing pending PDA so account validation passes and
      // the handler runs into the pause check.
      await setFactory(FACTORY_MANAGER.publicKey, true);
      await setFactoryPendingManager(Keypair.generate().publicKey);

      try {
        await cancelNomination({ currentManager: FACTORY_MANAGER });
        assert.fail("Expected FactoryPaused error but cancel_nomination succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      await setFactoryPendingManager(Keypair.generate().publicKey);

      try {
        await cancelNomination({ currentManager: rogue });
        assert.fail("Expected NotManager error but cancel_nomination succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when there is no pending nomination", async () => {
      try {
        await cancelNomination({ currentManager: FACTORY_MANAGER });
        assert.fail("Expected failure but cancel_nomination succeeded with no pending PDA");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("closes the pending PDA and leaves manager unchanged", async () => {
      await setFactoryPendingManager(Keypair.generate().publicKey);

      await cancelNomination({ currentManager: FACTORY_MANAGER });

      assert.isNull(await getAccountInfo(factoryPendingManagerPda()), "pending PDA should be closed");
      assert.equal(
        (await getFactory()).manager.toBase58(),
        FACTORY_MANAGER.publicKey.toBase58(),
        "manager should be unchanged after cancel"
      );
    });
  });

  describe("accept_nomination", () => {
    const pendingManager = Keypair.generate();

    before(async () => {
      await setAssetClassOwnership(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_OWNER.publicKey);
      await requestAirdrop(pendingManager.publicKey);
    });

    beforeEach(async () => {
      await setFactoryPendingManager(pendingManager.publicKey);
    });

    after(async () => {
      await clearFactoryPendingManager();
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("promotes the pending manager and closes the pending PDA", async () => {
      await acceptNomination({ pendingManager });

      assert.equal(
        (await getFactory()).manager.toBase58(),
        pendingManager.publicKey.toBase58(),
        "manager should be replaced by the pending manager"
      );
      assert.isNull(await getAccountInfo(factoryPendingManagerPda()), "pending PDA should be closed after accept");
    });

    it("fails with FactoryPaused when the factory is paused", async () => {
      await setFactory(FACTORY_MANAGER.publicKey, true);

      try {
        await acceptNomination({ pendingManager });
        assert.fail("Expected FactoryPaused error but accept_nomination succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotPendingManager when called by someone else", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await acceptNomination({ pendingManager: rogue });
        assert.fail("Expected NotPendingManager error but accept_nomination succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotPendingManager");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when there is no pending nomination", async () => {
      await clearFactoryPendingManager();

      try {
        await acceptNomination({ pendingManager });
        assert.fail("Expected failure but accept_nomination succeeded with no pending PDA");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });
  });

  describe("pause", () => {
    it("pauses the factory", async () => {
      await pauseFactory({ manager: FACTORY_MANAGER });

      assert.equal((await getFactory()).pause, true, "pause should be true after pause instruction");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryPaused when the factory is already paused", async () => {
      await setFactory(FACTORY_MANAGER.publicKey, true);

      try {
        await pauseFactory({ manager: FACTORY_MANAGER });
        assert.fail("Expected FactoryPaused error but pause succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await pauseFactory({ manager: rogue });
        assert.fail("Expected NotManager error but pause succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
      }
    });
  });

  describe("unpause", () => {
    it("unpauses factory", async () => {
      await setFactory(FACTORY_MANAGER.publicKey, true);

      await unpauseFactory({ manager: FACTORY_MANAGER });

      assert.equal((await getFactory()).pause, false, "pause should be false after unpause instruction");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryNotPaused when the factory is not paused", async () => {
      try {
        await unpauseFactory({ manager: FACTORY_MANAGER });
        assert.fail("Expected FactoryNotPaused error but unpause succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryNotPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      await setFactory(FACTORY_MANAGER.publicKey, true);
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await unpauseFactory({ manager: rogue });
        assert.fail("Expected NotManager error but unpause succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
      }
    });
  });

  describe("create_asset_class", () => {
    afterEach(async () => {
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("creates the ownership PDA with owner, latest_version=0 and bump", async () => {
      await createAssetClass(
        { manager: FACTORY_MANAGER },
        { configId: ASSET_CLASS_CONFIG_ID, owner: ASSET_CLASS_OWNER.publicKey }
      );

      const stored = await getAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
      assert.equal(stored.owner.toBase58(), ASSET_CLASS_OWNER.publicKey.toBase58(), "owner mismatch");
      assert.equal(stored.latestVersion.toString(), "0", "latest_version should be 0");
      assert.equal(stored.bump, assetClassOwnershipPdaWithBump(ASSET_CLASS_CONFIG_ID)[1], "bump mismatch");

      const info = await getAccountInfo(assetClassOwnershipPda(ASSET_CLASS_CONFIG_ID));
      assert.isNotNull(info, "asset class PDA should be created");
      assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "asset class PDA should be owned by factory");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryPaused when the factory is paused", async () => {
      await setFactory(FACTORY_MANAGER.publicKey, true);

      try {
        await createAssetClass(
          { manager: FACTORY_MANAGER },
          { configId: ASSET_CLASS_CONFIG_ID, owner: ASSET_CLASS_OWNER.publicKey }
        );
        assert.fail("Expected FactoryPaused error but create_asset_class succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await createAssetClass(
          { manager: rogue },
          { configId: ASSET_CLASS_CONFIG_ID, owner: ASSET_CLASS_OWNER.publicKey }
        );
        assert.fail("Expected NotManager error but create_asset_class succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when the asset class already exists for the config id", async () => {
      // Force-create the ownership PDA for this config id via surfpool so `init` collides.
      await setAssetClassOwnership(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_OWNER.publicKey);

      try {
        await createAssetClass(
          { manager: FACTORY_MANAGER },
          { configId: ASSET_CLASS_CONFIG_ID, owner: ASSET_CLASS_OWNER.publicKey }
        );
        assert.fail("Expected failure but create_asset_class succeeded on an existing PDA");
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
  });

  describe("nominate_asset_class_owner", () => {
    before(async () => {
      await setAssetClassOwnership(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_OWNER.publicKey);
    });

    afterEach(async () => {
      await clearAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID);
    });

    after(async () => {
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("creates the pending PDA when none exists", async () => {
      const nominee = Keypair.generate().publicKey;

      await nominateAssetClassOwner(
        { currentOwner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, newOwner: nominee }
      );

      const pending = await getAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID);
      assert.equal(pending.pendingOwner.toBase58(), nominee.toBase58(), "pending owner mismatch");
      assert.equal(pending.bump, assetClassPendingOwnerPdaWithBump(ASSET_CLASS_CONFIG_ID)[1], "bump mismatch");

      const info = await getAccountInfo(assetClassPendingOwnerPda(ASSET_CLASS_CONFIG_ID));
      assert.isNotNull(info, "pending PDA should be created");
      assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "pending PDA should be owned by factory");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("replaces the pending owner when a nomination already exists", async () => {
      const oldNominee = Keypair.generate().publicKey;
      const newNominee = Keypair.generate().publicKey;
      // Force-create the pending PDA with an existing nominee via surfpool.
      await setAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID, oldNominee);

      await nominateAssetClassOwner(
        { currentOwner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, newOwner: newNominee }
      );

      const pending = await getAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID);
      assert.equal(pending.pendingOwner.toBase58(), newNominee.toBase58(), "pending owner should be replaced");
    });

    it("fails with FactoryPaused when the factory is paused", async () => {
      await setFactory(FACTORY_MANAGER.publicKey, true);

      try {
        await nominateAssetClassOwner(
          { currentOwner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, newOwner: Keypair.generate().publicKey }
        );
        assert.fail("Expected FactoryPaused error but nominate_asset_class_owner succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await nominateAssetClassOwner(
          { currentOwner: rogue },
          { configId: ASSET_CLASS_CONFIG_ID, newOwner: Keypair.generate().publicKey }
        );
        assert.fail("Expected NotOwner error but nominate_asset_class_owner succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when the asset class does not exist", async () => {
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
      assert.isNull(
        await getAccountInfo(assetClassOwnershipPda(ASSET_CLASS_CONFIG_ID)),
        "precondition: asset class ownership PDA should not exist"
      );

      try {
        await nominateAssetClassOwner(
          { currentOwner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, newOwner: Keypair.generate().publicKey }
        );
        assert.fail("Expected failure but nominate_asset_class_owner succeeded with no asset class");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });
  });

  describe("cancel_asset_class_ownership", () => {
    before(async () => {
      await setAssetClassOwnership(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_OWNER.publicKey);
    });

    beforeEach(async () => {
      await setAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID, Keypair.generate().publicKey);
    });

    after(async () => {
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
      await clearAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID);
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("closes the pending PDA and leaves owner unchanged", async () => {
      await cancelAssetClassOwnership({ currentOwner: ASSET_CLASS_OWNER }, { configId: ASSET_CLASS_CONFIG_ID });

      assert.isNull(
        await getAccountInfo(assetClassPendingOwnerPda(ASSET_CLASS_CONFIG_ID)),
        "pending PDA should be closed"
      );
      assert.equal(
        (await getAssetClassOwnership(ASSET_CLASS_CONFIG_ID)).owner.toBase58(),
        ASSET_CLASS_OWNER.publicKey.toBase58(),
        "owner should be unchanged after cancel"
      );
    });

    it("fails with FactoryPaused when the factory is paused", async () => {
      // Paused factory + an asset class owned by `owner` + an existing pending PDA
      // so account validation passes and the handler runs into the pause check.
      await setFactory(Keypair.generate().publicKey, true);

      try {
        await cancelAssetClassOwnership({ currentOwner: ASSET_CLASS_OWNER }, { configId: ASSET_CLASS_CONFIG_ID });
        assert.fail("Expected FactoryPaused error but cancel_asset_class_ownership succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await cancelAssetClassOwnership({ currentOwner: rogue }, { configId: ASSET_CLASS_CONFIG_ID });
        assert.fail("Expected NotOwner error but cancel_asset_class_ownership succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when there is no pending nomination", async () => {
      await clearAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID);

      try {
        await cancelAssetClassOwnership({ currentOwner: ASSET_CLASS_OWNER }, { configId: ASSET_CLASS_CONFIG_ID });
        assert.fail("Expected failure but cancel_asset_class_ownership succeeded with no pending PDA");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });
  });

  describe("accept_asset_class_ownership", () => {
    const pendingOwner = Keypair.generate();

    before(async () => {
      await setAssetClassOwnership(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_OWNER.publicKey);
      await requestAirdrop(pendingOwner.publicKey);
    });

    beforeEach(async () => {
      await setAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID, pendingOwner.publicKey);
    });

    after(async () => {
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
      await clearAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID);
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("promotes the pending owner and closes the pending PDA", async () => {
      await acceptAssetClassOwnership({ pendingOwner }, { configId: ASSET_CLASS_CONFIG_ID });

      assert.equal(
        (await getAssetClassOwnership(ASSET_CLASS_CONFIG_ID)).owner.toBase58(),
        pendingOwner.publicKey.toBase58(),
        "owner should be replaced by the pending owner"
      );
      assert.isNull(
        await getAccountInfo(assetClassPendingOwnerPda(ASSET_CLASS_CONFIG_ID)),
        "pending PDA should be closed after accept"
      );
    });

    it("fails with FactoryPaused when the factory is paused", async () => {
      await setFactory(Keypair.generate().publicKey, true);

      try {
        await acceptAssetClassOwnership({ pendingOwner }, { configId: ASSET_CLASS_CONFIG_ID });
        assert.fail("Expected FactoryPaused error but accept_asset_class_ownership succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotPendingOwner when called by someone else", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await acceptAssetClassOwnership({ pendingOwner: rogue }, { configId: ASSET_CLASS_CONFIG_ID });
        assert.fail("Expected NotPendingOwner error but accept_asset_class_ownership succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotPendingOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when there is no pending nomination", async () => {
      await clearAssetClassPendingOwner(ASSET_CLASS_CONFIG_ID);

      try {
        await acceptAssetClassOwnership({ pendingOwner }, { configId: ASSET_CLASS_CONFIG_ID });
        assert.fail("Expected failure but accept_asset_class_ownership succeeded with no pending PDA");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });
  });

  describe("init_asset_class_version", () => {
    before(async () => {
      await setAssetClassOwnership(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_OWNER.publicKey);
    });

    afterEach(async () => {
      await clearAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
    });

    after(async () => {
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("creates the Draft version PDA", async () => {
      const versionPda = assetClassVersionPda(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
      const [, expectedBump] = assetClassVersionPdaWithBump(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
      assert.isNull(
        await getAccountInfo(versionPda),
        "precondition: asset class version PDA should not exist before init"
      );

      await initAssetClassVersion(
        { owner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
      );

      const stored = await getAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
      assert.equal(stored.configId.toString(), ASSET_CLASS_CONFIG_ID.toString(), "config id mismatch");
      assert.equal(stored.version.toString(), ASSET_CLASS_VERSION.toString(), "version mismatch");
      assert.equal(stored.state, 0, "version should be Draft (0) right after init");
      assert.equal(stored.bump, expectedBump, "bump should match the canonical bump");

      const info = await getAccountInfo(versionPda);
      assert.isNotNull(info, "asset class version PDA should be created by init");
      assert.equal(
        info!.owner.toBase58(),
        FACTORY_PROGRAM_ID.toBase58(),
        "asset class version PDA should be owned by factory"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryPaused when the factory is paused", async () => {
      await setFactory(FACTORY_MANAGER.publicKey, true);

      try {
        await initAssetClassVersion(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
        );
        assert.fail("Expected FactoryPaused but init succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await initAssetClassVersion(
          { owner: rogue },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
        );
        assert.fail("Expected NotOwner but init succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with InvalidVersion when version is not latest_version + 1", async () => {
      const newVersion = ASSET_CLASS_VERSION.add(new anchor.BN(2));

      try {
        await initAssetClassVersion(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: newVersion }
        );
        assert.fail("Expected InvalidVersion but init succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "InvalidVersion");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when trying to create the same (config_id, version) twice", async () => {
      await initAssetClassVersion(
        { owner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
      );

      try {
        // `init` for the same (config_id, version) PDA must fail — it already exists.
        await initAssetClassVersion(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
        );
        assert.fail("Expected failure but init succeeded for an existing version");
      } catch (err) {
        // System program "already in use" — surfaced as a SendTransactionError,
        // raised by the `init` account constraint before the handler runs.
        assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
        const logs = (err as SendTransactionError).logs ?? [];
        assert.isTrue(
          logs.some((l) => l.includes("already in use")),
          "transaction logs should mention account already in use"
        );
      }
    });
  });

  describe("enable_asset_class_version_functionalities", () => {
    before(async () => {
      await setAssetClassOwnership(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_OWNER.publicKey);
      await setAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
      });
    });

    after(async () => {
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
      await clearAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
    });

    it("turns on the given functionality bits without touching others", async () => {
      const functionality0 = 0;
      const functionality17 = 17;

      await enableAssetClassVersionFunctionalities(
        { owner: ASSET_CLASS_OWNER },
        {
          configId: ASSET_CLASS_CONFIG_ID,
          version: ASSET_CLASS_VERSION,
          functionalities: [functionality0, functionality17],
        }
      );

      const assetClassVersion = await getAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);

      assert.isTrue(
        areFunctionalitiesEnabled(assetClassVersion.mask, [functionality0, functionality17]),
        `functionalities ${functionality0} & ${functionality17} should be enabled`
      );
      assert.isFalse(isFunctionalityEnabled(assetClassVersion.mask, 2), "functionality 2 should be untouched");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryPaused when the factory is paused", async () => {
      // Pause only after the draft exists, so the failure is isolated to the
      // enable call itself, not to some earlier step.
      await setFactory(Keypair.generate().publicKey, true);

      try {
        await enableAssetClassVersionFunctionalities(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION, functionalities: [0] }
        );
        assert.fail("Expected FactoryPaused but enable succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await enableAssetClassVersionFunctionalities(
          { owner: rogue },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION, functionalities: [0] }
        );
        assert.fail("Expected NotOwner but enable succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FunctionalityOutOfBounds when a functionality exceeds the mask capacity", async () => {
      try {
        await enableAssetClassVersionFunctionalities(
          { owner: ASSET_CLASS_OWNER },
          {
            configId: ASSET_CLASS_CONFIG_ID,
            version: ASSET_CLASS_VERSION,
            functionalities: [FUNCTIONALITIES_BITS_MASK + 1],
          }
        );
        assert.fail("Expected FunctionalityOutOfBounds but enable succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FunctionalityOutOfBounds");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with VersionNotDraft once the version is sealed (immutability)", async () => {
      await finalizeAssetClassVersion(
        { owner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
      );

      try {
        await enableAssetClassVersionFunctionalities(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION, functionalities: [1] }
        );
        assert.fail("Expected VersionNotDraft but enable succeeded on a sealed version");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "VersionNotDraft");
      }
    });
  });

  describe("disable_asset_class_version_functionalities", () => {
    before(async () => {
      await setAssetClassOwnership(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_OWNER.publicKey);
      await setAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
      });
    });

    after(async () => {
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
      await clearAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
    });

    it("turns off the given functionality bits without touching others", async () => {
      const functionality0 = 0;
      const functionality2 = 2;
      await enableAssetClassVersionFunctionalities(
        { owner: ASSET_CLASS_OWNER },
        {
          configId: ASSET_CLASS_CONFIG_ID,
          version: ASSET_CLASS_VERSION,
          functionalities: [functionality0, functionality2],
        }
      );

      await disableAssetClassVersionFunctionalities(
        { owner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION, functionalities: [functionality0] }
      );

      const assetClassVersion = await getAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
      assert.isFalse(
        isFunctionalityEnabled(assetClassVersion.mask, functionality0),
        "functionality 0 should be disabled"
      );
      assert.isTrue(
        isFunctionalityEnabled(assetClassVersion.mask, functionality2),
        "functionality 2 should remain enabled"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryPaused when the factory is paused", async () => {
      await enableAssetClassVersionFunctionalities(
        { owner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION, functionalities: [0] }
      );

      // Pause only after the functionality is enabled, so the failure is isolated
      // to the disable call itself, not to some earlier step.
      await setFactory(Keypair.generate().publicKey, true);

      try {
        await disableAssetClassVersionFunctionalities(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION, functionalities: [0] }
        );
        assert.fail("Expected FactoryPaused but disable succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      await enableAssetClassVersionFunctionalities(
        { owner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION, functionalities: [0] }
      );

      try {
        await disableAssetClassVersionFunctionalities(
          { owner: rogue },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION, functionalities: [0] }
        );
        assert.fail("Expected NotOwner but disable succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FunctionalityOutOfBounds when a functionality exceeds the mask capacity", async () => {
      try {
        await disableAssetClassVersionFunctionalities(
          { owner: ASSET_CLASS_OWNER },
          {
            configId: ASSET_CLASS_CONFIG_ID,
            version: ASSET_CLASS_VERSION,
            functionalities: [FUNCTIONALITIES_BITS_MASK + 1],
          }
        );
        assert.fail("Expected FunctionalityOutOfBounds but disable succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FunctionalityOutOfBounds");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with VersionNotDraft once the version is sealed (immutability)", async () => {
      await finalizeAssetClassVersion(
        { owner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
      );

      try {
        await disableAssetClassVersionFunctionalities(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION, functionalities: [0] }
        );
        assert.fail("Expected VersionNotDraft but disable succeeded on a sealed version");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "VersionNotDraft");
      }
    });
  });

  describe("finalize_asset_class_version", () => {
    beforeEach(async () => {
      await setAssetClassOwnership(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_OWNER.publicKey);
      await setAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
      });
    });

    after(async () => {
      await clearAssetClassOwnership(ASSET_CLASS_CONFIG_ID);
      await clearAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
    });

    it("seals the version to Ready and advances latest_version", async () => {
      const before = await getAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
      assert.equal(before.state, 0, "precondition: version should be Draft (0) before finalize");

      await finalizeAssetClassVersion(
        { owner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
      );

      const after = await getAssetClassVersion(ASSET_CLASS_CONFIG_ID, ASSET_CLASS_VERSION);
      assert.equal(after.state, 1, "version should be Ready (1) after finalize");
      assert.equal(
        (await getAssetClassOwnership(ASSET_CLASS_CONFIG_ID)).latestVersion.toString(),
        ASSET_CLASS_VERSION.toString(),
        "latest_version should advance to the finalized version"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryPaused when the factory is paused", async () => {
      await setFactory(FACTORY_MANAGER.publicKey, true);

      try {
        await finalizeAssetClassVersion(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
        );
        assert.fail("Expected FactoryPaused but finalize succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);

      try {
        await finalizeAssetClassVersion(
          { owner: rogue },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
        );
        assert.fail("Expected NotOwner but finalize succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with VersionNotDraft when the version is already sealed", async () => {
      await finalizeAssetClassVersion(
        { owner: ASSET_CLASS_OWNER },
        { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
      );

      try {
        // Same version, already Ready — must be rejected, not silently re-sealed.
        await finalizeAssetClassVersion(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
        );
        assert.fail("Expected VersionNotDraft but finalize succeeded on an already-sealed version");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "VersionNotDraft");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with InvalidVersion when latest_version no longer matches", async () => {
      await setAssetClassOwnership(
        ASSET_CLASS_CONFIG_ID,
        ASSET_CLASS_OWNER.publicKey,
        ASSET_CLASS_VERSION.add(new anchor.BN(2))
      );

      try {
        await finalizeAssetClassVersion(
          { owner: ASSET_CLASS_OWNER },
          { configId: ASSET_CLASS_CONFIG_ID, version: ASSET_CLASS_VERSION }
        );
        assert.fail("Expected InvalidVersion but finalize succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "InvalidVersion");
      }
    });
  });
});
