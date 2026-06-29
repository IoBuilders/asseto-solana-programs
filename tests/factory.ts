import * as anchor from "@anchor-lang/core";
import { Keypair, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { FACTORY_PROGRAM_ID } from "./utils/address_utils";
import * as pdaUtils from "./utils/pda_utils";
import { getAccountInfo } from "./program_helpers/account_helper";
import { getFactory, initializeFactory } from "./program_helpers/factory_helper";

describe("factory", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // ────────────────────────────────────────────────────────────────────────────
  it("initialize: creates the factory PDA and stores manager, pause=false and bump", async () => {
    const factoryPda = pdaUtils.factoryPda();
    const manager = Keypair.generate();

    // Always runs the instruction — on a fresh validator the singleton PDA does
    // not exist yet, so this both creates it and exercises the handler.
    // `manager` is a required signer, so it must be passed in `signers`.
    await initializeFactory(manager.publicKey, { signers: [manager] });

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
      await initializeFactory(manager.publicKey, { signers: [] });
      assert.fail("Expected failure but initialize succeeded without the manager's signature");
    } catch (err) {
      const message = (err as Error).message ?? "";
      assert.match(message, /signature/i, "error should reference the missing manager signature");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("initialize: fails when the factory PDA already exists", async () => {
    // Ensure the PDA exists (created either by the test above or here).
    // `manager` is a required signer, so it must be passed in `signers`.
    if ((await getAccountInfo(pdaUtils.factoryPda())) === null) {
      const seedManager = Keypair.generate();
      await initializeFactory(seedManager.publicKey, { signers: [seedManager] });
    }

    try {
      // Fully sign the transaction so it reaches the cluster — the failure must
      // come from `init` (PDA already exists), not from a missing signature.
      const manager = Keypair.generate();
      await initializeFactory(manager.publicKey, { signers: [manager] });
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
