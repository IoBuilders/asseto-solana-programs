import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { ExtraAccountMeta, getExtraAccountMetas } from "@solana/spl-token";
import { Program } from "@anchor-lang/core";
import { TRANSFER_HOOK_PROGRAM_ID } from "../../utils/address_utils";
import { TransferHook } from "../../../target/types/transfer_hook";
import { surfnetSetAccount } from "../account_helper";

function getTransferHookProgram(): Program<TransferHook> {
  return anchor.workspace.TransferHook as Program<TransferHook>;
}

// ── transfer_hook_authority PDA ─────────────────────────────────────────────────────────

export function transferHookAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("transfer_hook_authority"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  )[0];
}

// ── extra-account-metas PDA ─────────────────────────────────────────────────────────────

export function extraAccountMetaListPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  )[0];
}

// ── extra-account-metas contents (test-only) ────────────────────────────────────────────

/** Decodes the mint's ExtraAccountMetaList into its entries, in metalist order. */
export async function getExtraAccountMetaEntries(mint: PublicKey): Promise<ExtraAccountMeta[]> {
  const info = await anchor.getProvider().connection.getAccountInfo(extraAccountMetaListPda(mint), "confirmed");
  if (!info) {
    throw new Error(`ExtraAccountMetaList not found for mint ${mint.toBase58()}`);
  }
  return getExtraAccountMetas(info);
}

// ── mint_compliance PDA ─────────────────────────────────────────────────────────────────

export type MintCompliance = {
  mint: PublicKey;
  version: number;
  bump: number;
  deactivated: number;
  transferMode: number;
  transferHookExecuteEnabled: number;
};

// Byte offsets in the account data (8-byte discriminator + struct offset). Pinned by
// the layout tests in common/src/state/compliance.rs.
const MINT_COMPLIANCE_DEACTIVATED_OFFSET = 8 + 34;
const MINT_COMPLIANCE_TRANSFER_HOOK_EXECUTE_OFFSET = 8 + 36;

export function mintCompliancePda(mint: PublicKey): PublicKey {
  return mintCompliancePdaWithBump(mint)[0];
}

export function mintCompliancePdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("mint_compliance"), mint.toBuffer()], TRANSFER_HOOK_PROGRAM_ID);
}

export async function getMintCompliance(mint: PublicKey): Promise<MintCompliance | null> {
  return (await getTransferHookProgram().account.mintCompliance.fetchNullable(
    mintCompliancePda(mint),
    "confirmed"
  )) as MintCompliance | null;
}

/**
 * Overwrites the record's copy of the `TRANSFER_HOOK_EXECUTE` bit via surfpool. On
 * chain the copy is taken once at `deploy_mint` and never changes; tests that swap a
 * mint's asset-class version after deploying use this to keep the copy in step.
 */
export async function setMintComplianceTransferHookExecute(mint: PublicKey, enabled: boolean): Promise<void> {
  await setMintComplianceFlag(mint, MINT_COMPLIANCE_TRANSFER_HOOK_EXECUTE_OFFSET, enabled);
}

/** Overwrites the record's `deactivated` flag via surfpool (the flag `execute` reads). */
export async function setMintComplianceDeactivated(mint: PublicKey, deactivated: boolean): Promise<void> {
  await setMintComplianceFlag(mint, MINT_COMPLIANCE_DEACTIVATED_OFFSET, deactivated);
}

async function setMintComplianceFlag(mint: PublicKey, offset: number, value: boolean): Promise<void> {
  const pda = mintCompliancePda(mint);
  const info = await anchor.getProvider().connection.getAccountInfo(pda, "confirmed");
  if (!info) {
    throw new Error(`MintCompliance not found for mint ${mint.toBase58()}`);
  }
  const data = Buffer.from(info.data);
  data[offset] = value ? 1 : 0;
  await surfnetSetAccount(pda, {
    lamports: info.lamports,
    owner: info.owner.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}
