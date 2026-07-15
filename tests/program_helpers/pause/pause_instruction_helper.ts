import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Pause } from "../../../target/types/pause";
import { MintWriteContext } from "../base_helper";
import { PublicKey } from "@solana/web3.js";
import { getEvent } from "../event_helper";
import { getMintOwner } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { PAUSE_PROGRAM_ID } from "../../utils/address_utils";
import { pausableAuthorityPda, pauseEventAuthorityPda } from "./pause_pda_helper";

function getPauseProgram(): Program<Pause> {
  return anchor.workspace.Pause as Program<Pause>;
}

// ── pause ────────────────────────────────────────────────────────────────────

export async function pauseMint(callContext: MintWriteContext): Promise<{ signature: string }> {
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const signature = await getPauseProgram()
    .methods.pause()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      pausableAuthority: pausableAuthorityPda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      eventAuthority: pauseEventAuthorityPda(),
      program: PAUSE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type PausedEvent = {
  mint: PublicKey;
  operator: PublicKey;
};

/**
 * Decodes the `PausedEvent` event from a `pause` transaction. The coder
 * returns the name in camelCase (`paused`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getPausedEvent(signature: string) {
  return getEvent<PausedEvent>(getPauseProgram(), signature, "paused");
}

// ── unpause ──────────────────────────────────────────────────────────────────

export async function unpauseMint(callContext: MintWriteContext): Promise<{ signature: string }> {
  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const signature = await getPauseProgram()
    .methods.unpause()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      pausableAuthority: pausableAuthorityPda(callContext.mint),
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      eventAuthority: pauseEventAuthorityPda(),
      program: PAUSE_PROGRAM_ID,
    })
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type UnpausedEvent = {
  mint: PublicKey;
  operator: PublicKey;
};

/**
 * Decodes the `UnpausedEvent` event from an `unpause` transaction. The coder
 * returns the name in camelCase (`unpaused`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getUnpausedEvent(signature: string) {
  return getEvent<UnpausedEvent>(getPauseProgram(), signature, "unpaused");
}
