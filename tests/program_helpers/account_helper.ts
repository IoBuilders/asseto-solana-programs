import { PublicKey } from "@solana/web3.js";
import { AnchorProvider } from "@anchor-lang/core";
import * as anchor from "@anchor-lang/core";

function getProvider(): AnchorProvider {
  return anchor.getProvider() as AnchorProvider;
}

export async function requestAirdrop(to: PublicKey, lamports = anchor.web3.LAMPORTS_PER_SOL): Promise<void> {
  const connection = getProvider().connection;
  const airdropSig = await connection.requestAirdrop(to, lamports);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "confirmed");
}

export async function getAccountInfo(address: PublicKey): Promise<anchor.web3.AccountInfo<Buffer> | null> {
  return getProvider().connection.getAccountInfo(address, "confirmed");
}

export async function getBalanceForRentExeption(expectedSize: number): Promise<number> {
  return getProvider().connection.getMinimumBalanceForRentExemption(expectedSize);
}
