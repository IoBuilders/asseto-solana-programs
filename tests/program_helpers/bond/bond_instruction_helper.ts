import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { Bond } from "../../../target/types/bond";
import { BOND_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import * as pdaUtils from "../../utils/pda_utils";
import { MintWriteWithPayerContext } from "../base_helper";
import { getEvent } from "../event_helper";
import { getMintOwner } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { bondEventAuthorityPda, bondTermsPda } from "./bond_pda_helper";

export function getBondProgram(): Program<Bond> {
  return anchor.workspace.Bond as Program<Bond>;
}

// ── update_bond_terms ──────────────────────────────────────────────────────────

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

export async function updateBondTerms(
  callContext: MintWriteWithPayerContext,
  args?: UpdateBondArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<UpdateBondArgs> = {
    ...getDefaultBondTermsArgs(),
    ...args,
  };

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const signature = await getBondProgram()
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
      bondTerms: bondTermsPda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: bondEventAuthorityPda(),
      program: BOND_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type BondTermsUpdatedEvent = {
  mint: PublicKey;
  operator: PublicKey;
  interestRate: anchor.BN;
  interestRateDecimals: number;
  parValue: anchor.BN;
  parValueDecimals: number;
  minimumDenomination: anchor.BN;
  issuanceDate: anchor.BN;
  dayCountConvention: any;
};

/**
 * Decodes the `BondTermsUpdated` event from an `update_bond_terms` transaction.
 * The coder returns the name in camelCase (`bondTermsUpdated`). Delegates to
 * the shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getBondTermsUpdatedEvent(signature: string) {
  return getEvent<BondTermsUpdatedEvent>(getBondProgram(), signature, "bondTermsUpdated");
}
