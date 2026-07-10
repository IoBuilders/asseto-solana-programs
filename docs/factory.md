# factory — Program Reference

Program ID: `FEY9E77nH7R1gLGNxkhYKchJpB6MgpMrWMhkNXrNhzR5`

Holds the factory's singleton configuration: the managing account and a pause flag. Initialised once via `initialize`. Management of the factory can be handed over through a two-step nomination flow (`nominate_manager` → `accept_nomination`), cancellable by the current manager (`cancel_nomination`).

The factory manager also creates **asset classes** (`create_asset_class`), each a per-`config_id` ownership record. Ownership of an asset class can in turn be handed over through its own two-step nomination flow (`nominate_asset_class_owner` → `accept_asset_class_ownership`), cancellable by the current owner (`cancel_asset_class_ownership`) — structurally identical to the manager handover, but gated to the asset class's `owner` / `pending_owner` rather than the factory manager.

Every instruction requires the factory not to be paused and is gated through the shared helpers in `helpers.rs` (`require_not_paused`, `verify_manager`, `verify_pending_manager`, `verify_owner`, `verify_pending_owner`).

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

### `AssetClassOwnership`

Per-asset-class ownership PDA stored at `["asset_class_ownership", config_id]` (`config_id` as little-endian `u64`). Created by `create_asset_class`; its `owner` is replaced on `accept_asset_class_ownership`.

| Field | Type | Notes |
|---|---|---|
| `owner` | `Pubkey` | Account that owns this asset class. Supplied at creation; replaced on `accept_asset_class_ownership`. |
| `latest_version` | `u64` | Most recent version of the asset class. Initialised to `0`. |
| `bump` | `u8` | Bump for the `["asset_class_ownership", config_id]` PDA. |

### `AssetClassPendingOwner`

Per-asset-class pending-owner PDA stored at `["asset_class_pending_owner", config_id]` (`config_id` as little-endian `u64`). Its existence means an ownership handover is in progress for that asset class. Created/updated by `nominate_asset_class_owner`; removed by `accept_asset_class_ownership` or `cancel_asset_class_ownership`.

| Field | Type | Notes |
|---|---|---|
| `pending_owner` | `Pubkey` | Account nominated to become the new asset class owner. |
| `bump` | `u8` | Bump for the `["asset_class_pending_owner", config_id]` PDA. |

### `AssetClassVersion`

Per-version PDA stored at `["asset_class_version", config_id, version]` (`config_id` and `version` as little-endian `u64`). Holds one version of an asset class — its lifecycle `state` and the functionality bit-mask. Created in `Draft` by `init_asset_class_version`; sealed to `Ready` (immutable) by `finalize_asset_class_version`.

**Zero-copy** (`#[account(zero_copy)]` / `AccountLoader`): the account is `#[repr(C)]` and read/written in place via `load()` / `load_mut()`, never deserialised as a whole, so reading a single functionality bit is cheap. The mask is a **fixed-size** `[u8; FUNCTIONALITIES_BYTES_MASK]` field: every version reserves the full global capacity (a single design-time constant, default 8192 bits = 1024 bytes). The header is laid out with explicit `_padding` so there is no implicit padding (a `Pod` requirement).

