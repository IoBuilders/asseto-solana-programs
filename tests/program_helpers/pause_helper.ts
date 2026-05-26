import * as pdaUtils from "../utils/pda_utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Pause } from "../../target/types/pause";
import { MintWriteContext } from "./base_helper";

function getPauseProgram(): Program<Pause> {
  return anchor.workspace.Pause as Program<Pause>;
}

export async function pauseMint(callContext: MintWriteContext): Promise<void> {
  await getPauseProgram()
    .methods.pause()
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      pausableAuthority: pdaUtils.pausableAuthorityPda(callContext.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export async function unpauseMint(params: MintWriteContext): Promise<void> {
  await getPauseProgram()
    .methods.unpause()
    .accountsStrict({
      deployer: params.deployer,
      mint: params.mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(params.mint),
      deactivatePda: pdaUtils.deactivatePda(params.mint),
      pausableAuthority: pdaUtils.pausableAuthorityPda(params.mint),
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc({ commitment: "confirmed" });
}
