import * as pdaUtils from "../utils/pda_utils";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID } from "../utils/address_utils";
import { Deactivate } from "../../target/types/deactivate";
import { MintWriteContext } from "./base_helper";
import { PublicKey } from "@solana/web3.js";

function getDeactivateProgram(): Program<Deactivate> {
  return anchor.workspace.Deactivate as Program<Deactivate>;
}

export async function deactivateMint(callContext: MintWriteContext): Promise<void> {
  await getDeactivateProgram()
    .methods.deactivate()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export async function getDeactivatePda(pda: PublicKey) {
  return await getDeactivateProgram().account.deactivateStatus.fetchNullable(pda);
}
