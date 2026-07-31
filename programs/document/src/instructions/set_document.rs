use anchor_lang::prelude::*;
use common::program_ids as constants;
use common::state::{AssetClassVersion, AssetConfiguration, Roles};
use common::{
    pda_seeds, pda_utils, require_active, require_functionality, require_not_paused, require_role,
    roles,
};

use crate::errors::ErrorCode;
use crate::events::DocumentUpdated;
use crate::state::Document;

pub fn set_document<'info>(
    ctx: Context<'info, SetDocument<'info>>,
    name: [u8; 32],
    uri: String,
    document_hash: [u8; 32],
) -> Result<()> {
    require_role(
        ctx.accounts.authority_roles_pda.load()?,
        roles::ROLE_DOCUMENT_MANAGER,
    )?;
    require_functionality(
        ctx.accounts.asset_class_version_pda.load()?,
        common::functionalities::DOCUMENT_SET_DOCUMENT,
    )?;
    require_not_paused(&ctx.accounts.mint.to_account_info())?;
    require_active(&ctx.accounts.deactivate_pda.to_account_info())?;

    require!(!uri.is_empty(), ErrorCode::EmptyUri);

    let space_needed = Document::space(uri.len());

    let document_pda = &ctx.accounts.document_pda;

    let document = if document_pda.data_is_empty() {
        let bump = ctx.bumps.document_pda;
        let signer_seeds = pda_utils::build_pda_signer_seeds(
            pda_seeds::document_seeds(ctx.accounts.mint.key, name.as_ref()),
            &bump,
        );
        pda_utils::create_or_adopt_pda(
            &ctx.accounts.payer,
            document_pda,
            &ctx.accounts.system_program,
            &ctx.program_id,
            space_needed,
            &signer_seeds,
        )?;
        Document {
            mint: ctx.accounts.mint.key(),
            name,
            uri: uri.clone(),
            document_hash,
            bump,
        }
    } else {
        let existing_document = Account::<Document>::try_from(document_pda)?;
        pda_utils::resize_pda(
            &ctx.accounts.payer,
            &ctx.accounts.system_program,
            document_pda,
            space_needed,
        )?;
        Document {
            name,
            uri: uri.clone(),
            document_hash,
            ..existing_document.into_inner()
        }
    };

    pda_utils::serialize_pda(&ctx.accounts.document_pda, &document)?;

    emit_cpi!(DocumentUpdated {
        mint: document.mint,
        operator: ctx.accounts.authority.key(),
        name,
        uri,
        document_hash,
    });

    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(name: [u8; 32], uri: String)]
pub struct SetDocument<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub authority: Signer<'info>,

    #[account(
        seeds = [pda_seeds::ROLES, mint.key().as_ref(), authority.key().as_ref()],
        seeds::program = constants::ACCESS_CONTROL_PROGRAM_ID,
        bump = authority_roles_pda.load()?.bump,
    )]
    pub authority_roles_pda: AccountLoader<'info, Roles>,

    #[account(
        seeds = [pda_seeds::ASSET_CONFIGURATION, mint.key().as_ref()],
        seeds::program = constants::DEPLOY_PROGRAM_ID,
        bump = asset_configuration_pda.bump,
    )]
    pub asset_configuration_pda: Account<'info, AssetConfiguration>,

    /// CHECK: Address verified by seeds/bump; emptiness checked by require_active.
    #[account(
        seeds = [pda_seeds::DEACTIVATE, mint.key().as_ref()],
        seeds::program = constants::DEACTIVATE_PROGRAM_ID,
        bump,
    )]
    pub deactivate_pda: UncheckedAccount<'info>,

    /// CHECK: Read-only; pause state validated by require_not_paused.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: Address verified by seeds/bump. Created, resized, and written by
    /// the handler instead of by `init_if_needed`, because Anchor's init
    /// constraint asserts `space == data_len()` on every call and this
    /// account's size is a function of the `uri` argument. Owner and
    /// discriminator are checked in the handler before an existing account
    /// is overwritten.
    #[account(
        mut,
        seeds = [pda_seeds::DOCUMENT, mint.key().as_ref(), name.as_ref()],
        bump,
    )]
    pub document_pda: UncheckedAccount<'info>,

    #[account(
        seeds = [
            pda_seeds::ASSET_CLASS_VERSION,
            &asset_configuration_pda.asset_class_config_id.to_le_bytes(),
            &asset_configuration_pda.asset_class_version_id.to_le_bytes()
        ],
        seeds::program = constants::FACTORY_PROGRAM_ID,
        bump = asset_class_version_pda.load()?.bump,
    )]
    pub asset_class_version_pda: AccountLoader<'info, AssetClassVersion>,

    pub system_program: Program<'info, System>,
}
