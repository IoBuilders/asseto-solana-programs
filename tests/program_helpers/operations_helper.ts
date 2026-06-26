import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, FREEZE_PROGRAM_ID, SNAPSHOT_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Operations } from "../../target/types/operations";

export type BurnTokensContext = MintWriteContext & {
  tokenAccount: PublicKey;
};

type BurnTokensArgs = {
  amount?: anchor.BN;
};

function getDefaultArgs(): Required<BurnTokensArgs> {
  return {
    amount: new anchor.BN(1),
  };
}

export async function burnTokens(callContext: BurnTokensContext, args?: BurnTokensArgs): Promise<void> {
  const effectiveArgs: Required<BurnTokensArgs> = {
    ...getDefaultArgs(),
    ...args,
  };

  const operationsProgram = anchor.workspace.Operations as Program<Operations>;

  await operationsProgram.methods
    .burn(effectiveArgs.amount)
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      tokenAccount: callContext.tokenAccount,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      operationsAuthority: pdaUtils.permanentDelegatePda(callContext.mint),
      freezeAuthority: pdaUtils.freezeAuthorityPda(callContext.mint),
      snapshotCounterPda: pdaUtils.snapshotCounterPda(callContext.mint),
      totalSupplySnapshot: pdaUtils.snapshotTotalSupplyPda(callContext.mint),
      holderBalanceSnapshot: pdaUtils.snapshotHolderBalancePda(callContext.mint, callContext.tokenAccount),
      freezeProgram: FREEZE_PROGRAM_ID,
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "processed" });
}
