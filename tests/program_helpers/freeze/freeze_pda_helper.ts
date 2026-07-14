import { PublicKey } from "@solana/web3.js";
import { FREEZE_PROGRAM_ID } from "../../utils/address_utils";
import { getFreezeProgram } from "./freeze_instruction_helper";

// ── freeze_authority PDA ───────────────────────────────────────────────────────

export function freezeAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("freeze_authority"), mint.toBuffer()], FREEZE_PROGRAM_ID)[0];
}

// ── frozen_account PDA ─────────────────────────────────────────────────────────

export function frozenAccountPda(mint: PublicKey, account: PublicKey): PublicKey {
  return frozenAccountPdaWithBump(mint, account)[0];
}

export function frozenAccountPdaWithBump(mint: PublicKey, account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("frozen_account"), mint.toBuffer(), account.toBuffer()],
    FREEZE_PROGRAM_ID
  );
}

export async function getFrozenAccountStatusByPda(pda: PublicKey) {
  return await getFreezeProgram().account.frozenAccountStatus.fetchNullable(pda, "confirmed");
}

// ── frozen_balance PDA ─────────────────────────────────────────────────────────

export function frozenBalancePda(mint: PublicKey, account: PublicKey): PublicKey {
  return frozenBalancePdaWithBump(mint, account)[0];
}

export function frozenBalancePdaWithBump(mint: PublicKey, account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("frozen_balance"), mint.toBuffer(), account.toBuffer()],
    FREEZE_PROGRAM_ID
  );
}

export async function getFrozenBalanceByPda(pda: PublicKey) {
  return await getFreezeProgram().account.frozenBalance.fetchNullable(pda, "confirmed");
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function freezeEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], FREEZE_PROGRAM_ID)[0];
}
