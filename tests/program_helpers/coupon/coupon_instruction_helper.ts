import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, SNAPSHOT_PROGRAM_ID } from "../../utils/address_utils";
import { MintWriteContext, MintWriteWithPayerContext } from "../base_helper";
import { Program } from "@anchor-lang/core";
import { Coupon } from "../../../target/types/coupon";
import { PublicKey } from "@solana/web3.js";
import { getEvent } from "../event_helper";
import { getAssetConfiguration } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { couponAuthorityPda, couponCounterPda, couponPda, couponEventAuthorityPda } from "./coupon_pda_helper";
import {
  snapshotCounterPda,
  snapshotMerkleRootPda,
  snapshotTriggeredEventAuthorityPda,
  nextSnapshotId,
} from "../snapshot/snapshot_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";

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
  merkleRoot?: number[];
};

function getDefaultCreateCouponArgs(): Required<CreateCouponArgs> {
  return {
    couponId: new anchor.BN(1),
    periodStartDate: new anchor.BN(1_700_000_000),
    periodEndDate: new anchor.BN(1_750_000_000),
    paymentDate: new anchor.BN(1_800_000_000),
    interestRateOverride: null,
    interestRateOverrideDecimals: null,
    merkleRoot: new Array(32).fill(0),
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

  const program = getCouponProgram();

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const authority = callContext.authority ?? program.provider.wallet.payer;

  // `take_snapshot` (CPI'd inside create_coupon) creates the merkle-root PDA for
  // the id the snapshot counter is about to allocate — compute it here to derive
  // the account address the CPI expects.
  const snapshotId = await nextSnapshotId(callContext.mint);

  const signature = await getCouponProgram()
    .methods.createCoupon(
      effectiveArgs.periodStartDate,
      effectiveArgs.periodEndDate,
      effectiveArgs.paymentDate,
      effectiveArgs.couponId,
      effectiveArgs.interestRateOverride,
      effectiveArgs.interestRateOverrideDecimals,
      effectiveArgs.merkleRoot
    )
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: authority.publicKey,
      mint: callContext.mint,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      couponAuthority: couponAuthorityPda(callContext.mint),
      couponCounter: couponCounterPda(callContext.mint),
      coupon: couponPda(callContext.mint, effectiveArgs.couponId),
      snapshotCounter: snapshotCounterPda(callContext.mint),
      snapshotMerkleRoot: snapshotMerkleRootPda(callContext.mint, snapshotId),
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      snapshotEventAuthority: snapshotTriggeredEventAuthorityPda(),
      eventAuthority: couponEventAuthorityPda(),
      program: getCouponProgram().programId,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
    })
    .signers(callContext?.signers ?? [authority])
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

  const program = getCouponProgram();

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(context.mint);

  const authority = context.authority ?? program.provider.wallet.payer;

  const signature = await getCouponProgram()
    .methods.setCouponRate(effectiveArgs.couponId, effectiveArgs.interestRate, effectiveArgs.interestRateDecimals)
    .accountsStrict({
      authority: authority.publicKey,
      mint: context.mint,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(context.mint),
      deactivatePda: deactivatePda(context.mint),
      coupon: couponPda(context.mint, effectiveArgs.couponId),
      eventAuthority: couponEventAuthorityPda(),
      program: getCouponProgram().programId,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      authorityRolesPda: rolesPda(context.mint, authority.publicKey),
    })
    .signers(context?.signers ?? [authority])
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
