import { PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  SYSTEM_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  OPERATIONS_PROGRAM_ID,
} from "../../utils/address_utils";
import { MintWriteWithPayerContext } from "../base_helper";
import { getEvent } from "../event_helper";
import { getAssetConfiguration } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { Operations } from "../../../target/types/operations";
import { permanentDelegatePda, operationsEventAuthorityPda } from "./burn_pda_helper";
import { freezeAuthorityPda } from "../freeze/freeze_pda_helper";
import { snapshotCounterPda, snapshotTotalSupplyPda, snapshotHolderBalancePda } from "../snapshot/snapshot_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";

export function getOperationsProgram(): Program<Operations> {
  return anchor.workspace.Operations as Program<Operations>;
}

// ── burn ─────────────────────────────────────────────────────────────────────

export type BurnTokensContext = MintWriteWithPayerContext & {
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
  getOperationsProgram();
  const effectiveArgs: Required<BurnTokensArgs> = {
    ...getDefaultArgs(),
    ...args,
  };

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `asset_configuration` account — the same values the on-chain program reads.
  const assetConfiguration = await getAssetConfiguration(callContext.mint);

  const signature = await getOperationsProgram()
    .methods.burn(effectiveArgs.amount)
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: callContext.authority.publicKey,
      mint: callContext.mint,
      tokenAccount: callContext.tokenAccount,
      assetConfigurationPda: pdaUtils.assetConfigurationPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      operationsAuthority: permanentDelegatePda(callContext.mint),
      freezeAuthority: freezeAuthorityPda(callContext.mint),
      snapshotCounterPda: snapshotCounterPda(callContext.mint),
      totalSupplySnapshot: snapshotTotalSupplyPda(callContext.mint),
      holderBalanceSnapshot: snapshotHolderBalancePda(callContext.mint, callContext.tokenAccount),
      freezeProgram: FREEZE_PROGRAM_ID,
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(
        assetConfiguration.assetClassConfigId,
        assetConfiguration.assetClassVersionId
      ),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: operationsEventAuthorityPda(),
      program: OPERATIONS_PROGRAM_ID,
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
    })
    .signers(callContext?.signers ?? [callContext.authority])
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
