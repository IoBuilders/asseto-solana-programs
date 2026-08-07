import { AccountMeta, PublicKey, SendTransactionError, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { deactivatePda } from "./deactivate/deactivate_pda_helper";
import { createTransferCheckedInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { AnchorError, AnchorProvider } from "@anchor-lang/core";
import { getMint } from "./spl_token_helper";
import {
  TRANSFER_HOOK_PROGRAM_ID,
  DEPLOY_PROGRAM_ID,
  FACTORY_PROGRAM_ID,
  DEACTIVATE_PROGRAM_ID,
  TRANSFER_CONTROL_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  HOLD_PROGRAM_ID,
} from "../utils/address_utils";
import { holdPositionPda } from "./hold/hold_pda_helper";
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

export type TransferContext = BaseWriteContext &
  MintContext & {
    sourceOwner: PublicKey;
    source: PublicKey;
    destination: PublicKey;
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
 * Sends Token-2022's own `transfer_checked` as a single top-level instruction.
 * There is no wrapper instruction in the `transfer` program and no compliance
 * pre-instruction any more — every check runs inside `transfer-hook::execute`,
 * so the only client-side obligation is appending the hook's accounts (see
 * `buildSplTransferCheckedInstruction`).
 */
export async function splTransfer(callContext: TransferContext, args?: TransferArgs): Promise<void> {
  const effectiveArgs: Required<TransferArgs> = {
    ...getDefaultTransferArgs(),
    ...args,
  };

  await sendTransferCheckedTransaction(
    callContext,
    await buildSplTransferCheckedInstruction(callContext, effectiveArgs)
  );
}

/**
 * `transfer_checked` **without** the ExtraAccountMetaList block, for the error
 * case: Token-2022 cannot invoke the hook and rejects the transfer, which is what
 * keeps compliance from being bypassed by simply not forwarding those accounts.
 */
export async function splTransferWithoutHookAccounts(callContext: TransferContext, args?: TransferArgs): Promise<void> {
  const effectiveArgs: Required<TransferArgs> = {
    ...getDefaultTransferArgs(),
    ...args,
  };

  const decimals = (await getMint(callContext.mint)).decimals;

  await sendTransferCheckedTransaction(
    callContext,
    createTransferCheckedInstruction(
      callContext.source,
      callContext.mint,
      callContext.destination,
      callContext.sourceOwner,
      BigInt(effectiveArgs.amount.toString()),
      decimals,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );
}

async function sendTransferCheckedTransaction(
  callContext: TransferContext,
  instruction: TransactionInstruction
): Promise<void> {
  const transaction = new Transaction().add(
    // The hook resolves the whole metalist and runs the full compliance suite,
    // which does not fit the 200k CU a single-instruction transaction gets.
    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    instruction
  );

  const provider = getTransferProgram().provider as AnchorProvider;

  try {
    await provider.sendAndConfirm!(transaction, callContext.signers ?? [], { commitment: "confirmed" });
  } catch (err) {
    // `sendAndConfirm` is the raw provider call, so it does not run Anchor's
    // error translation the way `.rpc()` does. Do it here, so callers can assert
    // on `errorCode.code` for the compliance errors the hook raises.
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
 * then the metalist's own entries (hook indices 5..=19). Token-2022 resolves the
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
    readonly(DEACTIVATE_PROGRAM_ID),
    readonly(deactivatePda(callContext.mint)),
    readonly(TRANSFER_CONTROL_PROGRAM_ID),
    readonly(transferControlModePda(callContext.mint)),
    readonly(whitelistPda(callContext.mint, callContext.source)),
    readonly(whitelistPda(callContext.mint, callContext.destination)),
    readonly(FREEZE_PROGRAM_ID),
    readonly(frozenAccountPda(callContext.mint, callContext.source)),
    readonly(frozenBalancePda(callContext.mint, callContext.source)),
    readonly(HOLD_PROGRAM_ID),
    readonly(holdPositionPda(callContext.mint, callContext.source))
  );

  return instruction;
}

// ── batch_transfer (one source → many destinations) ─────────────────────────

export type BatchTransferContext = BaseWriteContext &
  MintContext & {
    sourceOwner: PublicKey;
    source: PublicKey;
    destinations: PublicKey[];
  };

export type BatchTransferArgs = {
  // The `amounts` instruction argument. Defaults to `1` per destination.
  amounts?: anchor.BN[];
  // Overrides batch_transfer's remaining accounts. Defaults to
  // `[destination (writable), destinationWhitelistPda]` per destination.
  // Provide to exercise error paths.
  transferRemainingAccounts?: AccountMeta[];
};

function defaultBatchAmounts(callContext: BatchTransferContext, args?: BatchTransferArgs): anchor.BN[] {
  return args?.amounts ?? callContext.destinations.map(() => new anchor.BN(1));
}

export async function batchTransfer(callContext: BatchTransferContext, args?: BatchTransferArgs): Promise<void> {
  const amounts = defaultBatchAmounts(callContext, args);

  // Every leg resolves the metalist and runs the hook's compliance suite, so the
  // budget scales with the number of destinations.
  const computeUnits = Math.min(1_400_000, 250_000 + 200_000 * callContext.destinations.length);
  const preInstructions = [anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })];

  // Two remaining accounts per destination: the destination token account
  // (writable) followed by its whitelist PDA — the hook resolves the latter
  // from the destination on every leg.
  const transferRemainingAccounts: AccountMeta[] =
    args?.transferRemainingAccounts ??
    callContext.destinations.flatMap((destination) => [
      { pubkey: destination, isWritable: true, isSigner: false },
      { pubkey: whitelistPda(callContext.mint, destination), isWritable: false, isSigner: false },
    ]);

  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  await getTransferProgram()
    .methods.batchTransfer(amounts)
    .accountsStrict({
      sourceOwner: callContext.sourceOwner,
      source: callContext.source,
      mint: callContext.mint,
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
      deactivateProgram: DEACTIVATE_PROGRAM_ID,
      deactivatePda: deactivatePda(callContext.mint),
      transferControlProgram: TRANSFER_CONTROL_PROGRAM_ID,
      transferControlModePda: transferControlModePda(callContext.mint),
      sourceWhitelistPda: whitelistPda(callContext.mint, callContext.source),
      sourceFrozenPda: frozenAccountPda(callContext.mint, callContext.source),
      sourceFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.source),
      holdProgram: HOLD_PROGRAM_ID,
      sourceHoldPositionPda: holdPositionPda(callContext.mint, callContext.source),
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .remainingAccounts(transferRemainingAccounts)
    .preInstructions(preInstructions)
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}
