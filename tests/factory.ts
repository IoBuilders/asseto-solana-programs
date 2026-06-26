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
    const manager = Keypair.generate().publicKey;

    // Always runs the instruction — on a fresh validator the singleton PDA does
    // not exist yet, so this both creates it and exercises the handler.
    await initializeFactory(manager);

    const stored = await getFactory(factoryPda);
    assert.equal(stored.manager.toBase58(), manager.toBase58(), "manager mismatch");
    assert.equal(stored.pause, false, "pause should default to false");
    assert.equal(stored.bump, pdaUtils.factoryPdaWithBump()[1], "bump mismatch");

    // PDA must now exist and be owned by factory.
    const info = await getAccountInfo(factoryPda);
    assert.isNotNull(info, "factory PDA should be created by initialize");
    assert.equal(info!.owner.toBase58(), FACTORY_PROGRAM_ID.toBase58(), "factory PDA should be owned by factory");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("initialize: fails when the factory PDA already exists", async () => {
    // Ensure the PDA exists (created either by the test above or here).
    if ((await getAccountInfo(pdaUtils.factoryPda())) === null) {
      await initializeFactory(Keypair.generate().publicKey);
    }

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
});
