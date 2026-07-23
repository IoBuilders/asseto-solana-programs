import { Keypair, PublicKey, Signer } from "@solana/web3.js";

export type BaseWriteContext = {
  signers?: Signer[];
};

export type PayerContext = {
  payer?: PublicKey;
};

export type AuthorityContext = BaseWriteContext & {
  authority: Keypair;
};

export type AuthorityWithPayerContext = AuthorityContext & PayerContext;

export type MintContext = {
  mint: PublicKey;
};

export type MintWriteContext = AuthorityContext & MintContext;

export type MintWriteWithPayerContext = AuthorityWithPayerContext & MintContext;
