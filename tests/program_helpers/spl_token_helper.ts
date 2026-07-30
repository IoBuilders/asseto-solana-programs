import { Keypair, PublicKey, Signer, Transaction } from "@solana/web3.js";
import {
  Account,
  createAccount,
  createBurnInstruction,
  createMint as splCreateMint,
  getAccount,
  getMint as splGetMint,
  mintTo as splMintTo,
  Mint,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getTokenMetadata as splGetTokenMetadata,
} from "@solana/spl-token";
import { AnchorProvider } from "@anchor-lang/core";
import * as anchor from "@anchor-lang/core";
import type { TokenMetadata } from "@solana/spl-token-metadata";
import { getAccountInfo, surfnetSetAccount } from "./account_helper";

function getProvider(): AnchorProvider {
  return anchor.getProvider() as AnchorProvider;
}

export type CreateTokenAccountArgs = {
  mint: PublicKey;
  owner: PublicKey;
  payer?: Signer;
  destination?: Keypair;
};

export async function createTokenAccount(args: CreateTokenAccountArgs): Promise<PublicKey> {
  const provider = getProvider();
  const destination = args.destination ?? null;

  return createAccount(
    provider.connection,
    args.payer ?? provider.wallet.payer,
    args.mint,
    args.owner,
    destination,
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
}

export async function getTokenAccount(address: PublicKey): Promise<Account> {
  return getAccount(getProvider().connection, address, "confirmed", TOKEN_2022_PROGRAM_ID);
}

export async function getMint(mint: PublicKey): Promise<Mint> {
  return splGetMint(getProvider().connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
}

export async function getTokenMetadata(mint: PublicKey): Promise<TokenMetadata | null> {
  return splGetTokenMetadata(getProvider().connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
}

export type CreateMintArgs = {
  payer?: Signer;
  mintAuthority?: PublicKey;
  decimals?: number;
  destination?: Keypair;
};

export async function createMint(args?: CreateMintArgs): Promise<PublicKey> {
  const provider = getProvider();
  return splCreateMint(
    provider.connection,
    args?.payer ?? provider.wallet.payer,
    args?.mintAuthority ?? provider.wallet.publicKey,
    null,
    args?.decimals ?? 6,
    Keypair.generate(),
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
}

export type MintToArgs = {
  mint: PublicKey;
  tokenAccount: PublicKey;
  amount: bigint;
  payer?: Signer;
  mintAuthority?: Signer;
  decimals?: number;
  destination?: Keypair;
};

export async function mintTo(args: MintToArgs): Promise<void> {
  const provider = getProvider();
  await splMintTo(
    provider.connection,
    args.payer ?? provider.wallet.payer,
    args.mint,
    args.tokenAccount,
    args.mintAuthority ?? provider.wallet.payer,
    args.amount,
    [],
    { commitment: "confirmed" },
    TOKEN_2022_PROGRAM_ID
  );
}

export type SplBurnArgs = {
  mint: PublicKey;
  tokenAccount: PublicKey;
  amount: bigint;
  // Owner (or delegate) of `tokenAccount`; must sign. Defaults to the provider wallet.
  owner?: Signer;
};

/**
 * Token-2022's own plain `Burn` — no permissioned-burn authority, no delegate.
 *
 * This is the instruction the `PermissionedBurn` extension is meant to make
 * unusable: it has only three account slots (account, mint, owner) and therefore
 * no way to carry the mint's permissioned-burn authority as a co-signer. On a mint
 * deployed by `deploy_mint` it is expected to fail; see `tests/burn.ts`.
 */
export async function splBurn(args: SplBurnArgs): Promise<void> {
  const provider = getProvider();
  const owner = args.owner ?? provider.wallet.payer;

  const transaction = new Transaction().add(
    createBurnInstruction(args.tokenAccount, args.mint, owner.publicKey, args.amount, [], TOKEN_2022_PROGRAM_ID)
  );

  await provider.sendAndConfirm!(transaction, [owner], { commitment: "confirmed" });
}

// Token-2022 layout: base Mint occupies bytes 0..82, byte 165 is the account-type
// tag, and TLV extension entries begin at 166. Each entry is
// type(u16 LE) + length(u16 LE) + value. `PausableConfig`'s value is
// `authority: Pubkey(32) + paused: bool(1)`, so `paused` is the byte at value+32.
const TLV_START = 166;

/**
 * Test-only: flips the mint's Token-2022 `Pausable` extension `paused` flag
 * directly via surfpool, without invoking the `pause` program. Lets a test set
 * up the paused precondition in isolation. Only the `data` field is rewritten;
 * the account's owner and lamports are left untouched.
 */
export async function setMintPaused(mint: PublicKey, paused: boolean): Promise<void> {
  const info = await getAccountInfo(mint);
  if (!info) throw new Error(`mint account ${mint.toBase58()} not found`);
  const data = Buffer.from(info.data);

  let cursor = TLV_START;
  while (cursor + 4 <= data.length) {
    const type = data.readUInt16LE(cursor);
    const length = data.readUInt16LE(cursor + 2);
    const valueStart = cursor + 4;
    if (type === ExtensionType.PausableConfig) {
      data.writeUInt8(paused ? 1 : 0, valueStart + 32);
      await surfnetSetAccount(mint, { data: data.toString("hex") });
      return;
    }
    if (type === 0 && length === 0) break;
    cursor = valueStart + length;
  }
  throw new Error(`PausableConfig extension not found on mint ${mint.toBase58()}`);
}

// Base token-account layout: `amount` is a u64 LE at offset 64 (after mint + owner),
// before any extension TLV. Base mint layout: `supply` is a u64 LE at offset 36
// (after the COption<Pubkey> mint authority). Both live in the fixed base section,
// so writing them is extension-agnostic.
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const MINT_SUPPLY_OFFSET = 36;

/**
 * Test-only: mints `amount` tokens to `tokenAccount` directly via surfpool — the
 * plant-based equivalent of running the `mint` instruction, with no CPI. Credits
 * the token account's `amount` field and bumps the mint's `supply` by the same
 * amount, both incremented so repeated calls and total-supply reads stay
 * consistent. The token account's `state` and every other field are untouched,
 * matching the state the real mint instruction leaves behind.
 */
export async function mintTokensViaSurfpool(
  mint: PublicKey,
  tokenAccount: PublicKey,
  amount: anchor.BN
): Promise<void> {
  const value = BigInt(amount.toString());

  const taInfo = await getAccountInfo(tokenAccount);
  if (!taInfo) throw new Error(`token account ${tokenAccount.toBase58()} not found`);
  const taData = Buffer.from(taInfo.data);
  taData.writeBigUInt64LE(taData.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET) + value, TOKEN_ACCOUNT_AMOUNT_OFFSET);
  await surfnetSetAccount(tokenAccount, { data: taData.toString("hex") });

  const mintInfo = await getAccountInfo(mint);
  if (!mintInfo) throw new Error(`mint account ${mint.toBase58()} not found`);
  const mintData = Buffer.from(mintInfo.data);
  mintData.writeBigUInt64LE(mintData.readBigUInt64LE(MINT_SUPPLY_OFFSET) + value, MINT_SUPPLY_OFFSET);
  await surfnetSetAccount(mint, { data: mintData.toString("hex") });
}

/**
 * Test-only: burns `amount` tokens from `tokenAccount` directly via surfpool — the
 * plant-based equivalent of running the `operations` burn instruction, with no CPI.
 * Debits the token account's `amount` field and lowers the mint's `supply` by the
 * same amount, both decremented so total-supply reads stay consistent. The token
 * account's `state` and every other field are untouched, matching the state the
 * real burn instruction leaves behind. Throws if either field would underflow.
 */
export async function burnTokensViaSurfpool(
  mint: PublicKey,
  tokenAccount: PublicKey,
  amount: anchor.BN
): Promise<void> {
  const value = BigInt(amount.toString());

  const taInfo = await getAccountInfo(tokenAccount);
  if (!taInfo) throw new Error(`token account ${tokenAccount.toBase58()} not found`);
  const taData = Buffer.from(taInfo.data);
  const taAmount = taData.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
  if (taAmount < value) {
    throw new Error(`cannot burn ${value} from token account ${tokenAccount.toBase58()} with balance ${taAmount}`);
  }
  taData.writeBigUInt64LE(taAmount - value, TOKEN_ACCOUNT_AMOUNT_OFFSET);
  await surfnetSetAccount(tokenAccount, { data: taData.toString("hex") });

  const mintInfo = await getAccountInfo(mint);
  if (!mintInfo) throw new Error(`mint account ${mint.toBase58()} not found`);
  const mintData = Buffer.from(mintInfo.data);
  const supply = mintData.readBigUInt64LE(MINT_SUPPLY_OFFSET);
  if (supply < value) {
    throw new Error(`cannot burn ${value} from mint ${mint.toBase58()} with supply ${supply}`);
  }
  mintData.writeBigUInt64LE(supply - value, MINT_SUPPLY_OFFSET);
  await surfnetSetAccount(mint, { data: mintData.toString("hex") });
}
