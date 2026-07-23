import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, TRANSFER_CONTROL_PROGRAM_ID } from "../../utils/address_utils";
import { MintWriteContext } from "../base_helper";
import { TransferControl } from "../../../target/types/transfer_control";
import { getEvent } from "../event_helper";
import { getAssetConfiguration } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { transferControlModePda, transferControlEventAuthorityPda, whitelistPda } from "./transfer_control_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";

export const TRANSFER_CONTROL_WHITELIST = { whitelist: {} };

export function getTransferControlProgram(): Program<TransferControl> {
  return anchor.workspace.TransferControl as Program<TransferControl>;
}

// ── set_modes ──────────────────────────────────────────────────────────────────

export type SetModeArgs = {
  mode: any;
};

function getDefaultSetModesArgs(): Required<SetModeArgs> {
  return {
    mode: TRANSFER_CONTROL_WHITELIST,
  };
}

export async function initializeTransferControlMode(
  callContext: MintWriteContext,
  args?: SetModeArgs
): Promise<{ signature: string }> {
  const program = getTransferControlProgram();
  const effectiveArgs: Required<SetModeArgs> = {
    ...getDefaultSetModesArgs(),
    ...args,
  };

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .initialize(effectiveArgs.mode)
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      transferControlModePda: transferControlModePda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: transferControlEventAuthorityPda(),
      program: TRANSFER_CONTROL_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type TransferControlModesSetEvent = {
  mint: PublicKey;
  operator: PublicKey;
  mode: any;
};

/**
 * Decodes the `TransferControlModesSet` event from a `set_modes` transaction.
 * The coder returns the name in camelCase (`transferControlModesSet`). Delegates
 * to the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getTransferControlModeSetEvent(signature: string) {
  return getEvent<TransferControlModesSetEvent>(getTransferControlProgram(), signature, "transferControlModeSet");
}

// ── add_to_whitelist ─────────────────────────────────────────────────────────

export type AddToWhitelistContext = MintWriteContext & {
  account: PublicKey;
};

export async function addToWhitelist(callContext: AddToWhitelistContext): Promise<{ signature: string }> {
  const program = getTransferControlProgram();
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .addToWhitelist()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      whitelistPda: whitelistPda(callContext.mint, callContext.account),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: transferControlEventAuthorityPda(),
      program: TRANSFER_CONTROL_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type AccountWhitelistedEvent = {
  mint: PublicKey;
  account: PublicKey;
  operator: PublicKey;
};

/**
 * Decodes the `AccountWhitelisted` event from an `add_to_whitelist` transaction.
 * The coder returns the name in camelCase (`accountWhitelisted`). Delegates to
 * the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountWhitelistedEvent(signature: string) {
  return getEvent<AccountWhitelistedEvent>(getTransferControlProgram(), signature, "accountWhitelisted");
}

// ── remove_from_whitelist ────────────────────────────────────────────────────

export type RemoveFromWhitelistContext = MintWriteContext & {
  account: PublicKey;
};

export async function removeFromWhitelist(callContext: RemoveFromWhitelistContext): Promise<{ signature: string }> {
  const program = getTransferControlProgram();
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .removeFromWhitelist()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      whitelistPda: whitelistPda(callContext.mint, callContext.account),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      eventAuthority: transferControlEventAuthorityPda(),
      program: TRANSFER_CONTROL_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type AccountRemovedFromWhitelistEvent = {
  mint: PublicKey;
  account: PublicKey;
  operator: PublicKey;
};

/**
 * Decodes the `AccountRemovedFromWhitelist` event from a `remove_from_whitelist` transaction.
 * The coder returns the name in camelCase (`accountRemovedFromWhitelist`). Delegates to
 * the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountRemovedFromWhitelistEvent(signature: string) {
  return getEvent<AccountRemovedFromWhitelistEvent>(
    getTransferControlProgram(),
    signature,
    "accountRemovedFromWhitelist"
  );
}
