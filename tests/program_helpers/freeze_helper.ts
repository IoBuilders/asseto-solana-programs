import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Freeze } from "../../target/types/freeze";

function getFreezeProgram(): Program<Freeze> {
  return anchor.workspace.Freeze as Program<Freeze>;
}

export type FreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function freezeAccount(callContext: FreezeAccountContext): Promise<void> {
  await getFreezeProgram()
    .methods.freezeAccount()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      frozenAccountPda: pdaUtils.frozenAccountPda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export type UnfreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function unfreezeAccount(callContext: UnfreezeAccountContext): Promise<void> {
  await getFreezeProgram()
    .methods.unfreezeAccount()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      frozenAccountPda: pdaUtils.frozenAccountPda(callContext.mint, callContext.account),
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
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
): Promise<void> {
  const effectiveArgs: Required<PartiallyFreezeAccountArgs> = {
    ...getDefaultCreateCouponArgs(),
    ...args,
  };

  await getFreezeProgram()
    .methods.partiallyFreezeAccount(effectiveArgs.balance)
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      frozenBalancePda: pdaUtils.frozenBalancePda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export type PartiallyUnfreezeAccountContext = MintWriteContext & {
  account: PublicKey;
};

export async function removePartialFreeze(callContext: PartiallyUnfreezeAccountContext): Promise<void> {
  await getFreezeProgram()
    .methods.removePartialFreeze()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      account: callContext.account,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      frozenBalancePda: pdaUtils.frozenBalancePda(callContext.mint, callContext.account),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export async function getFrozenAccountStatusByPda(pda: PublicKey) {
  return await getFreezeProgram().account.frozenAccountStatus.fetchNullable(pda, "confirmed");
}

export async function getFrozenBalanceByPda(pda: PublicKey) {
  return await getFreezeProgram().account.frozenBalance.fetchNullable(pda, "confirmed");
}
