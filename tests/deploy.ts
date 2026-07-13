import * as anchor from "@anchor-lang/core";
import { SendTransactionError } from "@solana/web3.js";
import { Keypair } from "@solana/web3.js";
import {
  AccountState,
  getDefaultAccountState,
  getMetadataPointerState,
  getPermanentDelegate,
  getPausableConfig,
} from "@solana/spl-token";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { permanentDelegatePda } from "./program_helpers/burn/burn_pda_helper";
import { pausableAuthorityPda } from "./program_helpers/pause/pause_pda_helper";
import { freezeAuthorityPda } from "./program_helpers/freeze/freeze_pda_helper";
import { deployMint, getMintDeployedEvent, getMintOwner } from "./program_helpers/deploy_helper";
import { getMint, getTokenMetadata } from "./program_helpers/spl_token_helper";

// ── Test mint parameters ───────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";
const MINT_ISIN_KEY = "isin";
const MINT_ISIN_VALUE = "CH0012221716";
// Asset-class PDA seed (config_id, version_id) the mint is hooked to.
const MINT_ASSET_CLASS_CONFIG_ID = 7;
const MINT_ASSET_CLASS_VERSION_ID = 3;

describe("deploy", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // The wallet that signs as deployer and becomes the recorded mint owner.
  const deployer = provider.wallet.publicKey;

  it("deploy_mint: deploys a Token-2022 mint with all extensions and metadata", async () => {
    const { mint, signature } = await deployMint(
      { deployer },
      {
        decimals: MINT_DECIMALS,
        name: MINT_NAME,
        symbol: MINT_SYMBOL,
        uri: MINT_URI,
        additionalMetadata: [{ key: MINT_ISIN_KEY, value: MINT_ISIN_VALUE }],
        assetClassConfigId: MINT_ASSET_CLASS_CONFIG_ID,
        assetClassVersionId: MINT_ASSET_CLASS_VERSION_ID,
      }
    );
    const mintAuthority = pdaUtils.mintAuthorityPda(mint);
    const permanentDelegateAuthority = permanentDelegatePda(mint);
    const metadataUpdateAuthority = pdaUtils.metadataUpdateAuthorityPda(mint);
    const pausableAuthority = pausableAuthorityPda(mint);
    const freezeAuthority = freezeAuthorityPda(mint);
    const mintInfo = await getMint(mint);
    const mintOwnerAccount = await getMintOwner(mint);
    const metadataPointerState = getMetadataPointerState(mintInfo);
    const permanentDelegateState = getPermanentDelegate(mintInfo);
    const defaultAccountState = getDefaultAccountState(mintInfo);
    const pausableState = getPausableConfig(mintInfo);
    const metadata = await getTokenMetadata(mint);

    // ── Assertions: mint core ──────────────────────────────────────────────────
    assert.isTrue(mintInfo.isInitialized, "mint should be initialized");
    assert.equal(mintInfo.decimals, MINT_DECIMALS);
    assert.equal(mintInfo.supply.toString(), "0");
    assert.equal(
      mintInfo.freezeAuthority?.toBase58(),
      freezeAuthority.toBase58(),
      "freeze authority should be the locked PDA"
    );
    assert.equal(
      mintInfo.mintAuthority?.toBase58(),
      mintAuthority.toBase58(),
      "mint authority should be the external PDA"
    );

    // ── Assertions: MetadataPointer ────────────────────────────────────────────
    assert.equal(
      metadataPointerState?.metadataAddress?.toBase58(),
      mint.toBase58(),
      "metadata should point to the mint itself"
    );
    assert.isNull(metadataPointerState?.authority ?? null, "metadata pointer authority should be null (immutable)");

    // ── Assertions: PermanentDelegate ─────────────────────────────────────────
    assert.equal(
      permanentDelegateState?.delegate?.toBase58(),
      permanentDelegateAuthority.toBase58(),
      "permanent delegate authority mismatch"
    );

    // ── Assertions: DefaultAccountState ───────────────────────────────────────
    assert.equal(defaultAccountState?.state, AccountState.Frozen, "default account state should be Frozen");

    // ── Assertions: Pausable ───────────────────────────────────────────────────
    assert.equal(pausableState?.authority?.toBase58(), pausableAuthority.toBase58(), "pausable authority mismatch");
    assert.equal(pausableState?.paused, false, "mint should be paused");

    // ── Assertions: Token metadata ─────────────────────────────────────────────
    assert.equal(metadata?.name, MINT_NAME);
    assert.equal(metadata?.symbol, MINT_SYMBOL);
    assert.equal(metadata?.uri, MINT_URI);
    assert.equal(
      metadata?.updateAuthority?.toBase58(),
      metadataUpdateAuthority.toBase58(),
      "metadata update authority mismatch"
    );
    assert.deepEqual(
      metadata?.additionalMetadata,
      [[MINT_ISIN_KEY, MINT_ISIN_VALUE]],
      "additional metadata should contain the ISIN field"
    );

    // ── Assertions: Mint owner PDA ─────────────────────────────────────────────
    assert.equal(
      mintOwnerAccount.deployer.toBase58(),
      deployer.toBase58(),
      "mint owner PDA should record the deployer"
    );
    // Verify the stored bump is consistent with the derived PDA address.
    const [, expectedBump] = pdaUtils.mintOwnerPdaWithBump(mint);
    assert.equal(mintOwnerAccount.bump, expectedBump, "stored bump should match the canonical PDA bump");
    // The asset-class PDA seed (config_id, version_id) is persisted verbatim.
    assert.equal(
      mintOwnerAccount.assetClassConfigId.toNumber(),
      MINT_ASSET_CLASS_CONFIG_ID,
      "mint owner PDA should record the asset-class config id"
    );
    assert.equal(
      mintOwnerAccount.assetClassVersionId.toNumber(),
      MINT_ASSET_CLASS_VERSION_ID,
      "mint owner PDA should record the asset-class version id"
    );

    // ── Assertions: MintDeployed event ─────────────────────────────────────────
    const event = await getMintDeployedEvent(signature);
    assert.isNotNull(event, "MintDeployed event should be emitted");
    assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
    assert.equal(event!.deployer.toBase58(), deployer.toBase58(), "event deployer should match");
    assert.equal(event!.decimals, MINT_DECIMALS);
    assert.equal(event!.name, MINT_NAME);
    assert.equal(event!.symbol, MINT_SYMBOL);
    assert.equal(event!.uri, MINT_URI);
    assert.equal(event!.isin, MINT_ISIN_VALUE, "isin should be taken from the additional_metadata 'isin' entry");
    assert.equal(
      event!.assetClassConfigId.toNumber(),
      MINT_ASSET_CLASS_CONFIG_ID,
      "event should carry the asset-class config id"
    );
    assert.equal(
      event!.assetClassVersionId.toNumber(),
      MINT_ASSET_CLASS_VERSION_ID,
      "event should carry the asset-class version id"
    );
  });

  it("deploy_mint: MintDeployed event has a null isin when no isin metadata is provided", async () => {
    const { signature } = await deployMint({ deployer }, { additionalMetadata: [] });

    const event = await getMintDeployedEvent(signature);

    assert.isNotNull(event, "MintDeployed event should be emitted");
    assert.isNull(event!.isin ?? null, "isin should be null when no 'isin' metadata entry exists");
  });

  it("deploy_mint: fails when attempting to deploy an already-deployed mint", async () => {
    const mintKeypair = Keypair.generate();
    await deployMint({ deployer, signers: [mintKeypair] });

    // Attempt to deploy the same mint again (by using the same mint pda) — mint_owner_pda already exists,
    // so Anchor's `init` constraint rejects it before the instruction body runs.
    try {
      await deployMint({ deployer, signers: [mintKeypair] });

      assert.fail("Expected re-deploy to fail but it succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const logs = (err as SendTransactionError).logs ?? [];
      assert.isTrue(
        logs.some((l) => l.includes("already in use")),
        "transaction logs should mention account already in use"
      );
    }
  });
});
