import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, SNAPSHOT_PROGRAM_ID, TREASURY_PROGRAM_ID } from "../../utils/address_utils";
import { MintWriteWithPayerContext } from "../base_helper";
import { getEvent } from "../event_helper";
import { Treasury } from "../../../target/types/treasury";
import { bondTermsPda } from "../bond/bond_pda_helper";
import { couponCounterPda, couponPda } from "../coupon/coupon_pda_helper";
import { getMintOwner } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import {
  treasuryConfigPda,
  treasuryAuthorityPda,
  couponPaidPda,
  treasuryEventAuthorityPda,
} from "./treasury_pda_helper";
import { snapshotHolderBalancePda } from "../snapshot/snapshot_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";

export function getTreasuryProgram(): Program<Treasury> {
  return anchor.workspace.Treasury as Program<Treasury>;
}

// ── set_payment_token ──────────────────────────────────────────────────────────

export type SetPaymentTokenContext = MintWriteWithPayerContext & {
  paymentMint: PublicKey;
};

export async function setPaymentToken(callContext: SetPaymentTokenContext): Promise<{ signature: string }> {
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const program = getTreasuryProgram();

  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await getTreasuryProgram()
    .methods.setPaymentToken()
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority?.publicKey,
      authority: authority.publicKey,
      mint: callContext.mint,
      paymentMint: callContext.paymentMint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      treasuryConfig: treasuryConfigPda(callContext.mint),
      couponCounter: couponCounterPda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: treasuryEventAuthorityPda(),
      program: TREASURY_PROGRAM_ID,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type PaymentTokenSetEvent = {
  mint: PublicKey;
  paymentMint: PublicKey;
};

/**
 * Decodes the `PaymentTokenSet` event from a `set_payment_token` transaction.
 * The coder returns the name in camelCase (`paymentTokenSet`).
 */
export async function getPaymentTokenSetEvent(signature: string) {
  return getEvent<PaymentTokenSetEvent>(getTreasuryProgram(), signature, "paymentTokenSet");
}

// ── pay_coupon ─────────────────────────────────────────────────────────────────

export type PayCouponContext = MintWriteWithPayerContext & {
  paymentMint: PublicKey;
  treasuryTokenAccount: PublicKey;
  holderPaymentAccount: PublicKey;
  holderTokenAccount: PublicKey;
};

type PayCouponArgs = {
  couponId: anchor.BN;
};

export async function payCoupon(callContext: PayCouponContext, args: PayCouponArgs): Promise<{ signature: string }> {
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const program = getTreasuryProgram();

  const authority = callContext.authority ?? program.provider.wallet.payer;

  const signature = await getTreasuryProgram()
    .methods.payCoupon(args.couponId)
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority?.publicKey,
      authority: authority.publicKey,
      mint: callContext.mint,
      paymentMint: callContext.paymentMint,
      treasuryTokenAccount: callContext.treasuryTokenAccount,
      holderPaymentAccount: callContext.holderPaymentAccount,
      holderTokenAccount: callContext.holderTokenAccount,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      treasuryConfig: treasuryConfigPda(callContext.mint),
      treasuryAuthority: treasuryAuthorityPda(callContext.mint),
      bondTerms: bondTermsPda(callContext.mint),
      coupon: couponPda(callContext.mint, args.couponId),
      holderBalanceSnapshot: snapshotHolderBalancePda(callContext.mint, callContext.holderTokenAccount),
      couponPaid: couponPaidPda(callContext.mint, args.couponId, callContext.holderTokenAccount),
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: treasuryEventAuthorityPda(),
      program: TREASURY_PROGRAM_ID,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type CouponPaidEvent = {
  mint: PublicKey;
  couponId: anchor.BN;
  holderTokenAccount: PublicKey;
  paymentMint: PublicKey;
  amount: anchor.BN;
  payer: PublicKey;
};

/**
 * Decodes the `CouponPaid` event from a `pay_coupon` transaction. The coder
 * returns the name in camelCase (`couponPaid`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getCouponPaidEvent(signature: string) {
  return getEvent<CouponPaidEvent>(getTreasuryProgram(), signature, "couponPaid");
}
