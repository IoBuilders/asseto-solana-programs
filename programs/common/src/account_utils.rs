use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use solana_system_interface::instruction as system_instruction;

/// Creates a program-owned PDA at `target`, tolerating an attacker having
/// pre-funded the (predictable) address with lamports.
///
/// `system_instruction::create_account` fails with `AccountAlreadyInUse` if the
/// destination already holds any lamports. Because a PDA address is
/// deterministic, anyone can compute it and send it 1 lamport before the program
/// creates it — permanently DoS'ing the creation of that PDA (and any flow that
/// depends on it). See the Solana SDK note on `create_account`'s "Security
/// issues".
///
/// This mirrors what Anchor's `#[account(init)]` does under the hood: when the
/// account is already funded, it tops up the rent difference (if any) and then
/// `allocate` + `assign`s the account to `owner`, instead of `create_account`.
/// An external attacker can only *fund* the address (adding lamports needs no
/// signature); it cannot `allocate`/`assign` a PDA (that requires the owning
/// program's `invoke_signed`), so the only hostile pre-state is
/// `lamports > 0, data empty, owner = system program`, which this handles.
///
/// The caller MUST ensure `target` is currently uninitialized (data empty)
/// before calling — this function does not inspect or preserve existing data.
///
/// `signer_seeds` must be the full PDA seeds **including** the bump, matching
/// `target`'s address.
pub fn create_or_adopt_pda<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    owner: &Pubkey,
    space: usize,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(space);
    let current_lamports = target.lamports();

    if current_lamports == 0 {
        // Normal path: no lamports yet, a single create_account does it all.
        invoke_signed(
            &system_instruction::create_account(payer.key, target.key, rent, space as u64, owner),
            &[payer.clone(), target.clone(), system_program.clone()],
            &[signer_seeds],
        )?;
    } else {
        // Pre-funded (possibly by a griefer): create_account would fail, so
        // top up to rent-exemption then allocate + assign manually.
        let deficit = rent.saturating_sub(current_lamports);
        if deficit > 0 {
            invoke(
                &system_instruction::transfer(payer.key, target.key, deficit),
                &[payer.clone(), target.clone(), system_program.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(target.key, space as u64),
            &[target.clone(), system_program.clone()],
            &[signer_seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(target.key, owner),
            &[target.clone(), system_program.clone()],
            &[signer_seeds],
        )?;
    }

    Ok(())
}
