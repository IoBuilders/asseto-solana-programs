import { PublicKey } from "@solana/web3.js";
import { FACTORY_PROGRAM_ID } from "../../utils/address_utils";
import BN from "bn.js";
import { getFactoryProgram } from "./factory_instruction_helper";
import * as anchor from "@anchor-lang/core";
import { getBalanceForRentExeption, surfnetSetAccount } from "../account_helper";
import { getMintOwner } from "../deploy_helper";

// ── factory PDA ───────────────────────────────────────────────────────────────────

export async function getFactory() {
  return await getFactoryProgram().account.factory.fetch(factoryPda(), "confirmed");
}

export function factoryPda(): PublicKey {
  return factoryPdaWithBump()[0];
}

export function factoryPdaWithBump(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("factory")], FACTORY_PROGRAM_ID);
}

export async function clearFactory(): Promise<void> {
  await surfnetSetAccount(factoryPda(), { lamports: 0 });
}

export async function setFactory(manager: PublicKey, pause: boolean): Promise<void> {
  const [pda, bump] = factoryPdaWithBump();
  const data = await encodeFactory(manager, pause, bump);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FACTORY_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

async function encodeFactory(manager: PublicKey, pause: boolean, bump: number): Promise<Buffer> {
  return getFactoryProgram().coder.accounts.encode("factory", { manager, pause, bump });
}

// ── factory_pending_manager PDA ───────────────────────────────────────────────────────────────────

export async function getFactoryPendingManager(pda: PublicKey = factoryPendingManagerPda()) {
  return await getFactoryProgram().account.factoryPendingManager.fetch(pda, "confirmed");
}

export function factoryPendingManagerPda(): PublicKey {
  return factoryPendingManagerPdaWithBump()[0];
}

export function factoryPendingManagerPdaWithBump(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("factory_pending_manager")], FACTORY_PROGRAM_ID);
}

export async function clearFactoryPendingManager(): Promise<void> {
  await surfnetSetAccount(factoryPendingManagerPda(), { lamports: 0 });
}

export async function setFactoryPendingManager(pendingManager: PublicKey): Promise<void> {
  const [pda, bump] = factoryPendingManagerPdaWithBump();
  const data = await encodeFactoryPendingManager(pendingManager, bump);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FACTORY_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

async function encodeFactoryPendingManager(pendingManager: PublicKey, bump: number): Promise<Buffer> {
  return getFactoryProgram().coder.accounts.encode("factoryPendingManager", { pendingManager, bump });
}

// ── asset_class_ownership PDA ───────────────────────────────────────────────────────────────────

export async function getAssetClassOwnership(configId: anchor.BN) {
  return await getFactoryProgram().account.assetClassOwnership.fetch(assetClassOwnershipPda(configId), "confirmed");
}

export function assetClassOwnershipPda(configId: BN): PublicKey {
  return assetClassOwnershipPdaWithBump(configId)[0];
}

export function assetClassOwnershipPdaWithBump(configId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset_class_ownership"), configId.toArrayLike(Buffer, "le", 8)],
    FACTORY_PROGRAM_ID
  );
}

export function assetClassPendingOwnerPda(configId: BN): PublicKey {
  return assetClassPendingOwnerPdaWithBump(configId)[0];
}

export async function clearAssetClassOwnership(configId: anchor.BN): Promise<void> {
  await surfnetSetAccount(assetClassOwnershipPda(configId), { lamports: 0 });
}

export async function setAssetClassOwnership(
  configId: anchor.BN,
  owner: PublicKey,
  latestVersion: anchor.BN = new anchor.BN(0)
): Promise<void> {
  const [pda, bump] = assetClassOwnershipPdaWithBump(configId);
  const data = await encodeAssetClassOwnership(owner, latestVersion, bump);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FACTORY_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

async function encodeAssetClassOwnership(owner: PublicKey, latestVersion: anchor.BN, bump: number): Promise<Buffer> {
  return getFactoryProgram().coder.accounts.encode("assetClassOwnership", { owner, latestVersion, bump });
}

// ── asset_class_pending_owner PDA ───────────────────────────────────────────────────────────────────

export async function getAssetClassPendingOwner(configId: anchor.BN) {
  return await getFactoryProgram().account.assetClassPendingOwner.fetch(
    assetClassPendingOwnerPda(configId),
    "confirmed"
  );
}

export function assetClassPendingOwnerPdaWithBump(configId: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset_class_pending_owner"), configId.toArrayLike(Buffer, "le", 8)],
    FACTORY_PROGRAM_ID
  );
}

export async function clearAssetClassPendingOwner(configId: anchor.BN): Promise<void> {
  await surfnetSetAccount(assetClassPendingOwnerPda(configId), { lamports: 0 });
}

