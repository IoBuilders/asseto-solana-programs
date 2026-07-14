import { PublicKey } from "@solana/web3.js";
import { MINT_PROGRAM_ID } from "../../utils/address_utils";

// ── mint_authority PDA ─────────────────────────────────────────────────────────

export function mintAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("mint_authority"), mint.toBuffer()], MINT_PROGRAM_ID)[0];
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function mintEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], MINT_PROGRAM_ID)[0];
}
