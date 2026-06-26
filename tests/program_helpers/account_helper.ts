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
  await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "processed");
}

export async function getAccountInfo(address: PublicKey): Promise<anchor.web3.AccountInfo<Buffer> | null> {
  return getProvider().connection.getAccountInfo(address, "processed");
}

export async function getBalanceForRentExeption(expectedSize: number): Promise<number> {
  return getProvider().connection.getMinimumBalanceForRentExemption(expectedSize);
}

type AccountUpdate = {
  lamports?: number;
  owner?: string; // base58 program id
  data?: string; // hex-encoded string (no 0x prefix)
  executable?: boolean;
  rentEpoch?: number;
};

/**
 * Test-only: overwrites an account's on-chain state directly via surfpool's
 * `surfnet_setAccount` cheatcode. Lets a test force state that is otherwise
 * unreachable in practice (e.g. a counter saturated at u64::MAX). `data` must
 * be a hex-encoded string (no `0x` prefix); omitted fields are left untouched.
 */
export async function surfnetSetAccount(address: PublicKey, update: AccountUpdate): Promise<void> {
  const endpoint = getProvider().connection.rpcEndpoint;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setAccount",
      params: [address.toBase58(), update],
    }),
  });
  const json = (await res.json()) as { error?: unknown };
  if (json.error) {
    throw new Error(`surfnet_setAccount failed: ${JSON.stringify(json.error)}`);
  }
}
