import { PublicKey } from "@solana/web3.js";
import { TRANSFER_CONTROL_PROGRAM_ID } from "../../utils/address_utils";
import { getTransferControlProgram } from "./transfer_control_instruction_helper";

// ── transfer_control_mode PDA ─────────────────────────────────────────────────

export function transferControlModePda(mint: PublicKey): PublicKey {
  return transferControlModePdaWithBump(mint)[0];
}

export function transferControlModePdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("transfer_control_mode"), mint.toBuffer()],
    TRANSFER_CONTROL_PROGRAM_ID
  );
}

export async function getTransferControlModeByPda(pda: PublicKey) {
  return await getTransferControlProgram().account.transferControlMode.fetchNullable(pda, "confirmed");
}

// ── whitelist PDA ──────────────────────────────────────────────────────────────

export function whitelistPda(mint: PublicKey, account: PublicKey): PublicKey {
  return whitelistPdaWithBump(mint, account)[0];
}

export function whitelistPdaWithBump(mint: PublicKey, account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), mint.toBuffer(), account.toBuffer()],
    TRANSFER_CONTROL_PROGRAM_ID
  );
}

export async function getWhitelistStatusByPda(pda: PublicKey) {
  return await getTransferControlProgram().account.whitelistStatus.fetchNullable(pda, "confirmed");
}

// ── __event_authority PDA ─────────────────────────────────────────────────────

export function transferControlEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], TRANSFER_CONTROL_PROGRAM_ID)[0];
}
