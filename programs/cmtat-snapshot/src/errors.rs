use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Caller is not an authorised PDA (mint_authority, permanent_delegate, or transfer)")]
    Unauthorized,
    #[msg("The provided total_supply_snapshot account does not match the expected PDA for this mint and snapshot")]
    InvalidTotalSupplyPda,
    #[msg("The provided token account is wrong")]
    InvalidTokenAccount,
}
