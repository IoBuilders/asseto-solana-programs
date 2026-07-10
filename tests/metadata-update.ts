import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint } from "./program_helpers/pause/pause_instruction_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import {
  getMetadataFieldRemovedEvent,
  getMetadataFieldUpdatedEvent,
  removeMetadataField,
  updateMetadataField,
} from "./program_helpers/metadata_update_helper";
import { getTokenMetadata } from "./program_helpers/spl_token_helper";
import { beforeEach } from "mocha";
import { setAssetClassVersionForMint } from "./program_helpers/factory/factory_pda_helper";
import { PAUSE_PAUSE } from "./utils/functionalities";

describe("metadata-update", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // The wallet is both payer and deployer in these tests.
  const deployer = provider.wallet.publicKey;

  describe("update_metadata_field", async () => {
    let mint: PublicKey;
    beforeEach(async () => {
      ({ mint } = await deployMint({ deployer }));
      await setAssetClassVersionForMint(mint, { functionalities: [PAUSE_PAUSE] });
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("update_metadata_field: updates all metadata fields", async () => {
      // ── New values ─────────────────────────────────────────────────────────────
      // Core fields are set to shorter strings → no account growth (pass null).
      const NEW_NAME = "Updated Token";
      const NEW_SYMBOL = "UTK";
      const NEW_URI = "https://example.com/updated.json";
      // Custom fields are new additions → account must grow.
      const ISIN_KEY = "isin";
      const ISIN_VALUE = "CH0012221716";
      const CTRY_KEY = "country";
      const CTRY_VALUE = "CH";

      // Update core fields (shorter → no growth, pass null)
      await updateMetadataField({ deployer, mint }, { key: "name", value: NEW_NAME });
      await updateMetadataField({ deployer, mint }, { key: "symbol", value: NEW_SYMBOL });
      await updateMetadataField({ deployer, mint }, { key: "uri", value: NEW_URI });

      // Add new custom fields — each grows the account by 4+key.len+4+value.len bytes
      await updateMetadataField({ deployer, mint }, { key: ISIN_KEY, value: ISIN_VALUE });
      const { signature } = await updateMetadataField({ deployer, mint }, { key: CTRY_KEY, value: CTRY_VALUE });

      // ── Assertions ─────────────────────────────────────────────────────────────
      const metadataAfter = await getTokenMetadata(mint);

      assert.equal(metadataAfter?.name, NEW_NAME, "name should be updated");
      assert.equal(metadataAfter?.symbol, NEW_SYMBOL, "symbol should be updated");
      assert.equal(metadataAfter?.uri, NEW_URI, "uri should be updated");
      assert.deepEqual(
        metadataAfter?.additionalMetadata,
        [
          [ISIN_KEY, ISIN_VALUE],
          [CTRY_KEY, CTRY_VALUE],
        ],
        "custom fields should be present with correct values"
      );

      const updatedEvent = await getMetadataFieldUpdatedEvent(signature);

      assert.isNotNull(updatedEvent, "MetadataFieldUpdated event should be emitted");
      assert.equal(updatedEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(updatedEvent!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
      assert.equal(updatedEvent!.key, CTRY_KEY, "event key should match the field that was updated");
      assert.equal(updatedEvent!.value, CTRY_VALUE, "event value should match the new value");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("update_metadata_field: fails with MintPaused when mint is paused", async () => {
      await pauseMint({ deployer, mint });

      try {
        await updateMetadataField({ deployer, mint });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("update_metadata_field: fails with Deactivated when mint has been deactivated", async () => {
      // ── Deactivate the mint ────────────────────────────────────────────────
      await deactivateMint({ deployer, mint });

      try {
        await updateMetadataField({ deployer, mint });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });
  });

  describe("remove_metadata_field", async () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("remove_metadata_field: removes all custom metadata fields", async () => {
      // Deploy the mint with custom fields already baked in — no update_metadata_field needed.
      const ISIN_KEY = "isin";
      const ISIN_VALUE = "CH0012221716";
      const JURIS_KEY = "jurisdiction";
      const JURIS_VALUE = "CH";
      const CAT_KEY = "category";
      const CAT_VALUE = "equity";

      const { mint } = await deployMint(
        { deployer },
        {
          additionalMetadata: [
            { key: ISIN_KEY, value: ISIN_VALUE },
            { key: JURIS_KEY, value: JURIS_VALUE },
            { key: CAT_KEY, value: CAT_VALUE },
          ],
        }
      );

      // Sanity-check that all three fields landed before we remove them
      const metadataBefore = await getTokenMetadata(mint);
      assert.deepEqual(
        metadataBefore?.additionalMetadata,
        [
          [ISIN_KEY, ISIN_VALUE],
          [JURIS_KEY, JURIS_VALUE],
          [CAT_KEY, CAT_VALUE],
        ],
        "all three custom fields should be present before removal"
      );

      // ── Remove all custom fields ───────────────────────────────────────────────
      await removeMetadataField({ deployer, mint }, { key: ISIN_KEY, idempotent: false });
      await removeMetadataField({ deployer, mint }, { key: JURIS_KEY, idempotent: false });
      const { signature } = await removeMetadataField({ deployer, mint }, { key: CAT_KEY, idempotent: false });

      // ── Assertions ─────────────────────────────────────────────────────────────
      const metadataAfter = await getTokenMetadata(mint);

      // Core fields must be untouched by remove
      assert.equal(metadataAfter?.name, "Test Token", "name should be unchanged");
      assert.equal(metadataAfter?.symbol, "TEST_TOKEN", "symbol should be unchanged");
      assert.equal(metadataAfter?.uri, "https://example.com/metadata.json", "uri should be unchanged");

      // All custom fields must be gone
      assert.deepEqual(metadataAfter?.additionalMetadata, [], "all custom metadata fields should be removed");

      const removedEvent = await getMetadataFieldRemovedEvent(signature);

      assert.isNotNull(removedEvent, "MetadataFieldRemoved event should be emitted");
      assert.equal(removedEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(removedEvent!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
      assert.equal(removedEvent!.key, CAT_KEY, "event key should match the field that was removed");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("remove_metadata_field: fails with MintPaused when mint is paused", async () => {
      const ISIN_KEY = "isin";
      const ISIN_VALUE = "CH0012221716";

      // Deploy with a custom field present so there is something to remove
      const { mint } = await deployMint({ deployer }, { additionalMetadata: [{ key: ISIN_KEY, value: ISIN_VALUE }] });

      await pauseMint({ deployer, mint });

      try {
        await removeMetadataField({ deployer, mint });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("remove_metadata_field: fails with Deactivated when mint has been deactivated", async () => {
      // ── Deploy a fresh mint ────────────────────────────────────────────────
      const { mint } = await deployMint({ deployer });

      // ── Deactivate the mint ────────────────────────────────────────────────
      await deactivateMint({ deployer, mint });

      try {
        await removeMetadataField({ deployer, mint });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("remove_metadata_field: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const ISIN_KEY = "isin";
      const ISIN_VALUE = "CH0012221716";
      const rogueKeypair = Keypair.generate();

      // Deploy with a custom field present so there is something to remove.
      const { mint } = await deployMint({ deployer }, { additionalMetadata: [{ key: ISIN_KEY, value: ISIN_VALUE }] });

      try {
        await updateMetadataField({ deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] });
        assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "UnauthorizedDeployer",
          "error code should be UnauthorizedDeployer"
        );
      }
    });
  });

  describe("update_metadata_field", async () => {
    let mint: PublicKey;
    beforeEach(async () => {
      ({ mint } = await deployMint({ deployer }));
      await setAssetClassVersionForMint(mint, { functionalities: [PAUSE_PAUSE] });
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("update_metadata_field: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const rogueKeypair = Keypair.generate();

      try {
        await updateMetadataField({ deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] });
        assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "UnauthorizedDeployer",
          "error code should be UnauthorizedDeployer"
        );
      }
    });
  });
});
