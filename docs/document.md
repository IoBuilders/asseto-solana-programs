# document — Program Reference

Program ID: `DzYjHw2JUBT8RdNqT8P5soRxJhmL6obibRUs5sMJ2Khi`

Ports ERC-1643 (Document Management Standard) to this workspace: a mint may carry arbitrarily many named documents (name, URI, integrity hash), each its own PDA at `["document", mint, name]`. There is no on-chain enumeration or history — off-chain clients read a PDA directly (when the name is known) or enumerate every document for a mint via `getProgramAccounts` + `memcmp(offset = 8, mint)`.

`document` is Management-only: no `initialize`, no Token-2022 extension authority, no CPI wiring into `deploy`.

---

## State

### `Document`

```rust
#[account]
pub struct Document {
    pub mint: Pubkey,           // 32 — first field after the discriminator, pins the memcmp offset
    pub name: [u8; 32],         // 32
    pub uri: String,            // 4 + len, variable — resized to fit on every set_document call
    pub document_hash: [u8; 32],// 32
    pub bump: u8,               // 1
}

// Seeds: ["document", mint, name]
```

| Field | Type | Meaning |
|---|---|---|
| `mint` | `Pubkey` | The mint this document belongs to. Stored (rather than left implicit in the PDA seeds) so `getProgramAccounts` + `memcmp` can find every document for a mint without knowing document names in advance. |
| `name` | `[u8; 32]` | The document's identifier, also used to derive the PDA. Without it, an enumerated account could confirm "some document exists" but never which one. |
| `uri` | `String` | Pointer to the document's off-chain content (IPFS, HTTPS, etc.). No business-defined maximum length — the account is resized to fit exactly on every call; the only limits are Solana's own transaction-size and account-size limits. |
| `document_hash` | `[u8; 32]` | Integrity hash of the document's content at `uri`. |
| `bump` | `u8` | Bump for the `["document", mint, name]` PDA. |

`mint` is stored first (immediately after the 8-byte discriminator) so its offset is stable even if fields are appended later — this is a deliberate departure from the workspace's usual bump-first convention on per-`(mint, X)` PDAs.

**Divergence from ERC-1643:** the reference `getDocument(bytes32 name)` returns `(uri, documentHash, timestamp)`. This port stores no timestamp. Nothing on-chain reads a last-modified time, no event carries one, and clients already have a stronger source: the `blockTime` of the transaction that emitted `DocumentUpdated`, which is consensus-supplied rather than handler-written. Storing it here would cost 8 bytes of rent per document to duplicate — less reliably — information the ledger already holds.

`Document::space(uri_len)` computes the exact account size for a given `uri` byte length: `8 (discriminator) + 32 (mint) + 32 (name) + 32 (document_hash) + 1 (bump) + 4 (Borsh length prefix) + uri_len` — 109 bytes plus the URI.

---

## Error Codes

```rust
#[error_code]
pub enum ErrorCode {
    EmptyUri, // uri argument is empty
}
```

`EmptyUri` ports the EVM reference implementation's `checkNotEmptyURI` — it is the only content validation this program performs; there is no `UriTooLong`, since URI length has no business-defined cap (see `Document.uri` above).

There is no bespoke "wrong owner" error: the existing-account path in `set_document` validates ownership via `Document::try_deserialize` (see "Why not `init_if_needed`" below), which surfaces Anchor's own `AccountOwnedByWrongProgram` / `AccountDiscriminatorMismatch` instead.

---

## Instruction: `set_document` (Management)

Creates the `Document` PDA for `(mint, name)` on the first call, and overwrites every field in place — including resizing the account to fit the new `uri` — on every later call for that same key. Never creates a second PDA for a key that already exists.

### Parameters

```rust
name: [u8; 32]
uri: String
document_hash: [u8; 32]
```

### Preconditions

- `require_role(ROLE_DOCUMENT_MANAGER)` — `authority` must sign and hold `ROLE_DOCUMENT_MANAGER` on the mint.
- `require_functionality(DOCUMENT_SET_DOCUMENT)` — the mint's asset-class version must be finalized with the `DOCUMENT_SET_DOCUMENT` functionality bit enabled.
- `require_not_paused` — the mint must not be paused.
- `require_active` — the mint must not have been deactivated.
- `uri` must not be empty (`EmptyUri`).

### Accounts

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `payer` | yes | yes | Signer | Funds account creation/growth; refunded on shrink. Distinct from `authority` so a wallet can pay rent without holding the role-holder's signature. |
| `authority` | no | yes | Signer | Must hold `ROLE_DOCUMENT_MANAGER`. |
| `authority_roles_pda` | no | no | AccountLoader\<Roles\> | seeds `["roles", mint, authority]`, `seeds::program = ACCESS_CONTROL_PROGRAM_ID`; read by `require_role`. |
| `asset_configuration_pda` | no | no | Account\<AssetConfiguration\> | seeds `["asset_configuration", mint]`, `seeds::program = DEPLOY_PROGRAM_ID`; supplies the asset-class ids. |
| `deactivate_pda` | no | no | UncheckedAccount | seeds `["deactivate", mint]`, `seeds::program = DEACTIVATE_PROGRAM_ID`; read by `require_active`. |
| `mint` | no | no | UncheckedAccount | Read-only; pause state validated by `require_not_paused`. |
| `document_pda` | yes | no | UncheckedAccount | seeds `["document", mint, name]`. Created, resized, and written by the handler — see "Why not `init_if_needed`" below. |
| `asset_class_version_pda` | no | no | AccountLoader\<AssetClassVersion\> | seeds `["asset_class_version", config_id, version_id]`, `seeds::program = FACTORY_PROGRAM_ID`; read by `require_functionality`. |
| `system_program` | no | no | Program\<System\> | Used for the manual create/resize CPIs below. |
| `event_authority` | no | no | UncheckedAccount | Added by `#[event_cpi]`; seeds `["__event_authority"]`. |
| `program` | no | no | UncheckedAccount | Added by `#[event_cpi]`; this program's own id. |

