import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, TRANSFER_CONTROL_PROGRAM_ID } from "../../utils/address_utils";
import { MintWriteContext } from "../base_helper";
import { TransferControl } from "../../../target/types/transfer_control";
import { getEvent } from "../event_helper";
import { getMintOwner } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { transferControlModePda, transferControlEventAuthorityPda, whitelistPda } from "./transfer_control_pda_helper";

export const TRANSFER_CONTROL_WHITELIST = { whitelist: {} };
export const TRANSFER_CONTROL_CLEARING = { clearing: {} };

export function getTransferControlProgram(): Program<TransferControl> {
  return anchor.workspace.TransferControl as Program<TransferControl>;
}

// ── set_modes ──────────────────────────────────────────────────────────────────

export type SetModesArgs = {
  modes: any[];
};

function getDefaultSetModesArgs(): Required<SetModesArgs> {
  return {
    modes: [TRANSFER_CONTROL_CLEARING],
  };
}

export async function setTransferControlModes(
  callContext: MintWriteContext,
  args?: SetModesArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<SetModesArgs> = {
    ...getDefaultSetModesArgs(),
    ...args,
  };

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const signature = await getTransferControlProgram()
    .methods.setModes(effectiveArgs.modes)
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      transferControlModePda: transferControlModePda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: transferControlEventAuthorityPda(),
      program: TRANSFER_CONTROL_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type TransferControlModesSetEvent = {
  mint: PublicKey;
  operator: PublicKey;
  modes: any[];
};

/**
 * Decodes the `TransferControlModesSet` event from a `set_modes` transaction.
 * The coder returns the name in camelCase (`transferControlModesSet`). Delegates
 * to the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getTransferControlModesSetEvent(signature: string) {
  return getEvent<TransferControlModesSetEvent>(getTransferControlProgram(), signature, "transferControlModesSet");
}

// ── add_to_whitelist ─────────────────────────────────────────────────────────

export type AddToWhitelistContext = MintWriteContext & {
  account: PublicKey;
};

export async function addToWhitelist(callContext: AddToWhitelistContext): Promise<{ signature: string }> {
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const signature = await getTransferControlProgram()
    .methods.addToWhitelist()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      whitelistPda: whitelistPda(callContext.mint, callContext.account),
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: transferControlEventAuthorityPda(),
      program: TRANSFER_CONTROL_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
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
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const signature = await getTransferControlProgram()
    .methods.removeFromWhitelist()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      whitelistPda: whitelistPda(callContext.mint, callContext.account),
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      eventAuthority: transferControlEventAuthorityPda(),
      program: TRANSFER_CONTROL_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
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
