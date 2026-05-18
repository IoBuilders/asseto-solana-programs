import * as anchor from "@anchor-lang/core";

// ── Test output verbosity ──────────────────────────────────────────────────────
// Set to `false` to silence all console.log calls across every test file.
// Set to `true` to display them when running `anchor test`.
export const VERBOSE = false;

if (!VERBOSE) {
  console.log = () => {};
}

// ── Wallet funding (localnet / surfpool) ───────────────────────────────────────
// requestAirdrop is a no-op on devnet/mainnet clusters; surfpool supports it
// on localnet, so this works for any environment without hardcoding a pubkey.
export const mochaHooks = {
  beforeAll: async function (this: Mocha.Context) {
    this.timeout(30_000);
    const provider = anchor.AnchorProvider.env();
    const balance = await provider.connection.getBalance(provider.wallet.publicKey);
    if (balance < 10 * anchor.web3.LAMPORTS_PER_SOL) {
      const sig = await provider.connection.requestAirdrop(
        provider.wallet.publicKey,
        100 * anchor.web3.LAMPORTS_PER_SOL,
      );
      await provider.connection.confirmTransaction(sig);
    }
  },
};
