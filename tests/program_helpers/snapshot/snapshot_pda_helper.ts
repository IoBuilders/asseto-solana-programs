import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { SNAPSHOT_PROGRAM_ID } from "../../utils/address_utils";
import { getSnapshotProgram } from "./snapshot_instruction_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";

// ── snapshot_counter PDA ───────────────────────────────────────────────────────

export function snapshotCounterPda(mint: PublicKey): PublicKey {
  return snapshotCounterPdaWithBump(mint)[0];
}

export function snapshotCounterPdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("snapshot_counter"), mint.toBuffer()], SNAPSHOT_PROGRAM_ID);
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

/**
 * Test-only: plants the `snapshot_counter` PDA for `mint` at `count` directly via
 * surfpool, without invoking `take_snapshot` (nor the `create_coupon` CPI that
 * drives it). Activates snapshot recording at index `count`: the snapshot CPIs
 * fired by mint/burn/transfer treat an existing counter as the current snapshot
 * id and stop exiting silently.
 */
export async function setSnapshotCounter(mint: PublicKey, count: anchor.BN): Promise<void> {
  const [pda, bump] = snapshotCounterPdaWithBump(mint);
  const data = await encodeSnapshotCounter(bump, count);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: SNAPSHOT_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
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

// ── snapshot_merkle_root PDA ───────────────────────────────────────────────────

export function snapshotMerkleRootPda(mint: PublicKey, snapshotId: anchor.BN): PublicKey {
  return snapshotMerkleRootPdaWithBump(mint, snapshotId)[0];
}

export function snapshotMerkleRootPdaWithBump(mint: PublicKey, snapshotId: anchor.BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("snapshot_merkle_root"), mint.toBuffer(), snapshotId.toArrayLike(Buffer, "le", 8)],
    SNAPSHOT_PROGRAM_ID
  );
}

export async function getSnapshotMerkleRoot(mint: PublicKey, snapshotId: anchor.BN) {
  const pda = snapshotMerkleRootPda(mint, snapshotId);
  return await getSnapshotProgram().account.snapshotMerkleRoot.fetch(pda, "confirmed");
}

/**
 * Computes the snapshot id that the next `take_snapshot` call will allocate for
 * `mint` (current counter + 1, or 1 when no counter exists yet). Needed
 * client-side to derive the `snapshot_merkle_root` PDA, since its address
 * depends on the yet-to-be-incremented id.
 */
export async function nextSnapshotId(mint: PublicKey): Promise<anchor.BN> {
  let count = new anchor.BN(0);
  try {
    count = (await getSnapshotCounterByPda(snapshotCounterPda(mint))).count;
  } catch {
    count = new anchor.BN(0);
  }
  const next = count.add(new anchor.BN(1));
  // The on-chain counter is u64; when saturated the program rejects with
  // SnapshotCounterOverflow before deriving the PDA, so cap here to keep the
  // 8-byte LE seed encoding valid for the (then unused) address.
  return next.bitLength() > 64 ? count : next;
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function snapshotTriggeredEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], SNAPSHOT_PROGRAM_ID)[0];
}
