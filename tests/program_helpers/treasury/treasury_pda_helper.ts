import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { TREASURY_PROGRAM_ID } from "../../utils/address_utils";
import { getTreasuryProgram } from "./treasury_instruction_helper";

// ── treasury_config PDA ────────────────────────────────────────────────────────

export function treasuryConfigPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury_config"), mint.toBuffer()], TREASURY_PROGRAM_ID)[0];
}

export async function getTreasuryConfigByPda(pda: PublicKey) {
  return getTreasuryProgram().account.treasuryConfig.fetchNullable(pda);
}

// ── treasury_authority PDA ─────────────────────────────────────────────────────

export function treasuryAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury_authority"), mint.toBuffer()], TREASURY_PROGRAM_ID)[0];
}

// ── coupon_paid PDA ────────────────────────────────────────────────────────────

export function couponPaidPda(mint: PublicKey, couponId: BN, holder: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("coupon_paid"), mint.toBuffer(), couponId.toArrayLike(Buffer, "le", 8), holder.toBuffer()],
    TREASURY_PROGRAM_ID
  )[0];
}

export async function getCouponPaidMarker(mint: PublicKey, couponId: BN, holder: PublicKey) {
  const pda = couponPaidPda(mint, couponId, holder);
  return getTreasuryProgram().account.couponPaidMarker.fetchNullable(pda);
}

// ── coupon_distribution PDA ────────────────────────────────────────────────────

export function couponDistributionPda(mint: PublicKey, couponId: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("coupon_distribution"), mint.toBuffer(), couponId.toArrayLike(Buffer, "le", 8)],
    TREASURY_PROGRAM_ID
  )[0];
}

export async function getCouponDistribution(mint: PublicKey, couponId: BN) {
  return getTreasuryProgram().account.couponDistribution.fetchNullable(couponDistributionPda(mint, couponId));
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function treasuryEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], TREASURY_PROGRAM_ID)[0];
}
