# Technical Debt

Known, deliberately-tracked gaps between what the code does today and what it
should do — not bugs blocking current work, but risks worth paying down.
Each entry records the current situation, why the fix is required, and a plan,
so the reasoning survives even if the person who found it doesn't write the
fix.

---

## Open Items

### TD-001 — `deploy_mint` doesn't validate the asset-class version exists or is finalized

**Status:** Open.

**Location:** [`programs/deploy/src/instructions/deploy_mint.rs`](../programs/deploy/src/instructions/deploy_mint.rs) — `DeployMintParams` (`asset_class_config_id`, `asset_class_version_id`) and step 13 of `deploy_mint`.

**Current situation**

`deploy_mint` takes `asset_class_config_id` and `asset_class_version_id` as
plain `u64` instruction arguments and writes them straight into the new
`asset_configuration_pda`. `DeployMint`'s account list has no `factory`,
`asset_class_ownership_pda`, or `asset_class_version_pda`, and the handler
makes no CPI into `factory`:

```rust
// deploy_mint.rs:285-286 — the entire "validation"
ctx.accounts.asset_configuration_pda.asset_class_config_id = params.asset_class_config_id;
ctx.accounts.asset_configuration_pda.asset_class_version_id = params.asset_class_version_id;
```

Nothing checks that a `factory::AssetClassVersion` PDA for that
`(config_id, version)` pair was ever created by `init_asset_class_version`,
or that it reached `Finalized` state via `finalize_asset_class_version`.
`asset_configuration_pda` also has no update instruction anywhere in the
workspace, so whatever is written here — valid or not — is permanent for
that mint's lifetime.

`docs/deploy.md` currently states the opposite: *"The deployer can re-point
the mint to a newer asset-class version by updating these fields."* That
line is stale — no such instruction exists in the codebase — and should be
corrected once the intended behavior is confirmed (see the Plan below).

**Why this is required**

Every functionality-gated instruction in the workspace — 35 call sites,
effectively every mutating instruction, including `transfer-hook::execute`
on every single transfer — resolves the mint's `asset_class_version_pda`
from `asset_configuration_pda` and calls `require_functionality`. That
resolution uses a seeds-constrained account with
`bump = asset_class_version_pda.load()?.bump`, which requires the account to
already exist and be owned by `factory` just to evaluate the constraint. If
the pair written at deploy time doesn't correspond to a real, finalized
version:

- A typo'd or premature `version` id (still `Draft`, or never created)
  silently deploys a mint that is **permanently non-functional** — no mint,
  transfer, freeze, or any other gated instruction will ever succeed on it,
  and there is no way to fix or re-point it afterward.
- The failure surfaces later, at Anchor's account-resolution layer, as an
  owner-mismatch-style error — not a clear "asset class version not found"
  message at the point of the actual mistake (`deploy_mint`).

**Plan**

1. Add `asset_class_ownership_pda` and `asset_class_version_pda`
   (`seeds::program = FACTORY_PROGRAM_ID`) to the `DeployMint` accounts
   struct.
2. Before step 13, assert
   `asset_class_version_pda.load()?.state == ASSET_CLASS_VERSION_STATE_FINALIZED`
   — the same check every other gated instruction already makes via
   `require_functionality` — and fail with a clear, `deploy`-owned error
   instead of letting it surface downstream on first use.
3. Once the real behavior (permanently pinned, no re-pointing) is confirmed
   as intended, fix the stale sentence in `docs/deploy.md`'s
   `AssetConfiguration` section. If re-pointing is actually meant to exist,
   that's a separate feature request, not a fix to this item.

---

### TD-002 — `deploy_mint` doesn't check the deployer owns the asset-class version

**Status:** Needs confirmation — may not be debt at all. Unlike TD-001, this
one is a product-design question, not a clear gap; see the note below before
treating it as something to fix.

**Location:** same as TD-001.

**Current situation**

Even once TD-001 is fixed (confirming the version exists and is
`Finalized`), nothing ties the `deployer` signer to
`asset_class_ownership_pda.owner` for that `config_id`. Any wallet can call
`deploy_mint` pointing at any already-finalized asset-class version —
including one it doesn't own — and the mint will work normally, inheriting
whatever functionality bits that version's actual owner enabled.

**Why this might not be required**

`asset_class_ownership_pda.owner` is consistently used, everywhere else in
the workspace, to gate *editing* an asset class — `verify_owner` in
`enable_/disable_/finalize_asset_class_version`, `init_asset_class_version`,
and the owner-handover instructions (`nominate_/accept_/cancel_asset_class_owner`).
Nothing in `factory` treats it as a usage gate, and operational permissions
on a deployed mint are `access-control`'s job, not `factory`'s. So the
existing pattern reads as "asset-class versions are published templates —
the owner controls what a version *supports*, not who may build a mint on
top of it" — which would make the current behavior intentional, not a gap.
The alternative reading (versions as a tenant's private config, deployable
only by its owner) is equally plausible from the code alone; nothing pins
it down either way.

**Plan**

1. Confirm the intended model with whoever owns the product requirements:
   are asset-class versions public templates any deployer can build on
   (current behavior — no change needed), or private to their owner?
2. If private: add an ownership check (e.g.
   `require_keys_eq!(deployer.key(), asset_class_ownership_pda.owner, ...)`,
   or a dedicated role) to `deploy_mint`, alongside the TD-001 fix — both
   touch the same accounts struct, so land them together.
3. If public (the reading the existing code pattern favors): close this
   item and record the decision here (or in
   [`docs/factory.md`](factory.md)) so it reads as deliberate the next time
   someone re-derives this from the code, rather than getting rediscovered
   as the same open question.

---

## Fixed Items

*(none yet)*
