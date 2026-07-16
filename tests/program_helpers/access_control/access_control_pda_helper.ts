import { PublicKey } from "@solana/web3.js";
import { ACCESS_CONTROL_PROGRAM_ID } from "../../utils/address_utils";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";
import { getAccessControlProgram } from "./access_control_instruction_helper";

/** Role id for the admin role (mirrors `common::roles::ROLE_ADMIN`). */
export const ROLE_ADMIN = 0;

/** Role mask capacity in bits (mirrors `ROLES_BITS_MASK` on-chain). */
export const ROLES_BITS_MASK = 8192;
/** Bits packed into each mask byte (mirrors `common::bitmask::MASK_CHUNK_BITS`). */
export const ROLES_MASK_CHUNK_BITS = 8;
/** Role mask capacity in bytes (mirrors `ROLES_BYTES_MASK` on-chain). */
export const ROLES_BYTES_MASK = ROLES_BITS_MASK / ROLES_MASK_CHUNK_BITS;

// ── roles PDA ────────────────────────────────────────────────────────────────

/** Seeds are the raw `[mint, account]` pubkeys — no string prefix. */
export function rolesPda(mint: PublicKey, account: PublicKey): PublicKey {
  return rolesPdaWithBump(mint, account)[0];
}

export function rolesPdaWithBump(mint: PublicKey, account: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("roles"), mint.toBuffer(), account.toBuffer()],
    ACCESS_CONTROL_PROGRAM_ID
  );
}

export async function getRoles(mint: PublicKey, account: PublicKey) {
  return await getAccessControlProgram().account.roles.fetch(rolesPda(mint, account), "confirmed");
}

export async function getRolesNullable(mint: PublicKey, account: PublicKey) {
  return await getAccessControlProgram().account.roles.fetchNullable(rolesPda(mint, account), "confirmed");
}

/** Reads whether role `r` is granted in a fetched mask (`byte = r/8`, `bit = r%8`). */
export function isRoleGranted(mask: number[], r: number): boolean {
  const byte = Math.floor(r / ROLES_MASK_CHUNK_BITS);
  const bit = r % ROLES_MASK_CHUNK_BITS;
  return ((mask[byte] >> bit) & 1) === 1;
}

/** Builds a `ROLES_BYTES_MASK`-byte mask with the given role bits set to 1. */
export function buildMask(roles: number[]): Buffer {
  const mask = Buffer.alloc(ROLES_BYTES_MASK);
  for (const r of roles) {
    mask[Math.floor(r / ROLES_MASK_CHUNK_BITS)] |= 1 << r % ROLES_MASK_CHUNK_BITS;
  }
  return mask;
}

/**
 * Test-only: plants a `Roles` PDA for `(mint, account)` directly via surfpool,
 * with the given roles pre-granted. Lets a test set up the "roles already exist"
 * precondition without invoking `grant_roles`.
 */
export async function setRoles(mint: PublicKey, account: PublicKey, roles: number[]): Promise<void> {
  const [pda, bump] = rolesPdaWithBump(mint, account);
  const data = encodeRoles(bump, buildMask(roles));
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: ACCESS_CONTROL_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

function encodeRoles(bump: number, mask: Buffer): Buffer {
  // `accountDiscriminator` exists on the concrete `BorshAccountsCoder` at runtime
  // but isn't part of the public `AccountsCoder` interface `coder.accounts` is
  // typed as (same access pattern as the factory zero-copy helper).
  const accounts = getAccessControlProgram().coder.accounts as unknown as {
    accountDiscriminator(name: string): Buffer;
  };
  const discriminator = accounts.accountDiscriminator("roles");

  const header = Buffer.alloc(8); // bump(1) + _padding(7)
  header.writeUInt8(bump, 0);
  // Bytes 1-7 stay zero (`_padding`).

  return Buffer.concat([discriminator, header, mask]);
}
