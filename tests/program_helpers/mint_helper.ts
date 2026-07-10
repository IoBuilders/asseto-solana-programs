import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../utils/pda_utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, FREEZE_PROGRAM_ID, SNAPSHOT_PROGRAM_ID } from "../utils/address_utils";
import { MintWriteContext } from "./base_helper";
import { Program } from "@anchor-lang/core";
import { Mint } from "../../target/types/mint";
import { getEvent } from "./event_helper";
import { transferControlModePda, whitelistPda } from "./transfer_control/transfer_control_pda_helper";

function getMintProgram(): Program<Mint> {
  return anchor.workspace.Mint as Program<Mint>;
}

export type MintTokensContext = MintWriteContext & {
  destination: PublicKey;
};

type MintTokensArgs = {
  amount?: anchor.BN;
};

function getDefaultArgs(): Required<MintTokensArgs> {
  return {
    amount: new anchor.BN(1),
  };
}

export async function mintTokens(callContext: MintTokensContext, args?: MintTokensArgs): Promise<string> {
  const effectiveArgs: Required<MintTokensArgs> = {
    ...getDefaultArgs(),
    ...args,
  };

  const mintProgram = getMintProgram();

  return await mintProgram.methods
    .mint(effectiveArgs.amount)
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      destination: callContext.destination,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      mintAuthority: pdaUtils.mintAuthorityPda(callContext.mint),
      freezeAuthority: pdaUtils.freezeAuthorityPda(callContext.mint),
      transferControlModePda: transferControlModePda(callContext.mint),
      destinationWhitelistPda: whitelistPda(callContext.mint, callContext.destination),
      snapshotCounterPda: pdaUtils.snapshotCounterPda(callContext.mint),
      totalSupplySnapshot: pdaUtils.snapshotTotalSupplyPda(callContext.mint),
      holderBalanceSnapshot: pdaUtils.snapshotHolderBalancePda(callContext.mint, callContext.destination),
      freezeProgram: FREEZE_PROGRAM_ID,
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: pdaUtils.mintEventAuthorityPda(),
      program: mintProgram.programId,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

type IssuedEvent = {
  mint: PublicKey;
  operator: PublicKey;
  to: PublicKey;
  value: anchor.BN;
};

export async function getIssuedEvent(signature: string) {
  return getEvent<IssuedEvent>(getMintProgram(), signature, "issued");
}
