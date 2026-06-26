import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteContext } from "./base_helper";
import { TransferControl } from "../../target/types/transfer_control";
import { Program } from "@anchor-lang/core";

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

export async function setTransferControlModes(callContext: MintWriteContext, args?: SetModesArgs): Promise<void> {
  const effectiveArgs: Required<SetModesArgs> = {
    ...getDefaultSetModesArgs(),
    ...args,
  };

  await getTransferControlProgram()
    .methods.setModes(effectiveArgs.modes)
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      transferControlModePda: pdaUtils.transferControlModePda(callContext.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "processed" });
}

export type AddToWhitelistContext = MintWriteContext & {
  account: PublicKey;
};

export async function addToWhitelist(callContext: AddToWhitelistContext): Promise<void> {
  await getTransferControlProgram()
    .methods.addToWhitelist()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      whitelistPda: pdaUtils.whitelistPda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "processed" });
}

export type RemoveFromWhitelistContext = MintWriteContext & {
  account: PublicKey;
};

export async function removeFromWhitelist(callContext: RemoveFromWhitelistContext): Promise<void> {
  await getTransferControlProgram()
    .methods.removeFromWhitelist()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      whitelistPda: pdaUtils.whitelistPda(callContext.mint, callContext.account),
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "processed" });
}

export async function getTransferControlModeByPda(pda: PublicKey) {
  return await getTransferControlProgram().account.transferControlMode.fetchNullable(pda, "processed");
}

export async function getWhitelistStatusByPda(pda: PublicKey) {
  return await getTransferControlProgram().account.whitelistStatus.fetchNullable(pda, "processed");
}
