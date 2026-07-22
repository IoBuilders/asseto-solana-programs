import { AccountMeta, PublicKey } from "@solana/web3.js";
import * as pdaUtils from "../../utils/pda_utils";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@anchor-lang/core";
import { SYSTEM_PROGRAM_ID, FREEZE_PROGRAM_ID, SNAPSHOT_PROGRAM_ID } from "../../utils/address_utils";
import { MintWriteContext, MintWriteWithPayerContext } from "../base_helper";
import { Program } from "@anchor-lang/core";
import { Mint } from "../../../target/types/mint";
import { getEvent, getEvents } from "../event_helper";
import { getMintOwner } from "../deploy_helper";
import { assetClassVersionPda } from "../factory/factory_pda_helper";
import { transferControlModePda, whitelistPda } from "../transfer_control/transfer_control_pda_helper";
import { freezeAuthorityPda } from "../freeze/freeze_pda_helper";
import { mintAuthorityPda, mintEventAuthorityPda } from "./mint_pda_helper";
import { snapshotCounterPda, snapshotTotalSupplyPda, snapshotHolderBalancePda } from "../snapshot/snapshot_pda_helper";
import { rolesPda } from "../access_control/access_control_pda_helper";

export function getMintProgram(): Program<Mint> {
  return anchor.workspace.Mint as Program<Mint>;
}

// ── mint ───────────────────────────────────────────────────────────────────────

export type MintTokensContext = MintWriteWithPayerContext & {
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

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  return await mintProgram.methods
    .mint(effectiveArgs.amount)
    .accountsStrict({
      payer: callContext.payer ?? callContext.authority.publicKey,
      authority: callContext.authority.publicKey,
      mint: callContext.mint,
      destination: callContext.destination,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mintAuthority: mintAuthorityPda(callContext.mint),
      freezeAuthority: freezeAuthorityPda(callContext.mint),
      transferControlModePda: transferControlModePda(callContext.mint),
      destinationWhitelistPda: whitelistPda(callContext.mint, callContext.destination),
      snapshotCounterPda: snapshotCounterPda(callContext.mint),
      totalSupplySnapshot: snapshotTotalSupplyPda(callContext.mint),
      holderBalanceSnapshot: snapshotHolderBalancePda(callContext.mint, callContext.destination),
      freezeProgram: FREEZE_PROGRAM_ID,
      snapshotProgram: SNAPSHOT_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      eventAuthority: mintEventAuthorityPda(),
      program: mintProgram.programId,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      authorityRolesPda: rolesPda(callContext.mint, callContext.authority.publicKey),
    })
    .signers(callContext?.signers ?? [callContext.authority])
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

// ── batch_mint ───────────────────────────────────────────────────────────────

export type BatchMintTokensContext = MintWriteContext & {
  destinations: PublicKey[];
};

type BatchMintTokensArgs = {
  // The `amounts` instruction argument. Defaults to `1` per destination.
  amounts?: anchor.BN[];
  // Overrides the remaining accounts. Defaults to `[destination (writable), whitelistPda]`
  // per destination, in order. Provide this to exercise remaining-account error paths.
  remainingAccounts?: AccountMeta[];
};

export async function batchMintTokens(
  callContext: BatchMintTokensContext,
  args?: BatchMintTokensArgs
): Promise<string> {
  const mintProgram = getMintProgram();

  const authority = callContext.authority ?? mintProgram.provider.wallet.payer;

  const amounts = args?.amounts ?? callContext.destinations.map(() => new anchor.BN(1));

  // Two remaining accounts per destination, in order: [destination (writable), whitelistPda].
  const remainingAccounts: AccountMeta[] =
    args?.remainingAccounts ??
    callContext.destinations.flatMap((destination) => [
      { pubkey: destination, isWritable: true, isSigner: false },
      { pubkey: whitelistPda(callContext.mint, destination), isWritable: false, isSigner: false },
    ]);

  // The asset-class version PDA is derived from the ids recorded in the mint's
  // `mint_owner` account — the same values the on-chain program reads.
  const mintOwner = await getMintOwner(callContext.mint);

  return await mintProgram.methods
    .batchMint(amounts)
    .accountsStrict({
      authority: authority.publicKey,
      mintOwnerPda: pdaUtils.mintOwnerPda(callContext.mint),
      deactivatePda: deactivatePda(callContext.mint),
      mint: callContext.mint,
      mintAuthority: mintAuthorityPda(callContext.mint),
      freezeAuthority: freezeAuthorityPda(callContext.mint),
      transferControlModePda: transferControlModePda(callContext.mint),
      freezeProgram: FREEZE_PROGRAM_ID,
      assetClassVersionPda: assetClassVersionPda(mintOwner.assetClassConfigId, mintOwner.assetClassVersionId),
      token2022Program: TOKEN_2022_PROGRAM_ID,
      authorityRolesPda: rolesPda(callContext.mint, authority.publicKey),
      eventAuthority: mintEventAuthorityPda(),
      program: mintProgram.programId,
    })
    .remainingAccounts(remainingAccounts)
    .signers(callContext?.signers ?? [authority])
    .rpc({ commitment: "confirmed" });
}

export async function getIssuedEvents(signature: string): Promise<IssuedEvent[]> {
  return (await getEvents(getMintProgram(), signature))
    .filter((event) => event.name === "issued")
    .map((event) => event.data as IssuedEvent);
}
