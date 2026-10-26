import { PublicKey } from "@solana/web3.js";
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
