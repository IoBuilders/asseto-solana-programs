import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Hold } from "../../../target/types/hold";
import {
  DEACTIVATE_PROGRAM_ID,
  DEPLOY_PROGRAM_ID,
  FACTORY_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  HOLD_PROGRAM_ID,
  OPERATIONS_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TRANSFER_CONTROL_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
} from "../../utils/address_utils";
import * as pdaUtils from "../../utils/pda_utils";
import { rolesPda } from "../access_control/access_control_pda_helper";
import { BaseWriteContext, MintContext, PayerContext } from "../base_helper";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { getAssetConfiguration } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { frozenAccountPda, frozenBalancePda } from "../freeze/freeze_pda_helper";
import { permanentDelegatePda } from "../operations/operations_pda_helper";
import { transferControlModePda, whitelistPda } from "../transfer_control/transfer_control_pda_helper";
import { getEvent } from "../event_helper";
import { holdAuthorityPda, holdEventAuthorityPda, holdPda, holdPositionPda, nextHoldId } from "./hold_pda_helper";

export function getHoldProgram(): Program<Hold> {
  return anchor.workspace.Hold as Program<Hold>;
}

/** One hour from now, the default expiration for a freshly created hold. */
export function defaultExpiration(): anchor.BN {
  return new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
}

// ── create_hold ──────────────────────────────────────────────────────────────

export type CreateHoldContext = BaseWriteContext &
  MintContext &
  PayerContext & {
    /** Owner of `tokenAccount`; signs the hold into existence. */
    authority: Keypair;
    tokenAccount: PublicKey;
  };

export type CreateHoldArgs = {
  /** Defaults to the position's next hold id (`hold_count + 1`). */
  holdId?: anchor.BN;
  amount?: anchor.BN;
  expiration?: anchor.BN;
  /** The notary. Defaults to the holder itself (a self-cancellable reserve). */
  escrow?: PublicKey;
  destination?: PublicKey | null;
};

export async function createHold(
  callContext: CreateHoldContext,
  args?: CreateHoldArgs
): Promise<{ signature: string; holdId: anchor.BN }> {
  const holdId = args?.holdId ?? (await nextHoldId(callContext.mint, callContext.tokenAccount));
  const amount = args?.amount ?? new anchor.BN(1);
  const expiration = args?.expiration ?? defaultExpiration();
  const escrow = args?.escrow ?? callContext.authority.publicKey;
  const destination = args?.destination ?? null;

  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await getHoldProgram()
    .methods.createHold(holdId, amount, expiration, escrow, destination)
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: callContext.authority.publicKey,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      tokenAccount: callContext.tokenAccount,
      tokenAccountFrozenPda: frozenAccountPda(callContext.mint, callContext.tokenAccount),
      tokenAccountFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.tokenAccount),
      holdPosition: holdPositionPda(callContext.mint, callContext.tokenAccount),
      holdRecord: holdPda(callContext.mint, callContext.tokenAccount, holdId),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: holdEventAuthorityPda(),
      program: HOLD_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });

  return { signature, holdId };
}

// ── controller_create_hold ───────────────────────────────────────────────────

export type ControllerCreateHoldContext = BaseWriteContext &
  MintContext &
  PayerContext & {
    /** Must hold ROLE_CONTROLLER; need not own `tokenAccount`. */
    authority: Keypair;
    /** The target holder's token account. */
    tokenAccount: PublicKey;
  };

export async function controllerCreateHold(
  callContext: ControllerCreateHoldContext,
  args?: CreateHoldArgs
): Promise<{ signature: string; holdId: anchor.BN }> {
  const holdId = args?.holdId ?? (await nextHoldId(callContext.mint, callContext.tokenAccount));
  const amount = args?.amount ?? new anchor.BN(1);
  const expiration = args?.expiration ?? defaultExpiration();
  const escrow = args?.escrow ?? callContext.authority.publicKey;
  const destination = args?.destination ?? null;

  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await getHoldProgram()
    .methods.controllerCreateHold(holdId, amount, expiration, escrow, destination)
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: callContext.authority.publicKey,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      tokenAccount: callContext.tokenAccount,
      tokenAccountFrozenPda: frozenAccountPda(callContext.mint, callContext.tokenAccount),
      tokenAccountFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.tokenAccount),
      holdPosition: holdPositionPda(callContext.mint, callContext.tokenAccount),
      holdRecord: holdPda(callContext.mint, callContext.tokenAccount, holdId),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: holdEventAuthorityPda(),
      program: HOLD_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [callContext.authority])
    .rpc({ commitment: "confirmed" });

  return { signature, holdId };
}

// ── execute_hold ─────────────────────────────────────────────────────────────

export type ExecuteHoldContext = BaseWriteContext &
  MintContext & {
    /** The notary recorded on the hold; the only signer allowed to execute. */
    escrow: Keypair;
    tokenAccount: PublicKey;
    destination: PublicKey;
  };

export type ExecuteHoldArgs = {
  holdId?: anchor.BN;
  amount?: anchor.BN;
};

