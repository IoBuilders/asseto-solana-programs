use crate::CommonError::InvalidHoldPositionData;
use anchor_lang::prelude::*;

/// Full field-for-field mirror of `hold::state::HoldPosition`, which must stay in
/// sync with this struct. A compile-time size assertion in `hold/src/state.rs`
/// guards against divergence.
///
/// Defined in `common` so downstream programs can read the lien without importing
/// `hold` — `hold` already depends on `operations`, so `operations` importing
/// `hold` would be circular.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct HoldPosition {
    pub mint: Pubkey,
    pub token_account: Pubkey,
    pub held_amount: u64,
    pub hold_count: u64,
    pub bump: u8,
}

impl Discriminator for HoldPosition {
    /// The 8-byte Anchor account discriminator for `hold::state::HoldPosition`
    /// Computed here since this crate has no `declare_id!`/`#[account]` to derive it from
    const DISCRIMINATOR: &'static [u8] = &[126, 32, 74, 45, 205, 98, 8, 28];
}

impl Owner for HoldPosition {
    fn owner() -> Pubkey {
        crate::program_ids::HOLD_PROGRAM_ID
    }
}

impl AccountDeserialize for HoldPosition {
    fn try_deserialize(buf: &mut &[u8]) -> Result<Self> {
        if buf.len() < Self::DISCRIMINATOR.len() {
            return Err(ErrorCode::AccountDiscriminatorNotFound.into());
        }
        let given_disc = &buf[..Self::DISCRIMINATOR.len()];
        if given_disc != Self::DISCRIMINATOR {
            return Err(ErrorCode::AccountDiscriminatorMismatch.into());
        }
        Self::try_deserialize_unchecked(buf)
    }

    fn try_deserialize_unchecked(buf: &mut &[u8]) -> Result<Self> {
        HoldPosition::deserialize(&mut &buf[Self::DISCRIMINATOR.len()..])
            .map_err(|_| error!(InvalidHoldPositionData))
    }
}

// No-op: We can't write to another program's account.
impl AccountSerialize for HoldPosition {}
