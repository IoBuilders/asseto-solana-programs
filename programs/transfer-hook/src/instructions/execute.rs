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

    require!(
        prev_ix.program_id == TRANSFER_PROGRAM_ID,
        TransferHookError::PrevInstructionWrongProgram
    );

    let curr_is_batch = curr_ix.program_id == TRANSFER_PROGRAM_ID
        && curr_ix.data.len() >= 8
        && curr_ix.data[0..8] == constants::BATCH_TRANSFER_DISCRIMINATOR;

    if curr_is_batch {
        assert_matches_batch_verify_transfer(&prev_ix, &expected)?;
        assert_matches_batch_transfer(&curr_ix, &expected)?;
        // verify (N-1) and transfer (N) must describe the IDENTICAL ordered
        // batch. Per-leg existence alone lets several transfer legs collapse
        // onto one verified leg, so verify's summed balance / partial-freeze
        // check would cover less than what is actually moved.
        assert_batch_pair_identical(&prev_ix, &curr_ix)?;
    } else if curr_ix.program_id == TRANSFER_PROGRAM_ID {
        assert_matches_transfer_ix(
            &prev_ix,
            &constants::VERIFY_TRANSFER_DISCRIMINATOR,
            &expected,
            IntrospectionTarget::PrevVerifyTransfer,
        )?;
        assert_matches_transfer_ix(
            &curr_ix,
            &constants::TRANSFER_DISCRIMINATOR,
            &expected,
            IntrospectionTarget::CurrentTransfer,
        )?;
    } else if curr_ix.program_id == anchor_spl::token_2022::ID {
        assert_matches_transfer_ix(
            &prev_ix,
            &constants::VERIFY_TRANSFER_DISCRIMINATOR,
            &expected,
            IntrospectionTarget::PrevVerifyTransfer,
        )?;
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

// Borsh layout of the `Vec<u64> amounts` arg: [disc(8)][len: u32 LE][len × u64].
fn batch_len(data: &[u8]) -> Option<usize> {
    if data.len() < 12 {
        return None;
    }
    let n = u32::from_le_bytes(data[8..12].try_into().ok()?) as usize;
    if data.len() != 12usize.checked_add(n.checked_mul(8)?)? {
        return None;
    }
    Some(n)
}

fn batch_amount_at(data: &[u8], i: usize) -> u64 {
    let off = 12 + i * 8;
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

fn assert_matches_batch_transfer(ix: &Instruction, expected: &ExpectedTransfer) -> Result<()> {
    let n = batch_len(&ix.data)
        .ok_or_else(|| error!(TransferHookError::CurrentInstructionArgumentMismatch))?;
    require!(
        n > 0 && ix.accounts.len() >= n + 3,
        TransferHookError::CurrentInstructionArgumentMismatch
    );
    require!(
        ix.accounts[1].pubkey == expected.source && ix.accounts[2].pubkey == expected.mint,
        TransferHookError::CurrentInstructionArgumentMismatch
    );

    let dest_start = ix.accounts.len() - n;
    for i in 0..n {
        if ix.accounts[dest_start + i].pubkey == expected.destination
            && batch_amount_at(&ix.data, i) == expected.amount
        {
            return Ok(());
        }
    }
    err!(TransferHookError::CurrentInstructionArgumentMismatch)
}

fn assert_matches_batch_verify_transfer(
    ix: &Instruction,
    expected: &ExpectedTransfer,
) -> Result<()> {
    require!(
        ix.data.len() >= 8 && ix.data[0..8] == constants::BATCH_VERIFY_TRANSFER_DISCRIMINATOR,
        TransferHookError::PrevInstructionNotVerifyTransfer
    );
    let n = batch_len(&ix.data)
        .ok_or_else(|| error!(TransferHookError::PrevInstructionArgumentMismatch))?;
    require!(
        n > 0 && ix.accounts.len() >= 2 * n + 3,
        TransferHookError::PrevInstructionArgumentMismatch
    );
    require!(
        ix.accounts[1].pubkey == expected.source && ix.accounts[2].pubkey == expected.mint,
        TransferHookError::PrevInstructionArgumentMismatch
    );

    let dest_start = ix.accounts.len() - 2 * n;
    for i in 0..n {
        if ix.accounts[dest_start + 2 * i].pubkey == expected.destination
            && batch_amount_at(&ix.data, i) == expected.amount
        {
            return Ok(());
        }
    }
    err!(TransferHookError::PrevInstructionArgumentMismatch)
}

fn assert_batch_pair_identical(prev: &Instruction, curr: &Instruction) -> Result<()> {
    // Identical `amounts` vectors (skip the 8-byte discriminator): same length,
    // values, and order.
    require!(
        prev.data.len() >= 8 && curr.data.len() >= 8 && prev.data[8..] == curr.data[8..],
        TransferHookError::CurrentInstructionArgumentMismatch
    );
    let n = batch_len(&curr.data)
        .ok_or_else(|| error!(TransferHookError::CurrentInstructionArgumentMismatch))?;
    require!(
        curr.accounts.len() >= n + 3 && prev.accounts.len() >= 2 * n + 3,
        TransferHookError::CurrentInstructionArgumentMismatch
    );
    // Identical destination order: transfer's trailing `n` vs verify's trailing
    // `2n` (destinations at even offsets of the (destination, whitelist) pairs).
    let curr_dest_start = curr.accounts.len() - n;
    let prev_dest_start = prev.accounts.len() - 2 * n;
    for i in 0..n {
        require!(
            curr.accounts[curr_dest_start + i].pubkey
                == prev.accounts[prev_dest_start + 2 * i].pubkey,
            TransferHookError::CurrentInstructionArgumentMismatch
        );
    }
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
