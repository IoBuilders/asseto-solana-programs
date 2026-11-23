# Technical Debt

Known, deliberately-tracked gaps between what the code does today and what it
should do — not bugs blocking current work, but risks worth paying down.
Each entry records the current situation, why the fix is required, and a plan,
so the reasoning survives even if the person who found it doesn't write the
fix.

---

## Open Items

### `set_coupon_rate` after a coupon's first payment is silently ineffective

**Situation.** `treasury::pay_coupon` pins the effective rate in `coupon_distribution` on a coupon's first payment. A later `coupon::set_coupon_rate` still succeeds and rewrites the `Coupon` account, but the remaining holders keep being paid at the pinned rate. Correct for holders, misleading for the operator.

**Fix.** Make `set_coupon_rate` fail once payments can have started: either `require!(now < coupon.payment_date)` (no cross-program read, mirrors EVM's cancellation cutoff), or require the `["coupon_distribution", mint, coupon_id]` PDA (`seeds::program = TREASURY_PROGRAM_ID`) to be empty, same pattern as `require_active`.

### Payment mints with `TransferFeeConfig` / `TransferHook` are accepted

**Situation.** `set_payment_token` accepts any Token-2022 mint. With `TransferFeeConfig`, `transfer_checked` succeeds but withholds the fee in the destination, so the holder receives less than the `amount` recorded in `coupon_paid` and `total_paid`. With `TransferHook`, `pay_coupon` does not append the hook's extra accounts, so every payment fails and the open distribution is stuck on that mint. EVM detects the first case (`FeeOnTransferDetected`).

**Fix.** In `set_payment_token`, when the mint is owned by Token-2022, parse it with `StateWithExtensions<Mint>` and reject both extensions.

### The snapshot Merkle root is not committed to anything verifiable

**Situation.** `create_coupon` stores whatever root `ROLE_CORPORATE_ACTION` supplies. With the destination now bound to the leaf's wallet, diverting funds requires that role to publish a root with false owners *and* `ROLE_TREASURER` to pay it, but nothing on-chain limits the number of leaves or their total balance.

**Fix.** Store `leaf_count` and `total_balance` alongside the root, check `total_balance` against the mint supply at `create_coupon`, and have `pay_coupon` enforce `coupon_distribution.paid_count <= leaf_count` (EVM pins `totalTokenHolders` the same way).

### `TreasuryConfig` layout shrank (`locked_for_coupon_id` removed)

**Situation.** `TreasuryConfig` went from 50 to 42 bytes. Existing accounts on a cluster deployed before this change deserialize fine (Anchor ignores trailing bytes), but a coupon whose payments started before the upgrade has no `coupon_distribution`, so its remaining payments would pin the terms current at upgrade time. Its root is also keyed by token account, not wallet, so its remaining holders can no longer be paid.

**Fix.** Before upgrading any cluster with live coupons, finish their distributions.

---

## Fixed Items

*(none yet)*
