import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";
import { ExtraAccountMeta, getExtraAccountMetas } from "@solana/spl-token";
import { Program } from "@anchor-lang/core";
import { TRANSFER_HOOK_PROGRAM_ID } from "../../utils/address_utils";
import { TransferHook } from "../../../target/types/transfer_hook";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";

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

// ── account_compliance PDA ──────────────────────────────────────────────────────────────

export type AccountCompliance = {
  mint: PublicKey;
  tokenAccount: PublicKey;
  frozenBalance: anchor.BN;
  heldAmount: anchor.BN;
  version: number;
  bump: number;
  inControlList: number;
  fullyFrozen: number;
};

// Byte offsets in the account data (8-byte discriminator + struct offset). Pinned by
// the layout tests in common/src/state/compliance.rs.
const ACCOUNT_COMPLIANCE_SPACE = 160;
const ACCOUNT_COMPLIANCE_MINT_OFFSET = 8 + 0;
const ACCOUNT_COMPLIANCE_TOKEN_ACCOUNT_OFFSET = 8 + 32;
const ACCOUNT_COMPLIANCE_FROZEN_BALANCE_OFFSET = 8 + 64;
const ACCOUNT_COMPLIANCE_VERSION_OFFSET = 8 + 80;
const ACCOUNT_COMPLIANCE_BUMP_OFFSET = 8 + 81;
const ACCOUNT_COMPLIANCE_FULLY_FROZEN_OFFSET = 8 + 83;
const COMPLIANCE_LAYOUT_VERSION = 1;

export function accountCompliancePda(mint: PublicKey, tokenAccount: PublicKey): PublicKey {
  return accountCompliancePdaWithBump(mint, tokenAccount)[0];
}

export function accountCompliancePdaWithBump(mint: PublicKey, tokenAccount: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("account_compliance"), mint.toBuffer(), tokenAccount.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID
  );
}

export async function getAccountComplianceByPda(pda: PublicKey): Promise<AccountCompliance | null> {
  return (await getTransferHookProgram().account.accountCompliance.fetchNullable(
    pda,
    "confirmed"
  )) as AccountCompliance | null;
}

export async function getAccountCompliance(
  mint: PublicKey,
  tokenAccount: PublicKey
): Promise<AccountCompliance | null> {
  return getAccountComplianceByPda(accountCompliancePda(mint, tokenAccount));
}

/**
 * Plants the freeze fields of the `(mint, tokenAccount)` record via surfpool, creating
 * the record if absent and keeping every field not in `changes` — the same effect a
 * `freeze` instruction has through `set_freeze`, without its role/functionality gates.
 */
export async function setAccountComplianceFreeze(
  mint: PublicKey,
  tokenAccount: PublicKey,
  changes: { fullyFrozen?: boolean; frozenBalance?: anchor.BN }
): Promise<void> {
  const [pda, bump] = accountCompliancePdaWithBump(mint, tokenAccount);
  const info = await anchor.getProvider().connection.getAccountInfo(pda, "confirmed");
  let data: Buffer;
  if (info) {
    data = Buffer.from(info.data);
  } else {
    data = Buffer.alloc(ACCOUNT_COMPLIANCE_SPACE);
    const discriminator = getTransferHookProgram().idl.accounts.find(
      (a) => a.name === "accountCompliance"
    )!.discriminator;
    Buffer.from(discriminator).copy(data, 0);
    mint.toBuffer().copy(data, ACCOUNT_COMPLIANCE_MINT_OFFSET);
    tokenAccount.toBuffer().copy(data, ACCOUNT_COMPLIANCE_TOKEN_ACCOUNT_OFFSET);
    data[ACCOUNT_COMPLIANCE_VERSION_OFFSET] = COMPLIANCE_LAYOUT_VERSION;
    data[ACCOUNT_COMPLIANCE_BUMP_OFFSET] = bump;
  }
  if (changes.fullyFrozen !== undefined) {
    data[ACCOUNT_COMPLIANCE_FULLY_FROZEN_OFFSET] = changes.fullyFrozen ? 1 : 0;
  }
  if (changes.frozenBalance !== undefined) {
    data.writeBigUInt64LE(BigInt(changes.frozenBalance.toString()), ACCOUNT_COMPLIANCE_FROZEN_BALANCE_OFFSET);
  }
  await surfnetSetAccount(pda, {
    lamports: info?.lamports ?? (await getBalanceForRentExeption(data.length)),
    owner: TRANSFER_HOOK_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}
