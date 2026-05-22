import { Keypair, PublicKey, Signer } from "@solana/web3.js";
import {
  Account,
  createAccount,
  createMint as splCreateMint,
  getAccount,
  getMint as splGetMint,
  mintTo as splMintTo,
  Mint,
  TOKEN_2022_PROGRAM_ID,
  getTokenMetadata as splGetTokenMetadata,
} from "@solana/spl-token";
import { AnchorProvider } from "@anchor-lang/core";
import * as anchor from "@anchor-lang/core";
import type { TokenMetadata } from "@solana/spl-token-metadata";

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
