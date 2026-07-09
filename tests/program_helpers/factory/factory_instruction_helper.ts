import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Factory } from "../../../target/types/factory";
import { SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import { BaseWriteContext, PayerContext } from "../base_helper";
import {
  assetClassOwnershipPda,
  assetClassPendingOwnerPda,
  assetClassVersionPda,
  factoryPda,
  factoryPendingManagerPda,
} from "./factory_pda_helper";

export function getFactoryProgram(): Program<Factory> {
  return anchor.workspace.Factory as Program<Factory>;
}

// ── initializeFactory ──────────────────────────────

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
      factory: factoryPda(),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [manager])
    .rpc({ commitment: "confirmed" });
}

// ── nominateManager ──────────────────────────────

export type NominateManagerContext = BaseWriteContext & { currentManager?: Keypair };

type NominateManagerArgs = {
  newManager: PublicKey;
};

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
      factory: factoryPda(),
      factoryPendingManagerPda: factoryPendingManagerPda(),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [currentManager])
    .rpc({ commitment: "confirmed" });
}

// ── acceptNomination ──────────────────────────────

export type AcceptNominationContext = BaseWriteContext & { pendingManager?: Keypair };

export async function acceptNomination(callContext: AcceptNominationContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const pendingManager = callContext.pendingManager ?? program.provider.wallet.payer;

  await program.methods
    .acceptNomination()
    .accountsStrict({
      pendingManager: pendingManager.publicKey,
      factory: factoryPda(),
      factoryPendingManagerPda: factoryPendingManagerPda(),
    })
    .signers(callContext.signers ?? [pendingManager])
    .rpc({ commitment: "confirmed" });
}

// ── cancelNomination ──────────────────────────────

export type CancelNominationContext = BaseWriteContext & { currentManager?: Keypair };

export async function cancelNomination(callContext: CancelNominationContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const currentManager = callContext.currentManager ?? program.provider.wallet.payer;

  await program.methods
    .cancelNomination()
    .accountsStrict({
      currentManager: currentManager.publicKey,
      factory: factoryPda(),
      factoryPendingManagerPda: factoryPendingManagerPda(),
    })
    .signers(callContext.signers ?? [currentManager])
    .rpc({ commitment: "confirmed" });
}

// ── createAssetClass ──────────────────────────────

export type CreateAssetClassContext = BaseWriteContext & { manager?: Keypair };

type CreateAssetClassArgs = {
  configId: anchor.BN;
  owner: PublicKey;
};

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
      factory: factoryPda(),
      assetClassOwnershipPda: assetClassOwnershipPda(configId),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [manager])
    .rpc({ commitment: "confirmed" });
}

// ── nominateAssetClassOwner ──────────────────────────────

export type NominateAssetClassOwnerContext = BaseWriteContext & { currentOwner?: Keypair };

type NominateAssetClassOwnerArgs = {
  configId: anchor.BN;
  newOwner: PublicKey;
};

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
      factory: factoryPda(),
      assetClassOwnershipPda: assetClassOwnershipPda(configId),
      assetClassPendingOwnerPda: assetClassPendingOwnerPda(configId),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [currentOwner])
    .rpc({ commitment: "confirmed" });
}

// ── acceptAssetClassOwnership ──────────────────────────────

export type AcceptAssetClassOwnershipContext = BaseWriteContext & { pendingOwner?: Keypair };

type AssetAssetClassOwnershipArgs = {
  configId: anchor.BN;
};

export async function acceptAssetClassOwnership(
  callContext: AcceptAssetClassOwnershipContext = {},
  args: AssetAssetClassOwnershipArgs
): Promise<void> {
  const program = getFactoryProgram();
  const pendingOwner = callContext.pendingOwner ?? program.provider.wallet.payer!;
  const { configId } = args;

  await program.methods
    .acceptAssetClassOwnership(configId)
    .accountsStrict({
      pendingOwner: pendingOwner.publicKey,
      factory: factoryPda(),
      assetClassOwnershipPda: assetClassOwnershipPda(configId),
      assetClassPendingOwnerPda: assetClassPendingOwnerPda(configId),
    })
    .signers(callContext.signers ?? [pendingOwner])
    .rpc({ commitment: "confirmed" });
}

// ── pauseFactory ──────────────────────────────

export type PauseFactoryContext = BaseWriteContext & { manager?: Keypair };

export async function pauseFactory(callContext: PauseFactoryContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const manager = callContext.manager ?? program.provider.wallet.payer;

  await program.methods
    .pause()
    .accountsStrict({
      manager: manager.publicKey,
      factory: factoryPda(),
    })
    .signers(callContext.signers ?? [manager])
    .rpc({ commitment: "confirmed" });
}

// ── unpauseFactory ──────────────────────────────

export type UnpauseFactoryContext = BaseWriteContext & { manager?: Keypair };

