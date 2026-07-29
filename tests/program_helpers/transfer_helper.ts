import { AccountMeta, PublicKey, SendTransactionError, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { deactivatePda } from "./deactivate/deactivate_pda_helper";
import { createTransferCheckedInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { AnchorError, AnchorProvider } from "@anchor-lang/core";
import { getMint } from "./spl_token_helper";
import { TRANSFER_HOOK_PROGRAM_ID, DEPLOY_PROGRAM_ID, FACTORY_PROGRAM_ID } from "../utils/address_utils";
import { BaseWriteContext, MintContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Transfer } from "../../target/types/transfer";
import { transferControlModePda, whitelistPda } from "./transfer_control/transfer_control_pda_helper";
import { frozenAccountPda, frozenBalancePda } from "./freeze/freeze_pda_helper";
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

/**
 * Sends `verify_transfer` followed by Token-2022's own `transfer_checked` as two
 * adjacent top-level instructions — the sequence the transfer hook introspects.
 * There is no wrapper instruction in the `transfer` program any more, so the
 * hook accounts have to be appended by the caller (see below).
 */
export async function splTransfer(callContext: TransferContext, args?: TransferArgs): Promise<void> {
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

  const transaction = new Transaction().add(
    ...preInstructions,
    await buildSplTransferCheckedInstruction(callContext, effectiveArgs)
  );

  const provider = getTransferProgram().provider as AnchorProvider;

  try {
    await provider.sendAndConfirm!(transaction, callContext.signers ?? [], { commitment: "confirmed" });
  } catch (err) {
    // The failing program is reached by CPI from Token-2022, so depending on the
    // path Anchor may hand back a raw SendTransactionError instead of parsing the
    // AnchorError out of the logs. Upgrade it here so callers can keep asserting
    // on `errorCode.code` for hook / verify_transfer failures.
    if (err instanceof SendTransactionError) {
      const anchorErr = AnchorError.parse(err.logs ?? []);
      if (anchorErr) throw anchorErr;
    }
    throw err;
  }
}

/**
 * Token-2022 `transfer_checked` with the transfer hook's accounts appended.
 *
 * **The trailing account order is load-bearing** and must stay in
 * ExtraAccountMetaList order — `extra_account_meta_list`, `transfer_hook_program`,
 * then the metalist's own entries (hook indices 5..=9). Token-2022 resolves the
 * metalist and verifies the forwarded accounts against it, so a wrong order fails
 * inside Token-2022 before the hook runs.
 */
export async function buildSplTransferCheckedInstruction(
  callContext: Omit<TransferContext, "deployer">,
  args: Required<TransferArgs>
): Promise<TransactionInstruction> {
  const decimals = (await getMint(callContext.mint)).decimals;
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the hook reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const instruction = createTransferCheckedInstruction(
    callContext.source,
    callContext.mint,
    callContext.destination,
    callContext.sourceOwner,
    BigInt(args.amount.toString()),
    decimals,
    [],
    TOKEN_2022_PROGRAM_ID
  );

  const readonly = (pubkey: PublicKey): AccountMeta => ({ pubkey, isWritable: false, isSigner: false });

  instruction.keys.push(
    readonly(pdaUtils.extraAccountMetaListPda(callContext.mint)),
    readonly(TRANSFER_HOOK_PROGRAM_ID),
    readonly(DEPLOY_PROGRAM_ID),
    readonly(pdaUtils.assetConfigurationPda(callContext.mint)),
    readonly(FACTORY_PROGRAM_ID),
    readonly(assetClassVersionPda(assetConfiguration.assetClassConfigId, assetConfiguration.assetClassVersionId)),
    readonly(anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY)
  );

  return instruction;
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
      extraAccountMetaList: pdaUtils.extraAccountMetaListPda(callContext.mint),
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
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
