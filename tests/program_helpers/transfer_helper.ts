import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { deactivatePda } from "./deactivate/deactivate_pda_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import {
  SYSTEM_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  DEPLOY_PROGRAM_ID,
  FACTORY_PROGRAM_ID,
} from "../utils/address_utils";
import { BaseWriteContext, MintContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Transfer } from "../../target/types/transfer";
import { transferControlModePda, whitelistPda } from "./transfer_control/transfer_control_pda_helper";
import { frozenAccountPda, frozenBalancePda, freezeAuthorityPda } from "./freeze/freeze_pda_helper";
import { snapshotCounterPda, snapshotHolderBalancePda } from "./snapshot/snapshot_pda_helper";
import { getMintOwner } from "./deploy_helper";
import { assetClassVersionPda } from "./factory/factory_pda_helper";

export function getTransferProgram(): Program<Transfer> {
  return anchor.workspace.Transfer as Program<Transfer>;
}

export type VerifyTransferInstructionContext = BaseWriteContext &
  MintContext & {
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
      mint: callContext.mint,
      sourceOwner: callContext.sourceOwner,
      source: callContext.source,
      destination: callContext.destination,
      deactivatePda: deactivatePda(callContext.mint),
      transferControlModePda: transferControlModePda(callContext.mint),
      sourceWhitelistPda: whitelistPda(callContext.mint, callContext.source),
      destinationWhitelistPda: whitelistPda(callContext.mint, callContext.destination),
      sourceFrozenPda: frozenAccountPda(callContext.mint, callContext.source),
      sourceFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.source),
    })
    .instruction();
}

export async function verifyTransfer(
  callContext: VerifyTransferInstructionContext,
  args?: VerifyTransferInstructionArgs
): Promise<string> {
  const effectiveArgs: Required<VerifyTransferInstructionArgs> = {
    ...getDefaultVerifyTransferInstructionArgs(),
    ...args,
  };

  return await getTransferProgram()
    .methods.verifyTransfer(effectiveArgs.amount)
    .accountsStrict({
      mint: callContext.mint,
      sourceOwner: callContext.sourceOwner,
      source: callContext.source,
      destination: callContext.destination,
      deactivatePda: deactivatePda(callContext.mint),
      transferControlModePda: transferControlModePda(callContext.mint),
      sourceWhitelistPda: whitelistPda(callContext.mint, callContext.source),
      destinationWhitelistPda: whitelistPda(callContext.mint, callContext.destination),
      sourceFrozenPda: frozenAccountPda(callContext.mint, callContext.source),
      sourceFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.source),
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export type TransferContext = BaseWriteContext &
  MintContext & {
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
    preInstructions = [verifyIx];
  }

  await getTransferProgram()
    .methods.transfer(effectiveArgs.amount)
    .accountsStrict(await getTransferAccounts(callContext))
    .preInstructions(preInstructions)
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export async function getTransferAccounts(callContext: Omit<TransferContext, "deployer">) {
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  return {
    mint: callContext.mint,
    destination: callContext.destination,
    sourceOwner: callContext.sourceOwner,
    source: callContext.source,
    transferAuthority: pdaUtils.transferAuthorityPda(callContext.mint),
    transferHookAuthority: pdaUtils.transferHookAuthorityPda(callContext.mint),
    freezeAuthority: freezeAuthorityPda(callContext.mint),
    extraAccountMetaList: pdaUtils.extraAccountMetaListPda(callContext.mint),
    transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
    freezeProgram: FREEZE_PROGRAM_ID,
    snapshotProgram: SNAPSHOT_PROGRAM_ID,
    snapshotCounterPda: snapshotCounterPda(callContext.mint),
    senderSnapshot: snapshotHolderBalancePda(callContext.mint, callContext.source),
    receiverSnapshot: snapshotHolderBalancePda(callContext.mint, callContext.destination),
    deployProgram: DEPLOY_PROGRAM_ID,
    mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
    factoryProgram: FACTORY_PROGRAM_ID,
    assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
    instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SYSTEM_PROGRAM_ID,
  };
}
