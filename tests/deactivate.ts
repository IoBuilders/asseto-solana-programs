import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import { Deactivate } from "../target/types/deactivate";
import * as pdas from "./utils/pda_utils";
import { SYSTEM_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID } from "./utils/address_utils";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";

describe("deactivate", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;
  const deployer = provider.wallet.publicKey;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    const mintOwnerPda = pdas.mintOwnerPda(mint);
    const tempMintAuthority = pdas.tempMintAuthorityPda(mint);
    const mintAuthority = pdas.mintAuthorityPda(mint);
    const operationsAuthority = pdas.permanentDelegatePda(mint);
    const metadataUpdateAuthority = pdas.metadataUpdateAuthorityPda(mint);
    const pausableAuthority = pdas.pausableAuthorityPda(mint);
    const freezeAuthority = pdas.freezeAuthorityPda(mint);
    const transferHookAuthority = pdas.transferHookAuthorityPda(mint);
    const extraAccountMetaList = pdas.extraAccountMetaListPda(mint);

    const tx = await deployProgram.methods
      .deployMint({
        decimals: MINT_DECIMALS,
        name: MINT_NAME,
        symbol: MINT_SYMBOL,
        uri: MINT_URI,
        additionalMetadata: [],
      })
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        mint,
        tempMintAuthority,
        mintAuthority,
        permanentDelegateAuthority: operationsAuthority,
        metadataUpdateAuthority,
        pausableAuthority,
        freezeAuthority,
        transferHookAuthority,
        extraAccountMetaList,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda };
  }

  // ── Happy-path test ──────────────────────────────────────────────────────────
  it("deactivate: creates the deactivate PDA for the mint", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const [deactivatePda, expectedBump] = pdas.deactivatePdaWithBump(mint);

    // ── Verify the deactivate PDA was created and stores the correct bump ─────
    const deactivateStatusBefore = await deactivateProgram.account.deactivateStatus.fetchNullable(deactivatePda);

    // ── Call the deactivate instruction ───────────────────────────────────────
    const tx = await deactivateProgram.methods
      .deactivate()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  deactivate tx:", tx);

    // ── Verify the deactivate PDA was created and stores the correct bump ─────
    const deactivateStatusAfter = await deactivateProgram.account.deactivateStatus.fetch(deactivatePda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:           ", mint.toBase58());
    console.log("  Deactivate PDA: ", deactivatePda.toBase58());
    console.log("  PDA bump:       ", deactivateStatusAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(deactivateStatusBefore, "deactivate PDA should not exist before calling deactivate");
    assert.isNotNull(deactivateStatusAfter, "deactivate PDA should exist after calling deactivate");
    assert.equal(deactivateStatusAfter.bump, expectedBump, "deactivate PDA bump should match the canonical bump");
  });
});
