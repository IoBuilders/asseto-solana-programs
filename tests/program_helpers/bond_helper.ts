import * as pdaUtils from "../utils/pda_utils";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID } from "../utils/address_utils";
import { Bond } from "../../target/types/bond";
import { Program } from "@anchor-lang/core";
import { MintWriteWithPayerContext } from "./base_helper";
import { PublicKey } from "@solana/web3.js";

function getBondProgram(): Program<Bond> {
  return anchor.workspace.Bond as Program<Bond>;
}

export type UpdateBondArgs = {
  interestRate?: anchor.BN;
  interestRateDecimals?: number;
  parValue?: anchor.BN;
  parValueDecimals?: number;
  minimumDenomination?: anchor.BN;
  issuanceDate?: anchor.BN;
  dayCountConvention?: any;
};

function getDefaultBondTermsArgs(): Required<UpdateBondArgs> {
  return {
    interestRate: new anchor.BN(5_275),
    interestRateDecimals: 5,
    parValue: new anchor.BN(100_000),
    parValueDecimals: 2,
    minimumDenomination: new anchor.BN(100),
    issuanceDate: new anchor.BN(1_700_000_000),
    dayCountConvention: { actual360: {} },
  };
}

export async function updateBondTerms(callContext: MintWriteWithPayerContext, args?: UpdateBondArgs): Promise<void> {
  const effectiveArgs: Required<UpdateBondArgs> = {
    ...getDefaultBondTermsArgs(),
    ...args,
  };

  await getBondProgram()
    .methods.updateBondTerms({
      interestRate: effectiveArgs.interestRate,
      interestRateDecimals: effectiveArgs.interestRateDecimals,
      parValue: effectiveArgs.parValue,
      parValueDecimals: effectiveArgs.parValueDecimals,
      minimumDenomination: effectiveArgs.minimumDenomination,
      issuanceDate: effectiveArgs.issuanceDate,
      dayCountConvention: effectiveArgs.dayCountConvention,
    })
    .accountsStrict({
      payer: callContext.payer ?? callContext.deployer,
      deployer: callContext.deployer,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      mint: callContext.mint,
      bondTerms: pdaUtils.bondTermsPda(callContext.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export async function getCouponCounterByPda(pda: PublicKey) {
  return await getBondProgram().account.bondTerms.fetch(pda, "confirmed");
}
