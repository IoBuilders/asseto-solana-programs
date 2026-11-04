import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { ExtraAccountMeta, getExtraAccountMetas } from "@solana/spl-token";
import { TRANSFER_HOOK_PROGRAM_ID } from "../../utils/address_utils";

// ── transfer_hook_authority PDA ─────────────────────────────────────────────────────────

export function transferHookAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("transfer_hook_authority"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  )[0];
}

// ── extra-account-metas PDA ─────────────────────────────────────────────────────────────

export function extraAccountMetaListPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  )[0];
}

// ── extra-account-metas contents (test-only) ────────────────────────────────────────────

/** Decodes the mint's ExtraAccountMetaList into its entries, in metalist order. */
export async function getExtraAccountMetaEntries(mint: PublicKey): Promise<ExtraAccountMeta[]> {
  const info = await anchor.getProvider().connection.getAccountInfo(extraAccountMetaListPda(mint), "confirmed");
  if (!info) {
    throw new Error(`ExtraAccountMetaList not found for mint ${mint.toBase58()}`);
  }
  return getExtraAccountMetas(info);
}
