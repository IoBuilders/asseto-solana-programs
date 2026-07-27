import { PublicKey } from "@solana/web3.js";
import { OPERATIONS_PROGRAM_ID } from "../../utils/address_utils";

// ── permanent_delegate PDA ─────────────────────────────────────────────────────────────

export function permanentDelegatePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("permanent_delegate"), mint.toBuffer()],
    OPERATIONS_PROGRAM_ID
  )[0];
}

// ── __event_authority PDA ─────────────────────────────────────────────────────────────

export function operationsEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], OPERATIONS_PROGRAM_ID)[0];
}
