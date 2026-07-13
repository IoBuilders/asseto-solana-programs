import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { deactivatePda } from "./deactivate/deactivate_pda_helper";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, FREEZE_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Freeze } from "../../target/types/freeze";
import { getEvent } from "./event_helper";

function getFreezeProgram(): Program<Freeze> {
  return anchor.workspace.Freeze as Program<Freeze>;
}

export type FreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function freezeAccount(callContext: FreezeAccountContext): Promise<{ signature: string }> {
  const signature = await getFreezeProgram()
    .methods.freezeAccount()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenAccountPda: pdaUtils.frozenAccountPda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: pdaUtils.freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export type UnfreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function unfreezeAccount(callContext: UnfreezeAccountContext): Promise<{ signature: string }> {
  const signature = await getFreezeProgram()
    .methods.unfreezeAccount()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenAccountPda: pdaUtils.frozenAccountPda(callContext.mint, callContext.account),
      eventAuthority: pdaUtils.freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export type PartiallyFreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

type PartiallyFreezeAccountArgs = {
  balance?: anchor.BN;
};

function getDefaultCreateCouponArgs(): Required<PartiallyFreezeAccountArgs> {
  return {
    balance: new anchor.BN(1),
  };
}

export async function partiallyFreezeAccount(
  callContext: PartiallyFreezeAccountContext,
  args?: PartiallyFreezeAccountArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<PartiallyFreezeAccountArgs> = {
    ...getDefaultCreateCouponArgs(),
    ...args,
  };

  const signature = await getFreezeProgram()
    .methods.partiallyFreezeAccount(effectiveArgs.balance)
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenBalancePda: pdaUtils.frozenBalancePda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: pdaUtils.freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export type PartiallyUnfreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function removePartialFreeze(
  callContext: PartiallyUnfreezeAccountContext
): Promise<{ signature: string }> {
  const signature = await getFreezeProgram()
    .methods.removePartialFreeze()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenBalancePda: pdaUtils.frozenBalancePda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: pdaUtils.freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export async function getFrozenAccountStatusByPda(pda: PublicKey) {
  return await getFreezeProgram().account.frozenAccountStatus.fetchNullable(pda, "confirmed");
}

export async function getFrozenBalanceByPda(pda: PublicKey) {
  return await getFreezeProgram().account.frozenBalance.fetchNullable(pda, "confirmed");
}

type AccountFrozenEvent = {
  mint: PublicKey;
  account: PublicKey;
  operator: PublicKey;
};

type AccountUnfrozenEvent = {
  mint: PublicKey;
  account: PublicKey;
  operator: PublicKey;
};

type AccountPartiallyFrozenEvent = {
  mint: PublicKey;
  account: PublicKey;
  frozenBalance: anchor.BN;
  operator: PublicKey;
};

type AccountPartialFreezeRemovedEvent = {
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

/**
 * Decodes the `AccountUnfrozenEvent` event from a `freeze` transaction. The coder
 * returns the name in camelCase (`unfrozen`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountUnfrozenEvent(signature: string) {
  return getEvent<AccountUnfrozenEvent>(getFreezeProgram(), signature, "accountUnfrozen");
}

/**
 * Decodes the `AccountPartiallyFrozenEvent` event from a `freeze` transaction. The coder
 * returns the name in camelCase (`partiallyfrozen`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountPartiallyFrozenEvent(signature: string) {
  return getEvent<AccountPartiallyFrozenEvent>(getFreezeProgram(), signature, "accountPartiallyFrozen");
}

/**
 * Decodes the `AccountPartialFreezeRemovedEvent` event from a `freeze` transaction. The coder
 * returns the name in camelCase (`partialfreezeremoved`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getAccountPartialFreezeRemovedEvent(signature: string) {
  return getEvent<AccountPartialFreezeRemovedEvent>(getFreezeProgram(), signature, "accountPartialFreezeRemoved");
}
