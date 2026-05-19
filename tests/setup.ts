// ── Test output verbosity ──────────────────────────────────────────────────────
// Set to `false` to silence all console.log calls across every test file.
// Set to `true` to display them when running `anchor test`.
export const VERBOSE = false;

if (!VERBOSE) {
  console.log = () => {};
}
