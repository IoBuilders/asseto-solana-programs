use anchor_lang::prelude::*;
use common::state::{
    discriminators_eq, AccountCompliance as AccountComplianceCommon,
    MintCompliance as MintComplianceCommon, ACCOUNT_COMPLIANCE_RESERVED_BYTES,
    COMPLIANCE_LAYOUT_VERSION, MINT_COMPLIANCE_RESERVED_BYTES,
};

#[account(zero_copy, discriminator = MintComplianceCommon::DISCRIMINATOR)]
#[repr(C)]
pub struct MintCompliance {
    pub mint: Pubkey,
    pub version: u8,
    pub bump: u8,
    pub deactivated: u8,
    pub transfer_mode: u8,
    pub transfer_hook_execute_enabled: u8,
    pub _padding: [u8; 3],
    pub _reserved: [u8; MINT_COMPLIANCE_RESERVED_BYTES],
}

#[account(zero_copy, discriminator = AccountComplianceCommon::DISCRIMINATOR)]
#[repr(C)]
pub struct AccountCompliance {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub frozen_balance: u64,
    pub held_amount: u64,
    pub version: u8,
    pub bump: u8,
    pub in_control_list: u8,
    pub fully_frozen: u8,
    pub _padding: [u8; 4],
    pub _reserved: [u8; ACCOUNT_COMPLIANCE_RESERVED_BYTES],
}

impl MintCompliance {
    pub const SPACE: usize = MintComplianceCommon::SPACE;
}

impl AccountCompliance {
    pub const SPACE: usize = AccountComplianceCommon::SPACE;
}

/// `load_init` only succeeds on a record `init_if_needed` has just created (its
/// discriminator is still zero), so that is where the identity fields are stamped.
pub(crate) fn load_or_init_account_compliance<'a, 'info>(
    record: &'a AccountLoader<'info, AccountCompliance>,
    bump: u8,
    mint: Pubkey,
    token_account: Pubkey,
) -> Result<std::cell::RefMut<'a, AccountCompliance>> {
    match record.load_init() {
        Ok(mut fresh) => {
            fresh.mint = mint;
            fresh.token_account = token_account;
            fresh.version = COMPLIANCE_LAYOUT_VERSION;
            fresh.bump = bump;
            Ok(fresh)
        }
        Err(_) => record.load_mut(),
    }
}

const _: () = assert!(
    size_of::<MintCompliance>() == size_of::<MintComplianceCommon>(),
    "transfer-hook::MintCompliance and common::state::MintCompliance have diverged — update both together",
);

const _: () = assert!(
    discriminators_eq(
        <MintCompliance as Discriminator>::DISCRIMINATOR,
        <MintComplianceCommon as Discriminator>::DISCRIMINATOR
    ),
    "transfer-hook::MintCompliance and common::state::MintCompliance discriminators have diverged",
);

const _: () = assert!(
    size_of::<AccountCompliance>() == size_of::<AccountComplianceCommon>(),
    "transfer-hook::AccountCompliance and common::state::AccountCompliance have diverged — update both together",
);

const _: () = assert!(
    discriminators_eq(
        <AccountCompliance as Discriminator>::DISCRIMINATOR,
        <AccountComplianceCommon as Discriminator>::DISCRIMINATOR
    ),
    "transfer-hook::AccountCompliance and common::state::AccountCompliance discriminators have diverged",
);

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes each struct through the hook's type and reads it back through the
    /// `common` mirror, so a reordered field fails here rather than misparsing
    /// on-chain (the size assert alone can't catch a same-size swap).
    #[test]
    fn mint_compliance_mirror_reads_the_same_layout() {
        let mut record = MintCompliance {
            mint: Pubkey::new_unique(),
            version: 1,
            bump: 254,
            deactivated: 1,
            transfer_mode: 2,
            transfer_hook_execute_enabled: 1,
            _padding: [0; 3],
            _reserved: [0; MINT_COMPLIANCE_RESERVED_BYTES],
        };
        record._reserved[MINT_COMPLIANCE_RESERVED_BYTES - 1] = 0xAB;

        let mirrored: &MintComplianceCommon = bytemuck::from_bytes(bytemuck::bytes_of(&record));

        assert_eq!(mirrored.mint, record.mint);
        assert_eq!(mirrored.version, record.version);
        assert_eq!(mirrored.bump, record.bump);
        assert!(mirrored.is_deactivated());
        assert_eq!(mirrored.transfer_mode, record.transfer_mode);
        assert!(mirrored.is_transfer_hook_execute_enabled());
        assert_eq!(mirrored._reserved, record._reserved);
    }

    #[test]
    fn account_compliance_mirror_reads_the_same_layout() {
        let record = AccountCompliance {
            mint: Pubkey::new_unique(),
            token_account: Pubkey::new_unique(),
            frozen_balance: 0x1122_3344_5566_7788,
            held_amount: 0x99AA_BBCC_DDEE_FF00,
            version: 1,
            bump: 253,
            in_control_list: 1,
            fully_frozen: 0,
            _padding: [0; 4],
            _reserved: [0; ACCOUNT_COMPLIANCE_RESERVED_BYTES],
        };

        let mirrored: &AccountComplianceCommon = bytemuck::from_bytes(bytemuck::bytes_of(&record));

        assert_eq!(mirrored.mint, record.mint);
        assert_eq!(mirrored.token_account, record.token_account);
        assert_eq!(mirrored.frozen_balance, record.frozen_balance);
        assert_eq!(mirrored.held_amount, record.held_amount);
        assert_eq!(mirrored.version, record.version);
        assert_eq!(mirrored.bump, record.bump);
        assert!(mirrored.is_in_control_list());
        assert!(!mirrored.is_fully_frozen());
    }
}
