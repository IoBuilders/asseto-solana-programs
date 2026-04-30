use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_2022::Token2022;
use spl_token_2022::{
    extension::StateWithExtensions,
    instruction::transfer_checked,
    state::{Account as TokenAccountState, Mint as MintState},
};
use cmtat_freeze::cpi::accounts::{BlockAccount, UnblockAccount};
use cmtat_common::{verify_deactivate, verify_deployer};
use cmtat_freeze::verify_frozen_account;
use cmtat_freeze::verify_frozen_account_balance;
use cmtat_transfer_control::{get_transfer_mode, verify_whitelist, TransferMode};
use crate::constants;

use crate::errors::CmtatTransferError;

/// Transfers `amount` tokens from `source` to `destination`.
///
/// Operational instruction — called by the token holder who owns `source`.
/// Authorization: `source_owner` must sign and must be the recorded owner of the
/// source token account. The transfer authority PDA then authorizes the freeze/thaw
/// CPIs to cmtat-freeze for the block/unblock steps.
pub fn transfer(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
    // ── Verify source is owned by the signer ────────────────────────────────
    {
        let source_data = ctx.accounts.source.try_borrow_data()?;
        let source_state = StateWithExtensions::<TokenAccountState>::unpack(&source_data)
            .map_err(|_| error!(CmtatTransferError::UnauthorizedTransfer))?;
        require!(
            source_state.base.owner == *ctx.accounts.source_owner.key,
            CmtatTransferError::UnauthorizedTransfer
        );
    }

    // ── Verify mint has not been deactivated ─────────────────────────────────
    verify_deactivate(&ctx.accounts.deactivate_pda.to_account_info())?;

    // ── Transfer control mode check (single deserialization) ─────────────────
    match get_transfer_mode(&ctx.accounts.transfer_control_mode_pda.to_account_info())? {
        None => {}
        Some(TransferMode::Clearing) => {
            require!(
                ctx.accounts.deployer.is_signer,
                CmtatTransferError::ClearingModeUnauthorized
            );
            verify_deployer(
                &ctx.accounts.mint_owner_pda.to_account_info(),
                &ctx.accounts.deployer.key(),
            )?;
        }
        Some(TransferMode::Whitelist) => {
            verify_whitelist(&ctx.accounts.source_whitelist_pda.to_account_info())?;
            verify_whitelist(&ctx.accounts.destination_whitelist_pda.to_account_info())?;
        }
    }

    // ── Verify source account has not been frozen ────────────────────────────
    verify_frozen_account(&ctx.accounts.source_frozen_pda.to_account_info())?;

    // ── Verify available (unfrozen) balance covers the transfer amount ────────
    verify_frozen_account_balance(
        amount,
        &ctx.accounts.source.to_account_info(),
        &ctx.accounts.source_frozen_balance_pda.to_account_info(),
    )?;

    // ── Read mint decimals ───────────────────────────────────────────────────
    let decimals = {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let mint_state = StateWithExtensions::<MintState>::unpack(&mint_data)
            .map_err(anchor_lang::error::Error::from)?;
        mint_state.base.decimals
    };

    let mint_key = ctx.accounts.mint.key();
    let token_program_id = ctx.accounts.token_2022_program.key();

    let transfer_authority_seeds: &[&[u8]] = &[
        b"transfer",
        mint_key.as_ref(),
        &[ctx.bumps.transfer_authority],
    ];

    // ── 1. Unblock source and destination (CPI to cmtat-freeze) ─────────────
    cmtat_freeze::cpi::unblock_account(
        CpiContext::new_with_signer(
            ctx.accounts.freeze_program.to_account_info(),
            UnblockAccount {
                calling_authority: ctx.accounts.transfer_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.source.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[transfer_authority_seeds],
        ),
    )?;

    cmtat_freeze::cpi::unblock_account(
        CpiContext::new_with_signer(
            ctx.accounts.freeze_program.to_account_info(),
            UnblockAccount {
                calling_authority: ctx.accounts.transfer_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.destination.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[transfer_authority_seeds],
        ),
    )?;

    // ── 2. Transfer ─────────────────────────────────────────────────────────
    //
    // token_2022::transfer_checked produces only 4 AccountMeta entries.
    // Token-2022 uses instruction.accounts to discover accessible accounts, so
    // the hook program and ExtraAccountMetaList must be appended explicitly —
    // passing them only in the AccountInfo slice is insufficient.
    let mut transfer_ix = transfer_checked(
        &token_program_id,
        &ctx.accounts.source.key(),
        &mint_key,
        &ctx.accounts.destination.key(),
        &ctx.accounts.source_owner.key(),
        &[],
        amount,
        decimals,
    )?;
    transfer_ix.accounts.push(AccountMeta::new_readonly(
        ctx.accounts.extra_account_meta_list.key(),
        false,
    ));
    transfer_ix.accounts.push(AccountMeta::new_readonly(
        ctx.accounts.transfer_hook_program.key(),
        false,
    ));

    invoke(
        &transfer_ix,
        &[
            ctx.accounts.source.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.source_owner.to_account_info(),
            ctx.accounts.extra_account_meta_list.to_account_info(),
            ctx.accounts.transfer_hook_program.to_account_info(),
        ],
    )?;

    // ── 3. Re-block source and destination (CPI to cmtat-freeze) ────────────
    cmtat_freeze::cpi::block_account(
        CpiContext::new_with_signer(
            ctx.accounts.freeze_program.to_account_info(),
            BlockAccount {
                calling_authority: ctx.accounts.transfer_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.source.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[transfer_authority_seeds],
        ),
    )?;

    cmtat_freeze::cpi::block_account(
        CpiContext::new_with_signer(
            ctx.accounts.freeze_program.to_account_info(),
            BlockAccount {
                calling_authority: ctx.accounts.transfer_authority.to_account_info(),
                freeze_authority: ctx.accounts.freeze_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                token_account: ctx.accounts.destination.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[transfer_authority_seeds],
        ),
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    /// The token holder initiating the transfer.
    /// Must own the source token account (verified in instruction body).
    pub source_owner: Signer<'info>,

    /// The deployer — required to sign only when the mint is in clearing mode.
    /// In other modes the account must be present but the signature is not checked.
    ///
    /// CHECK: Signer status is enforced in the instruction body (`deployer.is_signer`)
    /// only when clearing mode is active. Unused as a signer in all other modes.
    pub deployer: UncheckedAccount<'info>,

    /// PDA created by cmtat-deploy that records the deployer for this mint.
    /// Used by verify_deployer when clearing mode is active.
    ///
    /// CHECK: Address verified by seeds/bump; contents Borsh-deserialized by verify_deployer.
    #[account(
        seeds = [b"mint_owner", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

    /// Transfer Control Mode PDA for this mint.
    /// Seeds: `["transfer_control_mode", mint]`, owned by `cmtat-transfer-control`.
    /// Read to determine whether clearing or whitelist mode is active.
    ///
    /// CHECK: Address verified by seeds/bump; contents read by get_transfer_mode.
    #[account(
        seeds = [b"transfer_control_mode", mint.key().as_ref()],
        seeds::program = constants::CMTAT_TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    /// Whitelist marker PDA for the source token account.
    /// Seeds: `["whitelist", mint, source]`, owned by `cmtat-transfer-control`.
    /// Must exist when whitelist mode is active; ignored otherwise.
    ///
    /// CHECK: Address verified by seeds/bump; existence checked by verify_whitelist if needed.
    #[account(
        seeds = [b"whitelist", mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::CMTAT_TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub source_whitelist_pda: UncheckedAccount<'info>,

    /// Whitelist marker PDA for the destination token account.
    /// Seeds: `["whitelist", mint, destination]`, owned by `cmtat-transfer-control`.
    /// Must exist when whitelist mode is active; ignored otherwise.
    ///
    /// CHECK: Address verified by seeds/bump; existence checked by verify_whitelist if needed.
    #[account(
        seeds = [b"whitelist", mint.key().as_ref(), destination.key().as_ref()],
        seeds::program = constants::CMTAT_TRANSFER_CONTROL_PROGRAM_ID,
        bump,
    )]
    pub destination_whitelist_pda: UncheckedAccount<'info>,

    /// The source token account (owned by source_owner).
    ///
    /// CHECK: Writable; owner verified in instruction body; validated by Token-2022 during CPI.
    #[account(mut)]
    pub source: UncheckedAccount<'info>,

    /// The destination token account.
    ///
    /// CHECK: Writable; validated by Token-2022 during CPI.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// The Token-2022 mint.
    ///
    /// CHECK: Validated by Token-2022 during CPI; decimals read in instruction body.
    pub mint: UncheckedAccount<'info>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    /// Seeds: `["deactivate", mint]`, owned by `cmtat-deactivate`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by verify_deactivate.
    #[account(
        seeds = [b"deactivate", mint.key().as_ref()],
        seeds::program = constants::CMTAT_DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// Transfer authority PDA — authorizes freeze/thaw CPIs to cmtat-freeze.
    /// Seeds: `["transfer", mint]`.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [b"transfer", mint.key().as_ref()],
        bump,
    )]
    pub transfer_authority: UncheckedAccount<'info>,

    /// cmtat-freeze's freeze authority PDA for this mint.
    /// Passed through to cmtat-freeze for the freeze/thaw CPIs.
    ///
    /// CHECK: PDA address verified by seeds/bump constraint.
    #[account(
        seeds = [b"freeze_authority", mint.key().as_ref()],
        seeds::program = constants::CMTAT_FREEZE_PROGRAM_ID,
        bump,
    )]
    pub freeze_authority: UncheckedAccount<'info>,

    /// Frozen account marker PDA for the source token account.
    /// Seeds: `["frozen_account", mint, source]`, owned by `cmtat-freeze`.
    /// Must not exist for the transfer to proceed.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by verify_frozen_account.
    #[account(
        seeds = [b"frozen_account", mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::CMTAT_FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_pda: UncheckedAccount<'info>,

    /// Frozen balance PDA for the source token account.
    /// Seeds: `["frozen_balance", mint, source]`, owned by `cmtat-freeze`.
    /// If present, the transfer amount must not exceed `source.balance - frozen_balance`.
    /// May be empty (no partial freeze recorded) — handled by verify_frozen_account_balance.
    ///
    /// CHECK: Address verified by seeds/bump; balance checked by verify_frozen_account_balance.
    #[account(
        seeds = [b"frozen_balance", mint.key().as_ref(), source.key().as_ref()],
        seeds::program = constants::CMTAT_FREEZE_PROGRAM_ID,
        bump,
    )]
    pub source_frozen_balance_pda: UncheckedAccount<'info>,

    /// ExtraAccountMetaList PDA for the transfer hook.
    /// Must be present so Token-2022 can invoke the hook during transfer_checked.
    ///
    /// CHECK: Address verified by seeds/bump constraint.
    #[account(
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        seeds::program = constants::CMTAT_TRANSFER_HOOK_PROGRAM_ID,
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// The transfer hook program — must be present in the transaction so
    /// Token-2022 can invoke it during transfer_checked.
    ///
    /// CHECK: Address verified by constraint.
    #[account(address = constants::CMTAT_TRANSFER_HOOK_PROGRAM_ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// CHECK: Address verified by constraint.
    #[account(address = constants::CMTAT_FREEZE_PROGRAM_ID)]
    pub freeze_program: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
}
