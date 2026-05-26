import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, SNAPSHOT_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteWithPayerContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Treasury } from "../../target/types/treasury";
import { couponPaidPda } from "../utils/pda_utils";
import BN from "bn.js";

function getTreasuryProgram(): Program<Treasury> {
  return anchor.workspace.Treasury as Program<Treasury>;
}

export type SetPaymentTokenContext = MintWriteWithPayerContext & {
  paymentMint: PublicKey;
};

export async function setPaymentToken(callContext: SetPaymentTokenContext): Promise<void> {
  await getTreasuryProgram()
    .methods.setPaymentToken()
    .accountsStrict({
      payer: callContext.payer ?? callContext.deployer,
      deployer: callContext.deployer,
      mint: callContext.mint,
      paymentMint: callContext.paymentMint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      treasuryConfig: pdaUtils.treasuryConfigPda(callContext.mint),
      couponCounter: pdaUtils.couponCounterPda(callContext.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export type PayCouponContext = MintWriteWithPayerContext & {
  paymentMint: PublicKey;
  treasuryTokenAccount: PublicKey;
  holderPaymentAccount: PublicKey;
  holderTokenAccount: PublicKey;
};

type PayCouponArgs = {
  couponId: anchor.BN;
};

export async function payCoupon(callContext: PayCouponContext, args: PayCouponArgs): Promise<void> {
  await getTreasuryProgram()
    .methods.payCoupon(args.couponId)
    .accountsStrict({
      payer: callContext.payer ?? callContext.deployer,
      deployer: callContext.deployer,
      mint: callContext.mint,
      paymentMint: callContext.paymentMint,
      treasuryTokenAccount: callContext.treasuryTokenAccount,
      holderPaymentAccount: callContext.holderPaymentAccount,
      holderTokenAccount: callContext.holderTokenAccount,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      treasuryConfig: pdaUtils.treasuryConfigPda(callContext.mint),
      treasuryAuthority: pdaUtils.treasuryAuthorityPda(callContext.mint),
      bondTerms: pdaUtils.bondTermsPda(callContext.mint),
      coupon: pdaUtils.couponPda(callContext.mint, args.couponId),
      holderBalanceSnapshot: pdaUtils.snapshotHolderBalancePda(callContext.mint, callContext.holderTokenAccount),
      couponPaid: pdaUtils.couponPaidPda(callContext.mint, args.couponId, callContext.holderTokenAccount),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export async function getTreasuryConfigByPda(pda: PublicKey) {
  return getTreasuryProgram().account.treasuryConfig.fetchNullable(pda);
}

export async function getCouponPaidMarker(mint: PublicKey, couponId: BN, holderTokenAccount: PublicKey) {
  const pda = couponPaidPda(mint, couponId, holderTokenAccount);
  return getTreasuryProgram().account.couponPaidMarker.fetchNullable(pda);
}
