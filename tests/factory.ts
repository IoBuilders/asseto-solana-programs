import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { FACTORY_PROGRAM_ID } from "./utils/address_utils";
import * as pdaUtils from "./utils/pda_utils";
import { getAccountInfo, requestAirdrop } from "./program_helpers/account_helper";
import {
  acceptAssetClassOwnership,
  acceptNomination,
  cancelAssetClassOwnership,
  cancelNomination,
  clearAssetClassOwnership,
  clearAssetClassPendingOwner,
  clearAssetClassVersion,
  clearFactory,
  clearFactoryPendingManager,
  createAssetClass,
  deployAssetClassVersion,
  finalizeAssetClassVersion,
  FUNCTIONALITIES_BYTES_MASK,
  getAssetClassOwnership,
  getAssetClassPendingOwner,
  getAssetClassVersion,
  getAssetClassVersionMask,
  getFactory,
  getFactoryPendingManager,
  initAssetClassVersion,
  initializeFactory,
  nominateAssetClassOwner,
  nominateManager,
  pauseFactory,
  unpauseFactory,
  setAssetClassOwnership,
  setAssetClassPendingOwner,
  setFactory,
  setFactoryPendingManager,
  writeAssetClassVersionMask,
} from "./program_helpers/factory_helper";

// The factory PDAs (`["factory"]`, `["factory_pending_manager"]`) are singletons
// with no per-mint seed, so their on-chain state would otherwise persist across
// tests. `beforeEach` removes both via surfpool so every test starts from a blank
// slate and only plants the state it actually needs — making each test fully
// independent of execution order.
// The factory PDAs (`["factory"]`, `["factory_pending_manager"]`) are singletons
// with no per-mint seed, so their on-chain state would otherwise persist across
// tests. `beforeEach` removes both via surfpool so every test starts from a blank
// slate and only plants the state it actually needs — making each test fully
// independent of execution order.
describe("factory", () => {
  const provider = anchor.AnchorProvider.env();
  const configId = new anchor.BN(4);
  anchor.setProvider(provider);

  beforeEach(async () => {
    await clearFactory();
    await clearFactoryPendingManager();
    await clearAssetClassOwnership(configId);
    await clearAssetClassPendingOwner(configId);
  });

  describe("initialize", () => {
    it("creates the factory PDA and stores manager, pause=false and bump", async () => {
      const factoryPda = pdaUtils.factoryPda();
      const manager = Keypair.generate();

      // Always runs the instruction — on a fresh validator the singleton PDA does
      // not exist yet, so this both creates it and exercises the handler.
      // `manager` is a required signer, so it must be passed in `signers`.
      await initializeFactory({ manager });

      const stored = await getFactory(factoryPda);
      assert.equal(stored.manager.toBase58(), manager.publicKey.toBase58(), "manager mismatch");
      assert.equal(stored.pause, false, "pause should default to false");
      assert.equal(stored.bump, pdaUtils.factoryPdaWithBump()[1], "bump mismatch");

      // PDA must now exist and be owned by factory.
      const info = await getAccountInfo(factoryPda);
      assert.isNotNull(info, "factory PDA should be created by initialize");
      assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "factory PDA should be owned by factory");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when the manager does not sign the transaction", async () => {
      const manager = Keypair.generate();

      try {
        // `manager` is a required `Signer`, but we deliberately omit its keypair
        // from `signers`. The transaction is therefore missing a required
        // signature and is rejected before it ever reaches the cluster.
        await initializeFactory({ manager, signers: [] });

        assert.fail("Expected failure but initialize succeeded without the manager's signature");
      } catch (err) {
        const message = (err as Error).message ?? "";
        assert.match(message, /signature/i, "error should reference the missing manager signature");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when the factory PDA already exists", async () => {
      // Plant an existing factory so a second `init` must fail.
      await setFactory(Keypair.generate().publicKey, false);

      try {
        // Fully sign the transaction so it reaches the cluster — the failure must
        // come from `init` (PDA already exists), not from a missing signature.
        const manager = Keypair.generate();
        await initializeFactory({ manager });

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
    it("fails with FactoryPaused when the factory is paused", async () => {
      const currentManager = Keypair.generate();
      await requestAirdrop(currentManager.publicKey);
      // Paused factory owned by `manager` (the manager check would pass, so we
      // isolate the pause precondition).
      await setFactory(currentManager.publicKey, true);

      try {
        await nominateManager({ currentManager }, { newManager: Keypair.generate().publicKey });
        assert.fail("Expected FactoryPaused error but nominate_manager succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      const manager = Keypair.generate();
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      // Unpaused factory owned by `manager`; the rogue signs instead.
      await setFactory(manager.publicKey, false);

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
      const currentManager = Keypair.generate();
      const nominee = Keypair.generate().publicKey;
      await requestAirdrop(currentManager.publicKey);
      await setFactory(currentManager.publicKey, false);
      assert.isNull(
        await getAccountInfo(pdaUtils.factoryPendingManagerPda()),
        "precondition: pending PDA should not exist before nomination"
      );

      await nominateManager({ currentManager }, { newManager: nominee });

      const pending = await getFactoryPendingManager();
      assert.equal(pending.pendingManager.toBase58(), nominee.toBase58(), "pending manager mismatch");
      assert.equal(pending.bump, pdaUtils.factoryPendingManagerPdaWithBump()[1], "bump mismatch");

      const info = await getAccountInfo(pdaUtils.factoryPendingManagerPda());
      assert.isNotNull(info, "pending PDA should be created");
      assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "pending PDA should be owned by factory");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("replaces the pending manager when a nomination already exists", async () => {
      const currentManager = Keypair.generate();
      const oldNominee = Keypair.generate().publicKey;
      const newNominee = Keypair.generate().publicKey;
      await requestAirdrop(currentManager.publicKey);
      await setFactory(currentManager.publicKey, false);
      // Force-create the pending PDA with an existing nominee via surfpool.
      await setFactoryPendingManager(oldNominee);
      assert.equal(
        (await getFactoryPendingManager()).pendingManager.toBase58(),
        oldNominee.toBase58(),
        "precondition: old nominee should be planted"
      );

      await nominateManager({ currentManager }, { newManager: newNominee });

      const pending = await getFactoryPendingManager();
      assert.equal(pending.pendingManager.toBase58(), newNominee.toBase58(), "pending manager should be replaced");
    });
  });

  describe("cancel_nomination", () => {
    it("fails with FactoryPaused when the factory is paused", async () => {
      const currentManager = Keypair.generate();
      await requestAirdrop(currentManager.publicKey);
      // Paused factory + an existing pending PDA so account validation passes and
      // the handler runs into the pause check.
      await setFactory(currentManager.publicKey, true);
      await setFactoryPendingManager(Keypair.generate().publicKey);

      try {
        await cancelNomination({ currentManager });
        assert.fail("Expected FactoryPaused error but cancel_nomination succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      const currentManager = Keypair.generate();
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      await setFactory(currentManager.publicKey, false);
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
      const currentManager = Keypair.generate();
      await requestAirdrop(currentManager.publicKey);
      // Unpaused factory, no pending PDA (cleared by beforeEach) — Anchor account
      // validation fails before the handler runs.
      await setFactory(currentManager.publicKey, false);

      try {
        await cancelNomination({ currentManager });
        assert.fail("Expected failure but cancel_nomination succeeded with no pending PDA");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("closes the pending PDA and leaves manager unchanged", async () => {
      const currentManager = Keypair.generate();
      await requestAirdrop(currentManager.publicKey);
      await setFactory(currentManager.publicKey, false);
      await setFactoryPendingManager(Keypair.generate().publicKey);

      await cancelNomination({ currentManager });

      assert.isNull(await getAccountInfo(pdaUtils.factoryPendingManagerPda()), "pending PDA should be closed");
      assert.equal(
        (await getFactory()).manager.toBase58(),
        currentManager.publicKey.toBase58(),
        "manager should be unchanged after cancel"
      );
    });
  });

  describe("accept_nomination", () => {
    it("fails with FactoryPaused when the factory is paused", async () => {
      const manager = Keypair.generate();
      const pendingManager = Keypair.generate();
      await requestAirdrop(pendingManager.publicKey);
      await setFactory(manager.publicKey, true);
      await setFactoryPendingManager(pendingManager.publicKey);

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
      const manager = Keypair.generate();
      const pendingManager = Keypair.generate().publicKey;
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      await setFactory(manager.publicKey, false);
      await setFactoryPendingManager(pendingManager);

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
      const pendingManager = Keypair.generate();
      await requestAirdrop(pendingManager.publicKey);
      // Unpaused factory, no pending PDA (cleared by beforeEach) — Anchor account
      // validation fails before the handler runs.
      await setFactory(Keypair.generate().publicKey, false);

      try {
        await acceptNomination({ pendingManager });
        assert.fail("Expected failure but accept_nomination succeeded with no pending PDA");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("promotes the pending manager and closes the pending PDA", async () => {
      const manager = Keypair.generate().publicKey;
      const pendingManager = Keypair.generate();
      await requestAirdrop(pendingManager.publicKey);
      await setFactory(manager, false);
      await setFactoryPendingManager(pendingManager.publicKey);

      await acceptNomination({ pendingManager });

      assert.equal(
        (await getFactory()).manager.toBase58(),
        pendingManager.publicKey.toBase58(),
        "manager should be replaced by the pending manager"
      );
      assert.isNull(
        await getAccountInfo(pdaUtils.factoryPendingManagerPda()),
        "pending PDA should be closed after accept"
      );
    });
  });

  describe("create_asset_class", () => {
    it("fails with FactoryPaused when the factory is paused", async () => {
      const manager = Keypair.generate();
      const owner = Keypair.generate().publicKey;
      await requestAirdrop(manager.publicKey);
      // Paused factory owned by `manager` (the manager check would pass, so we
      // isolate the pause precondition).
      await setFactory(manager.publicKey, true);

      try {
        await createAssetClass({ manager }, { configId, owner });
        assert.fail("Expected FactoryPaused error but create_asset_class succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      const manager = Keypair.generate();
      const rogue = Keypair.generate();
      const owner = Keypair.generate().publicKey;
      await requestAirdrop(rogue.publicKey);
      // Unpaused factory owned by `manager`; the rogue signs instead.
      await setFactory(manager.publicKey, false);

      try {
        await createAssetClass({ manager: rogue }, { configId, owner });
        assert.fail("Expected NotManager error but create_asset_class succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when the asset class already exists for the config id", async () => {
      const manager = Keypair.generate();
      const owner = Keypair.generate().publicKey;
      await requestAirdrop(manager.publicKey);
      await setFactory(manager.publicKey, false);
      // Force-create the ownership PDA for this config id via surfpool so `init` collides.
      await setAssetClassOwnership(configId, owner);

      try {
        await createAssetClass({ manager }, { configId, owner });
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

    // ────────────────────────────────────────────────────────────────────────────
    it("creates the ownership PDA with owner, latest_version=0 and bump", async () => {
      const manager = Keypair.generate();
      const owner = Keypair.generate().publicKey;
      await requestAirdrop(manager.publicKey);
      await setFactory(manager.publicKey, false);
      assert.isNull(
        await getAccountInfo(pdaUtils.assetClassOwnershipPda(configId)),
        "precondition: asset class PDA should not exist before creation"
      );

      await createAssetClass({ manager }, { configId, owner });

      const stored = await getAssetClassOwnership(configId);
      assert.equal(stored.owner.toBase58(), owner.toBase58(), "owner mismatch");
      assert.equal(stored.latestVersion.toString(), "0", "latest_version should be 0");
      assert.equal(stored.bump, pdaUtils.assetClassOwnershipPdaWithBump(configId)[1], "bump mismatch");

      const info = await getAccountInfo(pdaUtils.assetClassOwnershipPda(configId));
      assert.isNotNull(info, "asset class PDA should be created");
      assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "asset class PDA should be owned by factory");
    });
  });

  describe("nominate_asset_class_owner", () => {
    it("fails with FactoryPaused when the factory is paused", async () => {
      const currentOwner = Keypair.generate();
      await requestAirdrop(currentOwner.publicKey);
      // Paused factory + an asset class owned by `owner` (the owner check would
      // pass, so we isolate the pause precondition).
      await setFactory(Keypair.generate().publicKey, true);
      await setAssetClassOwnership(configId, currentOwner.publicKey);

      try {
        await nominateAssetClassOwner({ currentOwner }, { configId, newOwner: Keypair.generate().publicKey });
        assert.fail("Expected FactoryPaused error but nominate_asset_class_owner succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const owner = Keypair.generate();
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      // Unpaused factory; asset class owned by `owner`; the rogue signs instead.
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(configId, owner.publicKey);

      try {
        await nominateAssetClassOwner({ currentOwner: rogue }, { configId, newOwner: Keypair.generate().publicKey });
        assert.fail("Expected NotOwner error but nominate_asset_class_owner succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("creates the pending PDA when none exists", async () => {
      const currentOwner = Keypair.generate();
      const nominee = Keypair.generate().publicKey;
      await requestAirdrop(currentOwner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(configId, currentOwner.publicKey);
      assert.isNull(
        await getAccountInfo(pdaUtils.assetClassPendingOwnerPda(configId)),
        "precondition: pending PDA should not exist before nomination"
      );

      await nominateAssetClassOwner({ currentOwner }, { configId, newOwner: nominee });

      const pending = await getAssetClassPendingOwner(configId);
      assert.equal(pending.pendingOwner.toBase58(), nominee.toBase58(), "pending owner mismatch");
      assert.equal(pending.bump, pdaUtils.assetClassPendingOwnerPdaWithBump(configId)[1], "bump mismatch");

      const info = await getAccountInfo(pdaUtils.assetClassPendingOwnerPda(configId));
      assert.isNotNull(info, "pending PDA should be created");
      assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "pending PDA should be owned by factory");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("replaces the pending owner when a nomination already exists", async () => {
      const currentOwner = Keypair.generate();
      const oldNominee = Keypair.generate().publicKey;
      const newNominee = Keypair.generate().publicKey;
      await requestAirdrop(currentOwner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(configId, currentOwner.publicKey);
      // Force-create the pending PDA with an existing nominee via surfpool.
      await setAssetClassPendingOwner(configId, oldNominee);
      assert.equal(
        (await getAssetClassPendingOwner(configId)).pendingOwner.toBase58(),
        oldNominee.toBase58(),
        "precondition: old nominee should be planted"
      );

      await nominateAssetClassOwner({ currentOwner }, { configId, newOwner: newNominee });

      const pending = await getAssetClassPendingOwner(configId);
      assert.equal(pending.pendingOwner.toBase58(), newNominee.toBase58(), "pending owner should be replaced");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when the asset class does not exist", async () => {
      const currentOwner = Keypair.generate();
      await requestAirdrop(currentOwner.publicKey);
      // Unpaused factory, but no asset class ownership PDA for `configId` (cleared
      // by beforeEach) — Anchor account validation of `asset_class_ownership_pda`
      // fails before the handler runs.
      await setFactory(Keypair.generate().publicKey, false);
      assert.isNull(
        await getAccountInfo(pdaUtils.assetClassOwnershipPda(configId)),
        "precondition: asset class ownership PDA should not exist"
      );

      try {
        await nominateAssetClassOwner({ currentOwner }, { configId, newOwner: Keypair.generate().publicKey });
        assert.fail("Expected failure but nominate_asset_class_owner succeeded with no asset class");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });
  });

  describe("cancel_asset_class_ownership", () => {
    it("fails with FactoryPaused when the factory is paused", async () => {
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      // Paused factory + an asset class owned by `owner` + an existing pending PDA
      // so account validation passes and the handler runs into the pause check.
      await setFactory(Keypair.generate().publicKey, true);
      await setAssetClassOwnership(configId, owner.publicKey);
      await setAssetClassPendingOwner(configId, Keypair.generate().publicKey);

      try {
        await cancelAssetClassOwnership({ currentOwner: owner.publicKey, signers: [owner] }, { configId });
        assert.fail("Expected FactoryPaused error but cancel_asset_class_ownership succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const owner = Keypair.generate();
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(configId, owner.publicKey);
      await setAssetClassPendingOwner(configId, Keypair.generate().publicKey);

      try {
        await cancelAssetClassOwnership({ currentOwner: rogue.publicKey, signers: [rogue] }, { configId });
        assert.fail("Expected NotOwner error but cancel_asset_class_ownership succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when there is no pending nomination", async () => {
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      // Unpaused factory, asset class present, but no pending PDA (cleared by
      // beforeEach) — Anchor account validation fails before the handler runs.
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(configId, owner.publicKey);

      try {
        await cancelAssetClassOwnership({ currentOwner: owner.publicKey, signers: [owner] }, { configId });
        assert.fail("Expected failure but cancel_asset_class_ownership succeeded with no pending PDA");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("closes the pending PDA and leaves owner unchanged", async () => {
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(configId, owner.publicKey);
      await setAssetClassPendingOwner(configId, Keypair.generate().publicKey);

      await cancelAssetClassOwnership({ currentOwner: owner.publicKey, signers: [owner] }, { configId });

      assert.isNull(await getAccountInfo(pdaUtils.assetClassPendingOwnerPda(configId)), "pending PDA should be closed");
      assert.equal(
        (await getAssetClassOwnership(configId)).owner.toBase58(),
        owner.publicKey.toBase58(),
        "owner should be unchanged after cancel"
      );
    });
  });

  describe("pause", () => {
    it("pauses the factory", async () => {
      const manager = Keypair.generate();
      await requestAirdrop(manager.publicKey);
      await setFactory(manager.publicKey, false);

      await pauseFactory({ manager });

      assert.equal((await getFactory()).pause, true, "pause should be true after pause instruction");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryPaused when the factory is already paused", async () => {
      const manager = Keypair.generate();
      await requestAirdrop(manager.publicKey);
      await setFactory(manager.publicKey, true);

      try {
        await pauseFactory({ manager });
        assert.fail("Expected FactoryPaused error but pause succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      const manager = Keypair.generate();
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      await setFactory(manager.publicKey, false);

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
      const manager = Keypair.generate();
      await requestAirdrop(manager.publicKey);
      await setFactory(manager.publicKey, true);

      await unpauseFactory({ manager });

      assert.equal((await getFactory()).pause, false, "pause should be false after unpause instruction");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryNotPaused when the factory is not paused", async () => {
      const manager = Keypair.generate();
      await requestAirdrop(manager.publicKey);
      await setFactory(manager.publicKey, false);

      try {
        await unpauseFactory({ manager });
        assert.fail("Expected FactoryNotPaused error but unpause succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryNotPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotManager when called by a non-manager", async () => {
      const manager = Keypair.generate();
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      await setFactory(manager.publicKey, true);

      try {
        await unpauseFactory({ manager: rogue });
        assert.fail("Expected NotManager error but unpause succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
      }
    });
  });

  describe("accept_asset_class_ownership", () => {
    it("fails with FactoryPaused when the factory is paused", async () => {
      const owner = Keypair.generate().publicKey;
      const pendingOwner = Keypair.generate();
      await requestAirdrop(pendingOwner.publicKey);
      await setFactory(Keypair.generate().publicKey, true);
      await setAssetClassOwnership(configId, owner);
      await setAssetClassPendingOwner(configId, pendingOwner.publicKey);

      try {
        await acceptAssetClassOwnership(
          { pendingOwner: pendingOwner.publicKey, signers: [pendingOwner] },
          { configId }
        );
        assert.fail("Expected FactoryPaused error but accept_asset_class_ownership succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotPendingOwner when called by someone else", async () => {
      const owner = Keypair.generate().publicKey;
      const pendingOwner = Keypair.generate().publicKey;
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(configId, owner);
      await setAssetClassPendingOwner(configId, pendingOwner);

      try {
        await acceptAssetClassOwnership({ pendingOwner: rogue.publicKey, signers: [rogue] }, { configId });
        assert.fail("Expected NotPendingOwner error but accept_asset_class_ownership succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotPendingOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when there is no pending nomination", async () => {
      const owner = Keypair.generate().publicKey;
      const pendingOwner = Keypair.generate();
      await requestAirdrop(pendingOwner.publicKey);
      // Unpaused factory, asset class present, no pending PDA (cleared by
      // beforeEach) — Anchor account validation fails before the handler runs.
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(configId, owner);

      try {
        await acceptAssetClassOwnership(
          { pendingOwner: pendingOwner.publicKey, signers: [pendingOwner] },
          { configId }
        );
        assert.fail("Expected failure but accept_asset_class_ownership succeeded with no pending PDA");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("promotes the pending owner and closes the pending PDA", async () => {
      const owner = Keypair.generate().publicKey;
      const pendingOwner = Keypair.generate();
      await requestAirdrop(pendingOwner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(configId, owner);
      await setAssetClassPendingOwner(configId, pendingOwner.publicKey);

      await acceptAssetClassOwnership({ pendingOwner: pendingOwner.publicKey, signers: [pendingOwner] }, { configId });

      assert.equal(
        (await getAssetClassOwnership(configId)).owner.toBase58(),
        pendingOwner.publicKey.toBase58(),
        "owner should be replaced by the pending owner"
      );
      assert.isNull(
        await getAccountInfo(pdaUtils.assetClassPendingOwnerPda(configId)),
        "pending PDA should be closed after accept"
      );
    });
  });

  describe("deploy asset class version (init → write → finalize)", () => {
    // Each test uses its own config id so the per-(config_id, version) version PDA
    // never collides across tests (beforeEach only clears the shared `configId`).
    it("writes the mask across chunks, seals to Ready and bumps latest_version", async () => {
      const cfg = new anchor.BN(100);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      // 1000-byte mask (8000 functionalities) with a few bits set, written in
      // 400-byte chunks → three `write` calls, so the multi-step path is exercised.
      const mask = Buffer.alloc(1000);
      mask[0] = 0b0000_0101; // functionalities 0 and 2
      mask[500] = 0xff;
      mask[999] = 0b1000_0000;
      const version = new anchor.BN(1);

      await deployAssetClassVersion({ owner }, { configId: cfg, version, mask, chunkSize: 400 });

      const stored = await getAssetClassVersion(cfg, version);
      assert.equal(stored.configId.toString(), cfg.toString(), "config id mismatch");
      assert.equal(stored.version.toString(), "1", "version mismatch");
      assert.equal(stored.state, 1, "version should be Ready (1) after finalize");

      // The on-chain mask is the full fixed capacity; the first 1000 bytes are what
      // we wrote, the rest stays zeroed.
      const onChainMask = await getAssetClassVersionMask(cfg, version);
      assert.equal(onChainMask.length, FUNCTIONALITIES_BYTES_MASK, "mask is fixed capacity");
      assert.isTrue(onChainMask.subarray(0, mask.length).equals(mask), "written mask should match");

      assert.equal(
        (await getAssetClassOwnership(cfg)).latestVersion.toString(),
        "1",
        "latest_version should advance to 1 after finalize"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("each version is independent and does not inherit from the previous one", async () => {
      const cfg = new anchor.BN(101);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      await clearAssetClassVersion(cfg, new anchor.BN(2));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      // v1 activates functionality 0.
      const v1 = new anchor.BN(1);
      const v1Mask = Buffer.alloc(8);
      v1Mask[0] = 0b0000_0001;
      await deployAssetClassVersion({ owner }, { configId: cfg, version: v1, mask: v1Mask });

      // v2 activates a completely different functionality (7) — nothing from v1.
      const v2 = new anchor.BN(2);
      const v2Mask = Buffer.alloc(8);
      v2Mask[0] = 0b1000_0000;
      await deployAssetClassVersion({ owner }, { configId: cfg, version: v2, mask: v2Mask });

      const onChainV2 = await getAssetClassVersionMask(cfg, v2);
      assert.equal(onChainV2[0], 0b1000_0000, "v2 reflects only its own bits, not v1's");
      assert.equal((await getAssetClassOwnership(cfg)).latestVersion.toString(), "2", "latest_version advances to 2");
    });
  });

  describe("init_asset_class_version", () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("creates the Draft version PDA", async () => {
      const cfg = new anchor.BN(115);
      const version = new anchor.BN(1);
      await clearAssetClassVersion(cfg, version);
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      const versionPda = pdaUtils.assetClassVersionPda(cfg, version);
      const [, expectedBump] = pdaUtils.assetClassVersionPdaWithBump(cfg, version);
      assert.isNull(
        await getAccountInfo(versionPda),
        "precondition: asset class version PDA should not exist before init"
      );

      await initAssetClassVersion({ owner }, { configId: cfg, version });

      const stored = await getAssetClassVersion(cfg, version);
      assert.equal(stored.configId.toString(), cfg.toString(), "config id mismatch");
      assert.equal(stored.version.toString(), version.toString(), "version mismatch");
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
      const cfg = new anchor.BN(116);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      // Paused factory + an asset class owned by `owner` (the owner check would
      // pass, so we isolate the pause precondition).
      await setFactory(Keypair.generate().publicKey, true);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      try {
        await initAssetClassVersion({ owner }, { configId: cfg, version: new anchor.BN(1) });
        assert.fail("Expected FactoryPaused but init succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const cfg = new anchor.BN(104);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate().publicKey;
      const rogue = Keypair.generate();
      await requestAirdrop(rogue.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner, new anchor.BN(0));

      try {
        await initAssetClassVersion({ owner: rogue }, { configId: cfg, version: new anchor.BN(1) });
        assert.fail("Expected NotOwner but init succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with InvalidVersion when version is not latest_version + 1", async () => {
      const cfg = new anchor.BN(103);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      // Ownership already at version 5, so the next version must be 6 — asking for 1 fails.
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(5));

      try {
        await initAssetClassVersion({ owner }, { configId: cfg, version: new anchor.BN(1) });
        assert.fail("Expected InvalidVersion but init succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "InvalidVersion");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails when trying to create the same (config_id, version) twice", async () => {
      const cfg = new anchor.BN(109);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      const version = new anchor.BN(1);
      const mask = Buffer.alloc(8);
      mask[0] = 0b0000_0001;
      // Deploy v1 fully so its version PDA exists on-chain.
      await deployAssetClassVersion({ owner }, { configId: cfg, version, mask });

      try {
        // `init` for the same (config_id, version) PDA must fail — it already exists.
        await initAssetClassVersion({ owner }, { configId: cfg, version });
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

  describe("write_asset_class_version_mask", () => {
    it("fails with MaskChunkOutOfBounds when the chunk exceeds the mask capacity", async () => {
      const cfg = new anchor.BN(107);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      const version = new anchor.BN(1);
      await initAssetClassVersion({ owner }, { configId: cfg, version });

      try {
        // A 2-byte chunk at the last byte runs one byte past the fixed capacity.
        await writeAssetClassVersionMask(
          { owner },
          { configId: cfg, version, offset: FUNCTIONALITIES_BYTES_MASK - 1, chunk: Buffer.alloc(2) }
        );
        assert.fail("Expected MaskChunkOutOfBounds but write succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "MaskChunkOutOfBounds");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with VersionNotDraft once the version is sealed (immutability)", async () => {
      const cfg = new anchor.BN(108);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      const version = new anchor.BN(1);
      const mask = Buffer.alloc(8);
      mask[0] = 0b0000_0001;
      await deployAssetClassVersion({ owner }, { configId: cfg, version, mask });

      try {
        await writeAssetClassVersionMask({ owner }, { configId: cfg, version, offset: 0, chunk: Buffer.from([0xff]) });
        assert.fail("Expected VersionNotDraft but write succeeded on a sealed version");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "VersionNotDraft");
      }
    });
  });

  describe("finalize_asset_class_version", () => {
    it("seals the version to Ready and advances latest_version", async () => {
      const cfg = new anchor.BN(110);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      const version = new anchor.BN(1);
      await initAssetClassVersion({ owner }, { configId: cfg, version });

      const before = await getAssetClassVersion(cfg, version);
      assert.equal(before.state, 0, "precondition: version should be Draft (0) before finalize");

      await finalizeAssetClassVersion({ owner }, { configId: cfg, version });

      const after = await getAssetClassVersion(cfg, version);
      assert.equal(after.state, 1, "version should be Ready (1) after finalize");
      assert.equal(
        (await getAssetClassOwnership(cfg)).latestVersion.toString(),
        version.toString(),
        "latest_version should advance to the finalized version"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with FactoryPaused when the factory is paused", async () => {
      const cfg = new anchor.BN(111);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      const version = new anchor.BN(1);
      await initAssetClassVersion({ owner }, { configId: cfg, version });

      // Pause only after the draft exists, so the failure is isolated to the
      // finalize call itself, not to some earlier step.
      await setFactory(Keypair.generate().publicKey, true);

      try {
        await finalizeAssetClassVersion({ owner }, { configId: cfg, version });
        assert.fail("Expected FactoryPaused but finalize succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with NotOwner when called by a non-owner", async () => {
      const cfg = new anchor.BN(112);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      const rogue = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await requestAirdrop(rogue.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      const version = new anchor.BN(1);
      await initAssetClassVersion({ owner }, { configId: cfg, version });

      try {
        await finalizeAssetClassVersion({ owner: rogue }, { configId: cfg, version });
        assert.fail("Expected NotOwner but finalize succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with VersionNotDraft when the version is already sealed", async () => {
      const cfg = new anchor.BN(113);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      const version = new anchor.BN(1);
      await initAssetClassVersion({ owner }, { configId: cfg, version });
      await finalizeAssetClassVersion({ owner }, { configId: cfg, version });

      try {
        // Same version, already Ready — must be rejected, not silently re-sealed.
        await finalizeAssetClassVersion({ owner }, { configId: cfg, version });
        assert.fail("Expected VersionNotDraft but finalize succeeded on an already-sealed version");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "VersionNotDraft");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("fails with InvalidVersion when latest_version no longer matches", async () => {
      const cfg = new anchor.BN(114);
      await clearAssetClassVersion(cfg, new anchor.BN(1));
      const owner = Keypair.generate();
      await requestAirdrop(owner.publicKey);
      await setFactory(Keypair.generate().publicKey, false);
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(0));

      const version = new anchor.BN(1);
      await initAssetClassVersion({ owner }, { configId: cfg, version });

      // Simulate `latest_version` having moved on since this draft was created —
      // the draft's own `version` field (1) no longer equals `latest_version + 1` (6).
      await setAssetClassOwnership(cfg, owner.publicKey, new anchor.BN(5));

      try {
        await finalizeAssetClassVersion({ owner }, { configId: cfg, version });
        assert.fail("Expected InvalidVersion but finalize succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        assert.equal((err as AnchorError).error.errorCode.code, "InvalidVersion");
      }
    });
  });
});
