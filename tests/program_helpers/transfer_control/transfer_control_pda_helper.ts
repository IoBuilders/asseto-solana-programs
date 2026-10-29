import { PublicKey } from "@solana/web3.js";
import { TRANSFER_CONTROL_PROGRAM_ID } from "../../utils/address_utils";
import { getTransferControlProgram } from "./transfer_control_instruction_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";

// ── transfer_control_mode PDA ─────────────────────────────────────────────────

export function transferControlModePda(mint: PublicKey): PublicKey {
  return transferControlModePdaWithBump(mint)[0];
}

export function transferControlModePdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("transfer_control_mode"), mint.toBuffer()],
    TRANSFER_CONTROL_PROGRAM_ID
  );
}

export async function getTransferControlModeByPda(pda: PublicKey) {
  return await getTransferControlProgram().account.transferControlMode.fetchNullable(pda, "confirmed");
}

export async function setTransferControlModeMarker(mint: PublicKey, mode: any): Promise<void> {
  const [pda, bump] = transferControlModePdaWithBump(mint);
  const data = await getTransferControlProgram().coder.accounts.encode("transferControlMode", { mode, bump });
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: TRANSFER_CONTROL_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

// ── control-list PDA ──────────────────────────────────────────────────────────────

export function controlListPda(mint: PublicKey, account: PublicKey): PublicKey {
  return controlListPdaWithBump(mint, account)[0];
}

export function controlListPdaWithBump(mint: PublicKey, account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("control_list"), mint.toBuffer(), account.toBuffer()],
    TRANSFER_CONTROL_PROGRAM_ID
  );
}

export async function getControlListStatusByPda(pda: PublicKey) {
  return await getTransferControlProgram().account.controlListStatus.fetchNullable(pda, "confirmed");
}

export async function setControlListMarker(mint: PublicKey, account: PublicKey): Promise<void> {
  const [pda, bump] = controlListPdaWithBump(mint, account);
  const data = await getTransferControlProgram().coder.accounts.encode("controlListStatus", { bump });
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: TRANSFER_CONTROL_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

// ── __event_authority PDA ─────────────────────────────────────────────────────

export function transferControlEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], TRANSFER_CONTROL_PROGRAM_ID)[0];
}
