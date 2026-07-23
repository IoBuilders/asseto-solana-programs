import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@anchor-lang/core";

// Mirrors common::merkle::leaf_hash — keccak256(account || balance_le(8)).
export function leafHash(account: PublicKey, balance: anchor.BN): number[] {
  const buf = Buffer.concat([account.toBuffer(), balance.toArrayLike(Buffer, "le", 8)]);
  return Array.from(keccak_256(buf));
}

// Root of a single-leaf tree is just the leaf hash; its proof is empty.
export function singleLeafRoot(account: PublicKey, balance: anchor.BN): number[] {
  return leafHash(account, balance);
}

export const EMPTY_PROOF: number[][] = [];
