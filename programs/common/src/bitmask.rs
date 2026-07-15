//! Generic `[u8; N]` bit-mask primitives, reused by every program that stores a
//! bit-mask (`factory` functionalities, `access-control` roles, and
//! `require_functionality`). Centralizes the arithmetic so no program repeats it.
//!
//! These helpers are error-type agnostic: on an out-of-range position they return
//! `Err(position)` — the offending `u16` — and leave it to the caller to raise its
//! own domain error (e.g. `map_err(|_| error!(RoleOutOfBounds))`). The bound is
//! derived from the mask length, so no per-domain capacity constant is needed here.

/// Bits packed into each byte of every workspace bit-mask (roles,
/// functionalities, …). The one truly-invariant mask constant; each domain
/// keeps its own capacity (`*_BITS_MASK`) and byte count (`*_BYTES_MASK`).
pub const MASK_CHUNK_BITS: usize = 8;

/// Maps a bit `position` to its `(byte, bit)` location within a mask of
/// `mask_len` bytes, or `Err(position)` if it is past the mask capacity.
fn locate(mask_len: usize, position: u16) -> Result<(usize, usize), u16> {
    let i = position as usize;
    if i < mask_len * MASK_CHUNK_BITS {
        Ok((i / MASK_CHUNK_BITS, i % MASK_CHUNK_BITS))
    } else {
        Err(position)
    }
}

/// Turns on (`= 1`) each bit in `positions`. Targeted merge — bits outside
/// `positions` are left untouched. Returns `Err(position)` for the first
/// out-of-range position, leaving the mask unchanged from that point on.
pub fn set_bits(mask: &mut [u8], positions: &[u16]) -> Result<(), u16> {
    for &position in positions {
        let (byte, bit) = locate(mask.len(), position)?;
        mask[byte] |= 1 << bit;
    }
    Ok(())
}

/// Turns off (`= 0`) each bit in `positions`. Targeted merge — bits outside
/// `positions` are left untouched. Returns `Err(position)` for the first
/// out-of-range position, leaving the mask unchanged from that point on.
pub fn clear_bits(mask: &mut [u8], positions: &[u16]) -> Result<(), u16> {
    for &position in positions {
        let (byte, bit) = locate(mask.len(), position)?;
        mask[byte] &= !(1 << bit);
    }
    Ok(())
}

/// Returns whether the bit at `position` is set, or `Err(position)` if it is
/// past the mask capacity.
pub fn is_set(mask: &[u8], position: u16) -> Result<bool, u16> {
    let (byte, bit) = locate(mask.len(), position)?;
    Ok((mask[byte] >> bit) & 1 == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_clear_and_read_round_trip() {
        let mut mask = [0u8; 4]; // 32 bits

        set_bits(&mut mask, &[0, 7, 8, 31]).unwrap();
        assert!(is_set(&mask, 0).unwrap());
        assert!(is_set(&mask, 7).unwrap()); // last bit of byte 0
        assert!(is_set(&mask, 8).unwrap()); // first bit of byte 1
        assert!(is_set(&mask, 31).unwrap()); // last bit
        assert!(!is_set(&mask, 1).unwrap());

        // Clearing is targeted: bit 7 stays set when only bit 0 is cleared.
        clear_bits(&mut mask, &[0]).unwrap();
        assert!(!is_set(&mask, 0).unwrap());
        assert!(is_set(&mask, 7).unwrap());
    }

    #[test]
    fn out_of_bounds_returns_the_offending_position() {
        let mut mask = [0u8; 4]; // valid positions: 0..=31
        assert_eq!(set_bits(&mut mask, &[32]), Err(32));
        assert_eq!(clear_bits(&mut mask, &[5, 40]), Err(40));
        assert_eq!(is_set(&mask, 32), Err(32));
    }
}
