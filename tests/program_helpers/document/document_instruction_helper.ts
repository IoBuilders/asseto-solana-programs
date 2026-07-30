import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { Document } from "../../../target/types/document";
import { DOCUMENT_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { MintWriteWithPayerContext } from "../base_helper";
import { getEvent } from "../event_helper";
import { getAssetConfiguration } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { documentEventAuthorityPda, documentPda, nameToBytes } from "./document_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";

export function getDocumentProgram(): Program<Document> {
  return anchor.workspace.Document as Program<Document>;
}

// ── set_document ─────────────────────────────────────────────────────────────

export type SetDocumentArgs = {
  name?: number[];
  uri?: string;
  documentHash?: number[];
};

function getDefaultSetDocumentArgs(): Required<SetDocumentArgs> {
  return {
    name: nameToBytes("prospectus"),
    uri: "https://example.com/prospectus.pdf",
    documentHash: new Array(32).fill(1),
  };
}

export async function setDocument(
  callContext: MintWriteWithPayerContext,
  args?: SetDocumentArgs
): Promise<{ signature: string }> {
  const program = getDocumentProgram();
  const effectiveArgs: Required<SetDocumentArgs> = {
    ...getDefaultSetDocumentArgs(),
    ...args,
  };

  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await program.methods
    .setDocument(effectiveArgs.name, effectiveArgs.uri, effectiveArgs.documentHash)
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: callContext.authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      documentPda: documentPda(callContext.mint, effectiveArgs.name),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: documentEventAuthorityPda(),
      program: DOCUMENT_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type DocumentUpdatedEvent = {
  mint: PublicKey;
  operator: PublicKey;
  name: number[];
  uri: string;
  documentHash: number[];
};

/**
 * Decodes the `DocumentUpdated` event from a `set_document` transaction. The
 * coder returns the name in camelCase (`documentUpdated`).
 */
export async function getDocumentUpdatedEvent(signature: string) {
  return getEvent<DocumentUpdatedEvent>(getDocumentProgram(), signature, "documentUpdated");
}

// ── remove_document ──────────────────────────────────────────────────────────

export type RemoveDocumentArgs = {
  name?: number[];
};

function getDefaultRemoveDocumentArgs(): Required<RemoveDocumentArgs> {
  return {
    name: nameToBytes("prospectus"),
  };
}

export async function removeDocument(
  callContext: MintWriteWithPayerContext,
  args?: RemoveDocumentArgs
): Promise<{ signature: string }> {
  const program = getDocumentProgram();
  const effectiveArgs: Required<RemoveDocumentArgs> = {
    ...getDefaultRemoveDocumentArgs(),
    ...args,
  };

  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await program.methods
    .removeDocument(effectiveArgs.name)
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: callContext.authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      documentPda: documentPda(callContext.mint, effectiveArgs.name),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      eventAuthority: documentEventAuthorityPda(),
      program: DOCUMENT_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type DocumentRemovedEvent = {
  mint: PublicKey;
  operator: PublicKey;
  name: number[];
  uri: string;
  documentHash: number[];
};

/**
 * Decodes the `DocumentRemoved` event from a `remove_document` transaction. The
 * coder returns the name in camelCase (`documentRemoved`).
 */
export async function getDocumentRemovedEvent(signature: string) {
  return getEvent<DocumentRemovedEvent>(getDocumentProgram(), signature, "documentRemoved");
}
