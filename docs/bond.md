# bond — Program Reference

Program ID: `8opYXiWzWBrUEr5vtcvaX1ybzYaMKrndxkW1U9Patk46`

Stores the on-chain-readable subset of a bond's term sheet in a typed PDA, one per mint. Other Solana programs can pull these fields directly via Anchor's `Account<'info, BondTerms>` constraint — no Token-2022 metadata scanning, no string parsing, no scale ambiguity.

The Token-2022 metadata extension (managed by `metadata-update`) keeps the rest of the bond term sheet — `currency`, `unique_identifier`, LEIs, schedule details, etc. Only the fields a consuming program needs to reason about programmatically live here.

---

## State

### `BondTerms`

```rust
#[account]
pub struct BondTerms {
    pub bump: u8,
    pub interest_rate: u64,
    pub interest_rate_decimals: u8,
    pub par_value: u64,
    pub par_value_decimals: u8,
    pub minimum_denomination: u64,
    pub issuance_date: i64,
    pub day_count_convention: DayCountConvention,
}
// LEN = 8 (disc) + 1 + 8 + 1 + 8 + 1 + 8 + 8 + 1 = 44 bytes
// Seeds: ["bond_terms", mint]
```

| Field | Type | Meaning |
|---|---|---|
| `bump` | `u8` | Bump for the `["bond_terms", mint]` PDA. Internal — not exposed by `get_bond_terms`. |
| `interest_rate` | `u64` | Annual coupon, scaled by `10^interest_rate_decimals`. Actual rate = `interest_rate / 10^interest_rate_decimals` as a fraction. Example: 5.275 % → `interest_rate = 5275`, `interest_rate_decimals = 5`. |
| `interest_rate_decimals` | `u8` | Number of fractional digits applied to `interest_rate`. |
| `par_value` | `u64` | Face / redemption amount per bond, in the bond's reference currency (recorded as Token-2022 metadata, not here). Scaled by `10^par_value_decimals`. Example: $1,000.00 USD → `par_value = 100_000`, `par_value_decimals = 2`. **Independent of the SPL mint's `decimals`.** |
| `par_value_decimals` | `u8` | Number of fractional digits applied to `par_value`. |
| `minimum_denomination` | `u64` | Smallest tradeable bond size, in **raw mint units** — uses the SPL mint's own `decimals`, no separate scale. |
| `issuance_date` | `i64` | Bond issuance date as a Unix timestamp (seconds). `i64` matches `Clock::unix_timestamp`. |
| `day_count_convention` | `DayCountConvention` | Day-count convention used to compute accrued interest. |

### `DayCountConvention`

```rust
pub enum DayCountConvention {
    Actual360,  // actual days / 360 (money-market convention)
    Actual365,  // actual days / 365
}
```

Encoded as a single byte on-chain via Borsh's enum tag.

### `BondTermsArgs`

Input struct for `update_bond_terms`. Same fields as `BondTerms` minus `bump`, which the program manages itself.

---

## Instruction: `update_bond_terms` (Management)

### Parameters

```rust
args: BondTermsArgs
```

Creates the `bond_terms` PDA on the first call (`init_if_needed`) and overwrites every field with `args` on every call. There is no per-field setter — every update specifies the full term sheet — to keep the on-chain payload trivial and to match the "rewrite, don't drift" intent of the typed-PDA design.

### Preconditions

- `require_role(ROLE_CORPORATE_ACTION)` — the `authority` caller must sign and hold `ROLE_CORPORATE_ACTION` on this mint (checked against its own `["roles", mint, authority]` PDA). Replaces the previous `verify_deployer` gate.
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not have been deactivated.
- `require_functionality(BOND_UPDATE_BOND_TERMS)` — the mint's asset-class version must be finalized and have the `BOND_UPDATE_BOND_TERMS` functionality bit enabled.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds the `bond_terms` PDA on the first call. Distinct from `authority` so a wallet can pay rent without holding the role-holder's signature. |
| `authority` | yes | yes | Signer | Must hold `ROLE_CORPORATE_ACTION`; also funds the PDA creation |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | no | no | UncheckedAccount | Read-only; pause state checked by `require_not_paused` |
| `bond_terms` | yes | no | `Account<BondTerms>` | `init_if_needed`; seeds `["bond_terms", mint]`, `payer = payer`, `space = BondTerms::LEN` |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `system_program` | no | no | Program<System> | |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id |

`event_authority` signs the self-CPI that carries the emitted event; `program` is the self-CPI's target.

---

## Events

`update_bond_terms` emits an event via `emit_cpi!` (requires the `event-cpi` feature on `anchor-lang`
and the `event_authority` / `program` accounts above on the instruction context).

### `BondTermsUpdated`

Emitted at the end of `update_bond_terms`, after the `bond_terms` PDA has been written — on both the
first call (creation) and every subsequent overwrite.

```rust
#[event]
pub struct BondTermsUpdated {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub interest_rate: u64,
    pub interest_rate_decimals: u8,
    pub par_value: u64,
    pub par_value_decimals: u8,
    pub minimum_denomination: u64,
    pub issuance_date: i64,
    pub day_count_convention: DayCountConvention,
}
```

`operator` is the `authority` that signed the instruction (must hold `ROLE_CORPORATE_ACTION`). The remaining fields mirror `args` (the full
term sheet as written), not the account's `bump` — so the event alone is enough to reconstruct the new
`BondTerms` state without re-fetching the PDA.

---

## Reading the bond terms

`bond` exposes **no** read instruction. Consumers load the PDA themselves — same data, no CPI cost, no extra IDL surface to maintain.

### From another on-chain program (typed account constraint)

Anchor gives both verification and typed access in one constraint:

```rust
use bond::state::BondTerms;

#[derive(Accounts)]
pub struct MyHandler<'info> {
    pub mint: UncheckedAccount<'info>,

    #[account(
        seeds = [b"bond_terms", mint.key().as_ref()],
        seeds::program = bond::ID,
        bump = bond_terms.bump,
    )]
    pub bond_terms: Account<'info, BondTerms>,
}

// Inside the handler:
let rate = ctx.accounts.bond_terms.interest_rate;
let dec  = ctx.accounts.bond_terms.interest_rate_decimals;
```

The `Account<'info, BondTerms>` constraint enforces (1) the address derived from the seeds, (2) ownership by `bond`, (3) the Anchor discriminator, and then Borsh-deserialises the typed struct. Reading individual fields is then ordinary Rust struct access — no allocations, no scanning, no string parsing.

### From an off-chain client

Anchor's IDL-generated account decoder turns the raw account bytes into the typed struct in one call (no transaction, no CPI):

```ts
const stored = await bondProgram.account.bondTerms.fetch(bondTermsPda);
console.log(stored.interestRate.toString(), stored.interestRateDecimals);
```

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
