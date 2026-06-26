# factory — Program Reference

Program ID: `FEY9E77nH7R1gLGNxkhYKchJpB6MgpMrWMhkNXrNhzR5`

Holds the factory's singleton configuration: the managing account and a pause flag. Initialised once via `initialize`.

---

## State

### `Factory`

Singleton config PDA stored at `["factory"]`.

| Field | Type | Notes |
|---|---|---|
| `manager` | `Pubkey` | Account authorised to manage the factory. Supplied at initialization. |
| `pause` | `bool` | Whether the factory is paused. Defaults to `false` at initialization. |
| `bump` | `u8` | Bump for the `["factory"]` PDA. |

---

## Instructions

### `initialize(manager: Pubkey)`

Creates the singleton `factory` PDA, records `manager`, and defaults `pause` to `false`.

The `factory` account uses Anchor's `init` constraint, so a second call fails because the PDA already exists — the factory can only be initialised once.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `payer` | `Signer` (mut) | Pays for the `factory` PDA creation. |
| `factory` | `Account<Factory>` (init) | Singleton config PDA. Seeds: `["factory"]`. `init` fails if it already exists. |
| `system_program` | `Program<System>` | Required for account creation. |

**Execution**

1. `init` creates the `factory` PDA at `["factory"]` (fails if it already exists).
2. Stores `manager` from the argument.
3. Sets `pause = false`.
4. Stores the PDA `bump`.

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. The `["factory"]` PDA seed is defined as `pda_seeds::FACTORY` in `common`. There is no per-program `constants.rs`.
