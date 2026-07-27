import { AccountMeta, PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, FREEZE_PROGRAM_ID } from "../../utils/address_utils";
import { MintWriteContext } from "../base_helper";
import { Program } from "@anchor-lang/core";
import { Freeze } from "../../../target/types/freeze";
import { getEvent, getEvents } from "../event_helper";
import { getAssetConfiguration } from "../deploy_helper";
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
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .freezeAccount()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenAccountPda: frozenAccountPda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
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

// ── batch_freeze_account ─────────────────────────────────────────────────────────

export type BatchFreezeAccountContext = MintWriteContext & {
  accounts: PublicKey[];
};

type BatchFreezeAccountArgs = {
  // Overrides the remaining accounts. Defaults to `[account, frozenAccountPda]` per
  // account, in order. Provide this to exercise remaining-account error paths.
  remainingAccounts?: AccountMeta[];
};

export async function batchFreezeAccount(
  callContext: BatchFreezeAccountContext,
  args?: BatchFreezeAccountArgs
): Promise<string> {
  // Two remaining accounts per entry: the account to freeze (read-only) and its
  // not-yet-created frozen_account_pda (writable) — the handler creates the
  // latter manually since Anchor's `init` can't target a variable-length list.
  const remainingAccounts: AccountMeta[] =
    args?.remainingAccounts ??
    callContext.accounts.flatMap((account) => [
      { pubkey: account, isWritable: false, isSigner: false },
      { pubkey: frozenAccountPda(callContext.mint, account), isWritable: true, isSigner: false },
    ]);

  const program = getFreezeProgram();
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  return await program.methods
    .batchFreezeAccount()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      mint: callContext.mint,
      deactivatePda: deactivatePda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });
}

export async function getAccountFrozenEvents(signature: string): Promise<AccountFrozenEvent[]> {
  return (await getEvents(getFreezeProgram(), signature))
    .filter((event) => event.name === "accountFrozen")
    .map((event) => event.data as AccountFrozenEvent);
}

// ── unfreeze_account ───────────────────────────────────────────────────────────

export type UnfreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function unfreezeAccount(callContext: UnfreezeAccountContext): Promise<{ signature: string }> {
  const program = getFreezeProgram();
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .unfreezeAccount()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenAccountPda: frozenAccountPda(callContext.mint, callContext.account),
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
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

// ── batch_unfreeze_account ───────────────────────────────────────────────────────

export type BatchUnfreezeAccountContext = MintWriteContext & {
  accounts: PublicKey[];
};

type BatchUnfreezeAccountArgs = {
  // Overrides the remaining accounts. Defaults to `[account, frozenAccountPda]` per
  // account, in order. Provide this to exercise remaining-account error paths.
  remainingAccounts?: AccountMeta[];
};

export async function batchUnfreezeAccount(
  callContext: BatchUnfreezeAccountContext,
  args?: BatchUnfreezeAccountArgs
): Promise<string> {
  // Two remaining accounts per entry: the account being unfrozen (read-only) and
  // its existing frozen_account_pda (writable) — closed manually since Anchor's
  // `close` constraint can't target a variable-length list.
  const remainingAccounts: AccountMeta[] =
    args?.remainingAccounts ??
    callContext.accounts.flatMap((account) => [
      { pubkey: account, isWritable: false, isSigner: false },
      { pubkey: frozenAccountPda(callContext.mint, account), isWritable: true, isSigner: false },
    ]);

  const program = getFreezeProgram();
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  return await program.methods
    .batchUnfreezeAccount()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      mint: callContext.mint,
      deactivatePda: deactivatePda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });
}

export async function getAccountUnfrozenEvents(signature: string): Promise<AccountUnfrozenEvent[]> {
  return (await getEvents(getFreezeProgram(), signature))
    .filter((event) => event.name === "accountUnfrozen")
    .map((event) => event.data as AccountUnfrozenEvent);
}

// ── freeze_account_partial ──────────────────────────────────────────────────────

export type FreezeAccountPartialContext = MintWriteContext & {
  account: PublicKey;
};

type FreezeAccountPartialArgs = {
  balance?: anchor.BN;
};

function getDefaultFreezeAccountPartialArgs(): Required<FreezeAccountPartialArgs> {
  return {
    balance: new anchor.BN(1),
  };
}

