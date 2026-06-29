import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { FACTORY_PROGRAM_ID } from "./utils/address_utils";
import * as pdaUtils from "./utils/pda_utils";
import { getAccountInfo, requestAirdrop } from "./program_helpers/account_helper";
import {
  acceptNomination,
  cancelNomination,
  clearAssetClassOwnership,
  clearFactory,
  clearFactoryPendingManager,
  createAssetClass,
  getAssetClassOwnership,
  getFactory,
  getFactoryPendingManager,
  initializeFactory,
  nominateManager,
  setAssetClassOwnership,
  setFactory,
  setFactoryPendingManager,
} from "./program_helpers/factory_helper";

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
  });

  // ── initialize ──────────────────────────────────────────────────────────────
  it("initialize: creates the factory PDA and stores manager, pause=false and bump", async () => {
    const factoryPda = pdaUtils.factoryPda();
    const manager = Keypair.generate().publicKey;

    await initializeFactory(manager);

    const stored = await getFactory(factoryPda);
    assert.equal(stored.manager.toBase58(), manager.toBase58(), "manager mismatch");
    assert.equal(stored.pause, false, "pause should default to false");
    assert.equal(stored.bump, pdaUtils.factoryPdaWithBump()[1], "bump mismatch");

    const info = await getAccountInfo(factoryPda);
    assert.isNotNull(info, "factory PDA should be created by initialize");
    assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "factory PDA should be owned by factory");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("initialize: fails when the factory PDA already exists", async () => {
    // Plant an existing factory so a second `init` must fail.
    await setFactory(Keypair.generate().publicKey, false);

    try {
      await initializeFactory(Keypair.generate().publicKey);
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
      await nominateManager(Keypair.generate().publicKey, {
        currentManager: manager.publicKey,
        signers: [manager],
      });
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
      await nominateManager(Keypair.generate().publicKey, {
        currentManager: rogue.publicKey,
        signers: [rogue],
      });
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

    await nominateManager(nominee, { currentManager: manager.publicKey, signers: [manager] });

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

    await nominateManager(newNominee, { currentManager: manager.publicKey, signers: [manager] });

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

    assert.isNull(
      await getAccountInfo(pdaUtils.factoryPendingManagerPda()),
      "pending PDA should be closed"
    );
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
});
