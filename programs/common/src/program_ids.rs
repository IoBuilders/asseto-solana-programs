// To update an ID: change declare_id! in the program's src/lib.rs, update
// workspace Anchor.toml, and update the constant here.
use anchor_lang::{prelude::Pubkey, pubkey};

pub const DEPLOY_PROGRAM_ID: Pubkey = pubkey!("HCe5Um7ThFBzDSyn256EPQvyr6jy6E66ydzZ5hMta3Tq");
pub const DEACTIVATE_PROGRAM_ID: Pubkey = pubkey!("H2iRjVVKsKQMAnJKqiTfW2LGvT1G9tDqQ81DzRjxfX7V");
pub const MINT_PROGRAM_ID: Pubkey = pubkey!("BgVv7zYbf3L4ECwaeNoNqD6unKWvQtgTwRJ2Dma7iSHQ");
pub const OPERATIONS_PROGRAM_ID: Pubkey = pubkey!("BHDyg8PeUyVBpmkcjYLdnt3VCmYf4wp8Xeu6TXREiLKp");
pub const FREEZE_PROGRAM_ID: Pubkey = pubkey!("8L1kqDvAYC9dQXNNNnZbABtRbHGjzoxSgAPzbQZmwmSd");
pub const METADATA_UPDATE_PROGRAM_ID: Pubkey =
    pubkey!("iShebeGRBZYSBMQYGAg8DbLnbaW2eDvX1Zt8EG9G1ZV");
pub const PAUSE_PROGRAM_ID: Pubkey = pubkey!("5j3F89fmVVusjwy9z3Rv5wLaVj4ovhwctQ7TRBsxNghq");
pub const TRANSFER_CONTROL_PROGRAM_ID: Pubkey =
    pubkey!("3h92PdZJB7TuCzp6iPDtrJm2k8V7fn5ETYNwCYiYy9Eo");
pub const TRANSFER_PROGRAM_ID: Pubkey = pubkey!("Fa5VLqopKp6cokXJreYeNNmUG8F9AaE4CUBnGQvtdq7Q");
pub const TRANSFER_HOOK_PROGRAM_ID: Pubkey =
    pubkey!("2qjsucJfrjP93FCwnYjc9EjYzYS8u31eWHhQo1jR9pcg");
pub const SNAPSHOT_PROGRAM_ID: Pubkey = pubkey!("hgUtrpstViwxutrkoVXwQh3GQC18wHAmuAvYFTNiV2M");
pub const BOND_PROGRAM_ID: Pubkey = pubkey!("8opYXiWzWBrUEr5vtcvaX1ybzYaMKrndxkW1U9Patk46");
pub const COUPON_PROGRAM_ID: Pubkey = pubkey!("CGQMgamBMtJ97CCMwVD9v5vAYVzFsXLy8beN8Ej6t3FK");
pub const TREASURY_PROGRAM_ID: Pubkey = pubkey!("G71RRNtr2PLZ9Tbmp9CKnxghf3aMoasUwLGPb2u7BytA");
pub const FACTORY_PROGRAM_ID: Pubkey = pubkey!("FEY9E77nH7R1gLGNxkhYKchJpB6MgpMrWMhkNXrNhzR5");
pub const ACCESS_CONTROL_PROGRAM_ID: Pubkey =
    pubkey!("GpyjQqBWux3JYqxKCXFrDbWZmhFWBJWVaVivkBW2DL2w");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_ids_match_declare_id() {
        assert_eq!(DEPLOY_PROGRAM_ID, deploy::ID);
        assert_eq!(DEACTIVATE_PROGRAM_ID, deactivate::ID);
        assert_eq!(MINT_PROGRAM_ID, mint::ID);
        assert_eq!(OPERATIONS_PROGRAM_ID, operations::ID);
        assert_eq!(FREEZE_PROGRAM_ID, freeze::ID);
        assert_eq!(METADATA_UPDATE_PROGRAM_ID, metadata_update::ID);
        assert_eq!(PAUSE_PROGRAM_ID, pause::ID);
        assert_eq!(TRANSFER_CONTROL_PROGRAM_ID, transfer_control::ID);
        assert_eq!(TRANSFER_PROGRAM_ID, transfer::ID);
        assert_eq!(TRANSFER_HOOK_PROGRAM_ID, transfer_hook::ID);
        assert_eq!(SNAPSHOT_PROGRAM_ID, snapshot::ID);
        assert_eq!(BOND_PROGRAM_ID, bond::ID);
        assert_eq!(COUPON_PROGRAM_ID, coupon::ID);
        assert_eq!(TREASURY_PROGRAM_ID, treasury::ID);
        assert_eq!(FACTORY_PROGRAM_ID, factory::ID);
        assert_eq!(ACCESS_CONTROL_PROGRAM_ID, access_control::ID);
    }
}
