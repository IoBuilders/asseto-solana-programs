use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use common::{pda_seeds, require_functionality};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::constants;
use crate::errors::TransferHookError;
use common::program_ids::{DEPLOY_PROGRAM_ID, FACTORY_PROGRAM_ID, TRANSFER_PROGRAM_ID};
use common::state::{AssetClassVersion, AssetConfiguration};

pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
    msg!("transfer-hook execute: amount={}", amount);

    // ── Double-introspection check ───────────────────────────────────────────
    // See docs/transfer-hook.md ("Why the double introspection") for the
    // wrapper-attack this closes.
    let sysvar = ctx.accounts.instructions_sysvar.to_account_info();
    let current_idx = load_current_index_checked(&sysvar)
        .map_err(|_| error!(TransferHookError::InstructionsSysvarUnreadable))?;
    require!(current_idx > 0, TransferHookError::NoPreviousInstruction);

    let expected = ExpectedTransfer {
        source: ctx.accounts.source_token.key(),
        mint: ctx.accounts.mint.key(),
        destination: ctx.accounts.destination_token.key(),
        amount,
    };

    let prev_ix = load_instruction_at_checked((current_idx - 1) as usize, &sysvar)
        .map_err(|_| error!(TransferHookError::InstructionsSysvarUnreadable))?;
    let curr_ix = load_instruction_at_checked(current_idx as usize, &sysvar)
        .map_err(|_| error!(TransferHookError::InstructionsSysvarUnreadable))?;

    // N-1 must be transfer::verify_transfer.
    require!(
        prev_ix.program_id == TRANSFER_PROGRAM_ID,
        TransferHookError::PrevInstructionWrongProgram
    );
    assert_matches_transfer_ix(
        &prev_ix,
        &constants::VERIFY_TRANSFER_DISCRIMINATOR,
        &expected,
        IntrospectionTarget::PrevVerifyTransfer,
    )?;

    // N must be transfer::transfer OR Token-2022::transfer_checked.
    if curr_ix.program_id == TRANSFER_PROGRAM_ID {
        assert_matches_transfer_ix(
            &curr_ix,
            &constants::TRANSFER_DISCRIMINATOR,
            &expected,
            IntrospectionTarget::CurrentTransfer,
        )?;
    } else if curr_ix.program_id == anchor_spl::token_2022::ID {
        assert_matches_token2022_transfer_checked(&curr_ix, &expected)?;
    } else {
        msg!(
            "introspection: top-level instruction's program is neither transfer nor token-2022 (program_id={})",
            curr_ix.program_id
        );
        return err!(TransferHookError::CurrentInstructionUnknownProgram);
    }

    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::TRANSFER_HOOK_EXECUTE,
    )?;

    Ok(())
}

struct ExpectedTransfer {
    source: Pubkey,
    mint: Pubkey,
    destination: Pubkey,
    amount: u64,
}

// `Copy` so it can be passed into multiple `require!` calls and helpers without cloning.
#[derive(Clone, Copy)]
enum IntrospectionTarget {
    PrevVerifyTransfer,
    CurrentTransfer,
    CurrentTokenTransferChecked,
}

impl IntrospectionTarget {
    fn err_wrong_method(self) -> TransferHookError {
        match self {
            Self::PrevVerifyTransfer => TransferHookError::PrevInstructionNotVerifyTransfer,
            Self::CurrentTransfer | Self::CurrentTokenTransferChecked => {
                TransferHookError::CurrentInstructionNotTransferOrTransferChecked
            }
        }
    }

    fn err_args_mismatch(self) -> TransferHookError {
        match self {
            Self::PrevVerifyTransfer => TransferHookError::PrevInstructionArgumentMismatch,
            Self::CurrentTransfer | Self::CurrentTokenTransferChecked => {
                TransferHookError::CurrentInstructionArgumentMismatch
            }
        }
    }
}

fn assert_matches_transfer_ix(
    ix: &Instruction,
    expected_discriminator: &[u8; 8],
    expected: &ExpectedTransfer,
    target: IntrospectionTarget,
) -> Result<()> {
    require!(ix.data.len() >= 16, target.err_args_mismatch());
    require!(
        &ix.data[0..8] == expected_discriminator.as_slice(),
        target.err_wrong_method()
    );
    let amount = u64::from_le_bytes(ix.data[8..16].try_into().unwrap());
    require!(amount == expected.amount, target.err_args_mismatch());

    require_account(ix, 1, &expected.source, target)?;
    require_account(ix, 2, &expected.destination, target)?;
    require_account(ix, 3, &expected.mint, target)?;
    Ok(())
}

fn assert_matches_token2022_transfer_checked(
    ix: &Instruction,
    expected: &ExpectedTransfer,
) -> Result<()> {
    let target = IntrospectionTarget::CurrentTokenTransferChecked;
    require!(ix.data.len() >= 10, target.err_args_mismatch());
    require!(
        ix.data[0] == constants::TOKEN_2022_TRANSFER_CHECKED_TAG,
        target.err_wrong_method()
    );
    let amount = u64::from_le_bytes(ix.data[1..9].try_into().unwrap());
    require!(amount == expected.amount, target.err_args_mismatch());

    require_account(ix, 0, &expected.source, target)?;
    require_account(ix, 1, &expected.mint, target)?;
    require_account(ix, 2, &expected.destination, target)?;
    Ok(())
}

fn require_account(
    ix: &Instruction,
    idx: usize,
    expected: &Pubkey,
    target: IntrospectionTarget,
) -> Result<()> {
    require!(
        ix.accounts.len() > idx && ix.accounts[idx].pubkey == *expected,
        target.err_args_mismatch()
    );
    Ok(())
}

#[derive(Accounts)]
pub struct Execute<'info> {
    /// CHECK: Source token account (index 0).
    pub source_token: UncheckedAccount<'info>,
    /// CHECK: Mint (index 1).
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Destination token account (index 2).
    pub destination_token: UncheckedAccount<'info>,
    /// CHECK: Source account owner/authority (index 3).
    pub owner: UncheckedAccount<'info>,
    /// CHECK: ExtraAccountMetaList PDA (index 4).
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// CHECK: deploy program (index 5). Address verified by constraint;
    /// resolves `asset_configuration_pda`'s external PDA in the metalist.
    #[account(address = DEPLOY_PROGRAM_ID)]
    pub deploy_program: UncheckedAccount<'info>,

    /// PDA that contains the configuration for this mint (index 6).
    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: factory program (index 7). Address verified by constraint;
    /// resolves `asset_class_version_pda`'s external PDA in the metalist.
    #[account(address = FACTORY_PROGRAM_ID)]
    pub factory_program: UncheckedAccount<'info>,

    /// Asset-class version PDA this mint is hooked to (index 8).
    #[account(
        seeds = [
            pda_seeds::ASSET_CLASS_VERSION,
            &asset_configuration_pda.asset_class_config_id.to_le_bytes(),
            &asset_configuration_pda.asset_class_version_id.to_le_bytes()
        ],
        seeds::program = FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    /// CHECK: Instructions sysvar (index 9); address verified by the metalist's literal-pubkey entry.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}
