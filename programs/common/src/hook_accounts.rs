use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

pub const HOOK_FORWARDED_ACCOUNT_COUNT: usize = 17;

/// Field order is the wire order Token-2022 matches positionally against
/// `transfer-hook`'s metalist — do not reshuffle.
pub struct HookAccounts<'a, 'info> {
    pub extra_account_meta_list: &'a AccountInfo<'info>,
    pub transfer_hook_program: &'a AccountInfo<'info>,
    pub deploy_program: &'a AccountInfo<'info>,
    pub asset_configuration_pda: &'a AccountInfo<'info>,
    pub factory_program: &'a AccountInfo<'info>,
    pub asset_class_version_pda: &'a AccountInfo<'info>,
    pub deactivate_program: &'a AccountInfo<'info>,
    pub deactivate_pda: &'a AccountInfo<'info>,
    pub transfer_control_program: &'a AccountInfo<'info>,
    pub transfer_control_mode_pda: &'a AccountInfo<'info>,
    pub source_whitelist_pda: &'a AccountInfo<'info>,
    pub destination_whitelist_pda: &'a AccountInfo<'info>,
    pub freeze_program: &'a AccountInfo<'info>,
    pub source_frozen_pda: &'a AccountInfo<'info>,
    pub source_frozen_balance_pda: &'a AccountInfo<'info>,
    pub hold_program: &'a AccountInfo<'info>,
    pub source_hold_position_pda: &'a AccountInfo<'info>,
}

impl<'a, 'info> HookAccounts<'a, 'info> {
    pub fn ordered(&self) -> [&'a AccountInfo<'info>; HOOK_FORWARDED_ACCOUNT_COUNT] {
        [
            self.extra_account_meta_list,
            self.transfer_hook_program,
            self.deploy_program,
            self.asset_configuration_pda,
            self.factory_program,
            self.asset_class_version_pda,
            self.deactivate_program,
            self.deactivate_pda,
            self.transfer_control_program,
            self.transfer_control_mode_pda,
            self.source_whitelist_pda,
            self.destination_whitelist_pda,
            self.freeze_program,
            self.source_frozen_pda,
            self.source_frozen_balance_pda,
            self.hold_program,
            self.source_hold_position_pda,
        ]
    }

    pub fn append_metas(&self, transfer_ix: &mut Instruction) {
        for account in self.ordered() {
            transfer_ix
                .accounts
                .push(AccountMeta::new_readonly(*account.key, false));
        }
    }

    /// Must always accompany [`Self::append_metas`].
    pub fn append_infos(&self, infos: &mut Vec<AccountInfo<'info>>) {
        for account in self.ordered() {
            infos.push(account.clone());
        }
    }
}
