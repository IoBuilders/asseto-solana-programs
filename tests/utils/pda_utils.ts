import { PublicKey } from "@solana/web3.js";
import { DEPLOY_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID, TRANSFER_PROGRAM_ID } from "./address_utils";

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

export function deployEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DEPLOY_PROGRAM_ID)[0];
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