A version is fully defined by its bit-mask — there is no separate length. Bit `i` is read as `mask[i / 8] >> (i % 8) & 1` (LSB-first within each byte); `1` means "functionality `i` is activated", `0` means disabled (whether reserved-for-the-future or explicitly off — they are indistinguishable, and that's fine).

| Field | Type | Notes |
|---|---|---|
| `config_id` | `u64` | Asset class this version belongs to. |
| `version` | `u64` | Version number (1-based); equals `AssetClassOwnership.latest_version + 1` at `init` time. |
| `state` | `u8` | `STATE_DRAFT` (0) while writing, `STATE_READY` (1) once sealed. |
| `bump` | `u8` | Bump for the `["asset_class_version", config_id, version]` PDA. |
| `_padding` | `[u8; 6]` | Keeps the header at 24 bytes (no implicit padding before `mask`). |
| `mask` | `[u8; FUNCTIONALITIES_BYTES_MASK]` | Fixed-capacity functionality bit-mask. `1` = activated; unwritten positions are `0`. |

### Constants

| Constant | Value | Notes |
|---|---|---|
| `STATE_DRAFT` / `STATE_READY` | `0` / `1` | `state` values (zero-copy accounts can't hold a Borsh enum). |

---

## Instructions

### `initialize()`

Creates the singleton `factory` PDA, records the `manager` account, and defaults `pause` to `false`.

The `manager` is supplied as a **signer account** rather than an instruction argument: it must sign the transaction, so the factory manager cannot be set to an account the caller does not control.
The `factory` account uses Anchor's `init` constraint, so a second call fails because the PDA already exists — the factory can only be initialised once.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `payer` | `Signer` (mut) | Pays for the `factory` PDA creation. |
| `manager` | `Signer` | Account recorded as the factory manager. Must sign the transaction. |
| `factory` | `Account<Factory>` (init) | Singleton config PDA. Seeds: `["factory"]`. `init` fails if it already exists. |
| `system_program` | `Program<System>` | Required for account creation. |

**Execution**

1. `init` creates the `factory` PDA at `["factory"]` (fails if it already exists).
2. Stores `manager` from the signer account's key.
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

### `create_asset_class(config_id: u64, owner: Pubkey)`

Creates a new asset class identified by `config_id` and owned by `owner`, creating its `asset_class_ownership` PDA with `latest_version` initialised to `0`. The `asset_class_ownership` PDA uses Anchor's `init` constraint, so a second call with the same `config_id` fails because the PDA already exists — each `config_id` can only be created once.

Callable only by the current `factory.manager`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `manager` | `Signer` (mut) | The current factory manager. Must sign; pays for PDA creation. |
| `factory` | `Account<Factory>` | Singleton config PDA. Seeds: `["factory"]`. |
| `asset_class_ownership_pda` | `Account<AssetClassOwnership>` (init) | Asset-class ownership PDA. Seeds: `["asset_class_ownership", config_id]`. `init` fails if it already exists. |
| `system_program` | `Program<System>` | Required for account creation. |

**Execution**

1. `require_not_paused` — fails if the factory is paused.
2. `verify_manager` — fails unless `manager` is the recorded `factory.manager`.
3. `init` creates the `asset_class_ownership` PDA at `["asset_class_ownership", config_id]` (fails if it already exists).
4. Stores `owner`, sets `latest_version = 0`, and stores the PDA `bump`.

---

### `nominate_asset_class_owner(config_id: u64, new_owner: Pubkey)`

Current owner of asset class `config_id` nominates `new_owner` as successor. Creates the `asset_class_pending_owner` PDA on the first call and overwrites the recorded `pending_owner` on subsequent calls (`init_if_needed`), so the owner may freely re-nominate while a nomination is pending. The current owner pays the PDA's rent.

Callable only by the current asset class `owner`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `current_owner` | `Signer` (mut) | The current asset class owner. Must sign; pays for PDA creation if needed. |
| `factory` | `Account<Factory>` | Singleton config PDA. Seeds: `["factory"]`. |
| `asset_class_ownership_pda` | `Account<AssetClassOwnership>` | Asset-class ownership PDA. Seeds: `["asset_class_ownership", config_id]`. Read to verify the current owner. |
| `asset_class_pending_owner_pda` | `Account<AssetClassPendingOwner>` (init_if_needed) | Pending-owner PDA. Seeds: `["asset_class_pending_owner", config_id]`. Created on first call, overwritten thereafter. |
| `system_program` | `Program<System>` | Required for account creation. |

**Execution**

1. `require_not_paused` — fails if the factory is paused.
2. `verify_owner` — fails unless `current_owner` is the recorded `asset_class_ownership.owner`.
3. Creates (or reuses) the `asset_class_pending_owner` PDA and stores `pending_owner = new_owner` plus the PDA `bump`.

---

### `accept_asset_class_ownership(config_id: u64)`

Pending owner accepts the nomination for asset class `config_id`. The recorded `pending_owner` becomes the new `asset_class_ownership.owner`, and the `asset_class_pending_owner` PDA is closed, returning its rent to the pending owner.

Callable only by the recorded `pending_owner`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `pending_owner` | `Signer` (mut) | The pending owner accepting. Must sign; receives the closed PDA's lamports. |
| `factory` | `Account<Factory>` | Singleton config PDA. Seeds: `["factory"]`. |
| `asset_class_ownership_pda` | `Account<AssetClassOwnership>` (mut) | Asset-class ownership PDA. Seeds: `["asset_class_ownership", config_id]`. `owner` is updated here. |
| `asset_class_pending_owner_pda` | `Account<AssetClassPendingOwner>` (mut, close) | Pending-owner PDA. Seeds: `["asset_class_pending_owner", config_id]`. Closed here. |

**Execution**

1. `require_not_paused` — fails if the factory is paused.
2. `verify_pending_owner` — fails unless `pending_owner` matches the PDA's `pending_owner`.
3. Sets `asset_class_ownership.owner = pending_owner`.
4. Closes the `asset_class_pending_owner` PDA (rent → `pending_owner`).

---

### `cancel_asset_class_ownership(config_id: u64)`

Current owner cancels a pending nomination for asset class `config_id`. The `asset_class_pending_owner` PDA is closed, returning its rent to the current owner; `asset_class_ownership.owner` is left unchanged.

Callable only by the current asset class `owner`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `current_owner` | `Signer` (mut) | The current asset class owner. Must sign; receives the closed PDA's lamports. |
| `factory` | `Account<Factory>` | Singleton config PDA. Seeds: `["factory"]`. |
| `asset_class_ownership_pda` | `Account<AssetClassOwnership>` | Asset-class ownership PDA. Seeds: `["asset_class_ownership", config_id]`. Read to verify the current owner. |
| `asset_class_pending_owner_pda` | `Account<AssetClassPendingOwner>` (mut, close) | Pending-owner PDA. Seeds: `["asset_class_pending_owner", config_id]`. Closed here. |

**Execution**

1. `require_not_paused` — fails if the factory is paused.
2. `verify_owner` — fails unless `current_owner` is the recorded `asset_class_ownership.owner`.
3. Closes the `asset_class_pending_owner` PDA (rent → `current_owner`).

---

### Deploying an asset class version (multi-step)

The version account is fixed-size and zero-copy, created at full capacity in one `init` (no `resize`, no rent top-up). Setting functionality bits is split across as many calls as needed only because the `functionalities` list (plus the rest of the instruction) must fit a single transaction. Each version is **independent**: it defines its own functionalities from scratch and inherits nothing from previous versions. A version is deployed in up to four steps, all callable only by the asset class `owner` while the factory is not paused:

1. **`init_asset_class_version`** — creates the version PDA at full capacity in `Draft` with an empty (all-zero) mask.
2. **`enable_asset_class_version_functionalities`** — called as many times as needed; turns on the given functionality bits (merge, not overwrite).
3. **`disable_asset_class_version_functionalities`** — called as many times as needed; turns off the given functionality bits (merge, not overwrite).
4. **`finalize_asset_class_version`** — flips `state` to `Ready` (immutable) and advances `AssetClassOwnership.latest_version`.

### `init_asset_class_version(config_id: u64, version: u64)`

Starts deploying version `version` of asset class `config_id`, creating the fixed-size `asset_class_version` PDA in `Draft` state with an empty mask. `version` must equal `asset_class_ownership.latest_version + 1`, so only one draft (the next version) can exist at a time.

Callable only by the asset class `owner`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `owner` | `Signer` (mut) | The asset class owner. Must sign; pays PDA creation. |
| `factory` | `Account<Factory>` | Singleton config PDA. Seeds: `["factory"]`. |
| `asset_class_ownership_pda` | `Account<AssetClassOwnership>` | Ownership PDA. Seeds: `["asset_class_ownership", config_id]`. Read to verify the owner and pin `version`. |
| `asset_class_version_pda` | `AccountLoader<AssetClassVersion>` (init) | Version PDA. Seeds: `["asset_class_version", config_id, version]`. `init` fails if it already exists. |
| `system_program` | `Program<System>` | Required for account creation. |

**Execution**

1. `require_not_paused` / `verify_owner`.
2. `require version == latest_version + 1` (`InvalidVersion`).
3. `load_init()` and write the header (`config_id`, `version`, `state = Draft`, `bump`). The mask is left zeroed.

### `enable_asset_class_version_functionalities(config_id: u64, version: u64, functionalities: Vec<u16>)`

For each entry in `functionalities`, sets the corresponding bit to `1` (`mask[byte] |= 1 << bit`) — a targeted merge, not an overwrite, so bits outside the given list are left untouched. Rejected once the version is sealed.

Callable only by the asset class `owner`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `owner` | `Signer` | The asset class owner. Must sign. |
| `factory` | `Account<Factory>` | Singleton config PDA. Seeds: `["factory"]`. |
| `asset_class_ownership_pda` | `Account<AssetClassOwnership>` | Ownership PDA. Seeds: `["asset_class_ownership", config_id]`. Read to verify the owner. |
| `asset_class_version_pda` | `AccountLoader<AssetClassVersion>` (mut) | Version PDA. Seeds: `["asset_class_version", config_id, version]`. Must be `Draft`. |

**Execution**

1. `require_not_paused` / `verify_owner`.
2. `require state == Draft` (`VersionNotDraft`).
3. For each `f` in `functionalities`: `(byte, bit) = common::functionalities::index_of(f)?` (bounds-checks `f` internally, erroring with `CommonError::FunctionalityOutOfBounds` if it exceeds `FUNCTIONALITIES_BITS_MASK`), then `mask[byte] |= 1 << bit`.

### `disable_asset_class_version_functionalities(config_id: u64, version: u64, functionalities: Vec<u16>)`

Same shape as `enable_asset_class_version_functionalities`, but clears each bit instead (`mask[byte] &= !(1 << bit)`).

**Accounts**

Same as `enable_asset_class_version_functionalities`.

**Execution**

Same as `enable_asset_class_version_functionalities`, except the final step is `mask[byte] &= !(1 << bit)`.

### `finalize_asset_class_version(config_id: u64, version: u64)`

Seals a `Draft` version into `Ready` (immutable) and advances `asset_class_ownership.latest_version` to this version. There is no completeness check — the mask is fully allocated from `init`, and unwritten positions are simply `0` (disabled).

Callable only by the asset class `owner`, and only while the factory is not paused.

**Accounts**

| Account | Type | Notes |
|---|---|---|
| `owner` | `Signer` | The asset class owner. Must sign. |
| `factory` | `Account<Factory>` | Singleton config PDA. Seeds: `["factory"]`. |
| `asset_class_ownership_pda` | `Account<AssetClassOwnership>` (mut) | Ownership PDA. Seeds: `["asset_class_ownership", config_id]`. `latest_version` is advanced here. |
| `asset_class_version_pda` | `AccountLoader<AssetClassVersion>` (mut) | Version PDA. Seeds: `["asset_class_version", config_id, version]`. Must be `Draft`; sealed to `Ready`. |

**Execution**

1. `require_not_paused` / `verify_owner`.
2. `require state == Draft` (`VersionNotDraft`).
3. `require version == latest_version + 1` (`InvalidVersion`, defensive).
4. Sets `state = Ready` and `asset_class_ownership.latest_version = version`.

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each instruction file. The PDA seeds are defined in `common` as `pda_seeds::FACTORY` (`["factory"]`), `pda_seeds::FACTORY_PENDING_MANAGER` (`["factory_pending_manager"]`), `pda_seeds::ASSET_CLASS_OWNERSHIP` (`["asset_class_ownership", config_id]`), `pda_seeds::ASSET_CLASS_PENDING_OWNER` (`["asset_class_pending_owner", config_id]`), and `pda_seeds::ASSET_CLASS_VERSION` (`["asset_class_version", config_id, version]`). There is no per-program `constants.rs`.
