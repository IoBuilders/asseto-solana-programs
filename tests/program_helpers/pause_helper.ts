import * as pdaUtils from "../utils/pda_utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Pause } from "../../target/types/pause";
import { MintWriteContext } from "./base_helper";
import { PublicKey } from "@solana/web3.js";
import { getEvent } from "./event_helper";
import { PAUSE_PROGRAM_ID } from "../utils/address_utils";

function getPauseProgram(): Program<Pause> {
  return anchor.workspace.Pause as Program<Pause>;
}

export async function pauseMint(callContext: MintWriteContext): Promise<{ signature: string }> {
  const signature = await getPauseProgram()
    .methods.pause()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      pausableAuthority: pdaUtils.pausableAuthorityPda(callContext.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      eventAuthority: pdaUtils.pauseEventAuthorityPda(),
      program: PAUSE_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

export async function unpauseMint(params: MintWriteContext): Promise<{ signature: string }> {
  const signature = await getPauseProgram()
    .methods.unpause()
    .accountsStrict({
      deployer: params.deployer,
      mint: params.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(params.mint),
      deactivatePda: pdaUtils.deactivatePda(params.mint),
      pausableAuthority: pdaUtils.pausableAuthorityPda(params.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      eventAuthority: pdaUtils.pauseEventAuthorityPda(),
      program: PAUSE_PROGRAM_ID,
    })
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type PausedEvent = {
  mint: PublicKey;
  operator: PublicKey;
};

type UnpausedEvent = {
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

/**
 * Decodes the `UnpausedEvent` event from an `unpause` transaction. The coder
 * returns the name in camelCase (`unpaused`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getUnpausedEvent(signature: string) {
  return getEvent<UnpausedEvent>(getPauseProgram(), signature, "unpaused");
}
