import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  SYSTEM_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  OPERATIONS_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  DEPLOY_PROGRAM_ID,
  FACTORY_PROGRAM_ID,
  DEACTIVATE_PROGRAM_ID,
  TRANSFER_CONTROL_PROGRAM_ID,
} from "../../utils/address_utils";
import { MintWriteContext, MintWriteWithPayerContext } from "../base_helper";
import { getEvent, getEvents } from "../event_helper";
import { getAssetConfiguration } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { Operations } from "../../../target/types/operations";
import { permanentDelegatePda, operationsEventAuthorityPda } from "./operations_pda_helper";
import { freezeAuthorityPda, frozenAccountPda, frozenBalancePda } from "../freeze/freeze_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";
import { transferControlModePda, whitelistPda } from "../transfer_control/transfer_control_pda_helper";

export function getOperationsProgram(): Program<Operations> {
  return anchor.workspace.Operations as Program<Operations>;
}

// ── burn ─────────────────────────────────────────────────────────────────────

export type BurnTokensContext = MintWriteWithPayerContext & {
  tokenAccount: PublicKey;
};

type BurnTokensArgs = {
  amount?: anchor.BN;
};

function getDefaultArgs(): Required<BurnTokensArgs> {
  return {
    amount: new anchor.BN(1),
  };
}

export async function burnTokens(
  callContext: BurnTokensContext,
  args?: BurnTokensArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<BurnTokensArgs> = {
    ...getDefaultArgs(),
    ...args,
  };

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await getOperationsProgram()
    .methods.burn(effectiveArgs.amount)
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: callContext.authority.publicKey,
      mint: callContext.mint,
      tokenAccount: callContext.tokenAccount,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      operationsAuthority: permanentDelegatePda(callContext.mint),
      freezeAuthority: freezeAuthorityPda(callContext.mint),
      freezeProgram: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: operationsEventAuthorityPda(),
      program: OPERATIONS_PROGRAM_ID,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
    })
    .signers(callContext?.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type ControllerRedemptionEvent = {
  mint: PublicKey;
  controller: PublicKey;
  from: PublicKey;
  value: anchor.BN;
};

/**
 * Decodes the `ControllerRedemption` event from a `burn` transaction. The coder
 * returns the name in camelCase (`controllerRedemption`). Delegates to the
 * shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getControllerRedemptionEvent(signature: string) {
  return getEvent<ControllerRedemptionEvent>(getOperationsProgram(), signature, "controllerRedemption");
}

// ── batch_burn ─────────────────────────────────────────────────────────────────

export type BatchBurnTokensContext = MintWriteWithPayerContext & {
  sources: PublicKey[];
};

type BatchBurnTokensArgs = {
  // The `amounts` instruction argument. Defaults to `1` per source.
  amounts?: anchor.BN[];
  // Overrides the remaining accounts. Defaults to `[source (writable)]` per source,
  // in order. Provide this to exercise remaining-account error paths.
  remainingAccounts?: AccountMeta[];
};

export async function batchBurnTokens(
  callContext: BatchBurnTokensContext,
  args?: BatchBurnTokensArgs
): Promise<string> {
  const amounts = args?.amounts ?? callContext.sources.map(() => new anchor.BN(1));

  // One remaining account per source: the token account to burn from (writable).
  // Unlike batch_mint there is no whitelist PDA — burn has no whitelist gate.
  const remainingAccounts: AccountMeta[] =
    args?.remainingAccounts ??
    callContext.sources.map((source) => ({ pubkey: source, isWritable: true, isSigner: false }));

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  return await getOperationsProgram()
    .methods.batchBurn(amounts)
    .accountsStrict({
      authority: callContext.authority.publicKey,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      operationsAuthority: permanentDelegatePda(callContext.mint),
      freezeAuthority: freezeAuthorityPda(callContext.mint),
      freezeProgram: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
      eventAuthority: operationsEventAuthorityPda(),
      program: OPERATIONS_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .signers(callContext?.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });
}

export async function getControllerRedemptionEvents(signature: string): Promise<ControllerRedemptionEvent[]> {
  return (await getEvents(getOperationsProgram(), signature))
    .filter((event) => event.name === "controllerRedemption")
    .map((event) => event.data as ControllerRedemptionEvent);
}

// ── controller_transfer ──────────────────────────────────────────────────────

export type ControllerTransferContext = MintWriteContext & {
  from: PublicKey;
  to: PublicKey;
  // Owner of `from`. No longer an account of `controller_transfer` nor a required
  // signer — kept optional for backwards compatibility with existing callers.
  sourceOwner?: PublicKey;
  preInstructions?: TransactionInstruction[];
};

type ControllerTransferArgs = {
  amount?: anchor.BN;
};

export async function controllerTransfer(
  callContext: ControllerTransferContext,
  args?: ControllerTransferArgs
): Promise<{ signature: string }> {
  const amount = args?.amount ?? new anchor.BN(1);

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  // Compliance lives in transfer-hook::execute, which bypasses the whitelist /
  // frozen checks for permanent-delegate transfers. Token-2022 still resolves the
  // whole metalist, so every forwarded PDA must be supplied (may be empty).
  // The unblock ×2 → transfer_checked → hook → block ×2 chain exceeds the default
  // 200k CU budget, so raise it.
  const preInstructions = [
    anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...(callContext.preInstructions ?? []),
  ];

  const signature = await getOperationsProgram()
    .methods.controllerTransfer(amount)
    .accountsStrict({
      authority: callContext.authority.publicKey,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      from: callContext.from,
      to: callContext.to,
      operationsAuthority: permanentDelegatePda(callContext.mint),
      freezeAuthority: freezeAuthorityPda(callContext.mint),
      extraAccountMetaList: pdaUtils.extraAccountMetaListPda(callContext.mint),
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      freezeProgram: FREEZE_PROGRAM_ID,
      deployProgram: DEPLOY_PROGRAM_ID,
      factoryProgram: FACTORY_PROGRAM_ID,
      deactivateProgram: DEACTIVATE_PROGRAM_ID,
      transferControlProgram: TRANSFER_CONTROL_PROGRAM_ID,
      transferControlModePda: transferControlModePda(callContext.mint),
      sourceWhitelistPda: whitelistPda(callContext.mint, callContext.from),
      destinationWhitelistPda: whitelistPda(callContext.mint, callContext.to),
      sourceFrozenPda: frozenAccountPda(callContext.mint, callContext.from),
      sourceFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.from),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
      eventAuthority: operationsEventAuthorityPda(),
      program: OPERATIONS_PROGRAM_ID,
    })
    .preInstructions(preInstructions)
    .signers(callContext?.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type ControllerTransferredEvent = {
  mint: PublicKey;
  controller: PublicKey;
  from: PublicKey;
  to: PublicKey;
  value: anchor.BN;
};

export async function getControllerTransferredEvent(signature: string) {
  return getEvent<ControllerTransferredEvent>(getOperationsProgram(), signature, "controllerTransferred");
}
