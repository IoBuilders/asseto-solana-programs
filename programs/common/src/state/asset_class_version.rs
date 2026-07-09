use anchor_lang::prelude::*;
use anchor_lang::ZeroCopy;
use bytemuck::{Pod, Zeroable};

/// Global capacity, in bits, of every asset-class version's functionality mask.
pub const FUNCTIONALITIES_BITS_MASK: usize = 8_192;
/// Number of bits packed into each mask's chunk, defined by the mask's [u8, N]
pub const FUNCTIONALITIES_MASK_CHUNK_BITS: usize = 8;
/// Capacity of the mask in bytes
pub const FUNCTIONALITIES_BYTES_MASK: usize =
    FUNCTIONALITIES_BITS_MASK / FUNCTIONALITIES_MASK_CHUNK_BITS;

/// Full field-for-field mirror of `factory::state::AssetClassVersion`,
/// which must stay in sync with this struct, field for field.
/// A compile-time size assertion in `factory/src/state.rs` guards against divergence.
///
/// Defined in `common` so all downstream programs can deserialize it without
/// importing `factory` (which would create circular dependencies).
#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
pub struct AssetClassVersion {
    pub config_id: u64,
    pub version: u64,
    pub state: u8,
    pub bump: u8,
    pub _padding: [u8; 6],
    pub mask: [u8; FUNCTIONALITIES_BYTES_MASK],
}

impl Discriminator for AssetClassVersion {
    /// The 8-byte Anchor account discriminator for `factory::state::AssetClassVersion`
    /// Computed here since this crate has no `declare_id!`/`#[account]` to derive it from
    /// Defined in `common` so all downstream programs can deserialize it
    const DISCRIMINATOR: &'static [u8] = &[255, 193, 180, 87, 186, 245, 78, 199];
}

// Defines the owner program of the Account<MintOwner>
impl Owner for AssetClassVersion {
    fn owner() -> Pubkey {
        crate::program_ids::FACTORY_PROGRAM_ID
    }
}

// Not `#[account]`-tagged zero-copy structs need to manually implement this
impl ZeroCopy for AssetClassVersion {}

// Not `#[account]`-tagged zero-copy structs need to manually implement this
#[cfg(feature = "idl-build")]
impl IdlBuild for AssetClassVersion {}
