import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { Factory } from "../../target/types/factory";
import { SYSTEM_PROGRAM_ID } from "../utils/address_utils";
import * as pdaUtils from "../utils/pda_utils";
import { BaseWriteContext, PayerContext } from "./base_helper";

function getFactoryProgram(): Program<Factory> {
  return anchor.workspace.Factory as Program<Factory>;
}

export type InitializeFactoryContext = BaseWriteContext & PayerContext;

export async function initializeFactory(manager: PublicKey, callContext: InitializeFactoryContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const payer = callContext.payer ?? program.provider.publicKey!;

  await program.methods
    .initialize(manager)
    .accountsStrict({
      payer,
      factory: pdaUtils.factoryPda(),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export async function getFactory(pda: PublicKey = pdaUtils.factoryPda()) {
  return await getFactoryProgram().account.factory.fetch(pda, "confirmed");
}
