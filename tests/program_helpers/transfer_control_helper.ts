import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, TRANSFER_CONTROL_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteContext } from "./base_helper";
import { TransferControl } from "../../target/types/transfer_control";
import { Program } from "@anchor-lang/core";
import { getEvent } from "./event_helper";

export const TRANSFER_CONTROL_WHITELIST = { whitelist: {} };
export const TRANSFER_CONTROL_CLEARING = { clearing: {} };

function getTransferControlProgram(): Program<TransferControl> {
  return anchor.workspace.TransferControl as Program<TransferControl>;
}

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

  const signature = await getTransferControlProgram()
    .methods.setModes(effectiveArgs.modes)
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      transferControlModePda: pdaUtils.transferControlModePda(callContext.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: pdaUtils.transferControlEventAuthorityPda(),
      program: TRANSFER_CONTROL_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export type AddToWhitelistContext = MintWriteContext & {
  account: PublicKey;
};

export async function addToWhitelist(callContext: AddToWhitelistContext): Promise<{ signature: string }> {
  const signature = await getTransferControlProgram()
    .methods.addToWhitelist()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      whitelistPda: pdaUtils.whitelistPda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: pdaUtils.transferControlEventAuthorityPda(),
      program: TRANSFER_CONTROL_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export type RemoveFromWhitelistContext = MintWriteContext & {
  account: PublicKey;
};

export async function removeFromWhitelist(callContext: RemoveFromWhitelistContext): Promise<{ signature: string }> {
  const signature = await getTransferControlProgram()
    .methods.removeFromWhitelist()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      whitelistPda: pdaUtils.whitelistPda(callContext.mint, callContext.account),
      eventAuthority: pdaUtils.transferControlEventAuthorityPda(),
      program: TRANSFER_CONTROL_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export async function getTransferControlModeByPda(pda: PublicKey) {
  return await getTransferControlProgram().account.transferControlMode.fetchNullable(pda, "confirmed");
}

export async function getWhitelistStatusByPda(pda: PublicKey) {
  return await getTransferControlProgram().account.whitelistStatus.fetchNullable(pda, "confirmed");
}

type TransferControlModesSetEvent = {
  mint: PublicKey;
  operator: PublicKey;
  modes: any[];
};

type AccountWhitelistedEvent = {
  mint: PublicKey;
  account: PublicKey;
  operator: PublicKey;
};

type AccountUnwhitelistedEvent = {
  mint: PublicKey;
  account: PublicKey;
  operator: PublicKey;
};

/**
 * Decodes the `TransferControlModesSet` event from a `set_modes` transaction.
 * The coder returns the name in camelCase (`transferControlModesSet`). Delegates
 * to the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getTransferControlModesSetEvent(signature: string) {
  return getEvent<TransferControlModesSetEvent>(getTransferControlProgram(), signature, "transferControlModesSet");
}

/**
 * Decodes the `AccountWhitelisted` event from an `add_to_whitelist` transaction.
 * The coder returns the name in camelCase (`accountWhitelisted`). Delegates to
 * the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountWhitelistedEvent(signature: string) {
  return getEvent<AccountWhitelistedEvent>(getTransferControlProgram(), signature, "accountWhitelisted");
}

/**
 * Decodes the `AccountUnwhitelisted` event from a `remove_from_whitelist` transaction.
 * The coder returns the name in camelCase (`accountUnwhitelisted`). Delegates to
 * the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountUnwhitelistedEvent(signature: string) {
  return getEvent<AccountUnwhitelistedEvent>(getTransferControlProgram(), signature, "accountUnwhitelisted");
}
