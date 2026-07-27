import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { Cap } from "../../../target/types/cap";
import { CAP_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { MintWriteWithPayerContext } from "../base_helper";
import { getEvent } from "../event_helper";
import { getAssetConfiguration } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { capEventAuthorityPda, maxSupplyPda } from "./cap_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";

export function getCapProgram(): Program<Cap> {
  return anchor.workspace.Cap as Program<Cap>;
}

// ── set_max_supply ─────────────────────────────────────────────────────────────

export type SetMaxSupplyArgs = {
  maxSupply?: anchor.BN;
};

function getDefaultSetMaxSupplyArgs(): Required<SetMaxSupplyArgs> {
  return {
    maxSupply: new anchor.BN(1_000_000),
  };
}

export async function setMaxSupply(
  callContext: MintWriteWithPayerContext,
  args?: SetMaxSupplyArgs
): Promise<{ signature: string }> {
  const program = getCapProgram();
  const effectiveArgs: Required<SetMaxSupplyArgs> = {
    ...getDefaultSetMaxSupplyArgs(),
    ...args,
  };

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await program.methods
    .setMaxSupply(effectiveArgs.maxSupply)
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: callContext.authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      maxSupplyPda: maxSupplyPda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: capEventAuthorityPda(),
      program: CAP_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type MaxSupplySetEvent = {
  mint: PublicKey;
  operator: PublicKey;
  maxSupply: anchor.BN;
};

/**
 * Decodes the `MaxSupplySet` event from a `set_max_supply` transaction. The coder
 * returns the name in camelCase (`maxSupplySet`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getMaxSupplySetEvent(signature: string) {
  return getEvent<MaxSupplySetEvent>(getCapProgram(), signature, "maxSupplySet");
}
