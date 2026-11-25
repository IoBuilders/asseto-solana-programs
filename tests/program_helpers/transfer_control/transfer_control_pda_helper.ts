import { PublicKey } from "@solana/web3.js";
import { TRANSFER_CONTROL_PROGRAM_ID } from "../../utils/address_utils";
import {
  getAccountCompliance,
  getMintCompliance,
  setAccountComplianceFields,
  setMintComplianceTransferMode,
  TRANSFER_MODE_BLACKLIST,
  TRANSFER_MODE_WHITELIST,
} from "../transfer_hook/transfer_hook_pda_helper";

export {
  TRANSFER_MODE_NONE,
  TRANSFER_MODE_WHITELIST,
  TRANSFER_MODE_BLACKLIST,
} from "../transfer_hook/transfer_hook_pda_helper";

// ── transfer mode (MintCompliance.transfer_mode) ──────────────────────────────

/** The `MintCompliance.transfer_mode` encoding of the program's `TransferMode` enum arg. */
export function transferModeValue(mode: { whitelist?: object; blacklist?: object }): number {
  return mode.whitelist !== undefined ? TRANSFER_MODE_WHITELIST : TRANSFER_MODE_BLACKLIST;
}

export async function getTransferMode(mint: PublicKey): Promise<number> {
  return (await getMintCompliance(mint))!.transferMode;
}

/** Test-only: sets the mint's transfer mode via surfpool, without `initialize`'s gates. */
export async function setTransferControlModeMarker(
  mint: PublicKey,
  mode: { whitelist?: object; blacklist?: object }
): Promise<void> {
  await setMintComplianceTransferMode(mint, transferModeValue(mode));
}

// ── control-list membership (AccountCompliance.in_control_list) ───────────────

export async function isInControlList(mint: PublicKey, account: PublicKey): Promise<boolean> {
  return ((await getAccountCompliance(mint, account))?.inControlList ?? 0) !== 0;
}

/** Test-only: puts `account` in the control list via surfpool, without `add_to_control_list`'s gates. */
export async function setControlListMarker(mint: PublicKey, account: PublicKey): Promise<void> {
  await setAccountComplianceFields(mint, account, { inControlList: true });
}

// ── registry_writer PDA ───────────────────────────────────────────────────────

export function transferControlRegistryWriterPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("registry_writer")], TRANSFER_CONTROL_PROGRAM_ID)[0];
}

// ── __event_authority PDA ─────────────────────────────────────────────────────

export function transferControlEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], TRANSFER_CONTROL_PROGRAM_ID)[0];
}
