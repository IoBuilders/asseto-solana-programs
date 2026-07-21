use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Caller is not an authorised PDA (mint_authority, permanent_delegate, or transfer)")]
    Unauthorized,
    #[msg("The provided token account is wrong")]
    InvalidTokenAccount,
    #[msg("Snapshot delta adjustment overflows the holder balance")]
    DeltaOverflow,
    #[msg("snapshot counter overflow when creating new snapshot")]
    SnapshotCounterOverflow,
    #[msg("The provided snapshot_merkle_root account does not match the expected PDA")]
    InvalidMerkleRootAccount,
}
