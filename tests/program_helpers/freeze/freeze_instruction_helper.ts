import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, FREEZE_PROGRAM_ID } from "../../utils/address_utils";
import { MintWriteContext } from "../base_helper";
import { Program } from "@anchor-lang/core";
import { Freeze } from "../../../target/types/freeze";
import { getEvent } from "../event_helper";
import { getMintOwner } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { frozenAccountPda, frozenBalancePda, freezeEventAuthorityPda } from "./freeze_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";

export function getFreezeProgram(): Program<Freeze> {
  return anchor.workspace.Freeze as Program<Freeze>;
}

// ── freeze_account ─────────────────────────────────────────────────────────────

export type FreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function freezeAccount(callContext: FreezeAccountContext): Promise<{ signature: string }> {
  const program = getFreezeProgram();
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .freezeAccount()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenAccountPda: frozenAccountPda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
    })
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type AccountFrozenEvent = {
  mint: PublicKey;
  account: PublicKey;
  operator: PublicKey;
};

/**
 * Decodes the `AccountFrozenEvent` event from a `freeze` transaction. The coder
 * returns the name in camelCase (`frozen`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountFrozenEvent(signature: string) {
  return getEvent<AccountFrozenEvent>(getFreezeProgram(), signature, "accountFrozen");
}

// ── unfreeze_account ───────────────────────────────────────────────────────────

export type UnfreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function unfreezeAccount(callContext: UnfreezeAccountContext): Promise<{ signature: string }> {
  const program = getFreezeProgram();
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .unfreezeAccount()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenAccountPda: frozenAccountPda(callContext.mint, callContext.account),
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
    })
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type AccountUnfrozenEvent = {
  mint: PublicKey;
  account: PublicKey;
  operator: PublicKey;
};

/**
 * Decodes the `AccountUnfrozenEvent` event from a `freeze` transaction. The coder
 * returns the name in camelCase (`unfrozen`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountUnfrozenEvent(signature: string) {
  return getEvent<AccountUnfrozenEvent>(getFreezeProgram(), signature, "accountUnfrozen");
}

// ── partially_freeze_account ───────────────────────────────────────────────────

export type PartiallyFreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

type PartiallyFreezeAccountArgs = {
  balance?: anchor.BN;
};

function getDefaultPartiallyFreezeAccountArgs(): Required<PartiallyFreezeAccountArgs> {
  return {
    balance: new anchor.BN(1),
  };
}

export async function partiallyFreezeAccount(
  callContext: PartiallyFreezeAccountContext,
  args?: PartiallyFreezeAccountArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<PartiallyFreezeAccountArgs> = {
    ...getDefaultPartiallyFreezeAccountArgs(),
    ...args,
  };

  const program = getFreezeProgram();
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .partiallyFreezeAccount(effectiveArgs.balance)
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenBalancePda: frozenBalancePda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
    })
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type AccountPartiallyFrozenEvent = {
  mint: PublicKey;
  account: PublicKey;
  frozenBalance: anchor.BN;
  operator: PublicKey;
};

/**
 * Decodes the `AccountPartiallyFrozenEvent` event from a `freeze` transaction. The coder
 * returns the name in camelCase (`partiallyfrozen`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountPartiallyFrozenEvent(signature: string) {
  return getEvent<AccountPartiallyFrozenEvent>(getFreezeProgram(), signature, "accountPartiallyFrozen");
}

// ── remove_partial_freeze ──────────────────────────────────────────────────────

export type PartiallyUnfreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function removePartialFreeze(
  callContext: PartiallyUnfreezeAccountContext
): Promise<{ signature: string }> {
  const program = getFreezeProgram();
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .removePartialFreeze()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenBalancePda: frozenBalancePda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
    })
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type AccountPartialFreezeRemovedEvent = {
  mint: PublicKey;
  account: PublicKey;
  operator: PublicKey;
};

/**
 * Decodes the `AccountPartialFreezeRemovedEvent` event from a `freeze` transaction. The coder
 * returns the name in camelCase (`partialfreezeremoved`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountPartialFreezeRemovedEvent(signature: string) {
  return getEvent<AccountPartialFreezeRemovedEvent>(getFreezeProgram(), signature, "accountPartialFreezeRemoved");
}
