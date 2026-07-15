use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use common::{pda_seeds, pda_utils, require_functionality};
use snapshot::cpi::accounts::UpdateHolderBalanceSnapshot;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::constants;
use crate::errors::TransferHookError;
use common::program_ids::{
    DEPLOY_PROGRAM_ID, FACTORY_PROGRAM_ID, SNAPSHOT_PROGRAM_ID, TRANSFER_PROGRAM_ID,
};
use common::state::{AssetClassVersion, MintOwner};

/// Called by Token-2022 on every transfer via the SPL Transfer Hook Interface.
///
/// All pre-transfer compliance checks (deactivation, transfer-mode,
/// whitelist, frozen account, frozen balance) live in
/// `transfer::verify_transfer`. This hook gates every transfer on a
/// matching `verify_transfer` having run as the immediately-prior top-level
/// instruction, then updates the sender / receiver holder-balance snapshots.
pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
    msg!("transfer-hook execute: amount={}", amount);

    // ── Double-introspection check ───────────────────────────────────────────
    //
    // The hook fires from inside Token-2022's transfer_checked CPI. The
    // Instructions sysvar exposes only TOP-LEVEL instructions, so:
    //  - `current_index`     points at whatever top-level instruction the user
    //                        signed (transfer.transfer or
    //                        Token-2022.transfer_checked).
    //  - `current_index - 1` must be transfer.verify_transfer for the
    //                        compliance suite to have run against the same
    //                        source / destination / mint / amount.
    //
    // Restricting the legal entrypoints at index N (instead of just checking
    // N-1) is what closes the wrapper-attack hole: a third-party program could
    // otherwise sit at top level, call verify_transfer + state-mutating CPIs +
    // transfer_checked all inside one instruction tree, and the
    // sysvar-based view would only reveal "the wrapper" — not the inner
    // mutations. Forcing N to be one of our two known-good entrypoints denies
    // any wrapper from sitting between the user and the actual transfer.
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

    // ── Snapshot updates (CPI to snapshot) ─────────────────────────────
    let mint_key = ctx.accounts.mint.key();
    let transfer_hook_authority_signer_seeds = pda_utils::build_pda_signer_seeds(
        pda_seeds::transfer_hook_authority_seeds(&mint_key),
        &ctx.bumps.transfer_hook_authority,
    );

    snapshot::cpi::update_holderbalance_snapshot(
        CpiContext::new_with_signer(
            SNAPSHOT_PROGRAM_ID,
            UpdateHolderBalanceSnapshot {
                calling_authority: ctx.accounts.transfer_hook_authority.to_account_info(),
                payer: ctx.accounts.transfer_hook_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
                holder_balance_snapshot: ctx.accounts.sender_snapshot.to_account_info(),
                holder_token_account: ctx.accounts.source_token.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[transfer_hook_authority_signer_seeds.as_slice()],
        ),
        amount,
        true,
    )?;

    snapshot::cpi::update_holderbalance_snapshot(
        CpiContext::new_with_signer(
            SNAPSHOT_PROGRAM_ID,
            UpdateHolderBalanceSnapshot {
                calling_authority: ctx.accounts.transfer_hook_authority.to_account_info(),
                payer: ctx.accounts.transfer_hook_authority.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                snapshot_counter: ctx.accounts.snapshot_counter_pda.to_account_info(),
                holder_balance_snapshot: ctx.accounts.receiver_snapshot.to_account_info(),
                holder_token_account: ctx.accounts.destination_token.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[transfer_hook_authority_signer_seeds.as_slice()],
        ),
        amount,
        false,
    )?;

    Ok(())
}

/// What the hook expects every introspected transfer view (verify_transfer,
/// transfer.transfer, or Token-2022.transfer_checked) to agree on.
struct ExpectedTransfer {
    source: Pubkey,
    mint: Pubkey,
    destination: Pubkey,
    amount: u64,
}

/// Identifies which introspection slot is being checked, so the helpers can
/// raise the failure-category-specific error variant. `Copy` so it can be
/// passed into multiple `require!` calls and helpers without cloning.
#[derive(Clone, Copy)]
enum IntrospectionTarget {
    PrevVerifyTransfer,
    CurrentTransfer,
    CurrentTokenTransferChecked,
}

impl IntrospectionTarget {
    /// Error to raise when the discriminator / instruction tag at this slot is
    /// not the expected method.
    fn err_wrong_method(self) -> TransferHookError {
        match self {
            Self::PrevVerifyTransfer => TransferHookError::PrevInstructionNotVerifyTransfer,
            Self::CurrentTransfer | Self::CurrentTokenTransferChecked => {
                TransferHookError::CurrentInstructionNotTransferOrTransferChecked
            }
        }
    }

    /// Error to raise when the introspected instruction's accounts / amount /
    /// data layout does not match the transfer being hooked.
    fn err_args_mismatch(self) -> TransferHookError {
        match self {
            Self::PrevVerifyTransfer => TransferHookError::PrevInstructionArgumentMismatch,
            Self::CurrentTransfer | Self::CurrentTokenTransferChecked => {
                TransferHookError::CurrentInstructionArgumentMismatch
            }
        }
    }
}

/// Validate an introspected `transfer::verify_transfer` or
/// `transfer::transfer` instruction.
///
/// Both share the Anchor calling convention (8-byte discriminator + 8-byte
/// little-endian `amount`) and the same account ordering at indices 0..=3:
/// `[source_owner, source, destination, mint]`. We don't constrain
/// `source_owner` — Token-2022's `transfer_checked` already enforces it
/// matches `source.owner` natively, and verify_transfer's Signer constraint
/// covers the same on its side.
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

/// Validate an introspected `Token-2022::TransferChecked` instruction.
///
/// SPL layout: 1-byte tag (`12`), 8-byte little-endian `amount`, 1-byte
/// `decimals`. Account ordering: `[source, mint, destination, owner]`.
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

/// Common helper: assert `ix.accounts[idx].pubkey == *expected`. Raises the
/// args-mismatch error appropriate to the target slot.
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

/// Accounts for the SPL Transfer Hook `Execute` instruction.
///
/// Order matches the metalist built by `initialize_extra_account_meta_list`.
/// Token-2022 passes the first 5 (SPL standard) accounts and then one account
/// per metalist entry, in declaration order.
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
    /// CHECK: snapshot program (index 5).
    pub snapshot_program: UncheckedAccount<'info>,
    /// CHECK: Snapshot counter PDA (index 6).
    pub snapshot_counter_pda: UncheckedAccount<'info>,
    /// CHECK: Sender holder balance snapshot PDA (index 7).
    pub sender_snapshot: UncheckedAccount<'info>,
    /// CHECK: Receiver holder balance snapshot PDA (index 8).
    pub receiver_snapshot: UncheckedAccount<'info>,
    /// CHECK: transfer hook authority (index 9). Mutable: pays for snapshot PDA creation.
    #[account(
        mut,
        seeds = [pda_seeds::TRANSFER_HOOK_AUTHORITY, mint.key().as_ref()],
        bump,
    )]
    pub transfer_hook_authority: UncheckedAccount<'info>,

    /// CHECK: deploy program (index 10). Address verified by constraint;
    /// resolves `mint_owner_pda`'s external PDA in the metalist.
    #[account(address = DEPLOY_PROGRAM_ID)]
    pub deploy_program: UncheckedAccount<'info>,

    /// PDA created by deploy that records the deployer for this mint (index 11).
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = DEPLOY_PROGRAM_ID,
        bump = mint_owner_pda.bump,
    )]
    pub mint_owner_pda: Account<'info, MintOwner>,

    /// CHECK: factory program (index 12). Address verified by constraint;
    /// resolves `asset_class_version_pda`'s external PDA in the metalist.
    #[account(address = FACTORY_PROGRAM_ID)]
    pub factory_program: UncheckedAccount<'info>,

    /// Asset-class version PDA this mint is hooked to (index 13).
    #[account(
        seeds = [pda_seeds::ASSET_CLASS_VERSION, &mint_owner_pda.asset_class_config_id.to_le_bytes(), &mint_owner_pda.asset_class_version_id.to_le_bytes()],
        seeds::program = FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub system_program: Program<'info, System>,

    /// Instructions sysvar (index 15). Required for the introspection check.
    /// Address pinned by the metalist; contents read via the
    /// `solana_program::sysvar::instructions` helpers.
    /// CHECK: Address verified by the metalist's literal-pubkey entry.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}
