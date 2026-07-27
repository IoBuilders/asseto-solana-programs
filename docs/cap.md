# cap — Program Reference

Program ID: `64THHYmfoHeWxbZQYq8yRsQJYydfd7yPa6MzNgebiJLm`

Records a maximum supply for a mint in a typed PDA, one per mint. The cap is stored as a plain on-chain value in raw mint units — the same unit as the Token-2022 mint's `supply` field, so no scaling is applied.

`cap` stores the cap and exposes the check that enforces it, but never enforces it itself — the programs that move supply do, by calling `require_within_max_supply` (see below). Today that is `mint::mint` and `mint::batch_mint`.

---

## State

### `MaxSupply`

```rust
#[account]
pub struct MaxSupply {
    pub bump: u8,
    pub max_supply: u64,
}
// LEN = 8 (disc) + 1 + 8 = 17 bytes
// Seeds: ["max_supply", mint]
```

| Field | Type | Meaning |
|---|---|---|
| `bump` | `u8` | Bump for the `["max_supply", mint]` PDA. |
| `max_supply` | `u64` | Maximum total supply allowed for the mint, in **raw mint units** — the mint's own `decimals` apply, no separate scale. Always `>= 1`. |

---

## Error Codes

```rust
#[error_code]
pub enum ErrorCode {
    MaxSupplyTooLow,            // max_supply argument is 0
    MaxSupplyBelowTotalSupply,  // max_supply argument is below the mint's current supply
    MaxSupplyExceeded,          // minting would push the total supply past the cap
}
```

`MaxSupplyExceeded` is raised by `require_within_max_supply` inside a *caller's* handler (e.g. `mint`), not by any `cap` instruction.

---

## Instruction: `set_max_supply` (Management)

### Parameters

```rust
max_supply: u64
```

Creates the `max_supply` PDA on the first call (`init_if_needed`) and overwrites the stored value on every subsequent call. The cap can be raised or lowered freely, provided the new value still covers the supply already in circulation — so it can never be set to a value the mint has already exceeded.

### Preconditions

- `require_role(ROLE_CAP)` — the `authority` caller must sign and hold `ROLE_CAP` on this mint (checked against its own `["roles", mint, authority]` PDA).
- `require_not_paused` — mint must not be paused.
- `require_active` — mint must not have been deactivated.
- `require_functionality(CAP_MAX_SUPPLY)` — the mint's asset-class version must be finalized and have the `CAP_MAX_SUPPLY` functionality bit enabled.
- `max_supply >= 1` — a cap of zero would make the mint permanently unmintable and is rejected (`MaxSupplyTooLow`). Deactivating the mint is the intended way to stop issuance for good.
- `max_supply >= mint.supply` — the cap cannot be set below what is already in circulation (`MaxSupplyBelowTotalSupply`). The current supply is read by unpacking the Token-2022 mint's base state.

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds the `max_supply_pda` on the first call. Distinct from `authority` so a wallet can pay rent without holding the role-holder's signature. |
| `authority` | no | yes | Signer | Must hold `ROLE_CAP` |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role` |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; must be empty |
| `mint` | no | no | UncheckedAccount | Read-only; pause state checked by `require_not_paused`, `supply` unpacked in the handler |
| `max_supply_pda` | yes | no | `Account<MaxSupply>` | `init_if_needed`; seeds `["max_supply", mint]`, `payer = payer` |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality` |
| `system_program` | no | no | Program\<System\> | |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]` |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id |

`event_authority` signs the self-CPI that carries the emitted event; `program` is the self-CPI's target.

### Execution steps

1. `require_role(ROLE_CAP)` against `authority_roles_pda`.
2. `require_not_paused(mint)`.
3. `require_active(deactivate_pda)`.
4. `require_functionality(CAP_MAX_SUPPLY)` against `asset_class_version_pda`.
5. Reject `max_supply == 0` with `MaxSupplyTooLow`.
6. Unpack the Token-2022 mint and reject `max_supply < mint.supply` with `MaxSupplyBelowTotalSupply`.
7. Write `bump` + `max_supply` into `max_supply_pda` (created on the first call).
8. Emit `MaxSupplySet`.

---

## Events

`set_max_supply` emits its event via `emit_cpi!` (requires the `event-cpi` feature on `anchor-lang`
and the `event_authority` / `program` accounts above on the instruction context).

### `MaxSupplySet`

Emitted at the end of `set_max_supply`, after the PDA has been written — on both the first call
(creation) and every subsequent overwrite.

```rust
#[event]
pub struct MaxSupplySet {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub max_supply: u64,
}
```

`operator` is the `authority` that signed the instruction (must hold `ROLE_CAP`).

---

## Enforcing the cap: `require_within_max_supply`

Exported from `cap`'s crate root (outside `#[program]`), so a program that mints can link it in and call it directly — no CPI, no compute cost beyond the account reads. Same pattern as `transfer_control::verify_transfer_control_mode`.

```rust
pub fn require_within_max_supply(
    mint_account: &AccountInfo,
    max_supply_pda: &AccountInfo,
    amount_to_mint: u64,
) -> Result<()>
```

| Case | Result |
|---|---|
| `max_supply_pda` is empty | `Ok(())` — no cap set, no restriction. The mint account isn't even unpacked |
| `supply + amount_to_mint <= max_supply` | `Ok(())` |
| `supply + amount_to_mint > max_supply` | `Err(MaxSupplyExceeded)` |
| `supply + amount_to_mint` overflows `u64` | `Err(MaxSupplyExceeded)` — a sum that overflows `u64` necessarily exceeds a `u64` cap |

There is no separate overflow error. Token-2022's `mint_to` already does `supply.checked_add(amount).ok_or(TokenError::Overflow)`, so an overflowing mint is rejected whether or not a cap is set; duplicating that here would only change which error surfaces, at the cost of unpacking the mint on every uncapped mint.

The caller must pass the `max_supply_pda` under a seeds constraint pinned to `CAP_PROGRAM_ID`:

```rust
/// CHECK: Address verified by seeds/bump; absence means no cap is set, contents read by require_within_max_supply.
#[account(
    seeds = [pda_seeds::MAX_SUPPLY, mint.key().as_ref()],
    seeds::program = constants::CAP_PROGRAM_ID,
    bump,
)]
pub max_supply_pda: UncheckedAccount<'info>,
```

That constraint is what makes the check un-bypassable — without it a caller could substitute an unrelated empty account and read as "no cap set".

### Why enforcement isn't functionality-gated

`require_within_max_supply` deliberately does **not** consult the `CAP_MAX_SUPPLY` functionality bit. That bit gates *creating* the PDA via `set_max_supply`, so an asset class without it can never have a cap and the check is already a no-op. Gating enforcement too would mean an asset class that set a cap and then rolled to a version with the bit off would keep a `max_supply` PDA recording a cap that no longer binds — on-chain state that lies.

---

## Reading the cap

`cap` exposes **no** read instruction. Consumers load the PDA themselves.

### From another on-chain program

```rust
use cap::state::MaxSupply;

#[derive(Accounts)]
pub struct MyHandler<'info> {
    pub mint: UncheckedAccount<'info>,

    #[account(
        seeds = [b"max_supply", mint.key().as_ref()],
        seeds::program = cap::ID,
        bump = max_supply_pda.bump,
    )]
    pub max_supply_pda: Account<'info, MaxSupply>,
}
```

### From an off-chain client

```ts
const stored = await capProgram.account.maxSupply.fetch(maxSupplyPda);
console.log(stored.maxSupply.toString());
```

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. There is no per-program `constants.rs`.
