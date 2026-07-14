import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { SNAPSHOT_PROGRAM_ID } from "../../utils/address_utils";
import { getSnapshotProgram } from "./snapshot_instruction_helper";

// ── snapshot_counter PDA ───────────────────────────────────────────────────────

export function snapshotCounterPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("snapshot_counter"), mint.toBuffer()], SNAPSHOT_PROGRAM_ID)[0];
}

export async function getSnapshotCounter(mint: PublicKey) {
  const pda = snapshotCounterPda(mint);
  return getSnapshotCounterByPda(pda);
}

export async function getSnapshotCounterByPda(pda: PublicKey) {
  return await getSnapshotProgram().account.snapshotCounter.fetch(pda, "confirmed");
}

/**
 * Borsh-encodes a `SnapshotCounter` (8-byte discriminator + bump + count) the
 * way the program stores it on-chain. Used by tests that plant counter state
 * directly via a surfpool cheatcode.
 */
export async function encodeSnapshotCounter(bump: number, count: anchor.BN): Promise<Buffer> {
  return getSnapshotProgram().coder.accounts.encode("snapshotCounter", { bump, count });
}

// ── snapshot_totalsupply PDA ───────────────────────────────────────────────────

export function snapshotTotalSupplyPda(mint: PublicKey): PublicKey {
  return snapshotTotalSupplyPdaWithBump(mint)[0];
}

export function snapshotTotalSupplyPdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("snapshot_totalsupply"), mint.toBuffer()], SNAPSHOT_PROGRAM_ID);
}

// ── snapshot_holderbalance PDA ─────────────────────────────────────────────────

export function snapshotHolderBalancePda(mint: PublicKey, tokenAccount: PublicKey): PublicKey {
  return snapshotHolderBalancePdaWithBump(mint, tokenAccount)[0];
}

export function snapshotHolderBalancePdaWithBump(mint: PublicKey, tokenAccount: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("snapshot_holderbalance"), mint.toBuffer(), tokenAccount.toBuffer()],
    SNAPSHOT_PROGRAM_ID
  );
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function snapshotTriggeredEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], SNAPSHOT_PROGRAM_ID)[0];
}
