import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import {
  SYSTEM_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
} from "../utils/address_utils";
import { MintWriteContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Transfer } from "../../target/types/transfer";

export function getTransferProgram(): Program<Transfer> {
  return anchor.workspace.Transfer as Program<Transfer>;
}

export type VerifyTransferInstructionContext = MintWriteContext & {
  sourceOwner: PublicKey;
  source: PublicKey;
  destination: PublicKey;
};

export type VerifyTransferInstructionArgs = {
  amount?: anchor.BN;
};

function getDefaultVerifyTransferInstructionArgs(): Required<VerifyTransferInstructionArgs> {
  return {
    amount: new anchor.BN(1),
  };
}

export async function buildVerifyTransferInstruction(
  callContext: VerifyTransferInstructionContext,
  args: VerifyTransferInstructionArgs
): Promise<TransactionInstruction> {
  const effectiveArgs: Required<VerifyTransferInstructionArgs> = {
    ...getDefaultVerifyTransferInstructionArgs(),
    ...args,
  };

  return await getTransferProgram()
    .methods.verifyTransfer(effectiveArgs.amount)
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      sourceOwner: callContext.sourceOwner,
      source: callContext.source,
      destination: callContext.destination,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      transferControlModePda: pdaUtils.transferControlModePda(callContext.mint),
      sourceWhitelistPda: pdaUtils.whitelistPda(callContext.mint, callContext.source),
      destinationWhitelistPda: pdaUtils.whitelistPda(callContext.mint, callContext.destination),
      sourceFrozenPda: pdaUtils.frozenAccountPda(callContext.mint, callContext.source),
      sourceFrozenBalancePda: pdaUtils.frozenBalancePda(callContext.mint, callContext.source),
    })
    .instruction();
}

export type TransferContext = MintWriteContext & {
  sourceOwner: PublicKey;
  source: PublicKey;
  destination: PublicKey;
  preInstructions?: TransactionInstruction[];
};

export type TransferArgs = {
  amount?: anchor.BN;
};

function getDefaultTransferArgs(): Required<TransferArgs> {
  return {
    amount: new anchor.BN(1),
  };
}

export async function transfer(callContext: TransferContext, args?: TransferArgs): Promise<void> {
  const effectiveArgs: Required<TransferArgs> = {
    ...getDefaultTransferArgs(),
    ...args,
  };

  let preInstructions: TransactionInstruction[];
  if (callContext.preInstructions) {
    preInstructions = callContext.preInstructions;
  } else {
    const verifyIx = await buildVerifyTransferInstruction(callContext, effectiveArgs);
    preInstructions = [anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx];
  }

  await getTransferProgram()
    .methods.transfer(effectiveArgs.amount)
    .accountsStrict(getTransferAccounts(callContext))
    .preInstructions(preInstructions)
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "processed" });
}

export function getTransferAccounts(callContext: Omit<TransferContext, "deployer">) {
  return {
    mint: callContext.mint,
    destination: callContext.destination,
    sourceOwner: callContext.sourceOwner,
    source: callContext.source,
    transferAuthority: pdaUtils.transferAuthorityPda(callContext.mint),
    transferHookAuthority: pdaUtils.transferHookAuthorityPda(callContext.mint),
    freezeAuthority: pdaUtils.freezeAuthorityPda(callContext.mint),
    extraAccountMetaList: pdaUtils.extraAccountMetaListPda(callContext.mint),
    transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
    freezeProgram: FREEZE_PROGRAM_ID,
    snapshotProgram: SNAPSHOT_PROGRAM_ID,
    snapshotCounterPda: pdaUtils.snapshotCounterPda(callContext.mint),
    senderSnapshot: pdaUtils.snapshotHolderBalancePda(callContext.mint, callContext.source),
    receiverSnapshot: pdaUtils.snapshotHolderBalancePda(callContext.mint, callContext.destination),
    instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SYSTEM_PROGRAM_ID,
  };
}
