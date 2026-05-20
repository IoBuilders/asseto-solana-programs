import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Snapshot } from "../target/types/snapshot";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";

describe("snapshot", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const snapshotProgram = anchor.workspace.Snapshot as Program<Snapshot>;
  const deployer = provider.wallet.publicKey;

  // ────────────────────────────────────────────────────────────────────────────
  // `take_snapshot` is auxiliary: only callable via CPI from coupon, with
  // the `coupon_authority` PDA as `calling_authority`. Any direct call from a
  // wallet must fail the authorised-caller check inside the handler.
  it("take_snapshot: rejects direct invocation with Unauthorized (auxiliary, only callable via coupon CPI)", async () => {
    const mint = Keypair.generate().publicKey;
    const [snapshotCounter] = PublicKey.findProgramAddressSync(
      [Buffer.from("snapshot_counter"), mint.toBuffer()],
      snapshotProgram.programId
    );

    try {
      await snapshotProgram.methods
        .takeSnapshot()
        .accountsStrict({
          callingAuthority: deployer,
          payer: deployer,
          mint,
          snapshotCounter,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected Unauthorized error but take_snapshot succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      console.log("  caught error code:", anchorErr.error.errorCode.code);
      assert.equal(anchorErr.error.errorCode.code, "Unauthorized");
    }
  });
});
