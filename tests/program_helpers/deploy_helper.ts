import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { DEPLOY_PROGRAM_ID, SYSTEM_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID } from "../utils/address_utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Deploy } from "../../target/types/deploy";
import { DeployerWithPayerContext } from "./base_helper";
import { getEvent } from "./event_helper";
import * as pdaUtils from "../utils/pda_utils";

function getDeployProgram(): Program<Deploy> {
  return anchor.workspace.Deploy as Program<Deploy>;
}

type DeployMintArgs = {
  decimals?: number;
  name?: string;
  symbol?: string;
  uri?: string;
  additionalMetadata?: { key: string; value: string }[];
};

function getDefaultArgs(): Required<DeployMintArgs> {
  return {
    decimals: 6,
    name: "Test Token",
    symbol: "TEST_TOKEN",
    uri: "https://example.com/metadata.json",
    additionalMetadata: [],
  };
}

export async function deployMint(
  callContext: DeployerWithPayerContext,
  args?: DeployMintArgs
): Promise<{ mint: PublicKey; signature: string }> {
  const effectiveArgs: Required<DeployMintArgs> = {
    ...getDefaultArgs(),
    ...args,
  };

  const signers = callContext?.signers ? callContext.signers : [Keypair.generate()];
  const mintKeypair = signers[0];
  const mint = mintKeypair.publicKey;

  const signature = await getDeployProgram()
    .methods.deployMint({
      decimals: effectiveArgs.decimals,
      name: effectiveArgs.name,
      symbol: effectiveArgs.symbol,
      uri: effectiveArgs.uri,
      additionalMetadata: effectiveArgs.additionalMetadata,
    })
    .accountsStrict({
      payer: callContext.payer ?? callContext.deployer,
      deployer: callContext.deployer,
      mint: mint,
      mintOwnerPda: pdaUtils.mintOwnerPda(mint),
      tempMintAuthority: pdaUtils.tempMintAuthorityPda(mint),
      mintAuthority: pdaUtils.mintAuthorityPda(mint),
      permanentDelegateAuthority: pdaUtils.permanentDelegatePda(mint),
      metadataUpdateAuthority: pdaUtils.metadataUpdateAuthorityPda(mint),
      pausableAuthority: pdaUtils.pausableAuthorityPda(mint),
      freezeAuthority: pdaUtils.freezeAuthorityPda(mint),
      transferHookAuthority: pdaUtils.transferHookAuthorityPda(mint),
      extraAccountMetaList: pdaUtils.extraAccountMetaListPda(mint),
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
      eventAuthority: pdaUtils.deployEventAuthorityPda(),
      program: DEPLOY_PROGRAM_ID,
    })
    .signers([mintKeypair])
    .rpc({ commitment: "confirmed" });

  return { mint, signature };
}

type MintDeployedEvent = {
  mint: PublicKey;
  deployer: PublicKey;
  decimals: number;
  name: string;
  symbol: string;
  uri: string;
  isin: string | null;
};

/**
 * Decodes the `MintDeployed` event from a `deploy_mint` transaction. The coder
 * returns the name in camelCase (`mintDeployed`). Delegates to the shared,
 * emit!/emit_cpi!-agnostic event helper.
 */
export async function getMintDeployedEvent(signature: string) {
  return getEvent<MintDeployedEvent>(getDeployProgram(), signature, "mintDeployed");
}

export async function getMintOwner(mint: PublicKey) {
  const pda = pdaUtils.mintOwnerPda(mint);
  return await getDeployProgram().account.mintOwner.fetch(pda, "confirmed");
}
