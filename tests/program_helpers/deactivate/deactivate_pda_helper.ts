import { PublicKey } from "@solana/web3.js";
import { DEACTIVATE_PROGRAM_ID } from "../../utils/address_utils";
import { getDeactivateProgram } from "./deactivate_instruction_helper";

// ── deactivate PDA ─────────────────────────────────────────────────────────────

export function deactivatePda(mint: PublicKey): PublicKey {
  return deactivatePdaWithBump(mint)[0];
}

export function deactivatePdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("deactivate"), mint.toBuffer()], DEACTIVATE_PROGRAM_ID);
}

export async function getDeactivatePda(pda: PublicKey) {
  return await getDeactivateProgram().account.deactivateStatus.fetchNullable(pda);
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function deactivateEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DEACTIVATE_PROGRAM_ID)[0];
}
