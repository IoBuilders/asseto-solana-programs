import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { NOMINAL_VALUE_PROGRAM_ID } from "../../utils/address_utils";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";
import { getNominalValueProgram } from "./nominal_value_instruction_helper";

// ── nominal_value PDA ──────────────────────────────────────────────────────

export function nominalValuePda(mint: PublicKey): PublicKey {
  return nominalValuePdaWithBump(mint)[0];
}

export function nominalValuePdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("nominal_value"), mint.toBuffer()], NOMINAL_VALUE_PROGRAM_ID);
}

export async function getNominalValue(mint: PublicKey) {
  return await getNominalValueProgram().account.nominalValue.fetch(nominalValuePda(mint), "confirmed");
}

export type NominalValueFields = {
  nominalValueCurrency: number[];
  nominalValuePublishType: { unit: {} } | { total: {} };
  nominalValueDecimals: number;
  nominalValue: anchor.BN;
  effectiveDatetime: anchor.BN;
};

/**
 * Test-only: plants the `nominal_value` PDA for `mint` directly via surfpool, so a test can
 * start from "already published at datetime X" without going through `publish_nominal_value`.
 */
export async function setNominalValuePda(mint: PublicKey, fields: NominalValueFields): Promise<void> {
  const [pda, bump] = nominalValuePdaWithBump(mint);
  const data = await getNominalValueProgram().coder.accounts.encode("nominalValue", { bump, ...fields });
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: NOMINAL_VALUE_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function nominalValueEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], NOMINAL_VALUE_PROGRAM_ID)[0];
}