export async function executeHold(
  callContext: ExecuteHoldContext,
  args?: ExecuteHoldArgs
): Promise<{ signature: string }> {
  const holdId = args?.holdId ?? new anchor.BN(1);
  const amount = args?.amount ?? new anchor.BN(1);

  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  // The transfer runs through operations' permanent delegate, so this pays for
  // the hold program's own checks plus a full Token-2022 transfer_checked with
  // metalist resolution — well past the default 200k CU budget.
  const preInstructions = [anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];

  const signature = await getHoldProgram()
    .methods.executeHold(holdId, amount)
    .accountsStrict({
      escrow: callContext.escrow.publicKey,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      sourceToken: callContext.tokenAccount,
      destinationToken: callContext.destination,
      holdPosition: holdPositionPda(callContext.mint, callContext.tokenAccount),
      holdRecord: holdPda(callContext.mint, callContext.tokenAccount, holdId),
      holdAuthority: holdAuthorityPda(callContext.mint),
      operationsAuthority: permanentDelegatePda(callContext.mint),
      operationsProgram: OPERATIONS_PROGRAM_ID,
      extraAccountMetaList: pdaUtils.extraAccountMetaListPda(callContext.mint),
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      deployProgram: DEPLOY_PROGRAM_ID,
      factoryProgram: FACTORY_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      deactivateProgram: DEACTIVATE_PROGRAM_ID,
      transferControlProgram: TRANSFER_CONTROL_PROGRAM_ID,
      transferControlModePda: transferControlModePda(callContext.mint),
      sourceWhitelistPda: whitelistPda(callContext.mint, callContext.tokenAccount),
      destinationWhitelistPda: whitelistPda(callContext.mint, callContext.destination),
      freezeProgram: FREEZE_PROGRAM_ID,
      sourceFrozenPda: frozenAccountPda(callContext.mint, callContext.tokenAccount),
      sourceFrozenBalancePda: frozenBalancePda(callContext.mint, callContext.tokenAccount),
      holdProgram: HOLD_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      eventAuthority: holdEventAuthorityPda(),
      program: HOLD_PROGRAM_ID,
    })
    .preInstructions(preInstructions)
    .signers(callContext.signers ?? [callContext.escrow])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

// ── release_hold ─────────────────────────────────────────────────────────────

export type ReleaseHoldContext = BaseWriteContext &
  MintContext & {
    escrow: Keypair;
    tokenAccount: PublicKey;
  };

export type ReleaseHoldArgs = {
  holdId?: anchor.BN;
  amount?: anchor.BN;
};

export async function releaseHold(
  callContext: ReleaseHoldContext,
  args?: ReleaseHoldArgs
): Promise<{ signature: string }> {
  const holdId = args?.holdId ?? new anchor.BN(1);
  const amount = args?.amount ?? new anchor.BN(1);

  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await getHoldProgram()
    .methods.releaseHold(holdId, amount)
    .accountsStrict({
      escrow: callContext.escrow.publicKey,
      mint: callContext.mint,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      tokenAccount: callContext.tokenAccount,
      holdPosition: holdPositionPda(callContext.mint, callContext.tokenAccount),
      holdRecord: holdPda(callContext.mint, callContext.tokenAccount, holdId),
      eventAuthority: holdEventAuthorityPda(),
      program: HOLD_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [callContext.escrow])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

// ── reclaim_hold ─────────────────────────────────────────────────────────────

export type ReclaimHoldContext = BaseWriteContext &
  MintContext & {
    /** Permissionless: any signer can reclaim once the hold has expired. */
    caller: Keypair;
    tokenAccount: PublicKey;
  };

export type ReclaimHoldArgs = {
  holdId?: anchor.BN;
};

export async function reclaimHold(
  callContext: ReclaimHoldContext,
  args?: ReclaimHoldArgs
): Promise<{ signature: string }> {
  const holdId = args?.holdId ?? new anchor.BN(1);

  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await getHoldProgram()
    .methods.reclaimHold(holdId)
    .accountsStrict({
      caller: callContext.caller.publicKey,
      mint: callContext.mint,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      tokenAccount: callContext.tokenAccount,
      holdPosition: holdPositionPda(callContext.mint, callContext.tokenAccount),
      holdRecord: holdPda(callContext.mint, callContext.tokenAccount, holdId),
      eventAuthority: holdEventAuthorityPda(),
      program: HOLD_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [callContext.caller])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

// ── events ───────────────────────────────────────────────────────────────────

type HoldCreatedEvent = {
  mint: PublicKey;
  tokenAccount: PublicKey;
  holdId: anchor.BN;
  escrow: PublicKey;
  destination: PublicKey | null;
  amount: anchor.BN;
  expiration: anchor.BN;
};

type ControllerHoldCreatedEvent = HoldCreatedEvent & {
  controller: PublicKey;
};

type HoldExecutedEvent = {
  mint: PublicKey;
  tokenAccount: PublicKey;
  holdId: anchor.BN;
  escrow: PublicKey;
  destination: PublicKey;
  amount: anchor.BN;
  remainingAmount: anchor.BN;
};

type HoldReleasedEvent = {
  mint: PublicKey;
  tokenAccount: PublicKey;
  holdId: anchor.BN;
  escrow: PublicKey;
  amount: anchor.BN;
  remainingAmount: anchor.BN;
};

type HoldReclaimedEvent = {
  mint: PublicKey;
  tokenAccount: PublicKey;
  holdId: anchor.BN;
  caller: PublicKey;
  amount: anchor.BN;
};

export async function getHoldCreatedEvent(signature: string) {
  return getEvent<HoldCreatedEvent>(getHoldProgram(), signature, "holdCreated");
}

export async function getControllerHoldCreatedEvent(signature: string) {
  return getEvent<ControllerHoldCreatedEvent>(getHoldProgram(), signature, "controllerHoldCreated");
}

export async function getHoldExecutedEvent(signature: string) {
  return getEvent<HoldExecutedEvent>(getHoldProgram(), signature, "holdExecuted");
}

export async function getHoldReleasedEvent(signature: string) {
  return getEvent<HoldReleasedEvent>(getHoldProgram(), signature, "holdReleased");
}

export async function getHoldReclaimedEvent(signature: string) {
  return getEvent<HoldReclaimedEvent>(getHoldProgram(), signature, "holdReclaimed");
}
