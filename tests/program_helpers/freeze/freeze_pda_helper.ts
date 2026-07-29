import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { FREEZE_PROGRAM_ID } from "../../utils/address_utils";
import { getFreezeProgram } from "./freeze_instruction_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";

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

export async function setFrozenAccountPda(mint: PublicKey, account: PublicKey): Promise<void> {
  const [pda, bump] = frozenAccountPdaWithBump(mint, account);
  const data = await getFreezeProgram().coder.accounts.encode("frozenAccountStatus", { bump });
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FREEZE_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
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

export async function setFrozenBalancePda(mint: PublicKey, account: PublicKey, balance: anchor.BN): Promise<void> {
  const [pda, bump] = frozenBalancePdaWithBump(mint, account);
  const data = await getFreezeProgram().coder.accounts.encode("frozenBalance", { balance, bump });
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FREEZE_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

export async function clearFrozenBalancePda(mint: PublicKey, account: PublicKey): Promise<void> {
  await surfnetSetAccount(frozenBalancePda(mint, account), { lamports: 0 });
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function freezeEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], FREEZE_PROGRAM_ID)[0];
}
