use anchor_lang::solana_program::pubkey::Pubkey;

pub fn is_caller_pda(caller: &Pubkey, program_seeds: &[&[u8]], program_id: &Pubkey) -> bool {
    let (pda, _) = Pubkey::find_program_address(program_seeds, program_id);
    pda == *caller
}

pub fn build_pda_signer_seeds<'info>(mut seeds: Vec<&'info [u8]>, bump: &'info u8) -> Vec<&'info [u8]> {
    seeds.push(std::slice::from_ref(bump));
    seeds
}
