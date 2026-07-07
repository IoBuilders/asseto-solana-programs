import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  BOND_PROGRAM_ID,
  COUPON_PROGRAM_ID,
  DEACTIVATE_PROGRAM_ID,
  DEPLOY_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  METADATA_UPDATE_PROGRAM_ID,
  MINT_PROGRAM_ID,
  OPERATIONS_PROGRAM_ID,
  PAUSE_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  TRANSFER_CONTROL_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  TRANSFER_PROGRAM_ID,
  TREASURY_PROGRAM_ID,
} from "./address_utils";

// ── deploy ─────────────────────────────────────────────────────────────────────

export function mintOwnerPda(mint: PublicKey): PublicKey {
  return mintOwnerPdaWithBump(mint)[0];
}

export function mintOwnerPdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("mint_owner"), mint.toBuffer()], DEPLOY_PROGRAM_ID);
}

export function tempMintAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("temp_mint_authority"), mint.toBuffer()], DEPLOY_PROGRAM_ID)[0];
}

// Anchor event-CPI authority for the deploy program (seed "__event_authority").
export function deployEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DEPLOY_PROGRAM_ID)[0];
}

// ── mint ───────────────────────────────────────────────────────────────────────

export function mintAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("mint_authority"), mint.toBuffer()], MINT_PROGRAM_ID)[0];
}

export function mintEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], MINT_PROGRAM_ID)[0];
}

// ── metadata-update ────────────────────────────────────────────────────────────

export function metadataUpdateAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata_update_authority"), mint.toBuffer()],
    METADATA_UPDATE_PROGRAM_ID
  )[0];
}

export function metadataUpdateEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], METADATA_UPDATE_PROGRAM_ID)[0];
}

// ── freeze ─────────────────────────────────────────────────────────────────────

export function freezeAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("freeze_authority"), mint.toBuffer()], FREEZE_PROGRAM_ID)[0];
}

export function frozenAccountPda(mint: PublicKey, account: PublicKey): PublicKey {
  return frozenAccountPdaWithBump(mint, account)[0];
}

export function frozenAccountPdaWithBump(mint: PublicKey, account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("frozen_account"), mint.toBuffer(), account.toBuffer()],
    FREEZE_PROGRAM_ID
  );
}

export function frozenBalancePda(mint: PublicKey, account: PublicKey): PublicKey {
  return frozenBalancePdaWithBump(mint, account)[0];
}

export function frozenBalancePdaWithBump(mint: PublicKey, account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("frozen_balance"), mint.toBuffer(), account.toBuffer()],
    FREEZE_PROGRAM_ID
  );
}

// Anchor event-CPI authority for the freeze program (seed "__event_authority").
export function freezeEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], FREEZE_PROGRAM_ID)[0];
}

// ── operations ─────────────────────────────────────────────────────────────────

export function permanentDelegatePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("permanent_delegate"), mint.toBuffer()],
    OPERATIONS_PROGRAM_ID
  )[0];
}

// Anchor event-CPI authority for the operations program (seed "__event_authority").
export function operationsEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], OPERATIONS_PROGRAM_ID)[0];
}

// ── pause ──────────────────────────────────────────────────────────────────────

export function pausableAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pausable_authority"), mint.toBuffer()], PAUSE_PROGRAM_ID)[0];
}

// Anchor event-CPI authority for the pause program (seed "__event_authority").
export function pauseEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PAUSE_PROGRAM_ID)[0];
}

// ── deactivate ─────────────────────────────────────────────────────────────────

export function deactivatePda(mint: PublicKey): PublicKey {
  return deactivatePdaWithBump(mint)[0];
}

export function deactivatePdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("deactivate"), mint.toBuffer()], DEACTIVATE_PROGRAM_ID);
}

// Anchor event-CPI authority for the deactivate program (seed "__event_authority").
export function deactivateEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DEACTIVATE_PROGRAM_ID)[0];
}

// ── transfer-control ───────────────────────────────────────────────────────────

export function transferControlModePda(mint: PublicKey): PublicKey {
  return transferControlModePdaWithBump(mint)[0];
}

export function transferControlModePdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("transfer_control_mode"), mint.toBuffer()],
    TRANSFER_CONTROL_PROGRAM_ID
  );
}

export function whitelistPda(mint: PublicKey, account: PublicKey): PublicKey {
  return whitelistPdaWithBump(mint, account)[0];
}

export function whitelistPdaWithBump(mint: PublicKey, account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), mint.toBuffer(), account.toBuffer()],
    TRANSFER_CONTROL_PROGRAM_ID
  );
}

// ── transfer ───────────────────────────────────────────────────────────────────

export function transferAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("transfer"), mint.toBuffer()], TRANSFER_PROGRAM_ID)[0];
}

// ── transfer-hook ──────────────────────────────────────────────────────────────

export function transferHookAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("transfer_hook_authority"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  )[0];
}

export function extraAccountMetaListPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  )[0];
}

// ── snapshot ───────────────────────────────────────────────────────────────────

export function snapshotCounterPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("snapshot_counter"), mint.toBuffer()], SNAPSHOT_PROGRAM_ID)[0];
}

export function snapshotTotalSupplyPda(mint: PublicKey): PublicKey {
  return snapshotTotalSupplyPdaWithBump(mint)[0];
}

export function snapshotTotalSupplyPdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("snapshot_totalsupply"), mint.toBuffer()], SNAPSHOT_PROGRAM_ID);
}

export function snapshotHolderBalancePda(mint: PublicKey, tokenAccount: PublicKey): PublicKey {
  return snapshotHolderBalancePdaWithBump(mint, tokenAccount)[0];
}

export function snapshotHolderBalancePdaWithBump(mint: PublicKey, tokenAccount: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("snapshot_holderbalance"), mint.toBuffer(), tokenAccount.toBuffer()],
    SNAPSHOT_PROGRAM_ID
  );
}

// Anchor event-CPI authority for the snapshot program (seed "__event_authority").
export function snapshotTriggeredEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], SNAPSHOT_PROGRAM_ID)[0];
}

// ── bond ───────────────────────────────────────────────────────────────────────

export function bondTermsPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bond_terms"), mint.toBuffer()], BOND_PROGRAM_ID)[0];
}

// Anchor event-CPI authority for the bond program (seed "__event_authority").
export function bondEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], BOND_PROGRAM_ID)[0];
}

// ── coupon ─────────────────────────────────────────────────────────────────────

export function couponAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("coupon_authority"), mint.toBuffer()], COUPON_PROGRAM_ID)[0];
}

export function couponCounterPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("coupon_counter"), mint.toBuffer()], COUPON_PROGRAM_ID)[0];
}

export function couponPda(mint: PublicKey, couponId: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("coupon"), mint.toBuffer(), couponId.toArrayLike(Buffer, "le", 8)],
    COUPON_PROGRAM_ID
  )[0];
}

// ── treasury ───────────────────────────────────────────────────────────────────

export function treasuryConfigPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury_config"), mint.toBuffer()], TREASURY_PROGRAM_ID)[0];
}

export function treasuryAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury_authority"), mint.toBuffer()], TREASURY_PROGRAM_ID)[0];
}

export function couponPaidPda(mint: PublicKey, couponId: BN, holderTokenAccount: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("coupon_paid"), mint.toBuffer(), couponId.toArrayLike(Buffer, "le", 8), holderTokenAccount.toBuffer()],
    TREASURY_PROGRAM_ID
  )[0];
}
