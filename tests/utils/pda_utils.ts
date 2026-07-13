import { PublicKey } from "@solana/web3.js";
import {
  DEPLOY_PROGRAM_ID,
  METADATA_UPDATE_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  TRANSFER_PROGRAM_ID,
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
// Moved to `program_helpers/mint/mint_pda_helper.ts` (per-program helper layout).

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
// Moved to `program_helpers/freeze/freeze_pda_helper.ts` (per-program helper layout).

// ── operations ─────────────────────────────────────────────────────────────────
// Moved to `program_helpers/burn/burn_pda_helper.ts` (per-program helper layout).

// ── pause ──────────────────────────────────────────────────────────────────────
// Moved to `program_helpers/pause/pause_pda_helper.ts` (per-program helper layout).

// ── deactivate ─────────────────────────────────────────────────────────────────
// Moved to `program_helpers/deactivate/deactivate_pda_helper.ts` (per-program helper layout).

// ── transfer-control ───────────────────────────────────────────────────────────
// Moved to `program_helpers/transfer_control/transfer_control_pda_helper.ts` (per-program helper layout).

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
// Moved to `program_helpers/bond/bond_pda_helper.ts` (per-program helper layout).

// ── coupon ─────────────────────────────────────────────────────────────────────
// Moved to `program_helpers/coupon/coupon_pda_helper.ts` (per-program helper layout).

// ── treasury ───────────────────────────────────────────────────────────────────
// Moved to `program_helpers/treasury/treasury_pda_helper.ts` (per-program helper layout).
