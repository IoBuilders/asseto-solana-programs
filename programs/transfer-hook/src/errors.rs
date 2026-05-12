use anchor_lang::prelude::*;

#[error_code]
pub enum TransferHookError {
    #[msg("Failed to compute extra account meta list size")]
    InvalidAccountSize,
    #[msg("Mint is in clearing mode: deployer signature is required")]
    ClearingModeUnauthorized,

    // ── Introspection: structural ───────────────────────────────────────────
    #[msg("Instructions sysvar could not be read")]
    InstructionsSysvarUnreadable,
    #[msg("No previous top-level instruction: transfer::verify_transfer must run as instruction N-1")]
    NoPreviousInstruction,

    // ── Introspection: previous instruction (must be verify_transfer) ───────
    #[msg("Previous top-level instruction's program is not transfer")]
    PrevInstructionWrongProgram,
    #[msg("Previous top-level instruction is not transfer::verify_transfer")]
    PrevInstructionNotVerifyTransfer,
    #[msg("Previous transfer::verify_transfer arguments do not match the transfer being hooked (amount / source / destination / mint)")]
    PrevInstructionArgumentMismatch,

    // ── Introspection: current instruction (must be transfer or transfer_checked) ──
    #[msg("Current top-level instruction's program is neither transfer nor token-2022")]
    CurrentInstructionUnknownProgram,
    #[msg("Current top-level instruction is neither transfer::transfer nor token-2022::transfer_checked")]
    CurrentInstructionNotTransferOrTransferChecked,
    #[msg("Current top-level instruction's arguments do not match the transfer being hooked (amount / source / destination / mint)")]
    CurrentInstructionArgumentMismatch,
}
