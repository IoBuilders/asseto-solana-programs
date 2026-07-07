import * as pdaUtils from "../utils/pda_utils";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, SNAPSHOT_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteContext, MintWriteWithPayerContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Coupon } from "../../target/types/coupon";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { getEvent } from "./event_helper";

function getCouponProgram(): Program<Coupon> {
  return anchor.workspace.Coupon as Program<Coupon>;
}

type CreateCouponArgs = {
  couponId?: anchor.BN;
  periodStartDate?: anchor.BN;
  periodEndDate?: anchor.BN;
  paymentDate?: anchor.BN;
  interestRateOverride?: anchor.BN | null;
  interestRateOverrideDecimals?: number | null;
};

function getDefaultCreateCouponArgs(): Required<CreateCouponArgs> {
  return {
    couponId: new anchor.BN(1),
    periodStartDate: new anchor.BN(1_700_000_000),
    periodEndDate: new anchor.BN(1_750_000_000),
    paymentDate: new anchor.BN(1_800_000_000),
    interestRateOverride: null,
    interestRateOverrideDecimals: null,
  };
}

export async function createCoupon(
  callContext: MintWriteWithPayerContext,
  args?: CreateCouponArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<CreateCouponArgs> = {
    ...getDefaultCreateCouponArgs(),
    ...args,
  };

  const signature = await getCouponProgram()
    .methods.createCoupon(
      effectiveArgs.periodStartDate,
      effectiveArgs.periodEndDate,
      effectiveArgs.paymentDate,
      effectiveArgs.couponId,
      effectiveArgs.interestRateOverride,
      effectiveArgs.interestRateOverrideDecimals
    )
    .accountsStrict({
      payer: callContext.payer ?? callContext.deployer,
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      couponAuthority: pdaUtils.couponAuthorityPda(callContext.mint),
      couponCounter: pdaUtils.couponCounterPda(callContext.mint),
      coupon: pdaUtils.couponPda(callContext.mint, effectiveArgs.couponId),
      snapshotCounter: pdaUtils.snapshotCounterPda(callContext.mint),
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      snapshotEventAuthority: pdaUtils.snapshotTriggeredEventAuthorityPda(),
      eventAuthority: pdaUtils.couponEventAuthorityPda(),
      program: getCouponProgram().programId,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type SetCouponRateArgs = {
  couponId?: anchor.BN;
  interestRate?: anchor.BN | null;
  interestRateDecimals?: number | null;
};

function getDefaultSetCouponRateArgs(): Required<SetCouponRateArgs> {
  return {
    couponId: new anchor.BN(1),
    interestRate: null,
    interestRateDecimals: null,
  };
}

export async function setCouponRate(
  context: MintWriteContext,
  args?: SetCouponRateArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<SetCouponRateArgs> = {
    ...getDefaultSetCouponRateArgs(),
    ...args,
  };

  const signature = await getCouponProgram()
    .methods.setCouponRate(effectiveArgs.couponId, effectiveArgs.interestRate, effectiveArgs.interestRateDecimals)
    .accountsStrict({
      deployer: context.deployer,
      mint: context.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(context.mint),
      deactivatePda: pdaUtils.deactivatePda(context.mint),
      coupon: pdaUtils.couponPda(context.mint, effectiveArgs.couponId),
      eventAuthority: pdaUtils.couponEventAuthorityPda(),
      program: getCouponProgram().programId,
    })
    .signers(context?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export async function getCoupon(mint: PublicKey, couponId: BN) {
  return getCouponByPda(pdaUtils.couponPda(mint, couponId));
}

export async function getCouponByPda(pda: PublicKey) {
  return await getCouponProgram().account.coupon.fetch(pda, "confirmed");
}

export async function getCouponCounter(mint: PublicKey) {
  return await getCouponCounterByPda(pdaUtils.couponCounterPda(mint));
}

/**
 * Borsh-encodes a `CouponCounter` (8-byte discriminator + bump + count) the way
 * the program stores it on-chain. Used by tests that plant counter state
 * directly via a surfpool cheatcode.
 */
export async function encodeCouponCounter(bump: number, count: anchor.BN): Promise<Buffer> {
  return getCouponProgram().coder.accounts.encode("couponCounter", { bump, count });
}

export async function getCouponCounterByPda(pda: PublicKey) {
  return await getCouponProgram().account.couponCounter.fetch(pda, "confirmed");
}

type CouponCreatedEvent = {
  mint: PublicKey;
  couponId: anchor.BN;
  periodStartDate: anchor.BN;
  periodEndDate: anchor.BN;
  paymentDate: anchor.BN;
  interestRateOverride: anchor.BN | null;
  interestRateOverrideDecimals: number | null;
};

type CouponRateSetEvent = {
  mint: PublicKey;
  couponId: anchor.BN;
  interestRateOverride: anchor.BN | null;
  interestRateOverrideDecimals: number | null;
};

/**
 * Decodes the `CouponCreatedEvent` event from a `create_coupon` transaction. The coder
 * returns the name in camelCase (`couponCreated`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getCouponCreatedEvent(signature: string) {
  return getEvent<CouponCreatedEvent>(getCouponProgram(), signature, "couponCreated");
}

/**
 * Decodes the `CouponRateSetEvent` event from a `set_coupon_rate` transaction. The coder
 * returns the name in camelCase (`couponRateSet`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getCouponRateSetEvent(signature: string) {
  return getEvent<CouponRateSetEvent>(getCouponProgram(), signature, "couponRateSet");
}
