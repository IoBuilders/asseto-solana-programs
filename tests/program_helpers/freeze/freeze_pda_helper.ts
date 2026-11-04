import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { FREEZE_PROGRAM_ID } from "../../utils/address_utils";
import { getFreezeProgram } from "./freeze_instruction_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";

// ── freeze_state PDA ───────────────────────────────────────────────────────────

export type FreezeState = {
  fullyFrozen: boolean;
  frozenBalance: anchor.BN;
  bump: number;
};

export function freezeStatePda(mint: PublicKey, account: PublicKey): PublicKey {
  return freezeStatePdaWithBump(mint, account)[0];
}

export function freezeStatePdaWithBump(mint: PublicKey, account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("freeze_state"), mint.toBuffer(), account.toBuffer()],
    FREEZE_PROGRAM_ID
  );
}

export async function getFreezeStateByPda(pda: PublicKey): Promise<FreezeState | null> {
  return await getFreezeProgram().account.freezeState.fetchNullable(pda, "confirmed");
}

export async function getFreezeState(mint: PublicKey, account: PublicKey): Promise<FreezeState | null> {
  return await getFreezeStateByPda(freezeStatePda(mint, account));
}

/**
 * Plants the `freeze_state` PDA via surfpool, merging `changes` into whatever is
 * already on-chain so planting one freeze side never wipes the other. When both
 * sides end up clear the account is removed, mirroring the program's own close.
 */
export async function setFreezeStatePda(
  mint: PublicKey,
  account: PublicKey,
  changes: Partial<Omit<FreezeState, "bump">>
): Promise<void> {
  const [pda, bump] = freezeStatePdaWithBump(mint, account);
  const current = await getFreezeStateByPda(pda);
  const next = {
    fullyFrozen: changes.fullyFrozen ?? current?.fullyFrozen ?? false,
    frozenBalance: changes.frozenBalance ?? current?.frozenBalance ?? new anchor.BN(0),
    bump,
  };

  if (!next.fullyFrozen && next.frozenBalance.isZero()) {
    await surfnetSetAccount(pda, { lamports: 0 });
    return;
  }

  const data = await getFreezeProgram().coder.accounts.encode("freezeState", next);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FREEZE_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
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

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function freezeEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], FREEZE_PROGRAM_ID)[0];
}
