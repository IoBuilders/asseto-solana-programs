import { PublicKey } from "@solana/web3.js";
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
    .rpc({ commitment: "confirmed" });
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

export async function getSnapshotCounter(mint: PublicKey) {
  const pda = pdaUtils.snapshotCounterPda(mint);
  return getSnapshotCounterByPda(pda);
}

export async function getSnapshotCounterByPda(pda: PublicKey) {
  return await getSnapshotProgram().account.snapshotCounter.fetch(pda, "confirmed");
}
