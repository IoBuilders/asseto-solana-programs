// Mirror of `common::functionalities` (programs/common/src/functionalities.rs).
// Flat `u16` identifiers for every instruction in the workspace, excluding
// `factory`. One continuous counter — do not reorder or remove; only append
// new ones at the end, matching the on-chain source.
export const BOND_UPDATE_BOND_TERMS = 0;
export const COUPON_CREATE_COUPON = 1;
export const COUPON_SET_COUPON_RATE = 2;
export const DEACTIVATE_DEACTIVATE = 3;
export const FREEZE_FREEZE_ACCOUNT = 4;
export const FREEZE_UNFREEZE_ACCOUNT = 5;
export const FREEZE_PARTIALLY_FREEZE_ACCOUNT = 6;
export const FREEZE_REMOVE_PARTIAL_FREEZE = 7;
export const METADATA_UPDATE_UPDATE_METADATA_FIELD = 8;
export const METADATA_UPDATE_REMOVE_METADATA_FIELD = 9;
export const MINT_MINT = 10;
export const OPERATIONS_BURN = 11;
export const PAUSE_PAUSE = 12;
export const PAUSE_UNPAUSE = 13;
export const TRANSFER_CONTROL_INITIALIZE = 14;
export const TRANSFER_CONTROL_ADD_TO_WHITELIST = 15;
export const TRANSFER_CONTROL_REMOVE_FROM_WHITELIST = 16;
export const TRANSFER_HOOK_EXECUTE = 17;
export const TREASURY_SET_PAYMENT_TOKEN = 18;
export const TREASURY_PAY_COUPON = 19;
export const ACCESS_CONTROL_GRANT_ROLES = 20;
export const ACCESS_CONTROL_REVOKE_ROLES = 21;
