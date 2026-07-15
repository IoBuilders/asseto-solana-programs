import { Keypair, PublicKey, Signer } from "@solana/web3.js";
import {
  Account,
  createAccount,
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
  const destination = args.destination ?? Keypair.generate();

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
