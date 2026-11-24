use anchor_lang::prelude::*;

#[error_code]
pub enum MintError {
    #[msg("The batch must contain at least one destination")]
    EmptyBatch,
    #[msg(
        "Expected exactly three remaining accounts (destination + control-list PDA + destination owner) per destination"
    )]
    InvalidRemainingAccounts,
    #[msg("The sum of the batch amounts overflows u64")]
    AmountOverflow,
    #[msg("The destination token account does not exist and no destination owner was provided to create it")]
    MissingDestinationOwner,
}
