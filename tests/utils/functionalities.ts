// Mirror of `common::functionalities` (programs/common/src/functionalities.rs).
// Flat `u16` identifiers for every instruction in the workspace, excluding
// `factory`. One continuous counter — do not reorder or remove; only append
// new ones at the end, matching the on-chain source.
export const BOND_UPDATE_BOND_TERMS = 0;
export const COUPON_CREATE_COUPON = 1;
export const COUPON_SET_COUPON_RATE = 2;
export const DEACTIVATE_DEACTIVATE = 3;
export const DEPLOY_DEPLOY_MINT = 4;
export const FREEZE_BLOCK_ACCOUNT = 5;
export const FREEZE_UNBLOCK_ACCOUNT = 6;
export const FREEZE_FREEZE_ACCOUNT = 7;
export const FREEZE_UNFREEZE_ACCOUNT = 8;
export const FREEZE_PARTIALLY_FREEZE_ACCOUNT = 9;
export const FREEZE_REMOVE_PARTIAL_FREEZE = 10;
export const METADATA_UPDATE_UPDATE_METADATA_FIELD = 11;
export const METADATA_UPDATE_REMOVE_METADATA_FIELD = 12;
export const MINT_MINT = 13;
export const OPERATIONS_BURN = 14;
export const PAUSE_PAUSE = 15;
export const PAUSE_UNPAUSE = 16;
export const SNAPSHOT_TAKE_SNAPSHOT = 17;
export const SNAPSHOT_UPDATE_TOTALSUPPLY_SNAPSHOT = 18;
export const SNAPSHOT_UPDATE_HOLDERBALANCE_SNAPSHOT = 19;
export const SNAPSHOT_GET_TOTALSUPPLY_SNAPSHOT_AT = 20;
export const SNAPSHOT_GET_HOLDERBALANCE_SNAPSHOT_AT = 21;
export const TRANSFER_TRANSFER = 22;
export const TRANSFER_VERIFY_TRANSFER = 23;
export const TRANSFER_CONTROL_SET_MODES = 24;
export const TRANSFER_CONTROL_ADD_TO_WHITELIST = 25;
export const TRANSFER_CONTROL_REMOVE_FROM_WHITELIST = 26;
export const TRANSFER_HOOK_INITIALIZE_EXTRA_ACCOUNT_META_LIST = 27;
export const TRANSFER_HOOK_EXECUTE = 28;
export const TREASURY_SET_PAYMENT_TOKEN = 29;
export const TREASURY_PAY_COUPON = 30;
