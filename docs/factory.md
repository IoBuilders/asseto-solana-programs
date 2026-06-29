# factory — Program Reference

Program ID: `FEY9E77nH7R1gLGNxkhYKchJpB6MgpMrWMhkNXrNhzR5`

Holds the factory's singleton configuration: the managing account and a pause flag. Initialised once via `initialize`. Management of the factory can be handed over through a two-step nomination flow (`nominate_manager` → `accept_nomination`), cancellable by the current manager (`cancel_nomination`).

All three nomination instructions require the factory not to be paused and are gated through the shared helpers in `helpers.rs` (`require_not_paused`, `verify_manager`, `verify_pending_manager`).

---

## State

### `Factory`

Singleton config PDA stored at `["factory"]`.

| Field | Type | Notes |
|---|---|---|
| `manager` | `Pubkey` | Account authorised to manage the factory. Supplied at initialization; replaced on `accept_nomination`. |
| `pause` | `bool` | Whether the factory is paused. Defaults to `false` at initialization. |
| `bump` | `u8` | Bump for the `["factory"]` PDA. |

### `FactoryPendingManager`

Singleton pending-manager PDA stored at `["factory_pending_manager"]`. Its existence means a manager handover is in progress. Created/updated by `nominate_manager`; removed by `accept_nomination` or `cancel_nomination`.

| Field | Type | Notes |
|---|---|---|
| `pending_manager` | `Pubkey` | Account nominated to become the new factory manager. |
| `bump` | `u8` | Bump for the `["factory_pending_manager"]` PDA. |

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

### `nominate_manager(new_manager: Pubkey)`

Current manager nominates `new_manager` as successor. Creates the `factory_pending_manager` PDA on the first call and overwrites the recorded `pending_manager` on subsequent calls (`init_if_needed`), so the manager may freely re-nominate while a nomination is pending. The current manager pays the PDA's rent.

Callable only by the current `factory.manager`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `current_manager` | `Signer` (mut) | The current factory manager. Must sign; pays for PDA creation if needed. |
| `factory` | `Account<Factory>` | Singleton config PDA. Seeds: `["factory"]`. |
| `factory_pending_manager_pda` | `Account<FactoryPendingManager>` (init_if_needed) | Pending-manager PDA. Seeds: `["factory_pending_manager"]`. Created on first call, overwritten thereafter. |
| `system_program` | `Program<System>` | Required for account creation. |

**Execution**

1. `require_not_paused` — fails if the factory is paused.
2. `verify_manager` — fails unless `current_manager` is the recorded `factory.manager`.
3. Creates (or reuses) the `factory_pending_manager` PDA and stores `pending_manager = new_manager` plus the PDA `bump`.

---

### `accept_nomination()`

Pending manager accepts the nomination. The recorded `pending_manager` becomes the new `factory.manager`, and the `factory_pending_manager` PDA is closed, returning its rent to the pending manager.

Callable only by the recorded `pending_manager`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `pending_manager` | `Signer` (mut) | The pending manager accepting. Must sign; receives the closed PDA's lamports. |
| `factory` | `Account<Factory>` (mut) | Singleton config PDA. Seeds: `["factory"]`. `manager` is updated here. |
| `factory_pending_manager_pda` | `Account<FactoryPendingManager>` (mut, close) | Pending-manager PDA. Seeds: `["factory_pending_manager"]`. Closed here. |

**Execution**

1. `require_not_paused` — fails if the factory is paused.
2. `verify_pending_manager` — fails unless `pending_manager` matches the PDA's `pending_manager`.
3. Sets `factory.manager = pending_manager`.
4. Closes the `factory_pending_manager` PDA (rent → `pending_manager`).

---

### `cancel_nomination()`

Current manager cancels a pending nomination. The `factory_pending_manager` PDA is closed, returning its rent to the current manager; `factory.manager` is left unchanged.

Callable only by the current `factory.manager`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `current_manager` | `Signer` (mut) | The current factory manager. Must sign; receives the closed PDA's lamports. |
| `factory` | `Account<Factory>` | Singleton config PDA. Seeds: `["factory"]`. |
| `factory_pending_manager_pda` | `Account<FactoryPendingManager>` (mut, close) | Pending-manager PDA. Seeds: `["factory_pending_manager"]`. Closed here. |

**Execution**

1. `require_not_paused` — fails if the factory is paused.
2. `verify_manager` — fails unless `current_manager` is the recorded `factory.manager`.
3. Closes the `factory_pending_manager` PDA (rent → `current_manager`).

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. The `["factory"]` and `["factory_pending_manager"]` PDA seeds are defined as `pda_seeds::FACTORY` and `pda_seeds::FACTORY_PENDING_MANAGER` in `common`. There is no per-program `constants.rs`.
