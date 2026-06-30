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
  clearFactory,
  clearFactoryPendingManager,
  createAssetClass,
  getAssetClassOwnership,
  getAssetClassPendingOwner,
  getFactory,
  getFactoryPendingManager,
  initializeFactory,
  nominateAssetClassOwner,
  nominateManager,
  setAssetClassOwnership,
  setAssetClassPendingOwner,
  setFactory,
  setFactoryPendingManager,
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

  // ── initialize ──────────────────────────────────────────────────────────────
  it("initialize: creates the factory PDA and stores manager, pause=false and bump", async () => {
    const factoryPda = pdaUtils.factoryPda();
    const manager = Keypair.generate();

    // Always runs the instruction — on a fresh validator the singleton PDA does
    // not exist yet, so this both creates it and exercises the handler.
    // `manager` is a required signer, so it must be passed in `signers`.
    await initializeFactory({ signers: [manager] }, { manager: manager.publicKey });

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
  it("initialize: fails when the manager does not sign the transaction", async () => {
    const manager = Keypair.generate();

    try {
      // `manager` is a required `Signer`, but we deliberately omit its keypair
      // from `signers`. The transaction is therefore missing a required
      // signature and is rejected before it ever reaches the cluster.
      await initializeFactory({ signers: [] }, { manager: manager.publicKey });

      assert.fail("Expected failure but initialize succeeded without the manager's signature");
    } catch (err) {
      const message = (err as Error).message ?? "";
      assert.match(message, /signature/i, "error should reference the missing manager signature");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("initialize: fails when the factory PDA already exists", async () => {
    // Plant an existing factory so a second `init` must fail.
    await setFactory(Keypair.generate().publicKey, false);

    try {
      // Fully sign the transaction so it reaches the cluster — the failure must
      // come from `init` (PDA already exists), not from a missing signature.
      const manager = Keypair.generate();
      await initializeFactory({ signers: [manager] }, { manager: manager.publicKey });

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

  // ── nominate_manager ──────────────────────────────────────────────────────────
  it("nominate_manager: fails with FactoryPaused when the factory is paused", async () => {
    const manager = Keypair.generate();
    await requestAirdrop(manager.publicKey);
    // Paused factory owned by `manager` (the manager check would pass, so we
    // isolate the pause precondition).
    await setFactory(manager.publicKey, true);

    try {
      await nominateManager(
        {
          currentManager: manager.publicKey,
          signers: [manager],
        },
        { newManager: Keypair.generate().publicKey }
      );
      assert.fail("Expected FactoryPaused error but nominate_manager succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("nominate_manager: fails with NotManager when called by a non-manager", async () => {
    const manager = Keypair.generate();
    const rogue = Keypair.generate();
    await requestAirdrop(rogue.publicKey);
    // Unpaused factory owned by `manager`; the rogue signs instead.
    await setFactory(manager.publicKey, false);

    try {
      await nominateManager(
        {
          currentManager: rogue.publicKey,
          signers: [rogue],
        },
        { newManager: Keypair.generate().publicKey }
      );
      assert.fail("Expected NotManager error but nominate_manager succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("nominate_manager: creates the pending PDA when none exists", async () => {
    const manager = Keypair.generate();
    const nominee = Keypair.generate().publicKey;
    await requestAirdrop(manager.publicKey);
    await setFactory(manager.publicKey, false);
    assert.isNull(
      await getAccountInfo(pdaUtils.factoryPendingManagerPda()),
      "precondition: pending PDA should not exist before nomination"
    );

    await nominateManager({ currentManager: manager.publicKey, signers: [manager] }, { newManager: nominee });

    const pending = await getFactoryPendingManager();
    assert.equal(pending.pendingManager.toBase58(), nominee.toBase58(), "pending manager mismatch");
    assert.equal(pending.bump, pdaUtils.factoryPendingManagerPdaWithBump()[1], "bump mismatch");

    const info = await getAccountInfo(pdaUtils.factoryPendingManagerPda());
    assert.isNotNull(info, "pending PDA should be created");
    assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "pending PDA should be owned by factory");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("nominate_manager: replaces the pending manager when a nomination already exists", async () => {
    const manager = Keypair.generate();
    const oldNominee = Keypair.generate().publicKey;
    const newNominee = Keypair.generate().publicKey;
    await requestAirdrop(manager.publicKey);
    await setFactory(manager.publicKey, false);
    // Force-create the pending PDA with an existing nominee via surfpool.
    await setFactoryPendingManager(oldNominee);
    assert.equal(
      (await getFactoryPendingManager()).pendingManager.toBase58(),
      oldNominee.toBase58(),
      "precondition: old nominee should be planted"
    );

    await nominateManager({ currentManager: manager.publicKey, signers: [manager] }, { newManager: newNominee });

    const pending = await getFactoryPendingManager();
    assert.equal(pending.pendingManager.toBase58(), newNominee.toBase58(), "pending manager should be replaced");
  });

  // ── cancel_nomination ─────────────────────────────────────────────────────────
  it("cancel_nomination: fails with FactoryPaused when the factory is paused", async () => {
    const manager = Keypair.generate();
    await requestAirdrop(manager.publicKey);
    // Paused factory + an existing pending PDA so account validation passes and
    // the handler runs into the pause check.
    await setFactory(manager.publicKey, true);
    await setFactoryPendingManager(Keypair.generate().publicKey);

    try {
      await cancelNomination({ currentManager: manager.publicKey, signers: [manager] });
      assert.fail("Expected FactoryPaused error but cancel_nomination succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("cancel_nomination: fails with NotManager when called by a non-manager", async () => {
    const manager = Keypair.generate();
    const rogue = Keypair.generate();
    await requestAirdrop(rogue.publicKey);
    await setFactory(manager.publicKey, false);
    await setFactoryPendingManager(Keypair.generate().publicKey);

    try {
      await cancelNomination({ currentManager: rogue.publicKey, signers: [rogue] });
      assert.fail("Expected NotManager error but cancel_nomination succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("cancel_nomination: fails when there is no pending nomination", async () => {
    const manager = Keypair.generate();
    await requestAirdrop(manager.publicKey);
    // Unpaused factory, no pending PDA (cleared by beforeEach) — Anchor account
    // validation fails before the handler runs.
    await setFactory(manager.publicKey, false);

    try {
      await cancelNomination({ currentManager: manager.publicKey, signers: [manager] });
      assert.fail("Expected failure but cancel_nomination succeeded with no pending PDA");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("cancel_nomination: closes the pending PDA and leaves manager unchanged", async () => {
    const manager = Keypair.generate();
    await requestAirdrop(manager.publicKey);
    await setFactory(manager.publicKey, false);
    await setFactoryPendingManager(Keypair.generate().publicKey);

    await cancelNomination({ currentManager: manager.publicKey, signers: [manager] });

    assert.isNull(await getAccountInfo(pdaUtils.factoryPendingManagerPda()), "pending PDA should be closed");
    assert.equal(
      (await getFactory()).manager.toBase58(),
      manager.publicKey.toBase58(),
      "manager should be unchanged after cancel"
    );
  });

  // ── accept_nomination ─────────────────────────────────────────────────────────
  it("accept_nomination: fails with FactoryPaused when the factory is paused", async () => {
    const manager = Keypair.generate();
    const pendingManager = Keypair.generate();
    await requestAirdrop(pendingManager.publicKey);
    await setFactory(manager.publicKey, true);
    await setFactoryPendingManager(pendingManager.publicKey);

    try {
      await acceptNomination({ pendingManager: pendingManager.publicKey, signers: [pendingManager] });
      assert.fail("Expected FactoryPaused error but accept_nomination succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("accept_nomination: fails with NotPendingManager when called by someone else", async () => {
    const manager = Keypair.generate();
    const pendingManager = Keypair.generate().publicKey;
    const rogue = Keypair.generate();
    await requestAirdrop(rogue.publicKey);
    await setFactory(manager.publicKey, false);
    await setFactoryPendingManager(pendingManager);

    try {
      await acceptNomination({ pendingManager: rogue.publicKey, signers: [rogue] });
      assert.fail("Expected NotPendingManager error but accept_nomination succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "NotPendingManager");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("accept_nomination: fails when there is no pending nomination", async () => {
    const pendingManager = Keypair.generate();
    await requestAirdrop(pendingManager.publicKey);
    // Unpaused factory, no pending PDA (cleared by beforeEach) — Anchor account
    // validation fails before the handler runs.
    await setFactory(Keypair.generate().publicKey, false);

    try {
      await acceptNomination({ pendingManager: pendingManager.publicKey, signers: [pendingManager] });
      assert.fail("Expected failure but accept_nomination succeeded with no pending PDA");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("accept_nomination: promotes the pending manager and closes the pending PDA", async () => {
    const manager = Keypair.generate().publicKey;
    const pendingManager = Keypair.generate();
    await requestAirdrop(pendingManager.publicKey);
    await setFactory(manager, false);
    await setFactoryPendingManager(pendingManager.publicKey);

    await acceptNomination({ pendingManager: pendingManager.publicKey, signers: [pendingManager] });

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

  // ── create_asset_class ────────────────────────────────────────────────────────
  it("create_asset_class: fails with FactoryPaused when the factory is paused", async () => {
    const manager = Keypair.generate();
    const owner = Keypair.generate().publicKey;
    await requestAirdrop(manager.publicKey);
    // Paused factory owned by `manager` (the manager check would pass, so we
    // isolate the pause precondition).
    await setFactory(manager.publicKey, true);

    try {
      await createAssetClass(configId, owner, { manager: manager.publicKey, signers: [manager] });
      assert.fail("Expected FactoryPaused error but create_asset_class succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_asset_class: fails with NotManager when called by a non-manager", async () => {
    const manager = Keypair.generate();
    const rogue = Keypair.generate();
    const owner = Keypair.generate().publicKey;
    await requestAirdrop(rogue.publicKey);
    // Unpaused factory owned by `manager`; the rogue signs instead.
    await setFactory(manager.publicKey, false);

    try {
      await createAssetClass(configId, owner, { manager: rogue.publicKey, signers: [rogue] });
      assert.fail("Expected NotManager error but create_asset_class succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "NotManager");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("create_asset_class: fails when the asset class already exists for the config id", async () => {
    const manager = Keypair.generate();
    const owner = Keypair.generate().publicKey;
    await requestAirdrop(manager.publicKey);
    await setFactory(manager.publicKey, false);
    // Force-create the ownership PDA for this config id via surfpool so `init` collides.
    await setAssetClassOwnership(configId, owner);

    try {
      await createAssetClass(configId, owner, { manager: manager.publicKey, signers: [manager] });
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
  it("create_asset_class: creates the ownership PDA with owner, latest_version=0 and bump", async () => {
    const manager = Keypair.generate();
    const owner = Keypair.generate().publicKey;
    await requestAirdrop(manager.publicKey);
    await setFactory(manager.publicKey, false);
    assert.isNull(
      await getAccountInfo(pdaUtils.assetClassOwnershipPda(configId)),
      "precondition: asset class PDA should not exist before creation"
    );

    await createAssetClass(configId, owner, { manager: manager.publicKey, signers: [manager] });

    const stored = await getAssetClassOwnership(configId);
    assert.equal(stored.owner.toBase58(), owner.toBase58(), "owner mismatch");
    assert.equal(stored.latestVersion.toString(), "0", "latest_version should be 0");
    assert.equal(stored.bump, pdaUtils.assetClassOwnershipPdaWithBump(configId)[1], "bump mismatch");

    const info = await getAccountInfo(pdaUtils.assetClassOwnershipPda(configId));
    assert.isNotNull(info, "asset class PDA should be created");
    assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "asset class PDA should be owned by factory");
  });

  // ── nominate_asset_class_owner ──────────────────────────────────────────────
  it("nominate_asset_class_owner: fails with FactoryPaused when the factory is paused", async () => {
    const owner = Keypair.generate();
    await requestAirdrop(owner.publicKey);
    // Paused factory + an asset class owned by `owner` (the owner check would
    // pass, so we isolate the pause precondition).
    await setFactory(Keypair.generate().publicKey, true);
    await setAssetClassOwnership(configId, owner.publicKey);

    try {
      await nominateAssetClassOwner(
        { currentOwner: owner.publicKey, signers: [owner] },
        { configId, newOwner: Keypair.generate().publicKey }
      );
      assert.fail("Expected FactoryPaused error but nominate_asset_class_owner succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("nominate_asset_class_owner: fails with NotOwner when called by a non-owner", async () => {
    const owner = Keypair.generate();
    const rogue = Keypair.generate();
    await requestAirdrop(rogue.publicKey);
    // Unpaused factory; asset class owned by `owner`; the rogue signs instead.
    await setFactory(Keypair.generate().publicKey, false);
    await setAssetClassOwnership(configId, owner.publicKey);

    try {
      await nominateAssetClassOwner(
        { currentOwner: rogue.publicKey, signers: [rogue] },
        { configId, newOwner: Keypair.generate().publicKey }
      );
      assert.fail("Expected NotOwner error but nominate_asset_class_owner succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "NotOwner");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("nominate_asset_class_owner: creates the pending PDA when none exists", async () => {
    const owner = Keypair.generate();
    const nominee = Keypair.generate().publicKey;
    await requestAirdrop(owner.publicKey);
    await setFactory(Keypair.generate().publicKey, false);
    await setAssetClassOwnership(configId, owner.publicKey);
    assert.isNull(
      await getAccountInfo(pdaUtils.assetClassPendingOwnerPda(configId)),
      "precondition: pending PDA should not exist before nomination"
    );

    await nominateAssetClassOwner({ currentOwner: owner.publicKey, signers: [owner] }, { configId, newOwner: nominee });

    const pending = await getAssetClassPendingOwner(configId);
    assert.equal(pending.pendingOwner.toBase58(), nominee.toBase58(), "pending owner mismatch");
    assert.equal(pending.bump, pdaUtils.assetClassPendingOwnerPdaWithBump(configId)[1], "bump mismatch");

    const info = await getAccountInfo(pdaUtils.assetClassPendingOwnerPda(configId));
    assert.isNotNull(info, "pending PDA should be created");
    assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "pending PDA should be owned by factory");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("nominate_asset_class_owner: replaces the pending owner when a nomination already exists", async () => {
    const owner = Keypair.generate();
    const oldNominee = Keypair.generate().publicKey;
    const newNominee = Keypair.generate().publicKey;
    await requestAirdrop(owner.publicKey);
    await setFactory(Keypair.generate().publicKey, false);
    await setAssetClassOwnership(configId, owner.publicKey);
    // Force-create the pending PDA with an existing nominee via surfpool.
    await setAssetClassPendingOwner(configId, oldNominee);
    assert.equal(
      (await getAssetClassPendingOwner(configId)).pendingOwner.toBase58(),
      oldNominee.toBase58(),
      "precondition: old nominee should be planted"
    );

    await nominateAssetClassOwner(
      { currentOwner: owner.publicKey, signers: [owner] },
      { configId, newOwner: newNominee }
    );

    const pending = await getAssetClassPendingOwner(configId);
    assert.equal(pending.pendingOwner.toBase58(), newNominee.toBase58(), "pending owner should be replaced");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("nominate_asset_class_owner: fails when the asset class does not exist", async () => {
    const owner = Keypair.generate();
    await requestAirdrop(owner.publicKey);
    // Unpaused factory, but no asset class ownership PDA for `configId` (cleared
    // by beforeEach) — Anchor account validation of `asset_class_ownership_pda`
    // fails before the handler runs.
    await setFactory(Keypair.generate().publicKey, false);
    assert.isNull(
      await getAccountInfo(pdaUtils.assetClassOwnershipPda(configId)),
      "precondition: asset class ownership PDA should not exist"
    );

    try {
      await nominateAssetClassOwner(
        { currentOwner: owner.publicKey, signers: [owner] },
        { configId, newOwner: Keypair.generate().publicKey }
      );
      assert.fail("Expected failure but nominate_asset_class_owner succeeded with no asset class");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
    }
  });

  // ── cancel_asset_class_ownership ────────────────────────────────────────────
  it("cancel_asset_class_ownership: fails with FactoryPaused when the factory is paused", async () => {
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
  it("cancel_asset_class_ownership: fails with NotOwner when called by a non-owner", async () => {
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
  it("cancel_asset_class_ownership: fails when there is no pending nomination", async () => {
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
  it("cancel_asset_class_ownership: closes the pending PDA and leaves owner unchanged", async () => {
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

  // ── accept_asset_class_ownership ────────────────────────────────────────────
  it("accept_asset_class_ownership: fails with FactoryPaused when the factory is paused", async () => {
    const owner = Keypair.generate().publicKey;
    const pendingOwner = Keypair.generate();
    await requestAirdrop(pendingOwner.publicKey);
    await setFactory(Keypair.generate().publicKey, true);
    await setAssetClassOwnership(configId, owner);
    await setAssetClassPendingOwner(configId, pendingOwner.publicKey);

    try {
      await acceptAssetClassOwnership({ pendingOwner: pendingOwner.publicKey, signers: [pendingOwner] }, { configId });
      assert.fail("Expected FactoryPaused error but accept_asset_class_ownership succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "FactoryPaused");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("accept_asset_class_ownership: fails with NotPendingOwner when called by someone else", async () => {
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
  it("accept_asset_class_ownership: fails when there is no pending nomination", async () => {
    const owner = Keypair.generate().publicKey;
    const pendingOwner = Keypair.generate();
    await requestAirdrop(pendingOwner.publicKey);
    // Unpaused factory, asset class present, no pending PDA (cleared by
    // beforeEach) — Anchor account validation fails before the handler runs.
    await setFactory(Keypair.generate().publicKey, false);
    await setAssetClassOwnership(configId, owner);

    try {
      await acceptAssetClassOwnership({ pendingOwner: pendingOwner.publicKey, signers: [pendingOwner] }, { configId });
      assert.fail("Expected failure but accept_asset_class_ownership succeeded with no pending PDA");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "AccountNotInitialized");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("accept_asset_class_ownership: promotes the pending owner and closes the pending PDA", async () => {
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