export async function unpauseFactory(callContext: UnpauseFactoryContext = {}): Promise<void> {
  const program = getFactoryProgram();
  const manager = callContext.manager ?? program.provider.wallet.payer;

  await program.methods
    .unpause()
    .accountsStrict({
      manager: manager.publicKey,
      factory: factoryPda(),
    })
    .signers(callContext.signers ?? [manager])
    .rpc({ commitment: "confirmed" });
}

// ── cancelAssetClassOwnership ──────────────────────────────

export type CancelAssetClassOwnershipContext = BaseWriteContext & { currentOwner?: Keypair };

type CancelAssetClassOwnershipArgs = {
  configId: anchor.BN;
};

export async function cancelAssetClassOwnership(
  callContext: CancelAssetClassOwnershipContext = {},
  args: CancelAssetClassOwnershipArgs
): Promise<void> {
  const program = getFactoryProgram();
  const currentOwner = callContext.currentOwner ?? program.provider.wallet.payer!;
  const { configId } = args;

  await program.methods
    .cancelAssetClassOwnership(configId)
    .accountsStrict({
      currentOwner: currentOwner.publicKey,
      factory: factoryPda(),
      assetClassOwnershipPda: assetClassOwnershipPda(configId),
      assetClassPendingOwnerPda: assetClassPendingOwnerPda(configId),
    })
    .signers(callContext.signers ?? [currentOwner])
    .rpc({ commitment: "confirmed" });
}

// ── initAssetClassVersion ───────────────────────────────────────────────

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
      factory: factoryPda(),
      assetClassOwnershipPda: assetClassOwnershipPda(configId),
      assetClassVersionPda: assetClassVersionPda(configId, version),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [owner])
    .rpc({ commitment: "confirmed" });
}

// ── enableAssetClassVersionFunctionalities ──────────────────────────────

/**
 * Reads whether functionality `f` is enabled in `mask`. Mirrors
 * `common::functionalities::index` (`byte = f / 8`, `bit = f % 8`).
 */
export function areFunctionalitiesEnabled(mask: number[], functionalities: number[]): boolean {
  return functionalities.every((f) => isFunctionalityEnabled(mask, f));
}

export function isFunctionalityEnabled(mask: number[], f: number): boolean {
  const byte = Math.floor(f / 8);
  const bit = f % 8;
  return ((mask[byte] >> bit) & 1) === 1;
}

export type EnableAssetClassVersionFunctionalitiesContext = BaseWriteContext & { owner?: Keypair };

type EnableAssetClassVersionFunctionalitiesArgs = {
  configId: anchor.BN;
  version: anchor.BN;
  functionalities: number[];
};

export async function enableAssetClassVersionFunctionalities(
  callContext: EnableAssetClassVersionFunctionalitiesContext = {},
  args: EnableAssetClassVersionFunctionalitiesArgs
): Promise<void> {
  const program = getFactoryProgram();
  const owner = callContext.owner ?? program.provider.wallet.payer;
  const { configId, version, functionalities } = args;

  await program.methods
    .enableAssetClassVersionFunctionalities(configId, version, functionalities)
    .accountsStrict({
      owner: owner.publicKey,
      factory: factoryPda(),
      assetClassOwnershipPda: assetClassOwnershipPda(configId),
      assetClassVersionPda: assetClassVersionPda(configId, version),
    })
    .signers(callContext.signers ?? [owner])
    .rpc({ commitment: "confirmed" });
}

// ── disableAssetClassVersionFunctionalities ──────────────────────────────

export type DisableAssetClassVersionFunctionalitiesContext = BaseWriteContext & { owner?: Keypair };

type DisableAssetClassVersionFunctionalitiesArgs = {
  configId: anchor.BN;
  version: anchor.BN;
  functionalities: number[];
};

export async function disableAssetClassVersionFunctionalities(
  callContext: DisableAssetClassVersionFunctionalitiesContext = {},
  args: DisableAssetClassVersionFunctionalitiesArgs
): Promise<void> {
  const program = getFactoryProgram();
  const owner = callContext.owner ?? program.provider.wallet.payer;
  const { configId, version, functionalities } = args;

  await program.methods
    .disableAssetClassVersionFunctionalities(configId, version, functionalities)
    .accountsStrict({
      owner: owner.publicKey,
      factory: factoryPda(),
      assetClassOwnershipPda: assetClassOwnershipPda(configId),
      assetClassVersionPda: assetClassVersionPda(configId, version),
    })
    .signers(callContext.signers ?? [owner])
    .rpc({ commitment: "confirmed" });
}

// ── finalizeAssetClassVersion ───────────────────────────────────────────────

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
      factory: factoryPda(),
      assetClassOwnershipPda: assetClassOwnershipPda(configId),
      assetClassVersionPda: assetClassVersionPda(configId, version),
    })
    .signers(callContext.signers ?? [owner])
    .rpc({ commitment: "confirmed" });
}
