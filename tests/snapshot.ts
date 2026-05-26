import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";
import { takeSnapshot } from "./program_helpers/snapshot_helper";

describe("snapshot", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployer = provider.wallet.publicKey;

  // ────────────────────────────────────────────────────────────────────────────
  // `take_snapshot` is auxiliary: only callable via CPI from coupon, with
  // the `coupon_authority` PDA as `calling_authority`. Any direct call from a
  // wallet must fail the authorised-caller check inside the handler.
  it("take_snapshot: rejects direct invocation with Unauthorized (auxiliary, only callable via coupon CPI)", async () => {
    const mint = Keypair.generate().publicKey;

    try {
      await takeSnapshot({ deployer, mint });
      assert.fail("Expected Unauthorized error but take_snapshot succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Unauthorized");
    }
  });
});
