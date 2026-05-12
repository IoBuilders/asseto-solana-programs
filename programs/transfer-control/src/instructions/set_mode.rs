use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use common::{pda_seeds, pda_utils, require_active, verify_deployer, require_not_paused};

use crate::constants;
use crate::state::{TransferControlMode, TransferMode};

/// Sets, updates, or removes the transfer control mode for a mint.
///
/// | `mode` argument      | PDA absent       | PDA present           |
/// |----------------------|------------------|-----------------------|
/// | `None`               | no-op            | close → return rent   |
/// | `Some(Clearing)`     | create + write   | overwrite             |
/// | `Some(Whitelist)`    | create + write   | overwrite             |
///
/// Management instruction — only the deployer recorded in `mint_owner_pda` may call this.
pub fn set_mode(ctx: Context<SetMode>, mode: Option<TransferMode>) -> Result<()> {
    // ── Verify deployer is the recorded mint owner ────────────────────────────
    verify_deployer(
        &ctx.accounts.mint_owner_pda.to_account_info(),
        &ctx.accounts.deployer.key(),
    )?;

    // ── Verify mint is not paused ─────────────────────────────────────────────
    require_not_paused(&ctx.accounts.mint.to_account_info())?;

    // ── Verify mint has not been deactivated ──────────────────────────────────
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    let pda = &ctx.accounts.transfer_control_mode_pda;
    let mint_key = ctx.accounts.mint.key();
    let bump = ctx.bumps.transfer_control_mode_pda;

    match mode {
        // ── None: remove controls ──────────────────────────────────────────────
        None => {
            if !pda.data_is_empty() {
                // Return rent to deployer.
                let lamports = pda.lamports();
                **pda.try_borrow_mut_lamports()? = 0;
                **ctx.accounts.deployer.try_borrow_mut_lamports()? = ctx
                    .accounts
                    .deployer
                    .lamports()
                    .checked_add(lamports)
                    .unwrap();
                // Zero the data so the Anchor discriminator no longer matches,
                // preventing the account from being deserialized after closure.
                let mut data = pda.try_borrow_mut_data()?;
                data.fill(0);
            }
            // PDA already absent → no-op.
        }

        // ── Some(m): create if absent, then write ─────────────────────────────
        Some(m) => {
            if pda.data_is_empty() {
                let space = TransferControlMode::LEN;
                let lamports = Rent::get()?.minimum_balance(space);
                let transfer_control_mode_signer_seeds = pda_utils::build_pda_signer_seeds(
                    pda_seeds::transfer_control_mode_seeds(&mint_key),
                    &bump
                );
                invoke_signed(
                    &system_instruction::create_account(
                        ctx.accounts.deployer.key,
                        pda.key,
                        lamports,
                        space as u64,
                        ctx.program_id,
                    ),
                    &[
                        ctx.accounts.deployer.to_account_info(),
                        pda.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                    &[transfer_control_mode_signer_seeds.as_slice()],
                )?;
            }
            // Write discriminator + data (works for both create and update).
            let mode_pda = TransferControlMode { mode: m, bump };
            let mut data = pda.try_borrow_mut_data()?;
            let mut slice: &mut [u8] = &mut data;
            mode_pda.try_serialize(&mut slice)?;
        }
    }

    Ok(())
}

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
