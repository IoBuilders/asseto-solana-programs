import { Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { MintContext, MintWriteWithPayerContext } from "../base_helper";
import { Program } from "@anchor-lang/core";
import { Snapshot } from "../../../target/types/snapshot";
import { SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import { getEvent } from "../event_helper";
import {
  snapshotCounterPda,
  snapshotTotalSupplyPda,
  snapshotHolderBalancePda,
  snapshotMerkleRootPda,
  snapshotTriggeredEventAuthorityPda,
  nextSnapshotId,
} from "./snapshot_pda_helper";

export const ZERO_MERKLE_ROOT: number[] = new Array(32).fill(0);

export function getSnapshotProgram(): Program<Snapshot> {
  return anchor.workspace.Snapshot as Program<Snapshot>;
}

// ── take_snapshot ──────────────────────────────────────────────────────────────

export async function takeSnapshot(
  callContext: MintWriteWithPayerContext,
  args?: { merkleRoot?: number[] }
): Promise<void> {
  const merkleRoot = args?.merkleRoot ?? ZERO_MERKLE_ROOT;
  const snapshotId = await nextSnapshotId(callContext.mint);

  await getSnapshotProgram()
    .methods.takeSnapshot(merkleRoot)
    .accountsStrict({
      callingAuthority: callContext.deployer,
      payer: callContext.payer ?? callContext.deployer,
      mint: callContext.mint,
      snapshotCounter: snapshotCounterPda(callContext.mint),
      snapshotMerkleRoot: snapshotMerkleRootPda(callContext.mint, snapshotId),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: snapshotTriggeredEventAuthorityPda(),
      program: getSnapshotProgram().programId,
    })
    .rpc({ commitment: "confirmed" });
}

type SnapshotTriggeredEvent = {
  mint: PublicKey;
  snapshotId: anchor.BN;
  merkleRoot: number[];
};

/**
 * Decodes the `SnapshotTriggeredEvent` event from a `take_snapshot` transaction. The coder
 * returns the name in camelCase (`snapshotTriggered`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getSnapshotTriggeredEvent(signature: string) {
  return getEvent<SnapshotTriggeredEvent>(getSnapshotProgram(), signature, "snapshotTriggered");
}

// ── get_totalsupply_snapshot_at ────────────────────────────────────────────────

export type GetTotalSupplySnapshotAtArgs = {
  snapshotId: anchor.BN;
};

export async function getTotalSupplySnapshotAt(
  callContext: MintContext,
  args: GetTotalSupplySnapshotAtArgs
): Promise<anchor.BN> {
  return await getSnapshotProgram()
    .methods.getTotalsupplySnapshotAt(args.snapshotId)
    .accountsStrict({
      mint: callContext.mint,
      totalSupplySnapshot: snapshotTotalSupplyPda(callContext.mint),
    })
    .view();
}

// ── get_holderbalance_snapshot_at ──────────────────────────────────────────────

export type GetHolderBalanceSnapshotAtContext = MintContext & {
  holderTokenAccount: PublicKey;
};

export type GetHolderBalanceSnapshotAtArgs = {
  snapshotId: anchor.BN;
};

export async function getHolderBalanceSnapshotAt(
  callContext: GetHolderBalanceSnapshotAtContext,
  args: GetHolderBalanceSnapshotAtArgs
): Promise<anchor.BN> {
  return await getSnapshotProgram()
    .methods.getHolderbalanceSnapshotAt(args.snapshotId)
    .accountsStrict({
      mint: callContext.mint,
      holderTokenAccount: callContext.holderTokenAccount,
      holderBalanceSnapshot: snapshotHolderBalancePda(callContext.mint, callContext.holderTokenAccount),
    })
    .view();
}

// ── update_totalsupply_snapshot ────────────────────────────────────────────────

export async function updateTotalSupplySnapshot(ctx: MintWriteWithPayerContext): Promise<void> {
  const callingAuthority = ctx.deployer;

  await getSnapshotProgram()
    .methods.updateTotalsupplySnapshot()
    .accountsStrict({
      callingAuthority: callingAuthority,
      payer: ctx.payer ?? ctx.deployer,
      mint: ctx.mint,
      snapshotCounter: snapshotCounterPda(ctx.mint),
      totalSupplySnapshot: snapshotTotalSupplyPda(ctx.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .rpc({ commitment: "confirmed" });
}

// ── update_holderbalance_snapshot ──────────────────────────────────────────────

type UpdateHolderBalanceSnapshotArgs = {
  delta: anchor.BN;
  increase: boolean;
};

function getUpdateHolderBalanceSnapshotArgs(): Required<UpdateHolderBalanceSnapshotArgs> {
  return {
    delta: new anchor.BN(0),
    increase: true,
  };
}

export async function updateHolderBalanceSnapshot(
  ctx: MintWriteWithPayerContext,
  args?: { delta: anchor.BN; increase: boolean }
): Promise<void> {
  const effectiveArgs: Required<UpdateHolderBalanceSnapshotArgs> = {
    ...getUpdateHolderBalanceSnapshotArgs(),
    ...args,
  };

  const callingAuthority = ctx.deployer;
  const holderTokenAccount = Keypair.generate().publicKey;

  await getSnapshotProgram()
    .methods.updateHolderbalanceSnapshot(effectiveArgs.delta, effectiveArgs.increase)
    .accountsStrict({
      callingAuthority: callingAuthority,
      payer: ctx.payer ?? ctx.deployer,
      mint: ctx.mint,
      snapshotCounter: snapshotCounterPda(ctx.mint),
      holderBalanceSnapshot: snapshotHolderBalancePda(ctx.mint, holderTokenAccount),
      holderTokenAccount: holderTokenAccount,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .rpc({ commitment: "confirmed" });
}
