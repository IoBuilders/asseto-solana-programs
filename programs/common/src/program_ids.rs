// To update an ID: change declare_id! in the program's src/lib.rs, update
// workspace Anchor.toml, and update the constant here.
use anchor_lang::{prelude::Pubkey, pubkey};

pub const DEPLOY_PROGRAM_ID: Pubkey = pubkey!("2XMEMg7FUxWksDRZQU9vtGHHSyKoSaH9bncj1noe38QK");
pub const DEACTIVATE_PROGRAM_ID: Pubkey =
    pubkey!("8rds1q4evGug816bswEEmDmJSymq86sq7mgYRcPQP996");
pub const MINT_PROGRAM_ID: Pubkey = pubkey!("AXGtgWoPXfyfQ7o823WG2ip6qSRw1s3wA3RCSdtCyN1P");
pub const OPERATIONS_PROGRAM_ID: Pubkey =
    pubkey!("BANmGRnoLxXCTzKm2aM1Zww8qn7GN2KBkbyY7QpW3vcX");
pub const FREEZE_PROGRAM_ID: Pubkey = pubkey!("ERyVR64dpCpoEa335A7LfJZnrEUeL7bxgqfqTogXYoAr");
pub const METADATA_UPDATE_PROGRAM_ID: Pubkey =
    pubkey!("Ei1dX3P7N9cBz2Vs28iB8nsWFqUAWTDicGX7YZSc5HXU");
pub const PAUSE_PROGRAM_ID: Pubkey = pubkey!("9GjHsbG5MgerXdyWRmNVMP9uXzi9iZyRyCrKw1LnSw1w");
pub const TRANSFER_CONTROL_PROGRAM_ID: Pubkey =
    pubkey!("BTLbhoZDCguRqmwhXvQej7pmAqV2TXY3iGdwMPsMBBMw");
pub const TRANSFER_PROGRAM_ID: Pubkey =
    pubkey!("EY3ndaFy8e647firyg1MiyNH9LJkBKfV9VK8CNc4N1MD");
pub const TRANSFER_HOOK_PROGRAM_ID: Pubkey =
    pubkey!("482AUGU4SbYePPHaV7yvXrGEprHhiWSTRBds4Bdr6CPz");
pub const SNAPSHOT_PROGRAM_ID: Pubkey =
    pubkey!("BcuEispMLyXAa44oRbxjgacAJWdEhFXqrBNXQfgHnfWW");
pub const BOND_PROGRAM_ID: Pubkey = pubkey!("BLA6wUczWivPKBw7wnZbvHfYPxcRWEE2Z5aGRnTdfUcU");
pub const COUPON_PROGRAM_ID: Pubkey = pubkey!("4pvS3t8wey2MhcgTgBSZZbHRUe6EFUv2pD9jJLFKWZ6u");
pub const TREASURY_PROGRAM_ID: Pubkey = pubkey!("CBxS9txE8qZqZkNXhTaWE42Ur3J3GtYv1ufLfNDNUEct");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_ids_match_declare_id() {
        assert_eq!(DEPLOY_PROGRAM_ID,          deploy::ID);
        assert_eq!(DEACTIVATE_PROGRAM_ID,      deactivate::ID);
        assert_eq!(MINT_PROGRAM_ID,            mint::ID);
        assert_eq!(OPERATIONS_PROGRAM_ID,      operations::ID);
        assert_eq!(FREEZE_PROGRAM_ID,          freeze::ID);
        assert_eq!(METADATA_UPDATE_PROGRAM_ID, metadata_update::ID);
        assert_eq!(PAUSE_PROGRAM_ID,           pause::ID);
        assert_eq!(TRANSFER_CONTROL_PROGRAM_ID,transfer_control::ID);
        assert_eq!(TRANSFER_PROGRAM_ID,        transfer::ID);
        assert_eq!(TRANSFER_HOOK_PROGRAM_ID,   transfer_hook::ID);
        assert_eq!(SNAPSHOT_PROGRAM_ID,        snapshot::ID);
        assert_eq!(BOND_PROGRAM_ID,            bond::ID);
        assert_eq!(COUPON_PROGRAM_ID,          coupon::ID);
        assert_eq!(TREASURY_PROGRAM_ID,        treasury::ID);
    }
}
