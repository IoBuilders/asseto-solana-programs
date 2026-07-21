import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { COUPON_PROGRAM_ID } from "../../utils/address_utils";
import { getCouponProgram } from "./coupon_instruction_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";
import { setSnapshotCounter } from "../snapshot/snapshot_pda_helper";

// ── coupon_authority PDA ───────────────────────────────────────────────────────

export function couponAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("coupon_authority"), mint.toBuffer()], COUPON_PROGRAM_ID)[0];
}

// ── coupon_counter PDA ─────────────────────────────────────────────────────────

export function couponCounterPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("coupon_counter"), mint.toBuffer()], COUPON_PROGRAM_ID)[0];
}

export async function getCouponCounter(mint: PublicKey) {
  return await getCouponCounterByPda(couponCounterPda(mint));
}

export async function getCouponCounterByPda(pda: PublicKey) {
  return await getCouponProgram().account.couponCounter.fetch(pda, "confirmed");
}

/**
 * Borsh-encodes a `CouponCounter` (8-byte discriminator + bump + count) the way
 * the program stores it on-chain. Used by tests that plant counter state
 * directly via a surfpool cheatcode.
 */
export async function encodeCouponCounter(bump: number, count: anchor.BN): Promise<Buffer> {
  return getCouponProgram().coder.accounts.encode("couponCounter", { bump, count });
}

// ── coupon PDA ─────────────────────────────────────────────────────────────────

export function couponPda(mint: PublicKey, couponId: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("coupon"), mint.toBuffer(), couponId.toArrayLike(Buffer, "le", 8)],
    COUPON_PROGRAM_ID
  )[0];
}

export async function getCoupon(mint: PublicKey, couponId: BN) {
  return getCouponByPda(couponPda(mint, couponId));
}

export async function getCouponByPda(pda: PublicKey) {
  return await getCouponProgram().account.coupon.fetch(pda, "confirmed");
}

type SetCouponArgs = {
  snapshotId?: anchor.BN;
  periodStartDate?: anchor.BN;
  periodEndDate?: anchor.BN;
  paymentDate?: anchor.BN;
  interestRateOverride?: anchor.BN | null;
  interestRateOverrideDecimals?: number | null;
};

/**
 * Test-only: plants the on-chain state a real `create_coupon` would leave, directly
 * via surfpool — without the CPI, the `COUPON_CREATE_COUPON` functionality gate, or
 * the caller's role check (mirrors `setDeactivateMarker`). Reproduces the three
 * observable effects a coupon creation has:
 *   - `coupon_counter` advanced to `couponId`,
 *   - the `coupon` PDA for `(mint, couponId)` recording `snapshotId`,
 *   - the `snapshot_counter` advanced to `snapshotId` (a coupon always takes exactly
 *     one snapshot) — so a subsequent mint/burn/transfer stops exiting silently and
 *     records balances at that id.
 *
 * `snapshotId` defaults to `couponId`: coupons and snapshots increment in lockstep
 * when every coupon takes exactly one snapshot and nothing else takes any, as in
 * these tests.
 */
export async function setCoupon(mint: PublicKey, couponId: anchor.BN, args?: SetCouponArgs): Promise<void> {
  const snapshotId = args?.snapshotId ?? couponId;

  // coupon_counter → couponId
  const [counterPda, counterBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("coupon_counter"), mint.toBuffer()],
    COUPON_PROGRAM_ID
  );
  const counterData = await encodeCouponCounter(counterBump, couponId);
  await surfnetSetAccount(counterPda, {
    lamports: await getBalanceForRentExeption(counterData.length),
    owner: COUPON_PROGRAM_ID.toBase58(),
    data: counterData.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });

  // coupon PDA for (mint, couponId)
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("coupon"), mint.toBuffer(), couponId.toArrayLike(Buffer, "le", 8)],
    COUPON_PROGRAM_ID
  );
  const couponData = await getCouponProgram().coder.accounts.encode("coupon", {
    bump,
    snapshotId,
    periodStartDate: args?.periodStartDate ?? new anchor.BN(1_700_000_000),
    periodEndDate: args?.periodEndDate ?? new anchor.BN(1_750_000_000),
    paymentDate: args?.paymentDate ?? new anchor.BN(1_800_000_000),
    interestRateOverride: args?.interestRateOverride ?? null,
    interestRateOverrideDecimals: args?.interestRateOverrideDecimals ?? null,
  });
  await surfnetSetAccount(pda, {
    lamports: await getBalanceForRentExeption(couponData.length),
    owner: COUPON_PROGRAM_ID.toBase58(),
    data: couponData.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });

  // A coupon always takes exactly one snapshot → advance the snapshot counter.
  await setSnapshotCounter(mint, snapshotId);
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function couponEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], COUPON_PROGRAM_ID)[0];
}
