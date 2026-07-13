import { PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { deactivatePda } from "./deactivate/deactivate_pda_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { METADATA_UPDATE_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteWithPayerContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { MetadataUpdate } from "../../target/types/metadata_update";
import { getEvent } from "./event_helper";

function getMetadataUpdateProgram(): Program<MetadataUpdate> {
  return anchor.workspace.MetadataUpdate as Program<MetadataUpdate>;
}

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

  const signature = await getMetadataUpdateProgram()
    .methods.updateMetadataField(effectiveArgs.key, effectiveArgs.value)
    .accountsStrict({
      payer: callContext.payer ?? callContext.deployer,
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      metadataUpdateAuthority: pdaUtils.metadataUpdateAuthorityPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: pdaUtils.metadataUpdateEventAuthorityPda(),
      program: METADATA_UPDATE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
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

  const signature = await getMetadataUpdateProgram()
    .methods.removeMetadataField(effectiveArgs.key, effectiveArgs.idempotent)
    .accountsStrict({
      payer: callContext.payer ?? callContext.deployer,
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      metadataUpdateAuthority: pdaUtils.metadataUpdateAuthorityPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority: pdaUtils.metadataUpdateEventAuthorityPda(),
      program: METADATA_UPDATE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
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