export async function setAssetClassPendingOwner(configId: anchor.BN, pendingOwner: PublicKey): Promise<void> {
  const [pda, bump] = assetClassPendingOwnerPdaWithBump(configId);
  const data = await encodeAssetClassPendingOwner(pendingOwner, bump);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FACTORY_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

async function encodeAssetClassPendingOwner(pendingOwner: PublicKey, bump: number): Promise<Buffer> {
  return getFactoryProgram().coder.accounts.encode("assetClassPendingOwner", { pendingOwner, bump });
}

// ── asset_class_version PDA ───────────────────────────────────────────────────────────────────

/** `AssetClassVersion.state` values (mirrors `STATE_DRAFT`/`STATE_FINALIZED` on-chain). */
export const ASSET_CLASS_VERSION_STATE_DRAFT = 0;
export const ASSET_CLASS_VERSION_STATE_FINALIZED = 1;

/** Global mask capacity in bits (mirrors `FUNCTIONALITIES_BITS_MASK` on-chain). */
export const FUNCTIONALITIES_BITS_MASK = 8192;
/** Number of bits packed into each mask's chunk (mirrors `FUNCTIONALITIES_MASK_CHUNK_BITS` on-chain). */
export const FUNCTIONALITIES_MASK_CHUNK_BITS = 8;
/** Global mask capacity in bytes  (mirrors `FUNCTIONALITIES_BYTES_MASK` on-chain). */
export const FUNCTIONALITIES_BYTES_MASK = FUNCTIONALITIES_BITS_MASK / FUNCTIONALITIES_MASK_CHUNK_BITS;

export async function getAssetClassVersion(configId: anchor.BN, version: anchor.BN) {
  return await getFactoryProgram().account.assetClassVersion.fetch(
    assetClassVersionPda(configId, version),
    "confirmed"
  );
}

export function assetClassVersionPda(configId: BN, version: BN): PublicKey {
  return assetClassVersionPdaWithBump(configId, version)[0];
}

export function assetClassVersionPdaWithBump(configId: BN, version: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("asset_class_version"), configId.toArrayLike(Buffer, "le", 8), version.toArrayLike(Buffer, "le", 8)],
    FACTORY_PROGRAM_ID
  );
}

export async function clearAssetClassVersion(configId: anchor.BN, version: anchor.BN): Promise<void> {
  await surfnetSetAccount(assetClassVersionPda(configId, version), { lamports: 0 });
}

export async function setAssetClassVersionForMint(
  mint: PublicKey,
  args: { state?: number; functionalities?: number[] } = {}
): Promise<void> {
  const mintOwner = await getMintOwner(mint);
  return setAssetClassVersion(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId, args);
}

export async function setAssetClassVersion(
  configId: anchor.BN,
  version: anchor.BN,
  args: { state?: number; functionalities?: number[] } = {}
): Promise<void> {
  const { state = ASSET_CLASS_VERSION_STATE_FINALIZED, functionalities = [] } = args;

  const mask = Buffer.alloc(FUNCTIONALITIES_BYTES_MASK);
  for (const f of functionalities) {
    const byte = Math.floor(f / FUNCTIONALITIES_MASK_CHUNK_BITS);
    const bit = f % FUNCTIONALITIES_MASK_CHUNK_BITS;
    mask[byte] |= 1 << bit;
  }

  const [pda, bump] = assetClassVersionPdaWithBump(configId, version);
  const data = await encodeAssetClassVersion(configId, version, bump, state, mask);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FACTORY_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

/** Derives the asset-class version PDA a mint is hooked to, from its `mint_owner`. */
export async function assetClassVersionPdaForMint(mint: PublicKey): Promise<PublicKey> {
  const mintOwner = await getMintOwner(mint);
  return assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId);
}

async function encodeAssetClassVersion(
  configId: anchor.BN,
  version: anchor.BN,
  bump: number,
  state: number,
  mask: Buffer
): Promise<Buffer> {
  // `accountDiscriminator` exists on the concrete `BorshAccountsCoder` at runtime
  // but isn't part of the public `AccountsCoder` interface `coder.accounts` is
  // typed as.
  const accounts = getFactoryProgram().coder.accounts as unknown as {
    accountDiscriminator(name: string): Buffer;
  };
  const discriminator = accounts.accountDiscriminator("assetClassVersion");

  const header = Buffer.alloc(24); // configId(8) + version(8) + state(1) + bump(1) + padding(6)
  configId.toArrayLike(Buffer, "le", 8).copy(header, 0);
  version.toArrayLike(Buffer, "le", 8).copy(header, 8);
  header.writeUInt8(state, 16);
  header.writeUInt8(bump, 17);
  // Bytes 18-23 stay zero (`_padding`).

  return Buffer.concat([discriminator, header, mask]);
}
