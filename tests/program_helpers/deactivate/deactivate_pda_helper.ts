import { PublicKey } from "@solana/web3.js";
import { DEACTIVATE_PROGRAM_ID } from "../../utils/address_utils";
import { getDeactivateProgram } from "./deactivate_instruction_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";

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

/**
 * Test-only: plants the `deactivate` marker PDA for `mint` directly via surfpool,
 * without invoking the `deactivate` program. `require_active` only checks that the
 * account is non-empty, so its existence is enough to make the mint read as
 * deactivated.
 */
export async function setDeactivateMarker(mint: PublicKey): Promise<void> {
  const [pda, bump] = deactivatePdaWithBump(mint);
  const data = await getDeactivateProgram().coder.accounts.encode("deactivateStatus", { bump });
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: DEACTIVATE_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

/** Test-only: deletes the `deactivate` marker PDA for `mint` (surfpool `lamports: 0`). */
export async function clearDeactivateMarker(mint: PublicKey): Promise<void> {
  await surfnetSetAccount(deactivatePda(mint), { lamports: 0 });
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function deactivateEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DEACTIVATE_PROGRAM_ID)[0];
}
