import * as pdaUtils from "../../utils/pda_utils";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, DEACTIVATE_PROGRAM_ID } from "../../utils/address_utils";
import { Deactivate } from "../../../target/types/deactivate";
import { MintWriteContext } from "../base_helper";
import { PublicKey } from "@solana/web3.js";
import { getEvent } from "../event_helper";
import { getMintOwner } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { deactivatePda, deactivateEventAuthorityPda } from "./deactivate_pda_helper";

export function getDeactivateProgram(): Program<Deactivate> {
  return anchor.workspace.Deactivate as Program<Deactivate>;
}

// ── deactivate ─────────────────────────────────────────────────────────────────

export async function deactivateMint(callContext: MintWriteContext): Promise<{ signature: string }> {
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const signature = await getDeactivateProgram()
    .methods.deactivate()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: deactivateEventAuthorityPda(),
      program: DEACTIVATE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type DeactivatedEvent = {
  mint: PublicKey;
  operator: PublicKey;
};

/**
 * Decodes the `DeactivatedEvent` event from a `deactivate` transaction. The coder
 * returns the name in camelCase (`deactivated`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getDeactivatedEvent(signature: string) {
  return getEvent<DeactivatedEvent>(getDeactivateProgram(), signature, "deactivated");
}