export async function freezeAccountPartial(
  callContext: FreezeAccountPartialContext,
  args?: FreezeAccountPartialArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<FreezeAccountPartialArgs> = {
    ...getDefaultFreezeAccountPartialArgs(),
    ...args,
  };

  const program = getFreezeProgram();
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .freezeAccountPartial(effectiveArgs.balance)
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenBalancePda: frozenBalancePda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
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

// ── batch_freeze_account_partial ─────────────────────────────────────────────────

export type BatchFreezeAccountPartialContext = MintWriteContext & {
  accounts: PublicKey[];
};

type BatchFreezeAccountPartialArgs = {
  // The `balances` instruction argument. Defaults to `1` per account.
  balances?: anchor.BN[];
  // Overrides the remaining accounts. Defaults to `[account, frozenBalancePda]` per
  // account, in order. Provide this to exercise remaining-account error paths.
  remainingAccounts?: AccountMeta[];
};

export async function batchFreezeAccountPartial(
  callContext: BatchFreezeAccountPartialContext,
  args?: BatchFreezeAccountPartialArgs
): Promise<string> {
  const balances = args?.balances ?? callContext.accounts.map(() => new anchor.BN(1));

  // Two remaining accounts per entry: the account being frozen (read-only) and
  // its frozen_balance_pda — created on first call, overwritten thereafter,
  // manually since Anchor's `init_if_needed` can't target a variable-length list.
  const remainingAccounts: AccountMeta[] =
    args?.remainingAccounts ??
    callContext.accounts.flatMap((account) => [
      { pubkey: account, isWritable: false, isSigner: false },
      { pubkey: frozenBalancePda(callContext.mint, account), isWritable: true, isSigner: false },
    ]);

  const program = getFreezeProgram();
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  return await program.methods
    .batchFreezeAccountPartial(balances)
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      mint: callContext.mint,
      deactivatePda: deactivatePda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });
}

export async function getAccountPartiallyFrozenEvents(signature: string): Promise<AccountPartiallyFrozenEvent[]> {
  return (await getEvents(getFreezeProgram(), signature))
    .filter((event) => event.name === "accountPartiallyFrozen")
    .map((event) => event.data as AccountPartiallyFrozenEvent);
}

// ── unfreeze_account_partial ────────────────────────────────────────────────────

export type UnfreezeAccountPartialContext = MintWriteContext & {
  account: PublicKey;
};

export async function unfreezeAccountPartial(
  callContext: UnfreezeAccountPartialContext
): Promise<{ signature: string }> {
  const program = getFreezeProgram();
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await program.methods
    .unfreezeAccountPartial()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      mint: callContext.mint,
      account: callContext.account,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      frozenBalancePda: frozenBalancePda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
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

// ── batch_unfreeze_account_partial ──────────────────────────────────────────────

export type BatchUnfreezeAccountPartialContext = MintWriteContext & {
  accounts: PublicKey[];
};

type BatchUnfreezeAccountPartialArgs = {
  // Overrides the remaining accounts. Defaults to `[account, frozenBalancePda]` per
  // account, in order. Provide this to exercise remaining-account error paths.
  remainingAccounts?: AccountMeta[];
};

export async function batchUnfreezeAccountPartial(
  callContext: BatchUnfreezeAccountPartialContext,
  args?: BatchUnfreezeAccountPartialArgs
): Promise<string> {
  // Two remaining accounts per entry: the account whose partial freeze is being
  // removed (read-only) and its existing frozen_balance_pda (writable) — closed
  // manually since Anchor's `close` constraint can't target a variable-length list.
  const remainingAccounts: AccountMeta[] =
    args?.remainingAccounts ??
    callContext.accounts.flatMap((account) => [
      { pubkey: account, isWritable: false, isSigner: false },
      { pubkey: frozenBalancePda(callContext.mint, account), isWritable: true, isSigner: false },
    ]);

  const program = getFreezeProgram();
  const assetConfiguration = await getAssetConfiguration(callContext.mint);
  const authority = callContext.authority ?? program.provider.wallet.payer;

  return await program.methods
    .batchUnfreezeAccountPartial()
    .accountsStrict({
      authority: authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      mint: callContext.mint,
      deactivatePda: deactivatePda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      eventAuthority: freezeEventAuthorityPda(),
      program: FREEZE_PROGRAM_ID,
    })
    .remainingAccounts(remainingAccounts)
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });
}

export async function getAccountPartialFreezeRemovedEvents(
  signature: string
): Promise<AccountPartialFreezeRemovedEvent[]> {
  return (await getEvents(getFreezeProgram(), signature))
    .filter((event) => event.name === "accountPartialFreezeRemoved")
    .map((event) => event.data as AccountPartialFreezeRemovedEvent);
}
