import { PublicKey, Signer } from "@solana/web3.js";

export type BaseWriteContext = {
  signers?: Signer[];
};

export type PayerContext = {
  payer?: PublicKey;
};

export type DeployerContext = BaseWriteContext & {
  deployer: PublicKey;
};

export type DeployerWithPayerContext = DeployerContext & PayerContext;

export type MintContext = {
  mint: PublicKey;
};

export type MintWriteContext = DeployerContext & MintContext;

export type MintWriteWithPayerContext = DeployerWithPayerContext & MintContext;
