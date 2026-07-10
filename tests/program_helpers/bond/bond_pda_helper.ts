import { PublicKey } from "@solana/web3.js";
import { BOND_PROGRAM_ID } from "../../utils/address_utils";
import { getBondProgram } from "./bond_instruction_helper";

// ── bond_terms PDA ──────────────────────────────────────────────────────────

export function bondTermsPda(mint: PublicKey): PublicKey {
  return bondTermsPdaWithBump(mint)[0];
}

export function bondTermsPdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("bond_terms"), mint.toBuffer()], BOND_PROGRAM_ID);
}

export async function getBondTerms(mint: PublicKey) {
  return await getBondProgram().account.bondTerms.fetch(bondTermsPda(mint), "confirmed");
}

// ── event authority ─────────────────────────────────────────────────────────

/** Anchor event-CPI authority for the bond program (seed "__event_authority"). */
export function bondEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], BOND_PROGRAM_ID)[0];
}
