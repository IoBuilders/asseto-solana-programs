import { PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { METADATA_UPDATE_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import { MintWriteWithPayerContext } from "../base_helper";
import { Program } from "@anchor-lang/core";
import { MetadataUpdate } from "../../../target/types/metadata_update";
import { getEvent } from "../event_helper";
import { getAssetConfiguration } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { metadataUpdateAuthorityPda, metadataUpdateEventAuthorityPda } from "./metadata_update_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";

function getMetadataUpdateProgram(): Program<MetadataUpdate> {
  return anchor.workspace.MetadataUpdate as Program<MetadataUpdate>;
}

// ── update_metadata_field ──────────────────────────────────────────────────────

type UpdateMetadataFieldArgs = {
  key?: string;
  value?: string;
};

function getDefaultUpdateMetadataFieldArgs(): Required<UpdateMetadataFieldArgs> {
  return {
    key: "key",
    value: "value",
  };
}

export async function updateMetadataField(
  callContext: MintWriteWithPayerContext,
  args?: UpdateMetadataFieldArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<UpdateMetadataFieldArgs> = {
    ...getDefaultUpdateMetadataFieldArgs(),
    ...args,
  };

  const program = getMetadataUpdateProgram();
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .updateMetadataField(effectiveArgs.key, effectiveArgs.value)
    .accountsStrict({
      payer: callContext.payer ?? authority.publicKey,
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      metadataUpdateAuthority: metadataUpdateAuthorityPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: metadataUpdateEventAuthorityPda(),
      program: METADATA_UPDATE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
    })
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type MetadataFieldUpdatedEvent = {
  mint: PublicKey;
  operator: PublicKey;
  key: string;
  value: string;
};

/**
 * Decodes the `MetadataFieldUpdated` event from an `update_metadata_field`
 * transaction. The coder returns the name in camelCase (`metadataFieldUpdated`).
 * Delegates to the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getMetadataFieldUpdatedEvent(signature: string) {
  return getEvent<MetadataFieldUpdatedEvent>(getMetadataUpdateProgram(), signature, "metadataFieldUpdated");
}

// ── remove_metadata_field ──────────────────────────────────────────────────────

type RemoveMetadataFieldArgs = {
  key?: string;
  idempotent?: boolean;
};

function getDefaultRemoveMetadataFieldArgs(): Required<RemoveMetadataFieldArgs> {
  return {
    key: "key",
    idempotent: true,
  };
}

export async function removeMetadataField(
  callContext: MintWriteWithPayerContext,
  args?: RemoveMetadataFieldArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<RemoveMetadataFieldArgs> = {
    ...getDefaultRemoveMetadataFieldArgs(),
    ...args,
  };

  const program = getMetadataUpdateProgram();
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .removeMetadataField(effectiveArgs.key, effectiveArgs.idempotent)
    .accountsStrict({
      payer: callContext.payer ?? authority.publicKey,
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      metadataUpdateAuthority: metadataUpdateAuthorityPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority: metadataUpdateEventAuthorityPda(),
      program: METADATA_UPDATE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
    })
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type MetadataFieldRemovedEvent = {
  mint: PublicKey;
  operator: PublicKey;
  key: string;
};

/**
 * Decodes the `MetadataFieldRemoved` event from a `remove_metadata_field`
 * transaction. The coder returns the name in camelCase (`metadataFieldRemoved`).
 * Delegates to the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getMetadataFieldRemovedEvent(signature: string) {
  return getEvent<MetadataFieldRemovedEvent>(getMetadataUpdateProgram(), signature, "metadataFieldRemoved");
}
