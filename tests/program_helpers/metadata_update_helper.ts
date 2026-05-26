import { SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteWithPayerContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { MetadataUpdate } from "../../target/types/metadata_update";

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
): Promise<void> {
  const effectiveArgs: Required<UpdateMetadataFieldArgs> = {
    ...getDefaultUpdateMetadataFieldArgs(),
    ...args,
  };

  await getMetadataUpdateProgram()
    .methods.updateMetadataField(effectiveArgs.key, effectiveArgs.value)
    .accountsStrict({
      payer: callContext.payer ?? callContext.deployer,
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      metadataUpdateAuthority: pdaUtils.metadataUpdateAuthorityPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
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
): Promise<void> {
  const effectiveArgs: Required<RemoveMetadataFieldArgs> = {
    ...getDefaultRemoveMetadataFieldArgs(),
    ...args,
  };

  await getMetadataUpdateProgram()
    .methods.removeMetadataField(effectiveArgs.key, effectiveArgs.idempotent)
    .accountsStrict({
      payer: callContext.payer ?? callContext.deployer,
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      metadataUpdateAuthority: pdaUtils.metadataUpdateAuthorityPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}
