import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, SNAPSHOT_PROGRAM_ID } from "../../utils/address_utils";
import { MintWriteContext, MintWriteWithPayerContext } from "../base_helper";
import { Program } from "@anchor-lang/core";
import { Coupon } from "../../../target/types/coupon";
import { PublicKey } from "@solana/web3.js";
import { getEvent } from "../event_helper";
import { getMintOwner } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { couponAuthorityPda, couponCounterPda, couponPda, couponEventAuthorityPda } from "./coupon_pda_helper";

export function getCouponProgram(): Program<Coupon> {
  return anchor.workspace.Coupon as Program<Coupon>;
}

// ── create_coupon ──────────────────────────────────────────────────────────────

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

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

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
      deactivatePda: deactivatePda(callContext.mint),
      couponAuthority: couponAuthorityPda(callContext.mint),
      couponCounter: couponCounterPda(callContext.mint),
      coupon: couponPda(callContext.mint, effectiveArgs.couponId),
      snapshotCounter: pdaUtils.snapshotCounterPda(callContext.mint),
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      snapshotEventAuthority: pdaUtils.snapshotTriggeredEventAuthorityPda(),
      eventAuthority: couponEventAuthorityPda(),
      program: getCouponProgram().programId,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
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

/**
 * Decodes the `CouponCreatedEvent` event from a `create_coupon` transaction. The coder
 * returns the name in camelCase (`couponCreated`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getCouponCreatedEvent(signature: string) {
  return getEvent<CouponCreatedEvent>(getCouponProgram(), signature, "couponCreated");
}

// ── set_coupon_rate ────────────────────────────────────────────────────────────

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

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(context.mint);

  const signature = await getCouponProgram()
    .methods.setCouponRate(effectiveArgs.couponId, effectiveArgs.interestRate, effectiveArgs.interestRateDecimals)
    .accountsStrict({
      deployer: context.deployer,
      mint: context.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(context.mint),
      deactivatePda: deactivatePda(context.mint),
      coupon: couponPda(context.mint, effectiveArgs.couponId),
      eventAuthority: couponEventAuthorityPda(),
      program: getCouponProgram().programId,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
    })
    .signers(context?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type CouponRateSetEvent = {
  mint: PublicKey;
  couponId: anchor.BN;
  interestRateOverride: anchor.BN | null;
  interestRateOverrideDecimals: number | null;
};

/**
 * Decodes the `CouponRateSetEvent` event from a `set_coupon_rate` transaction. The coder
 * returns the name in camelCase (`couponRateSet`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getCouponRateSetEvent(signature: string) {
  return getEvent<CouponRateSetEvent>(getCouponProgram(), signature, "couponRateSet");
}
