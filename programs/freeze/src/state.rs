use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace, Default)]
pub struct FreezeState {
    pub fully_frozen: bool,
    /// Partial-freeze side; 0 means "no partial freeze".
    pub frozen_balance: u64,
    pub bump: u8,
}

impl FreezeState {
    pub const SPACE: usize = Self::DISCRIMINATOR.len() + Self::INIT_SPACE;

    pub fn is_partially_frozen(&self) -> bool {
        self.frozen_balance > 0
    }

    pub fn is_empty(&self) -> bool {
        !self.fully_frozen && !self.is_partially_frozen()
    }
}

pub(crate) fn load_freeze_state<'info>(
    freeze_state_pda: &'info AccountInfo<'info>,
) -> Result<Option<FreezeState>> {
    if freeze_state_pda.data_is_empty() {
        return Ok(None);
    }
    Ok(Some(
        Account::<FreezeState>::try_from(freeze_state_pda)?.into_inner(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(fully_frozen: bool, frozen_balance: u64) -> FreezeState {
        FreezeState {
            fully_frozen,
            frozen_balance,
            bump: 255,
        }
    }

    #[test]
    fn is_empty_only_when_both_sides_are_clear() {
        assert!(state(false, 0).is_empty());
        assert!(!state(true, 0).is_empty());
        assert!(!state(false, 1).is_empty());
        assert!(!state(true, 10).is_empty());
    }

    #[test]
    fn partial_side_is_a_non_zero_balance() {
        assert!(state(false, 40).is_partially_frozen());
        assert!(state(true, 40).is_partially_frozen());
        assert!(!state(true, 0).is_partially_frozen());
    }

    #[test]
    fn space_covers_discriminator_and_fields() {
        assert_eq!(FreezeState::SPACE, 8 + 1 + 8 + 1);
    }
}
