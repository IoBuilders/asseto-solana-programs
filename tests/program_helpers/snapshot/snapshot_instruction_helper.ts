import { Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { MintWriteWithPayerContext } from "../base_helper";
import { Program } from "@anchor-lang/core";
import { Snapshot } from "../../../target/types/snapshot";
import { SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import { getEvent } from "../event_helper";
import {
  snapshotCounterPda,
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
      callingAuthority: callContext.authority.publicKey,
      payer: callContext.payer ?? callContext.authority.publicKey,
      mint: callContext.mint,
      snapshotCounter: snapshotCounterPda(callContext.mint),
      snapshotMerkleRoot: snapshotMerkleRootPda(callContext.mint, snapshotId),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: snapshotTriggeredEventAuthorityPda(),
      program: getSnapshotProgram().programId,
    })
    .signers(callContext.signers ?? [callContext.authority])
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

  const holderTokenAccount = Keypair.generate().publicKey;

  await getSnapshotProgram()
    .methods.updateHolderbalanceSnapshot(effectiveArgs.delta, effectiveArgs.increase)
    .accountsStrict({
      callingAuthority: ctx.authority.publicKey,
      payer: ctx.payer ?? ctx.authority.publicKey,
      mint: ctx.mint,
      snapshotCounter: snapshotCounterPda(ctx.mint),
      holderBalanceSnapshot: snapshotHolderBalancePda(ctx.mint, holderTokenAccount),
      holderTokenAccount: holderTokenAccount,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(ctx.signers ?? [ctx.authority])
    .rpc({ commitment: "confirmed" });
}
