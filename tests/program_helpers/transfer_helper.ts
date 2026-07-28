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
  DEACTIVATE_PROGRAM_ID,
  TRANSFER_CONTROL_PROGRAM_ID,
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

  // Compliance now lives in transfer-hook::execute (run by Token-2022 during the
  // inner transfer_checked), so no verify_transfer pre-instruction is needed.
  // The unblock ×2 → transfer_checked → hook → block ×2 chain exceeds the default
  // 200k CU budget, so raise it (the old two-instruction flow did the same).
  const preInstructions = [
    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...(callContext.preInstructions ?? []),
  ];

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
    deactivateProgram: DEACTIVATE_PROGRAM_ID,
    deactivatePda: deactivatePda(callContext.mint),
    transferControlProgram: TRANSFER_CONTROL_PROGRAM_ID,
    transferControlModePda: transferControlModePda(callContext.mint),
    sourceWhitelistPda: whitelistPda(callContext.mint, callContext.source),
    destinationWhitelistPda: whitelistPda(callContext.mint, callContext.destination),
    sourceFrozenPda: frozenAccountPda(callContext.mint, callContext.source),
    sourceFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.source),
    token2022Program: TOKEN_2022_PROGRAM_ID,
  };
}

// ── batch_transfer (one source → many destinations) ─────────────────────────

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

  // Each leg runs its own unblock → transfer_checked → hook → block chain, so the
  // budget scales with the number of destinations.
  const computeUnits = Math.min(1_400_000, 250_000 + 200_000 * callContext.destinations.length);
  const preInstructions = [
    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ...(callContext.preInstructions ?? []),
  ];

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
      deactivateProgram: DEACTIVATE_PROGRAM_ID,
      deactivatePda: deactivatePda(callContext.mint),
      transferControlProgram: TRANSFER_CONTROL_PROGRAM_ID,
      transferControlModePda: transferControlModePda(callContext.mint),
      sourceWhitelistPda: whitelistPda(callContext.mint, callContext.source),
      sourceFrozenPda: frozenAccountPda(callContext.mint, callContext.source),
      sourceFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.source),
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .remainingAccounts(transferRemainingAccounts)
    .preInstructions(preInstructions)
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}
