use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use common::{pda_seeds, pda_utils, require_active, require_not_paused, verify_deployer};

use crate::events::TransferControlModesSet;
use crate::state::{TransferControlMode, TransferMode};
use common::program_ids as constants;

/// Sets, updates, or removes the transfer control modes for a mint.
///
/// | `modes` argument     | PDA absent       | PDA present               |
/// |----------------------|------------------|---------------------------|
/// | empty vec            | no-op            | close → return rent       |
/// | non-empty vec        | create + write   | realloc if needed + write |
///
/// The full active mode list is replaced on every call.
/// Duplicate modes in the input are rejected.
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn set_modes(ctx: Context<SetMode>, modes: Vec<TransferMode>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    // ── Remove possible duplicate modes ─────────────────────────────────────────────────────
    let mut modes = modes;
    modes.sort_unstable_by_key(|m| *m as u8);
    modes.dedup();

    let pda = &ctx.accounts.transfer_control_mode_pda;

    if modes.is_empty() {
        close_pda(pda, &ctx.accounts.deployer)?;
    } else {
        let bump = ctx.bumps.transfer_control_mode_pda;
        let new_space = TransferControlMode::space(modes.len());
        if pda.data_is_empty() {
            create_pda(&ctx, pda, bump, new_space)?;
        } else if pda.data_len() != new_space {
            resize_pda(
                pda,
                &ctx.accounts.deployer,
                &ctx.accounts.system_program,
                new_space,
            )?;
        }
        write_pda(
            pda,
            TransferControlMode {
                modes: modes.clone(),
                bump,
            },
        )?;
    }

    emit_cpi!(TransferControlModesSet {
        mint: ctx.accounts.mint.key(),
        operator: ctx.accounts.deployer.key(),
        modes,
    });

    Ok(())
}

/// Closes the PDA and returns rent to the deployer. No-op if already absent.
fn close_pda<'info>(pda: &UncheckedAccount<'info>, deployer: &Signer<'info>) -> Result<()> {
    if pda.data_is_empty() {
        return Ok(());
    }
    let lamports = pda.lamports();
    **pda.try_borrow_mut_lamports()? = 0;
    **deployer.try_borrow_mut_lamports()? = deployer.lamports().checked_add(lamports).unwrap();
    pda.try_borrow_mut_data()?.fill(0);
    Ok(())
}

/// Allocates a new PDA account via `create_account`.
fn create_pda<'info>(
    ctx: &Context<SetMode<'info>>,
    pda: &UncheckedAccount<'info>,
    bump: u8,
    space: usize,
) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let signer_seeds =
        pda_utils::build_pda_signer_seeds(pda_seeds::transfer_control_mode_seeds(&mint_key), &bump);
    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.deployer.key,
            pda.key,
            Rent::get()?.minimum_balance(space),
            space as u64,
            ctx.program_id,
        ),
        &[
            ctx.accounts.deployer.to_account_info(),
            pda.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[signer_seeds.as_slice()],
    )
    .map_err(Into::into)
}

/// Adjusts lamports and resizes an existing PDA to `new_space`.
fn resize_pda<'info>(
    pda: &UncheckedAccount<'info>,
    deployer: &Signer<'info>,
    system_program: &Program<'info, System>,
    new_space: usize,
) -> Result<()> {
    let new_min = Rent::get()?.minimum_balance(new_space);
    let current = pda.lamports();
    match new_min.cmp(&current) {
        std::cmp::Ordering::Greater => {
            // Deployer pays the missing rent via a system transfer CPI
            let diff = new_min - current;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    system_program.key(),
                    anchor_lang::system_program::Transfer {
                        from: deployer.to_account_info(),
                        to: pda.to_account_info(),
                    },
                ),
                diff,
            )?;
        }
        std::cmp::Ordering::Less => {
            // PDA pays the leftover rent to the deployer
            let diff = current - new_min;
            **pda.try_borrow_mut_lamports()? = new_min;
            **deployer.try_borrow_mut_lamports()? = deployer.lamports().checked_add(diff).unwrap();
        }
        std::cmp::Ordering::Equal => {}
    }
    pda.resize(new_space).map_err(Into::into)
}

/// Serializes `TransferControlMode` into the PDA's data buffer.
fn write_pda(pda: &UncheckedAccount, content: TransferControlMode) -> Result<()> {
    let mut data = pda.try_borrow_mut_data()?;
    let mut slice: &mut [u8] = &mut data;
    content.try_serialize(&mut slice)
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetMode<'info> {
    /// The deployer recorded as mint owner — must sign and fund PDA creation if needed.
    #[account(mut)]
    pub deployer: Signer<'info>,

    /// PDA created by deploy that records the deployer for this mint.
    ///
    /// CHECK: Address verified by seeds/bump; contents Borsh-deserialized by verify_deployer.
    #[account(
        seeds = [pda_seeds::MINT_OWNER, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump,
    )]
    pub mint_owner_pda: UncheckedAccount<'info>,

    /// The Token-2022 mint.
    ///
    /// CHECK: Read-only; validated by require_not_paused (checks the Pausable extension).
    pub mint: UncheckedAccount<'info>,

    /// Deactivation marker PDA — must not exist for the instruction to proceed.
    /// Seeds: `["deactivate", mint]`, owned by `deactivate`.
    ///
    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// Transfer Control Mode PDA.
    /// Created when `mode` is `Some(_)`, closed when `mode` is `None`.
    /// Absent PDA == no controls active.
    ///
    /// CHECK: Account lifecycle (create / update / close) is handled entirely
    /// in the instruction body; seeds/bump constraint verifies the address.
    #[account(
        mut,
        seeds = [pda_seeds::TRANSFER_CONTROL_MODE, mint.key().as_ref()],
        bump,
    )]
    pub transfer_control_mode_pda: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// Just to make TransferControlMode part of the IDL
#[derive(Accounts)]
pub struct __TransferControlModeIDL<'info> {
    pub transfer_control_mode: Account<'info, TransferControlMode>,
}
