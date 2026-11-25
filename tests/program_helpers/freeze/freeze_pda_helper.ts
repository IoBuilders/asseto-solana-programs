import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { FREEZE_PROGRAM_ID } from "../../utils/address_utils";
import {
  accountCompliancePda,
  getAccountComplianceByPda,
  setAccountComplianceFreeze,
} from "../transfer_hook/transfer_hook_pda_helper";

export { accountCompliancePda, accountCompliancePdaWithBump } from "../transfer_hook/transfer_hook_pda_helper";

// ── freeze side of the hook's AccountCompliance ─────────────────────────────────

export type FreezeState = {
  fullyFrozen: boolean;
  frozenBalance: anchor.BN;
  bump: number;
};

/** The freeze fields of the account's `AccountCompliance`, or null if no record exists. */
export async function getFreezeStateByPda(pda: PublicKey): Promise<FreezeState | null> {
  const record = await getAccountComplianceByPda(pda);
  if (!record) {
    return null;
  }
  return { fullyFrozen: record.fullyFrozen !== 0, frozenBalance: record.frozenBalance, bump: record.bump };
}

export async function getFreezeState(mint: PublicKey, account: PublicKey): Promise<FreezeState | null> {
  return await getFreezeStateByPda(accountCompliancePda(mint, account));
}

/** Plants freeze fields via surfpool, keeping the side not named in `changes`. */
export async function setFreezeStatePda(
  mint: PublicKey,
  account: PublicKey,
  changes: Partial<Omit<FreezeState, "bump">>
): Promise<void> {
  await setAccountComplianceFreeze(mint, account, changes);
}

export async function setFrozenAccountPda(mint: PublicKey, account: PublicKey): Promise<void> {
  await setFreezeStatePda(mint, account, { fullyFrozen: true });
}

export async function setFrozenBalancePda(mint: PublicKey, account: PublicKey, balance: anchor.BN): Promise<void> {
  await setFreezeStatePda(mint, account, { frozenBalance: balance });
}

export async function clearFrozenBalancePda(mint: PublicKey, account: PublicKey): Promise<void> {
  await setFreezeStatePda(mint, account, { frozenBalance: new anchor.BN(0) });
}

// ── registry_writer PDA ────────────────────────────────────────────────────────

export function freezeRegistryWriterPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("registry_writer")], FREEZE_PROGRAM_ID)[0];
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function freezeEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], FREEZE_PROGRAM_ID)[0];
}
