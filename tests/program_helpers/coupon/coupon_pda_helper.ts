import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { COUPON_PROGRAM_ID } from "../../utils/address_utils";
import { getCouponProgram } from "./coupon_instruction_helper";

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

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function couponEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], COUPON_PROGRAM_ID)[0];
}
