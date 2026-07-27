import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { deactivatePda } from "./deactivate/deactivate_pda_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import {
  FREEZE_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  DEPLOY_PROGRAM_ID,
  FACTORY_PROGRAM_ID,
} from "../utils/address_utils";
import { BaseWriteContext, MintContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Transfer } from "../../target/types/transfer";
import { transferControlModePda, whitelistPda } from "./transfer_control/transfer_control_pda_helper";
import { frozenAccountPda, frozenBalancePda, freezeAuthorityPda } from "./freeze/freeze_pda_helper";
import { getAssetConfiguration } from "./deploy_helper";
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
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  return {
    mint: callContext.mint,
    destination: callContext.destination,
    sourceOwner: callContext.sourceOwner,
    source: callContext.source,
    transferAuthority: pdaUtils.transferAuthorityPda(callContext.mint),
    freezeAuthority: freezeAuthorityPda(callContext.mint),
    extraAccountMetaList: pdaUtils.extraAccountMetaListPda(callContext.mint),
    transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
    freezeProgram: FREEZE_PROGRAM_ID,
    deployProgram: DEPLOY_PROGRAM_ID,
    assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
    factoryProgram: FACTORY_PROGRAM_ID,
    assetClassVersionPda: assetClassVersionPda(
      assetConfiguration.assetClassConfigId,
      assetConfiguration.assetClassVersionId
    ),
    instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    token2022Program: TOKEN_2022_PROGRAM_ID,
  };
}

// ── batch_verify_transfer / batch_transfer (one source → many destinations) ──

export type BatchTransferContext = BaseWriteContext &
  MintContext & {
    sourceOwner: PublicKey;
    source: PublicKey;
    destinations: PublicKey[];
    preInstructions?: TransactionInstruction[];
  };

export type BatchTransferArgs = {
  // The `amounts` instruction argument. Defaults to `1` per destination.
  amounts?: anchor.BN[];
  // Overrides batch_verify_transfer's remaining accounts. Defaults to
  // `[destination, whitelistPda]` per destination. Provide to exercise error paths.
  verifyRemainingAccounts?: AccountMeta[];
  // Overrides batch_transfer's remaining accounts. Defaults to `[destination (writable)]`
  // per destination. Provide to exercise error paths.
  transferRemainingAccounts?: AccountMeta[];
};

function defaultBatchAmounts(callContext: BatchTransferContext, args?: BatchTransferArgs): anchor.BN[] {
  return args?.amounts ?? callContext.destinations.map(() => new anchor.BN(1));
}

export async function buildBatchVerifyTransferInstruction(
  callContext: BatchTransferContext,
  args?: BatchTransferArgs
): Promise<TransactionInstruction> {
  const amounts = defaultBatchAmounts(callContext, args);

  const remainingAccounts: AccountMeta[] =
    args?.verifyRemainingAccounts ??
    callContext.destinations.flatMap((destination) => [
      { pubkey: destination, isWritable: false, isSigner: false },
      { pubkey: whitelistPda(callContext.mint, destination), isWritable: false, isSigner: false },
    ]);

  return await getTransferProgram()
    .methods.batchVerifyTransfer(amounts)
    .accountsStrict({
      sourceOwner: callContext.sourceOwner,
      source: callContext.source,
      mint: callContext.mint,
      deactivatePda: deactivatePda(callContext.mint),
      transferControlModePda: transferControlModePda(callContext.mint),
      sourceWhitelistPda: whitelistPda(callContext.mint, callContext.source),
      sourceFrozenPda: frozenAccountPda(callContext.mint, callContext.source),
      sourceFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.source),
    })
    .remainingAccounts(remainingAccounts)
    .instruction();
}

export async function batchTransfer(callContext: BatchTransferContext, args?: BatchTransferArgs): Promise<void> {
  const amounts = defaultBatchAmounts(callContext, args);

  const preInstructions = callContext.preInstructions ?? [
    await buildBatchVerifyTransferInstruction(callContext, { ...args, amounts }),
  ];

  const transferRemainingAccounts: AccountMeta[] =
    args?.transferRemainingAccounts ??
    callContext.destinations.map((destination) => ({ pubkey: destination, isWritable: true, isSigner: false }));

  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  await getTransferProgram()
    .methods.batchTransfer(amounts)
    .accountsStrict({
      sourceOwner: callContext.sourceOwner,
      source: callContext.source,
      mint: callContext.mint,
      transferAuthority: pdaUtils.transferAuthorityPda(callContext.mint),
      freezeAuthority: freezeAuthorityPda(callContext.mint),
      extraAccountMetaList: pdaUtils.extraAccountMetaListPda(callContext.mint),
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      freezeProgram: FREEZE_PROGRAM_ID,
      deployProgram: DEPLOY_PROGRAM_ID,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      factoryProgram: FACTORY_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .remainingAccounts(transferRemainingAccounts)
    .preInstructions(preInstructions)
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}
