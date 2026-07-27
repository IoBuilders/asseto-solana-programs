use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::pubkey::Pubkey;
use solana_system_interface::instruction as system_instruction;

pub fn is_caller_pda(caller: &Pubkey, program_seeds: &[&[u8]], program_id: &Pubkey) -> bool {
    let (pda, _) = Pubkey::find_program_address(program_seeds, program_id);
    pda == *caller
}

pub fn build_pda_signer_seeds<'info>(
    mut seeds: Vec<&'info [u8]>,
    bump: &'info u8,
) -> Vec<&'info [u8]> {
    seeds.push(std::slice::from_ref(bump));
    seeds
}

pub fn create_or_adopt_pda<'info>(
    payer: &AccountInfo<'info>,
    pda: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    program_id: &Pubkey,
    space: usize,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let rent_exempt_lamports = Rent::get()?.minimum_balance(space);
    let current_lamports = pda.lamports();

    if current_lamports == 0 {
        // Normal path: no lamports yet, a single create_account does it all.
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                pda.key,
                rent_exempt_lamports,
                space as u64,
                program_id,
            ),
            &[payer.clone(), pda.clone(), system_program.clone()],
            &[signer_seeds],
        )?;
    } else {
        // Pre-funded (possibly by a griefer): create_account would fail, so
        // top up to rent-exemption then allocate + assign manually.
        let rent_deficit = rent_exempt_lamports.saturating_sub(current_lamports);
        if rent_deficit > 0 {
            invoke(
                &system_instruction::transfer(payer.key, pda.key, rent_deficit),
                &[payer.clone(), pda.clone(), system_program.clone()],
            )?;
        }

        invoke_signed(
            &system_instruction::allocate(pda.key, space as u64),
            &[pda.clone(), system_program.clone()],
            &[signer_seeds],
        )?;

        invoke_signed(
            &system_instruction::assign(pda.key, program_id),
            &[pda.clone(), system_program.clone()],
            &[signer_seeds],
        )?;
    }

    Ok(())
}

/// Closes `pda`, returning its lamports to `authority` and zeroing its data.
///
/// The manual counterpart to Anchor's `#[account(close = authority)]`
/// constraint, needed anywhere a PDA is closed via `remaining_accounts` rather
/// than through a typed Anchor account (Anchor's `close` constraint can't
/// target a variable-length account list). Callers are expected to have
/// already verified `pda` is the expected account and is non-empty.
pub fn close_pda(pda: &AccountInfo, authority: &AccountInfo) -> Result<()> {
    let lamports = pda.lamports();
    **pda.try_borrow_mut_lamports()? = 0;
    **authority.try_borrow_mut_lamports()? = authority
        .lamports()
        .checked_add(lamports)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    pda.try_borrow_mut_data()?.fill(0);
    Ok(())
}
