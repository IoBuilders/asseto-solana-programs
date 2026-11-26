import { Connection } from "@solana/web3.js";

// ── Blockhash cache ───────────────────────────────────────────────────────────
// Anchor.toml sets surfpool's slot_time to 50 ms, so a blockhash expires after
// ~7.5 s (150 slots) — well inside web3.js's 30 s blockhash cache, which the
// spl-token helpers and airdrops rely on. Force a fresh blockhash on every send.
// Wraps a web3.js internal (verified against 1.98.4).
const connectionProto = Connection.prototype as any;
const fetchBlockhash = connectionProto._blockhashWithExpiryBlockHeight;
connectionProto._blockhashWithExpiryBlockHeight = function () {
  return fetchBlockhash.call(this, true);
};

// ── Test output verbosity ──────────────────────────────────────────────────────
// Set to `false` to silence all console.log calls across every test file.
// Set to `true` to display them when running `anchor test`.
export const VERBOSE = false;

if (!VERBOSE) {
  console.log = () => {};
}
