import { Keypair, PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import * as anchor from "@anchor-lang/core";
import { MintContext, MintWriteWithPayerContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Snapshot } from "../../target/types/snapshot";
import { SYSTEM_PROGRAM_ID } from "../utils/address_utils";

function getSnapshotProgram(): Program<Snapshot> {
  return anchor.workspace.Snapshot as Program<Snapshot>;
}

export async function takeSnapshot(callContext: MintWriteWithPayerContext): Promise<void> {
  await getSnapshotProgram()
    .methods.takeSnapshot()
    .accountsStrict({
      callingAuthority: callContext.deployer,
      payer: callContext.payer ?? callContext.deployer,
      mint: callContext.mint,
      snapshotCounter: pdaUtils.snapshotCounterPda(callContext.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .rpc({ commitment: "processed" });
}

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
      totalSupplySnapshot: pdaUtils.snapshotTotalSupplyPda(callContext.mint),
    })
    .view();
}

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
      holderBalanceSnapshot: pdaUtils.snapshotHolderBalancePda(callContext.mint, callContext.holderTokenAccount),
    })
    .view();
}

export async function updateTotalSupplySnapshot(ctx: MintWriteWithPayerContext): Promise<void> {
  const callingAuthority = ctx.deployer;

  await getSnapshotProgram()
    .methods.updateTotalsupplySnapshot()
    .accountsStrict({
      callingAuthority: callingAuthority,
      payer: ctx.payer ?? ctx.deployer,
      mint: ctx.mint,
      snapshotCounter: pdaUtils.snapshotCounterPda(ctx.mint),
      totalSupplySnapshot: pdaUtils.snapshotTotalSupplyPda(ctx.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .rpc({ commitment: "processed" });
}

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
      snapshotCounter: pdaUtils.snapshotCounterPda(ctx.mint),
      holderBalanceSnapshot: pdaUtils.snapshotHolderBalancePda(ctx.mint, holderTokenAccount),
      holderTokenAccount: holderTokenAccount,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .rpc({ commitment: "processed" });
}

export async function getSnapshotCounter(mint: PublicKey) {
  const pda = pdaUtils.snapshotCounterPda(mint);
  return getSnapshotCounterByPda(pda);
}

export async function getSnapshotCounterByPda(pda: PublicKey) {
  return await getSnapshotProgram().account.snapshotCounter.fetch(pda, "processed");
}

/**
 * Borsh-encodes a `SnapshotCounter` (8-byte discriminator + bump + count) the
 * way the program stores it on-chain. Used by tests that plant counter state
 * directly via a surfpool cheatcode.
 */
export async function encodeSnapshotCounter(bump: number, count: anchor.BN): Promise<Buffer> {
  return getSnapshotProgram().coder.accounts.encode("snapshotCounter", { bump, count });
}
