import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Factory } from "../../target/types/factory";
import { FACTORY_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "../utils/address_utils";
import * as pdaUtils from "../utils/pda_utils";
import { BaseWriteContext, PayerContext } from "./base_helper";
import { getBalanceForRentExeption, surfnetSetAccount } from "./account_helper";

type NominateManagerArgs = {
  newManager: PublicKey;
};

type CreateAssetClassArgs = {
  configId: anchor.BN;
  owner: PublicKey;
};

type NominateAssetClassOwnerArgs = {
  configId: anchor.BN;
  newOwner: PublicKey;
};

type AssetClassOwnershipArgs = {
  configId: anchor.BN;
};

function getFactoryProgram(): Program<Factory> {
  return anchor.workspace.Factory as Program<Factory>;
}

export type InitializeFactoryContext = BaseWriteContext &
  PayerContext & {
    manager?: Keypair;
  };

export async function initializeFactory(callContext: InitializeFactoryContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const payer = callContext.payer ?? program.provider.publicKey!;
  const manager = callContext.manager ?? program.provider.wallet.payer;

  // `manager` is now a `Signer` account (not an instruction argument). The
  // caller must include the matching keypair in `callContext.signers`.
  await program.methods
    .initialize()
    .accountsStrict({
      payer,
      manager: manager.publicKey,
      factory: pdaUtils.factoryPda(),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [manager])
    .rpc({ commitment: "confirmed" });
}

export type NominateManagerContext = BaseWriteContext & { currentManager?: Keypair };

export async function nominateManager(
  callContext: NominateManagerContext = {},
  args: NominateManagerArgs
): Promise<void> {
  const program = getFactoryProgram();
  const currentManager = callContext.currentManager ?? program.provider.wallet.payer;
  const { newManager } = args;

  await program.methods
    .nominateManager(newManager)
    .accountsStrict({
      currentManager: currentManager.publicKey,
      factory: pdaUtils.factoryPda(),
      factoryPendingManagerPda: pdaUtils.factoryPendingManagerPda(),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [currentManager])
    .rpc({ commitment: "confirmed" });
}

export type AcceptNominationContext = BaseWriteContext & { pendingManager?: Keypair };

export async function acceptNomination(callContext: AcceptNominationContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const pendingManager = callContext.pendingManager ?? program.provider.wallet.payer;

  await program.methods
    .acceptNomination()
    .accountsStrict({
      pendingManager: pendingManager.publicKey,
      factory: pdaUtils.factoryPda(),
      factoryPendingManagerPda: pdaUtils.factoryPendingManagerPda(),
    })
    .signers(callContext.signers ?? [pendingManager])
    .rpc({ commitment: "confirmed" });
}

export type CancelNominationContext = BaseWriteContext & { currentManager?: Keypair };

export async function cancelNomination(callContext: CancelNominationContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const currentManager = callContext.currentManager ?? program.provider.wallet.payer;

  await program.methods
    .cancelNomination()
    .accountsStrict({
      currentManager: currentManager.publicKey,
      factory: pdaUtils.factoryPda(),
      factoryPendingManagerPda: pdaUtils.factoryPendingManagerPda(),
    })
    .signers(callContext.signers ?? [currentManager])
    .rpc({ commitment: "confirmed" });
}

export type CreateAssetClassContext = BaseWriteContext & { manager?: Keypair };

export async function createAssetClass(
  callContext: CreateAssetClassContext = {},
  args: CreateAssetClassArgs
): Promise<void> {
  const program = getFactoryProgram();
  const manager = callContext.manager ?? program.provider.wallet.payer;

  const { configId, owner } = args;

  await program.methods
    .createAssetClass(configId, owner)
    .accountsStrict({
      manager: manager.publicKey,
      factory: pdaUtils.factoryPda(),
      assetClassOwnershipPda: pdaUtils.assetClassOwnershipPda(configId),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [manager])
    .rpc({ commitment: "confirmed" });
}

export type NominateAssetClassOwnerContext = BaseWriteContext & { currentOwner?: Keypair };

export async function nominateAssetClassOwner(
  callContext: NominateAssetClassOwnerContext = {},
  args: NominateAssetClassOwnerArgs
): Promise<void> {
  const program = getFactoryProgram();
  const currentOwner = callContext.currentOwner ?? program.provider.wallet.payer;
  const { configId, newOwner } = args;

  await program.methods
    .nominateAssetClassOwner(configId, newOwner)
    .accountsStrict({
      currentOwner: currentOwner.publicKey,
      factory: pdaUtils.factoryPda(),
      assetClassOwnershipPda: pdaUtils.assetClassOwnershipPda(configId),
      assetClassPendingOwnerPda: pdaUtils.assetClassPendingOwnerPda(configId),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [currentOwner])
    .rpc({ commitment: "confirmed" });
}

export type AcceptAssetClassOwnershipContext = BaseWriteContext & { pendingOwner?: PublicKey };

export async function acceptAssetClassOwnership(
  callContext: AcceptAssetClassOwnershipContext = {},
  args: AssetClassOwnershipArgs
): Promise<void> {
  const program = getFactoryProgram();
  const pendingOwner = callContext.pendingOwner ?? program.provider.publicKey!;
  const { configId } = args;

  await program.methods
    .acceptAssetClassOwnership(configId)
    .accountsStrict({
      pendingOwner,
      factory: pdaUtils.factoryPda(),
      assetClassOwnershipPda: pdaUtils.assetClassOwnershipPda(configId),
      assetClassPendingOwnerPda: pdaUtils.assetClassPendingOwnerPda(configId),
    })
    .signers(callContext.signers ?? [])
    .rpc({ commitment: "confirmed" });
}

export type PauseFactoryContext = BaseWriteContext & { manager?: Keypair };

export async function pauseFactory(callContext: PauseFactoryContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const manager = callContext.manager ?? program.provider.wallet.payer;

  await program.methods
    .pause()
    .accountsStrict({
      manager: manager.publicKey,
      factory: pdaUtils.factoryPda(),
    })
    .signers(callContext.signers ?? [manager])
    .rpc({ commitment: "confirmed" });
}

export type UnpauseFactoryContext = BaseWriteContext & { manager?: Keypair };

export async function unpauseFactory(callContext: UnpauseFactoryContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const manager = callContext.manager ?? program.provider.wallet.payer;

  await program.methods
    .unpause()
    .accountsStrict({
      manager: manager.publicKey,
      factory: pdaUtils.factoryPda(),
    })
    .signers(callContext.signers ?? [manager])
    .rpc({ commitment: "confirmed" });
}

export type CancelAssetClassOwnershipContext = BaseWriteContext & { currentOwner?: PublicKey };

export async function cancelAssetClassOwnership(
  callContext: CancelAssetClassOwnershipContext = {},
  args: AssetClassOwnershipArgs
): Promise<void> {
  const program = getFactoryProgram();
  const currentOwner = callContext.currentOwner ?? program.provider.publicKey!;
  const { configId } = args;

  await program.methods
    .cancelAssetClassOwnership(configId)
    .accountsStrict({
      currentOwner,
      factory: pdaUtils.factoryPda(),
      assetClassOwnershipPda: pdaUtils.assetClassOwnershipPda(configId),
      assetClassPendingOwnerPda: pdaUtils.assetClassPendingOwnerPda(configId),
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

export async function getAssetClassPendingOwner(configId: anchor.BN) {
  return await getFactoryProgram().account.assetClassPendingOwner.fetch(
    pdaUtils.assetClassPendingOwnerPda(configId),
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
 * Borsh-encodes an `AssetClassPendingOwner` (discriminator + pending_owner +
 * bump). Used by tests that plant a pending ownership nomination directly via a
 * surfpool cheatcode.
 */
export async function encodeAssetClassPendingOwner(pendingOwner: PublicKey, bump: number): Promise<Buffer> {
  return getFactoryProgram().coder.accounts.encode("assetClassPendingOwner", { pendingOwner, bump });
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

/**
 * Test-only: plants the `asset_class_pending_owner` PDA for `configId` via
 * surfpool with the given `pendingOwner`, simulating an in-flight ownership
 * nomination.
 */
export async function setAssetClassPendingOwner(configId: anchor.BN, pendingOwner: PublicKey): Promise<void> {
  const [pda, bump] = pdaUtils.assetClassPendingOwnerPdaWithBump(configId);
  const data = await encodeAssetClassPendingOwner(pendingOwner, bump);
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
 * Test-only: removes the `asset_class_pending_owner` PDA for `configId` via
 * surfpool by zeroing its lamports, so the account reads back as non-existent.
 * Lets a test exercise the "no pending ownership nomination" path independently
 * of execution order.
 */
export async function clearAssetClassPendingOwner(configId: anchor.BN): Promise<void> {
  await surfnetSetAccount(pdaUtils.assetClassPendingOwnerPda(configId), { lamports: 0 });
}

// ── asset class version (deploy) ───────────────────────────────────────────────

/** Global mask capacity in bits (mirrors `FUNCTIONALITIES_BITS_MASK` on-chain). */
export const FUNCTIONALITIES_BITS_MASK = 8192;
/** Global mask capacity in bytes. */
export const FUNCTIONALITIES_BYTES_MASK = FUNCTIONALITIES_BITS_MASK / 8;

type InitAssetClassVersionArgs = {
  configId: anchor.BN;
  version: anchor.BN;
};

export type InitAssetClassVersionContext = BaseWriteContext & { owner?: Keypair };

export async function initAssetClassVersion(
  callContext: InitAssetClassVersionContext = {},
  args: InitAssetClassVersionArgs
): Promise<void> {
  const program = getFactoryProgram();
  const owner = callContext.owner ?? program.provider.wallet.payer;
  const { configId, version } = args;

  await program.methods
    .initAssetClassVersion(configId, version)
    .accountsStrict({
      owner: owner.publicKey,
      factory: pdaUtils.factoryPda(),
      assetClassOwnershipPda: pdaUtils.assetClassOwnershipPda(configId),
      assetClassVersionPda: pdaUtils.assetClassVersionPda(configId, version),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [owner])
    .rpc({ commitment: "confirmed" });
}

export type WriteAssetClassVersionMaskContext = BaseWriteContext & { owner?: Keypair };

type WriteAssetClassVersionMaskArgs = {
  configId: anchor.BN;
  version: anchor.BN;
  offset: number;
  chunk: Buffer;
};

export async function writeAssetClassVersionMask(
  callContext: WriteAssetClassVersionMaskContext = {},
  args: WriteAssetClassVersionMaskArgs
): Promise<void> {
  const program = getFactoryProgram();
  const owner = callContext.owner ?? program.provider.wallet.payer;
  const { configId, version, offset, chunk } = args;

  await program.methods
    .writeAssetClassVersionMask(configId, version, offset, chunk)
    .accountsStrict({
      owner: owner.publicKey,
      factory: pdaUtils.factoryPda(),
      assetClassOwnershipPda: pdaUtils.assetClassOwnershipPda(configId),
      assetClassVersionPda: pdaUtils.assetClassVersionPda(configId, version),
    })
    .signers(callContext.signers ?? [owner])
    .rpc({ commitment: "confirmed" });
}

export type FinalizeAssetClassVersionContext = BaseWriteContext & { owner?: Keypair };

type FinalizeAssetClassVersionArgs = {
  configId: anchor.BN;
  version: anchor.BN;
};

export async function finalizeAssetClassVersion(
  callContext: FinalizeAssetClassVersionContext = {},
  args: FinalizeAssetClassVersionArgs
): Promise<void> {
  const program = getFactoryProgram();
  const owner = callContext.owner ?? program.provider.wallet.payer;
  const { configId, version } = args;

  await program.methods
    .finalizeAssetClassVersion(configId, version)
    .accountsStrict({
      owner: owner.publicKey,
      factory: pdaUtils.factoryPda(),
      assetClassOwnershipPda: pdaUtils.assetClassOwnershipPda(configId),
      assetClassVersionPda: pdaUtils.assetClassVersionPda(configId, version),
    })
    .signers(callContext.signers ?? [owner])
    .rpc({ commitment: "confirmed" });
}

/**
 * High-level convenience: deploys a full asset-class version end to end — `init`,
 * then one `write` per `chunkSize`-byte slice of `mask` (OR-ed in), then
 * `finalize`. Mirrors what a real client does when the mask is too large for a
 * single transaction.
 */

export type DeployAssetClassVersionContext = BaseWriteContext & { owner?: Keypair };

type DeployAssetClassVersionArgs = {
  configId: anchor.BN;
  version: anchor.BN;
  mask: Buffer;
  chunkSize?: number;
};

export async function deployAssetClassVersion(
  callContext: DeployAssetClassVersionContext = {},
  args: DeployAssetClassVersionArgs
): Promise<void> {
  const { configId, version, mask, chunkSize = 800 } = args;

  await initAssetClassVersion(callContext, { configId, version });
  for (let offset = 0; offset < mask.length; offset += chunkSize) {
    const chunk = mask.subarray(offset, Math.min(offset + chunkSize, mask.length));
    await writeAssetClassVersionMask(callContext, { configId, version, offset, chunk: Buffer.from(chunk) });
  }
  await finalizeAssetClassVersion(callContext, { configId, version });
}

export async function getAssetClassVersion(configId: anchor.BN, version: anchor.BN) {
  return await getFactoryProgram().account.assetClassVersion.fetch(
    pdaUtils.assetClassVersionPda(configId, version),
    "confirmed"
  );
}

/**
 * Returns the full fixed-capacity functionality mask (`FUNCTIONALITIES_BYTES_MASK`
 * bytes) of a version. The zero-copy `mask: [u8; N]` field decodes as a number
 * array; this packs it back into a Buffer.
 */
export async function getAssetClassVersionMask(configId: anchor.BN, version: anchor.BN): Promise<Buffer> {
  const stored = await getAssetClassVersion(configId, version);
  return Buffer.from(stored.mask as number[]);
}

/**
 * Test-only: removes the `asset_class_version` PDA for `(configId, version)` via
 * surfpool by zeroing its lamports, so the account reads back as non-existent.
 * Lets a test re-run from a blank slate (version PDAs are not cleared by the
 * suite's `beforeEach`).
 */
export async function clearAssetClassVersion(configId: anchor.BN, version: anchor.BN): Promise<void> {
  await surfnetSetAccount(pdaUtils.assetClassVersionPda(configId, version), { lamports: 0 });
}
