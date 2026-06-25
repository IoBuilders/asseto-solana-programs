import * as anchor from "@anchor-lang/core";

/** Maximum value of a Rust `u64` (2^64 - 1). Useful for overflow-path tests. */
export const U64_MAX = new anchor.BN(1).shln(64).subn(1);
