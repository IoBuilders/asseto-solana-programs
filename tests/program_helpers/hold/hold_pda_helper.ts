import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { HOLD_PROGRAM_ID } from "../../utils/address_utils";
import { getHoldProgram } from "./hold_instruction_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";

// ── hold_position PDA ────────────────────────────────────────────────────────

export function holdPositionPda(mint: PublicKey, tokenAccount: PublicKey): PublicKey {
  return holdPositionPdaWithBump(mint, tokenAccount)[0];
}

export function holdPositionPdaWithBump(mint: PublicKey, tokenAccount: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hold_position"), mint.toBuffer(), tokenAccount.toBuffer()],
    HOLD_PROGRAM_ID
  );
}

export async function getHoldPosition(mint: PublicKey, tokenAccount: PublicKey) {
  return await getHoldProgram().account.holdPosition.fetch(holdPositionPda(mint, tokenAccount), "confirmed");
}

export async function getHoldPositionNullable(mint: PublicKey, tokenAccount: PublicKey) {
  return await getHoldProgram().account.holdPosition.fetchNullable(holdPositionPda(mint, tokenAccount), "confirmed");
}

/** The id assigned to the next hold on this position: `holdCount + 1`, or 1 when the position does not exist yet. */
export async function nextHoldId(mint: PublicKey, tokenAccount: PublicKey): Promise<anchor.BN> {
  const position = await getHoldPositionNullable(mint, tokenAccount);
  return position ? position.holdCount.add(new anchor.BN(1)) : new anchor.BN(1);
}

// ── hold PDA ─────────────────────────────────────────────────────────────────

export function holdPda(mint: PublicKey, tokenAccount: PublicKey, holdId: anchor.BN): PublicKey {
  return holdPdaWithBump(mint, tokenAccount, holdId)[0];
}

export function holdPdaWithBump(mint: PublicKey, tokenAccount: PublicKey, holdId: anchor.BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hold"), mint.toBuffer(), tokenAccount.toBuffer(), holdId.toArrayLike(Buffer, "le", 8)],
    HOLD_PROGRAM_ID
  );
}

export async function getHold(mint: PublicKey, tokenAccount: PublicKey, holdId: anchor.BN) {
  return await getHoldProgram().account.hold.fetch(holdPda(mint, tokenAccount, holdId), "confirmed");
}

/**
 * Overwrites a `Hold` in place. `create_hold` refuses a past expiration, so the
 * only deterministic way to reach the expired branch is to plant the record
 * rather than sleep through a real expiry.
 */
export async function setHoldRecord(
  mint: PublicKey,
  tokenAccount: PublicKey,
  holdId: anchor.BN,
  fields: {
    escrow: PublicKey;
    destination?: PublicKey | null;
    initialAmount: anchor.BN;
    currentAmount: anchor.BN;
    createdAt: anchor.BN;
    expiration: anchor.BN;
    status?: { active: {} } | { expired: {} } | { closed: {} };
  }
): Promise<void> {
  const [pda, bump] = holdPdaWithBump(mint, tokenAccount, holdId);
  const data = await getHoldProgram().coder.accounts.encode("hold", {
    mint,
    tokenAccount,
    holdId,
    escrow: fields.escrow,
    destination: fields.destination ?? null,
    initialAmount: fields.initialAmount,
    currentAmount: fields.currentAmount,
    createdAt: fields.createdAt,
    expiration: fields.expiration,
    status: fields.status ?? { active: {} },
    bump,
  });
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: HOLD_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

// ── hold_authority PDA (signs the operations::hold_transfer CPI) ─────────────

export function holdAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("hold_authority"), mint.toBuffer()], HOLD_PROGRAM_ID)[0];
}

// ── __event_authority PDA (event-CPI target, see `#[event_cpi]`) ─────────────

export function holdEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], HOLD_PROGRAM_ID)[0];
}
