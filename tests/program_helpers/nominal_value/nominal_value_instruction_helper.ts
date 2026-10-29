import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { NominalValue } from "../../../target/types/nominal_value";
import { NOMINAL_VALUE_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import { assetConfigurationPda, getAssetConfiguration } from "../deploy/deploy_pda_helper";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { MintWriteWithPayerContext, MintWriteContext } from "../base_helper";
import { getEvent } from "../event_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";
import { nominalValueEventAuthorityPda, nominalValuePda } from "./nominal_value_pda_helper";

export function getNominalValueProgram(): Program<NominalValue> {
  return anchor.workspace.NominalValue as Program<NominalValue>;
}

export const PUBLISH_TYPE_UNIT = { unit: {} };
export const PUBLISH_TYPE_TOTAL = { total: {} };
export type PublishType = typeof PUBLISH_TYPE_UNIT | typeof PUBLISH_TYPE_TOTAL;

// ISO 4217 "EUR"
export const EUR = [69, 85, 82];

// ── initialize_nominal_value ───────────────────────────────────────────────────

export type InitializeNominalValueArgs = {
  nominalValueDecimals?: number;
  nominalValueCurrency?: number[];
  nominalValuePublishType?: PublishType;
};

function getDefaultInitializeNominalValueArgs(): Required<InitializeNominalValueArgs> {
  return {
    nominalValueDecimals: 6,
    nominalValueCurrency: EUR,
    nominalValuePublishType: PUBLISH_TYPE_UNIT,
  };
}

export async function initializeNominalValue(
  callContext: MintWriteWithPayerContext,
  args?: InitializeNominalValueArgs
): Promise<{ signature: string }> {
  const program = getNominalValueProgram();
  const effectiveArgs: Required<InitializeNominalValueArgs> = {
    ...getDefaultInitializeNominalValueArgs(),
    ...args,
  };
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await program.methods
    .initializeNominalValue(
      effectiveArgs.nominalValueDecimals,
      effectiveArgs.nominalValueCurrency,
      effectiveArgs.nominalValuePublishType
    )
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: callContext.authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
      assetConfigurationPda: assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      nominalValuePda: nominalValuePda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: nominalValueEventAuthorityPda(),
      program: NOMINAL_VALUE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type NominalValueInitializedEvent = {
  mint: PublicKey;
  operator: PublicKey;
  nominalValueDecimals: number;
  nominalValueCurrency: number[];
  nominalValuePublishType: PublishType;
};

export async function getNominalValueInitializedEvent(signature: string) {
  return getEvent<NominalValueInitializedEvent>(getNominalValueProgram(), signature, "nominalValueInitialized");
}

// ── publish_nominal_value / republish_nominal_value ────────────────────────────

export type WriteNominalValueArgs = {
  nominalValue?: anchor.BN;
  effectiveDatetime?: anchor.BN;
};

function getDefaultWriteNominalValueArgs(): Required<WriteNominalValueArgs> {
  return {
    nominalValue: new anchor.BN(1_000_000),
    effectiveDatetime: new anchor.BN(1_700_000_000),
  };
}

async function writeNominalValue(
  method: "publishNominalValue" | "republishNominalValue",
  callContext: MintWriteContext,
  args?: WriteNominalValueArgs
): Promise<{ signature: string }> {
  const program = getNominalValueProgram();
  const effectiveArgs: Required<WriteNominalValueArgs> = {
    ...getDefaultWriteNominalValueArgs(),
    ...args,
  };
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await program.methods[method](effectiveArgs.nominalValue, effectiveArgs.effectiveDatetime)
    .accountsStrict({
      authority: callContext.authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
      assetConfigurationPda: assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      nominalValuePda: nominalValuePda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      eventAuthority: nominalValueEventAuthorityPda(),
      program: NOMINAL_VALUE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export function publishNominalValue(callContext: MintWriteContext, args?: WriteNominalValueArgs) {
  return writeNominalValue("publishNominalValue", callContext, args);
}

export function republishNominalValue(callContext: MintWriteContext, args?: WriteNominalValueArgs) {
  return writeNominalValue("republishNominalValue", callContext, args);
}

type NominalValueWrittenEvent = {
  mint: PublicKey;
  operator: PublicKey;
  nominalValue: anchor.BN;
  effectiveDatetime: anchor.BN;
};

export async function getNominalValuePublishedEvent(signature: string) {
  return getEvent<NominalValueWrittenEvent>(getNominalValueProgram(), signature, "nominalValuePublished");
}

export async function getNominalValueRepublishedEvent(signature: string) {
  return getEvent<NominalValueWrittenEvent>(getNominalValueProgram(), signature, "nominalValueRepublished");
}
