use anchor_lang::solana_program::pubkey::Pubkey;

/********************************** DEPLOY **********************************/
pub const MINT_OWNER: &[u8] = b"mint_owner";

pub fn mint_owner_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![MINT_OWNER, mint.as_ref()]
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
pub const FREEZE_AUTHORITY: &[u8] = b"freeze_authority";
pub const FROZEN_ACCOUNT: &[u8] = b"frozen_account";
pub const FROZEN_BALANCE: &[u8] = b"frozen_balance";

pub fn freeze_authority_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![FREEZE_AUTHORITY, mint.as_ref()]
}

/******************************** OPERATIONS ********************************/
pub const PERMANENT_DELEGATE: &[u8] = b"permanent_delegate";

pub fn permanent_delegate_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![PERMANENT_DELEGATE, mint.as_ref()]
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

/********************************* TRANSFER *********************************/
pub const TRANSFER: &[u8] = b"transfer";

pub fn transfer_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![TRANSFER, mint.as_ref()]
}

/****************************** TRANSFER-HOOK *******************************/
pub const TRANSFER_HOOK_AUTHORITY: &[u8] = b"transfer_hook_authority";
pub const EXTRA_ACCOUNT_METAS: &[u8] = b"extra-account-metas";

pub fn transfer_hook_authority_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![TRANSFER_HOOK_AUTHORITY, mint.as_ref()]
}

/********************************* SNAPSHOT *********************************/
pub const SNAPSHOT_COUNTER: &[u8] = b"snapshot_counter";
pub const SNAPSHOT_TOTALSUPPLY: &[u8] = b"snapshot_totalsupply";
pub const SNAPSHOT_HOLDERBALANCE: &[u8] = b"snapshot_holderbalance";

pub fn snapshot_totalsupply_seeds<'info>(mint: &'info Pubkey) -> Vec<&'info [u8]> {
    vec![SNAPSHOT_TOTALSUPPLY, mint.as_ref()]
}

pub fn snapshot_holderbalance_seeds<'info>(
    mint: &'info Pubkey,
    holder_token_account: &'info Pubkey,
) -> Vec<&'info [u8]> {
    vec![
        SNAPSHOT_HOLDERBALANCE,
        mint.as_ref(),
        holder_token_account.as_ref(),
    ]
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
