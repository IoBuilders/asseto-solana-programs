use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, MintCompliance, Roles};
use common::{
    freeze_status, pda_seeds, require_active, require_functionality, require_not_paused,
    require_role, roles, verify_account_compliance_pda,
};

use crate::errors::ErrorCode;
use crate::events::AccountPartiallyFrozen;
use crate::registry::RegistryWriter;

pub fn batch_freeze_account_partial<'info>(
    ctx: Context<'info, BatchFreezeAccountPartial<'info>>,
    balances: Vec<u64>,
) -> Result<()> {
    require!(!balances.is_empty(), ErrorCode::EmptyBatch);
    require!(
        balances.iter().all(|balance| *balance > 0),
        ErrorCode::InvalidFreezeAmount
    );
    require!(
        ctx.remaining_accounts.len() == balances.len() * 2,
        ErrorCode::InvalidRemainingAccounts
    );

    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_FREEZE_MANAGER,
    )?;

    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    require_active(ctx.accounts.mint_compliance_pda.load()?)?;

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::FREEZE_PARTIALLY_FREEZE_ACCOUNT,
    )?;

    let mint_key = ctx.accounts.mint.key();
    let authority_key = ctx.accounts.authority.key();
    let writer = RegistryWriter {
        registry_writer: &ctx.accounts.registry_writer,
        bump: ctx.bumps.registry_writer,
        mint: &ctx.accounts.mint,
    };

    for (entry, balance) in ctx.remaining_accounts.chunks_exact(2).zip(balances) {
        let (account, account_compliance_pda) = (&entry[0], &entry[1]);
        verify_account_compliance_pda(account_compliance_pda, account.key, &mint_key)?;

        let mut status = freeze_status(account_compliance_pda)?;
        status.frozen_balance = balance;
        writer.set_freeze(
            &ctx.accounts.authority,
            &ctx.accounts.system_program,
            account,
            account_compliance_pda,
            status,
        )?;

        emit_cpi!(AccountPartiallyFrozen {
            mint: mint_key,
            account: account.key(),
            frozen_balance: balance,
            operator: authority_key,
        });
    }

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct BatchFreezeAccountPartial<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, Roles>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    #[account(
        seeds = [pda_seeds::MINT_COMPLIANCE, mint.key().as_ref()],
        seeds::program = constants::TRANSFER_HOOK_PROGRAM_ID,
        bump = mint_compliance_pda.load()?.bump,
    )]
    pub mint_compliance_pda: AccountLoader<'info, MintCompliance>,

    #[account(
        seeds = [
            pda_seeds::ASSET_CLASS_VERSION,
            &asset_configuration_pda.asset_class_config_id.to_le_bytes(),
            &asset_configuration_pda.asset_class_version_id.to_le_bytes()
        ],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    /// CHECK: Address verified by seeds/bump; signs the set_freeze CPI, which accepts
    /// only this PDA.
    #[account(seeds = [pda_seeds::REGISTRY_WRITER], bump)]
    pub registry_writer: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
