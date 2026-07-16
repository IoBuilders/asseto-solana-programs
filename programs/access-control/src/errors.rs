use anchor_lang::prelude::*;

#[error_code]
pub enum AccessControlError {
    #[msg("Role id is past the mask capacity")]
    RoleOutOfBounds,
    #[msg("Only the deployer can authorize this instruction")]
    Unauthorized,
}
