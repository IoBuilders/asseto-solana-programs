import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { Factory } from "../../target/types/factory";
import { FACTORY_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../utils/address_utils";
import * as pdaUtils from "../utils/pda_utils";
import { BaseWriteContext, PayerContext } from "./base_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "./account_helper";

function getFactoryProgram(): Program<Factory> {
  return anchor.workspace.Factory as Program<Factory>;
}

export type InitializeFactoryContext = BaseWriteContext & PayerContext;

export async function initializeFactory(manager: PublicKey, callContext: InitializeFactoryContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const payer = callContext.payer ?? program.provider.publicKey!;

  await program.methods
    .initialize(manager)
    .accountsStrict({
      payer,
      factory: pdaUtils.factoryPda(),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export type NominateManagerContext = BaseWriteContext & { currentManager?: PublicKey };

export async function nominateManager(newManager: PublicKey, callContext: NominateManagerContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const currentManager = callContext.currentManager ?? program.provider.publicKey!;

  await program.methods
    .nominateManager(newManager)
    .accountsStrict({
      currentManager,
      factory: pdaUtils.factoryPda(),
      factoryPendingManagerPda: pdaUtils.factoryPendingManagerPda(),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export type AcceptNominationContext = BaseWriteContext & { pendingManager?: PublicKey };

export async function acceptNomination(callContext: AcceptNominationContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const pendingManager = callContext.pendingManager ?? program.provider.publicKey!;

  await program.methods
    .acceptNomination()
    .accountsStrict({
      pendingManager,
      factory: pdaUtils.factoryPda(),
      factoryPendingManagerPda: pdaUtils.factoryPendingManagerPda(),
    })
    .signers(callContext.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export type CancelNominationContext = BaseWriteContext & { currentManager?: PublicKey };

export async function cancelNomination(callContext: CancelNominationContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const currentManager = callContext.currentManager ?? program.provider.publicKey!;

  await program.methods
    .cancelNomination()
    .accountsStrict({
      currentManager,
      factory: pdaUtils.factoryPda(),
      factoryPendingManagerPda: pdaUtils.factoryPendingManagerPda(),
    })
    .signers(callContext.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export type CreateAssetClassContext = BaseWriteContext & { manager?: PublicKey };

export async function createAssetClass(
  configId: anchor.BN,
  owner: PublicKey,
  callContext: CreateAssetClassContext = {}
): Promise<void> {
  const program = getFactoryProgram();
  const manager = callContext.manager ?? program.provider.publicKey!;

  await program.methods
    .createAssetClass(configId, owner)
    .accountsStrict({
      manager,
      factory: pdaUtils.factoryPda(),
      assetClassOwnershipPda: pdaUtils.assetClassOwnershipPda(configId),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export async function getFactory(pda: PublicKey = pdaUtils.factoryPda()) {
  return await getFactoryProgram().account.factory.fetch(pda, "confirmed");
}

export async function getFactoryPendingManager(pda: PublicKey = pdaUtils.factoryPendingManagerPda()) {
  return await getFactoryProgram().account.factoryPendingManager.fetch(pda, "confirmed");
}

export async function getAssetClassOwnership(configId: anchor.BN) {
  return await getFactoryProgram().account.assetClassOwnership.fetch(
    pdaUtils.assetClassOwnershipPda(configId),
    "confirmed"
  );
}

/**
 * Borsh-encodes a `Factory` (discriminator + manager + pause + bump) the way the
 * program stores it on-chain. Used by tests that plant factory state directly
 * via a surfpool cheatcode.
 */
export async function encodeFactory(manager: PublicKey, pause: boolean, bump: number): Promise<Buffer> {
  return getFactoryProgram().coder.accounts.encode("factory", { manager, pause, bump });
}

/**
 * Borsh-encodes a `FactoryPendingManager` (discriminator + pending_manager +
 * bump). Used by tests that plant a pending nomination directly via a surfpool
 * cheatcode.
 */
export async function encodeFactoryPendingManager(pendingManager: PublicKey, bump: number): Promise<Buffer> {
  return getFactoryProgram().coder.accounts.encode("factoryPendingManager", { pendingManager, bump });
}

/**
 * Borsh-encodes an `AssetClassOwnership` (discriminator + owner + latest_version
 * + bump). Used by tests that plant an existing asset class directly via a
 * surfpool cheatcode.
 */
export async function encodeAssetClassOwnership(
  owner: PublicKey,
  latestVersion: anchor.BN,
  bump: number
): Promise<Buffer> {
  return getFactoryProgram().coder.accounts.encode("assetClassOwnership", { owner, latestVersion, bump });
}

/**
 * Test-only: plants the singleton `factory` PDA with the given `manager` and
 * `pause` flag via surfpool, so a test can control the factory state (manager
 * identity, paused/unpaused) before exercising an instruction.
 */
export async function setFactory(manager: PublicKey, pause: boolean): Promise<void> {
  const [pda, bump] = pdaUtils.factoryPdaWithBump();
  const data = await encodeFactory(manager, pause, bump);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FACTORY_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

/**
 * Test-only: plants the singleton `factory_pending_manager` PDA with the given
 * `pendingManager` via surfpool, simulating an in-flight nomination.
 */
export async function setFactoryPendingManager(pendingManager: PublicKey): Promise<void> {
  const [pda, bump] = pdaUtils.factoryPendingManagerPdaWithBump();
  const data = await encodeFactoryPendingManager(pendingManager, bump);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FACTORY_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

/**
 * Test-only: removes the singleton `factory` PDA via surfpool by zeroing its
 * lamports, so the account reads back as non-existent. Lets a test exercise the
 * "factory not yet initialised" path independently of execution order.
 */
export async function clearFactory(): Promise<void> {
  await surfnetSetAccount(pdaUtils.factoryPda(), { lamports: 0 });
}

/**
 * Test-only: removes the singleton `factory_pending_manager` PDA via surfpool by
 * zeroing its lamports, so the account reads back as non-existent. Lets a test
 * exercise the "no pending nomination" path independently of execution order.
 */
export async function clearFactoryPendingManager(): Promise<void> {
  await surfnetSetAccount(pdaUtils.factoryPendingManagerPda(), { lamports: 0 });
}

/**
 * Test-only: plants the `asset_class_ownership` PDA for `configId` via surfpool,
 * simulating an asset class that already exists. The stored `owner` and
 * `latestVersion` (default 0) are written into the account content.
 */
export async function setAssetClassOwnership(
  configId: anchor.BN,
  owner: PublicKey,
  latestVersion: anchor.BN = new anchor.BN(0)
): Promise<void> {
  const [pda, bump] = pdaUtils.assetClassOwnershipPdaWithBump(configId);
  const data = await encodeAssetClassOwnership(owner, latestVersion, bump);
  const lamports = await getBalanceForRentExeption(data.length);
  await surfnetSetAccount(pda, {
    lamports,
    owner: FACTORY_PROGRAM_ID.toBase58(),
    data: data.toString("hex"),
    executable: false,
    rentEpoch: 0,
  });
}

/**
 * Test-only: removes the `asset_class_ownership` PDA for `configId` via surfpool
 * by zeroing its lamports, so the account reads back as non-existent. Lets a test
 * exercise the "no ownership" path independently of execution order.
 */
export async function clearAssetClassOwnership(configId: anchor.BN): Promise<void> {
  await surfnetSetAccount(pdaUtils.assetClassOwnershipPda(configId), { lamports: 0 });
}
