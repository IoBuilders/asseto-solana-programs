import { PublicKey } from "@solana/web3.js";
import { PAUSE_PROGRAM_ID } from "../../utils/address_utils";

// ── pausable_authority PDA ──────────────────────────────────────────────────────────────

export function pausableAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pausable_authority"), mint.toBuffer()], PAUSE_PROGRAM_ID)[0];
}

// ── __event_authority PDA ─────────────────────────────────────────────────────────────

export function pauseEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PAUSE_PROGRAM_ID)[0];
}
