import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { CAP_PROGRAM_ID } from "../../utils/address_utils";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";
import { getCapProgram } from "./cap_instruction_helper";

// ── max_supply PDA ──────────────────────────────────────────────────────────

export function maxSupplyPda(mint: PublicKey): PublicKey {
  return maxSupplyPdaWithBump(mint)[0];
}

export function maxSupplyPdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("max_supply"), mint.toBuffer()], CAP_PROGRAM_ID);
}

export async function getMaxSupply(mint: PublicKey) {
  return await getCapProgram().account.maxSupply.fetch(maxSupplyPda(mint), "confirmed");
}

export async function getMaxSupplyNullable(mint: PublicKey) {
  return await getCapProgram().account.maxSupply.fetchNullable(maxSupplyPda(mint), "confirmed");
}

/**
 * Test-only: plants the `max_supply` PDA for `mint` directly via surfpool, with
 * the given cap already stored. Lets a test set up the "a cap is already set"
 * precondition without invoking `set_max_supply` first.
 */
export async function setMaxSupplyPda(mint: PublicKey, maxSupply: anchor.BN): Promise<void> {
  const [pda, bump] = maxSupplyPdaWithBump(mint);
  const data = await getCapProgram().coder.accounts.encode("maxSupply", { bump, maxSupply });
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: CAP_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

// ── __event_authority PDA ──────────────────────────────────────────────────────

/** Anchor event-CPI authority for the cap program (seed "__event_authority"). */
export function capEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], CAP_PROGRAM_ID)[0];
}
