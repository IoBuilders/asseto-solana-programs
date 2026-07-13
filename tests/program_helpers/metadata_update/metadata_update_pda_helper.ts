import { PublicKey } from "@solana/web3.js";
import { METADATA_UPDATE_PROGRAM_ID } from "../../utils/address_utils";

// ── metadata_update_authority PDA ──────────────────────────────────────────────

export function metadataUpdateAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata_update_authority"), mint.toBuffer()],
    METADATA_UPDATE_PROGRAM_ID
  )[0];
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function metadataUpdateEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], METADATA_UPDATE_PROGRAM_ID)[0];
}