### Why not `init_if_needed`

`document_pda`'s size is a function of `uri`'s length, which changes on every call. Anchor's `init_if_needed` constraint asserts `space == data_len()` on **every** invocation, including the account-already-exists path — so no fixed `space` value can satisfy both the create path and a later call with a different-length `uri`; every choice hits `ConstraintSpace`. `init_if_needed` and the `realloc` constraint also cannot be combined at all in this Anchor version (each rejects the other's `mut` handling at parse time). `document_pda` is therefore an `UncheckedAccount`, and the handler performs the full account lifecycle itself:

- **First call** (`document_pda` has no data): delegates to `common::pda_utils::create_or_adopt_pda` — the same helper `freeze::batch_freeze_account`/`batch_freeze_account_partial` use, rather than a bespoke re-implementation. It mirrors Anchor's own `init` codegen rather than assuming the address is untouched: if the PDA address was pre-funded with lamports before ever being created (cheap griefing, since anyone can transfer SOL to any address), `System::CreateAccount` would fail permanently. So: if the account holds 0 lamports, `System::CreateAccount` (signed by the PDA's own seeds) creates it at exactly `Document::space(uri.len())`. If it already holds lamports (griefed), the helper instead transfers any shortfall from `payer`, then `System::Allocate` and `System::Assign` (both signed by the PDA's own seeds) bring it to the same end state.
- **Later calls** (`document_pda` already exists): the handler deserializes the account with `Document::try_deserialize`, which validates both Anchor's 8-byte account discriminator *and* the owner in one call — a bespoke owner-only check would confirm the account belongs to this program without confirming its bytes actually hold a `Document` (Anchor raises `AccountOwnedByWrongProgram` / `AccountDiscriminatorMismatch` otherwise). It then resizes to exactly `Document::space(uri.len())` if the length changed — growing transfers the lamport shortfall from `payer` first, shrinking refunds the excess to `payer` directly (a program-owned account can debit its own lamports without a CPI) — before calling `AccountInfo::resize`.

Every field is rewritten on every call regardless of path, so there is no `init_if_needed` "stale state survives" hazard, and both paths already require the same role, so there is no privilege difference between "create" and "overwrite".

### Events

```rust
#[event]
pub struct DocumentUpdated {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub name: [u8; 32],
    pub uri: String,
    pub document_hash: [u8; 32],
}
```

Emitted via `emit_cpi!` after the PDA is written, on both first call (creation) and subsequent overwrites. `operator` is `authority`.

---

## Instruction: `remove_document` (Management)

Closes the `Document` PDA for `(mint, name)`, refunding its rent to `payer`, and emits `DocumentRemoved` carrying the closed record's data.

### Parameters

```rust
name: [u8; 32]
```

### Preconditions

Same four checks as `set_document`, gated on `DOCUMENT_REMOVE_DOCUMENT` instead of `DOCUMENT_SET_DOCUMENT`. If no `Document` PDA exists for `(mint, name)`, the instruction fails at account resolution (`AccountNotInitialized`) before the handler body runs, since `document_pda` is a typed `Account<'info, Document>` here.

### Accounts

Same support accounts as `set_document` (`payer`, `authority`, `authority_roles_pda`, `asset_configuration_pda`, `deactivate_pda`, `mint`, `asset_class_version_pda`, `event_authority`, `program`), except:

| Account | Mut | Signer | Type | Notes |
|---|---|---|---|---|
| `document_pda` | yes | no | Account\<Document\> | seeds `["document", mint, name]`, `close = payer`. A typed account (not `UncheckedAccount`) is required here: `close` needs `Discriminator`, and nothing is resized, so there's no reason to bypass Anchor's own deserialization. |

No `system_program` is needed — `close` needs no CPI, just a lamport transfer and a data zero-out that Anchor performs directly in `exit()`.

### Events

```rust
#[event]
pub struct DocumentRemoved {
    pub mint: Pubkey,
    pub operator: Pubkey,
    pub name: [u8; 32],
    pub uri: String,
    pub document_hash: [u8; 32],
}
```

Emitted via `emit_cpi!` **before** the account is closed — `close = payer` runs in Anchor's `exit()`, after the handler body, so the handler reads `uri`/`document_hash` off `document_pda` into the event while they're still present.

---

## Reading documents off-chain

`document` exposes no read instruction. Consumers load PDA state directly:

```ts
const [documentPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("document"), mint.toBuffer(), Buffer.from(name)], // name: 32-byte buffer
  DOCUMENT_PROGRAM_ID
);
const stored = await documentProgram.account.document.fetch(documentPda);
```

To enumerate every document for a mint without knowing names in advance:

```ts
const accounts = await connection.getProgramAccounts(DOCUMENT_PROGRAM_ID, {
  filters: [{ memcmp: { offset: 8, bytes: mint.toBase58() } }],
});
```

`offset: 8` skips the account discriminator to land on `mint`, the first stored field.

---

## Program IDs

Program IDs are imported from `common::program_ids` via `use common::program_ids as constants;` in each file. There is no per-program `constants.rs`.
