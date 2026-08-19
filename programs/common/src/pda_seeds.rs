use anchor_lang::solana_program::pubkey::Pubkey;

/********************************** DEPLOY **********************************/
pub const ASSET_CONFIGURATION: &[u8] = b"asset_configuration";

pub fn asset_configuration_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![ASSET_CONFIGURATION, mint.as_ref()]
}

pub const TEMP_MINT_AUTHORITY_SEED: &[u8] = b"temp_mint_authority";

pub fn temp_mint_authority_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![TEMP_MINT_AUTHORITY_SEED, mint.as_ref()]
}

/*********************************** MINT ***********************************/
pub const MINT_AUTHORITY: &[u8] = b"mint_authority";

pub fn mint_authority_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![MINT_AUTHORITY, mint.as_ref()]
}

/***************************** METADATA-UPDATE ******************************/
pub const METADATA_UPDATE_AUTHORITY: &[u8] = b"metadata_update_authority";

pub fn metadata_update_authority_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![METADATA_UPDATE_AUTHORITY, mint.as_ref()]
}

/********************************** FREEZE **********************************/
pub const FROZEN_ACCOUNT: &[u8] = b"frozen_account";
pub const FROZEN_BALANCE: &[u8] = b"frozen_balance";

pub fn frozen_account_seeds<'info>(
    mint: &'info Pubkey,
    account: &'info Pubkey,
) -> Vec<&'info [u8]> {
    vec![FROZEN_ACCOUNT, mint.as_ref(), account.as_ref()]
}

pub fn frozen_balance_seeds<'info>(
    mint: &'info Pubkey,
    account: &'info Pubkey,
) -> Vec<&'info [u8]> {
    vec![FROZEN_BALANCE, mint.as_ref(), account.as_ref()]
}

/******************************** OPERATIONS ********************************/
pub const PERMANENT_DELEGATE: &[u8] = b"permanent_delegate";
pub const PERMISSIONED_BURN: &[u8] = b"permissioned_burn";

pub fn permanent_delegate_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![PERMANENT_DELEGATE, mint.as_ref()]
}

pub fn permissioned_burn_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![PERMISSIONED_BURN, mint.as_ref()]
}

/********************************** PAUSE ***********************************/
pub const PAUSABLE_AUTHORITY: &[u8] = b"pausable_authority";

pub fn pausable_authority_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![PAUSABLE_AUTHORITY, mint.as_ref()]
}

/******************************** DEACTIVATE ********************************/
pub const DEACTIVATE: &[u8] = b"deactivate";

/***************************** TRANSFER-CONTROL *****************************/
pub const TRANSFER_CONTROL_MODE: &[u8] = b"transfer_control_mode";
pub const WHITELIST: &[u8] = b"whitelist";

pub fn transfer_control_mode_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![TRANSFER_CONTROL_MODE, mint.as_ref()]
}

pub fn whitelist_seeds<'info>(mint: &'info Pubkey, account: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![WHITELIST, mint.as_ref(), account.as_ref()]
}

/********************************* TRANSFER *********************************/
pub const TRANSFER: &[u8] = b"transfer";

pub fn transfer_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![TRANSFER, mint.as_ref()]
}

/****************************** TRANSFER-HOOK *******************************/
pub const TRANSFER_HOOK_AUTHORITY: &[u8] = b"transfer_hook_authority";
pub const EXTRA_ACCOUNT_METAS: &[u8] = b"extra-account-metas";

/********************************* SNAPSHOT *********************************/
pub const SNAPSHOT_COUNTER: &[u8] = b"snapshot_counter";
pub const SNAPSHOT_MERKLE_ROOT: &[u8] = b"snapshot_merkle_root";

pub fn snapshot_merkle_root_seeds<'info>(
    mint: &'info Pubkey,
    snapshot_id: &'info [u8],
) -> Vec<&'info [u8]> {
    vec![SNAPSHOT_MERKLE_ROOT, mint.as_ref(), snapshot_id]
}

/*********************************** BOND ***********************************/
pub const BOND_TERMS: &[u8] = b"bond_terms";

/********************************** COUPON **********************************/
pub const COUPON_AUTHORITY: &[u8] = b"coupon_authority";
pub const COUPON_COUNTER: &[u8] = b"coupon_counter";
pub const COUPON: &[u8] = b"coupon";

pub fn coupon_authority_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![COUPON_AUTHORITY, mint.as_ref()]
}

/********************************* TREASURY *********************************/
pub const TREASURY_CONFIG: &[u8] = b"treasury_config";
pub const TREASURY_AUTHORITY: &[u8] = b"treasury_authority";
pub const COUPON_PAID: &[u8] = b"coupon_paid";

pub fn treasury_authority_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![TREASURY_AUTHORITY, mint.as_ref()]
}

/********************************* FACTORY *********************************/
pub const FACTORY: &[u8] = b"factory";
pub const FACTORY_PENDING_MANAGER: &[u8] = b"factory_pending_manager";
pub const ASSET_CLASS_OWNERSHIP: &[u8] = b"asset_class_ownership";
pub const ASSET_CLASS_PENDING_OWNER: &[u8] = b"asset_class_pending_owner";
pub const ASSET_CLASS_VERSION: &[u8] = b"asset_class_version";

/********************************* ACCESS CONTROL *********************************/
pub const ROLES: &[u8] = b"roles";

/*********************************** CAP ************************************/
pub const MAX_SUPPLY: &[u8] = b"max_supply";

/********************************* DOCUMENT *********************************/
pub const DOCUMENT: &[u8] = b"document";

pub fn document_seeds<'info>(mint: &'info Pubkey, name: &'info [u8]) -> Vec<&'info [u8]> {
    vec![DOCUMENT, mint.as_ref(), name]
}

/*********************************** HOLD ***********************************/
pub const HOLD_POSITION: &[u8] = b"hold_position";
pub const HOLD: &[u8] = b"hold";
pub const HOLD_AUTHORITY: &[u8] = b"hold_authority";

pub fn hold_position_seeds<'info>(
    mint: &'info Pubkey,
    token_account: &'info Pubkey,
) -> Vec<&'info [u8]> {
    vec![HOLD_POSITION, mint.as_ref(), token_account.as_ref()]
}

pub fn hold_seeds<'info>(
    mint: &'info Pubkey,
    token_account: &'info Pubkey,
    hold_id: &'info [u8],
) -> Vec<&'info [u8]> {
    vec![HOLD, mint.as_ref(), token_account.as_ref(), hold_id]
}

pub fn hold_authority_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![HOLD_AUTHORITY, mint.as_ref()]
}
