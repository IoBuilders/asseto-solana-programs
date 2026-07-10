import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  SYSTEM_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  OPERATIONS_PROGRAM_ID,
} from "../../utils/address_utils";
import { MintWriteContext } from "../base_helper";
import { getEvent } from "../event_helper";
import { getMintOwner } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { Operations } from "../../../target/types/operations";
import { permanentDelegatePda, operationsEventAuthorityPda } from "./burn_pda_helper";

export function getOperationsProgram(): Program<Operations> {
  return anchor.workspace.Operations as Program<Operations>;
}

// ── burn ─────────────────────────────────────────────────────────────────────

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

export async function burnTokens(
  callContext: BurnTokensContext,
  args?: BurnTokensArgs
): Promise<{ signature: string }> {
  const effectiveArgs: Required<BurnTokensArgs> = {
    ...getDefaultArgs(),
    ...args,
  };

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  const signature = await getOperationsProgram()
    .methods.burn(effectiveArgs.amount)
    .accountsStrict({
      deployer: callContext.deployer,
      mint: callContext.mint,
      tokenAccount: callContext.tokenAccount,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: pdaUtils.deactivatePda(callContext.mint),
      operationsAuthority: permanentDelegatePda(callContext.mint),
      freezeAuthority: pdaUtils.freezeAuthorityPda(callContext.mint),
      snapshotCounterPda: pdaUtils.snapshotCounterPda(callContext.mint),
      totalSupplySnapshot: pdaUtils.snapshotTotalSupplyPda(callContext.mint),
      holderBalanceSnapshot: pdaUtils.snapshotHolderBalancePda(callContext.mint, callContext.tokenAccount),
      freezeProgram: FREEZE_PROGRAM_ID,
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: operationsEventAuthorityPda(),
      program: OPERATIONS_PROGRAM_ID,
    })
    .signers(callContext?.signers ?? [])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

type ControllerRedemptionEvent = {
  mint: PublicKey;
  controller: PublicKey;
  from: PublicKey;
  value: anchor.BN;
};

/**
 * Decodes the `ControllerRedemption` event from a `burn` transaction. The coder
 * returns the name in camelCase (`controllerRedemption`). Delegates to the
 * shared, emit!/emit_cpi!-agnostic event helper.
 */
export async function getControllerRedemptionEvent(signature: string) {
  return getEvent<ControllerRedemptionEvent>(getOperationsProgram(), signature, "controllerRedemption");
}
