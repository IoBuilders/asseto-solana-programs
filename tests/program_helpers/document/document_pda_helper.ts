import { PublicKey } from "@solana/web3.js";
import { DOCUMENT_PROGRAM_ID } from "../../utils/address_utils";
import { getDocumentProgram } from "./document_instruction_helper";

/** Right-pads a UTF-8 name to the on-chain `[u8; 32]` width. */
export function nameToBytes(name: string): number[] {
  const buf = Buffer.alloc(32);
  const written = buf.write(name, "utf-8");
  if (written < Buffer.byteLength(name, "utf-8")) {
    throw new Error(`name "${name}" does not fit in 32 bytes`);
  }
  return Array.from(buf);
}

// ── document PDA ─────────────────────────────────────────────────────────────

export function documentPda(mint: PublicKey, name: number[]): PublicKey {
  return documentPdaWithBump(mint, name)[0];
}

export function documentPdaWithBump(mint: PublicKey, name: number[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("document"), mint.toBuffer(), Buffer.from(name)],
    DOCUMENT_PROGRAM_ID
  );
}

export async function getDocument(mint: PublicKey, name: number[]) {
  return await getDocumentProgram().account.document.fetch(documentPda(mint, name), "confirmed");
}

export async function getDocumentNullable(mint: PublicKey, name: number[]) {
  return await getDocumentProgram().account.document.fetchNullable(documentPda(mint, name), "confirmed");
}

// ── __event_authority PDA (event-CPI target, see `#[event_cpi]`) ─────────────

export function documentEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DOCUMENT_PROGRAM_ID)[0];
}
