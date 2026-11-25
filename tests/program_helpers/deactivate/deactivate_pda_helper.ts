import { PublicKey } from "@solana/web3.js";
import { DEACTIVATE_PROGRAM_ID } from "../../utils/address_utils";
import { setMintComplianceDeactivated } from "../transfer_hook/transfer_hook_pda_helper";

/**
 * Test-only: sets the hook's `MintCompliance.deactivated` flag directly via surfpool,
 * without invoking the `deactivate` program (which requires `ROLE_DEACTIVATE` and the
 * `DEACTIVATE_DEACTIVATE` functionality).
 */
export async function setDeactivated(mint: PublicKey): Promise<void> {
  await setMintComplianceDeactivated(mint, true);
}

/** Test-only: clears the hook's `MintCompliance.deactivated` flag. */
export async function clearDeactivated(mint: PublicKey): Promise<void> {
  await setMintComplianceDeactivated(mint, false);
}

// ── registry_writer PDA ────────────────────────────────────────────────────────

export function deactivateRegistryWriterPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("registry_writer")], DEACTIVATE_PROGRAM_ID)[0];
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

export function deactivateEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DEACTIVATE_PROGRAM_ID)[0];
}
