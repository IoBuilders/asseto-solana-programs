use anchor_lang::prelude::*;
use anchor_lang::ZeroCopy;
use bytemuck::{Pod, Zeroable};

pub const COMPLIANCE_LAYOUT_VERSION: u8 = 1;

pub const TRANSFER_MODE_NONE: u8 = 0;
pub const TRANSFER_MODE_WHITELIST: u8 = 1;
pub const TRANSFER_MODE_BLACKLIST: u8 = 2;

pub const MINT_COMPLIANCE_RESERVED_BYTES: usize = 128;
pub const ACCOUNT_COMPLIANCE_RESERVED_BYTES: usize = 64;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
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

impl MintCompliance {
    pub const SPACE: usize = 8 + core::mem::size_of::<Self>();

    pub fn is_deactivated(&self) -> bool {
        self.deactivated != 0
    }

    pub fn is_transfer_hook_execute_enabled(&self) -> bool {
        self.transfer_hook_execute_enabled != 0
    }
}

impl Discriminator for MintCompliance {
    const DISCRIMINATOR: &'static [u8] = &[170, 49, 174, 72, 169, 245, 200, 188];
}

impl Owner for MintCompliance {
    fn owner() -> Pubkey {
        crate::program_ids::TRANSFER_HOOK_PROGRAM_ID
    }
}

impl ZeroCopy for MintCompliance {}

#[cfg(feature = "idl-build")]
impl IdlBuild for MintCompliance {}

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
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

impl AccountCompliance {
    pub const SPACE: usize = 8 + core::mem::size_of::<Self>();

    pub fn is_in_control_list(&self) -> bool {
        self.in_control_list != 0
    }

    pub fn is_fully_frozen(&self) -> bool {
        self.fully_frozen != 0
    }
}

impl Discriminator for AccountCompliance {
    const DISCRIMINATOR: &'static [u8] = &[14, 187, 211, 209, 190, 110, 11, 232];
}

impl Owner for AccountCompliance {
    fn owner() -> Pubkey {
        crate::program_ids::TRANSFER_HOOK_PROGRAM_ID
    }
}

impl ZeroCopy for AccountCompliance {}

#[cfg(feature = "idl-build")]
impl IdlBuild for AccountCompliance {}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::{offset_of, size_of};

    #[test]
    fn mint_compliance_layout_is_pinned() {
        assert_eq!(offset_of!(MintCompliance, mint), 0);
        assert_eq!(offset_of!(MintCompliance, version), 32);
        assert_eq!(offset_of!(MintCompliance, bump), 33);
        assert_eq!(offset_of!(MintCompliance, deactivated), 34);
        assert_eq!(offset_of!(MintCompliance, transfer_mode), 35);
        assert_eq!(
            offset_of!(MintCompliance, transfer_hook_execute_enabled),
            36
        );
        assert_eq!(offset_of!(MintCompliance, _reserved), 40);
        assert_eq!(size_of::<MintCompliance>(), 168);
        assert_eq!(MintCompliance::SPACE, 176);
    }

    #[test]
    fn account_compliance_layout_is_pinned() {
        assert_eq!(offset_of!(AccountCompliance, mint), 0);
        assert_eq!(offset_of!(AccountCompliance, token_account), 32);
        assert_eq!(offset_of!(AccountCompliance, frozen_balance), 64);
        assert_eq!(offset_of!(AccountCompliance, held_amount), 72);
        assert_eq!(offset_of!(AccountCompliance, version), 80);
        assert_eq!(offset_of!(AccountCompliance, bump), 81);
        assert_eq!(offset_of!(AccountCompliance, in_control_list), 82);
        assert_eq!(offset_of!(AccountCompliance, fully_frozen), 83);
        assert_eq!(offset_of!(AccountCompliance, _reserved), 88);
        assert_eq!(size_of::<AccountCompliance>(), 152);
        assert_eq!(AccountCompliance::SPACE, 160);
    }
}
