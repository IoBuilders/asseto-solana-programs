import * as anchor from "@anchor-lang/core";
import { Keypair, SendTransactionError } from "@solana/web3.js";
import { getPermissionedBurn, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { permissionedBurnPda } from "./program_helpers/operations/operations_pda_helper";
import {
  createTokenAccount,
  getMint,
  getTokenAccount,
  mintTokensViaSurfpool,
  splBurn,
} from "./program_helpers/spl_token_helper";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
const BURN_AMOUNT = BigInt(100 * 10 ** MINT_DECIMALS);

describe("burn", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: Token-2022's plain Burn is rejected without the permissioned-burn authority", async () => {
    const { mint } = await deployMint({}, { decimals: MINT_DECIMALS });

    // Precondition: the mint really does carry a PermissionedBurn authority.
    // Asserted explicitly so a failure below is attributable to that authority
    // being unsatisfiable by the plain Burn instruction, not to some other cause.
    const permissionedBurnState = getPermissionedBurn(await getMint(mint));
    assert.equal(
      permissionedBurnState?.authority?.toBase58(),
      permissionedBurnPda(mint).toBase58(),
      "mint should carry the operations program's permissioned-burn authority"
    );

    const holder = Keypair.generate();
    const tokenAccount = await createTokenAccount({ mint, owner: holder.publicKey });
    await mintTokensViaSurfpool(mint, tokenAccount, MINT_AMOUNT);

    const supplyBefore = (await getMint(mint)).supply;
    const balanceBefore = (await getTokenAccount(tokenAccount)).amount;

    // The holder owns the tokens and signs, so the *only* thing missing is the
    // mint's permissioned-burn authority — which plain `Burn` has no slot for.
    try {
      await splBurn({ mint, tokenAccount, amount: BURN_AMOUNT, owner: holder });
      assert.fail("Expected the plain Token-2022 Burn to be rejected but it succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const logs = (err as SendTransactionError).logs ?? [];

      // Token-2022 reached the plain Burn handler...
      assert.isTrue(
        logs.some((l) => l.includes("Instruction: Burn")),
        `plain Burn should be the attempted instruction, got logs:\n${logs.join("\n")}`
      );
      // ...and rejected it with TokenError::InvalidInstruction (0xc). There is no
      // dedicated "permissioned burn required" variant — Token-2022 reuses
      // InvalidInstruction to say the plain Burn is unusable on this mint.
      assert.isTrue(
        logs.some((l) => l.includes(TOKEN_2022_PROGRAM_ID.toBase58()) && l.includes("custom program error: 0xc")),
        `Token-2022 should reject the burn with InvalidInstruction (0xc), got logs:\n${logs.join("\n")}`
      );
    }

    // Nothing moved: the burn was rejected, not partially applied.
    assert.equal(
      (await getTokenAccount(tokenAccount)).amount.toString(),
      balanceBefore.toString(),
      "holder balance should be unchanged after the rejected burn"
    );
    assert.equal(
      (await getMint(mint)).supply.toString(),
      supplyBefore.toString(),
      "total supply should be unchanged after the rejected burn"
    );
  });
});
