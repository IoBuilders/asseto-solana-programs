import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { NOMINAL_VALUE_PROGRAM_ID } from "./utils/address_utils";
import { deployMint } from "./program_helpers/deploy/deploy_instruction_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_ADMIN, ROLE_NOMINAL_VALUE } from "./utils/roles";
import { NOMINAL_VALUE_INITIALIZE, NOMINAL_VALUE_PUBLISH, NOMINAL_VALUE_REPUBLISH } from "./utils/functionalities";
import {
  EUR,
  PUBLISH_TYPE_TOTAL,
  PUBLISH_TYPE_UNIT,
  getNominalValueInitializedEvent,
  getNominalValuePublishedEvent,
  getNominalValueRepublishedEvent,
  initializeNominalValue,
  publishNominalValue,
  republishNominalValue,
} from "./program_helpers/nominal_value/nominal_value_instruction_helper";
import {
  getNominalValue,
  nominalValuePda,
  nominalValuePdaWithBump,
  setNominalValuePda,
} from "./program_helpers/nominal_value/nominal_value_pda_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import { getAccountInfo } from "./program_helpers/account_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setMintPaused } from "./program_helpers/spl_token_helper";

const ALL_FUNCTIONALITIES = [NOMINAL_VALUE_INITIALIZE, NOMINAL_VALUE_PUBLISH, NOMINAL_VALUE_REPUBLISH];

// Far enough in the past / future that the surfpool clock can't straddle them.
const PAST_1 = new anchor.BN(1_700_000_000);
const PAST_2 = new anchor.BN(1_700_100_000);
const FUTURE = new anchor.BN(4_000_000_000);

async function expectAnchorError(call: () => Promise<unknown>, code: string) {
  try {
    await call();
    assert.fail(`Expected ${code} error but instruction succeeded`);
  } catch (err) {
    assert.instanceOf(err, AnchorError, "error should be an AnchorError");
    assert.equal((err as AnchorError).error.errorCode.code, code);
  }
}

describe("nominal-value", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const authority = provider.wallet.payer;
  let mint: PublicKey;

  // The asset-class version PDA must exist (Anchor loads it before the handler's checks
  // run), so seed it Ready with every nominal-value functionality; tests that need one
  // disabled re-seed it themselves.
  beforeEach(async () => {
    ({ mint } = await deployMint());
    await setAssetClassVersionForMint(mint, { functionalities: ALL_FUNCTIONALITIES });
    await setRoles(mint, authority.publicKey, [ROLE_ADMIN, ROLE_NOMINAL_VALUE]);
  });

  describe("initialize_nominal_value", () => {
    it("initialize_nominal_value: creates the PDA with the supplied config and an unset value", async () => {
      assert.isNull(await getAccountInfo(nominalValuePda(mint)), "PDA should not exist yet");

      const { signature } = await initializeNominalValue(
        { authority, mint },
        { nominalValueDecimals: 6, nominalValueCurrency: EUR, nominalValuePublishType: PUBLISH_TYPE_TOTAL }
      );

      const info = await getAccountInfo(nominalValuePda(mint));
      assert.equal(info!.owner.toBase58(), NOMINAL_VALUE_PROGRAM_ID.toBase58());

      const stored = await getNominalValue(mint);
      assert.equal(stored.bump, nominalValuePdaWithBump(mint)[1]);
      assert.deepEqual(Array.from(stored.nominalValueCurrency), EUR);
      assert.deepEqual(stored.nominalValuePublishType, PUBLISH_TYPE_TOTAL);
      assert.equal(stored.nominalValueDecimals, 6);
      assert.equal(stored.nominalValue.toString(), "0");
      assert.equal(stored.effectiveDatetime.toString(), "0");

      const event = await getNominalValueInitializedEvent(signature);
      assert.isNotNull(event, "NominalValueInitialized event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58());
      assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58());
      assert.equal(event!.nominalValueDecimals, 6);
      assert.deepEqual(Array.from(event!.nominalValueCurrency), EUR);
      assert.deepEqual(event!.nominalValuePublishType, PUBLISH_TYPE_TOTAL);
    });

    it("initialize_nominal_value: fails on a second call for the same mint", async () => {
      await initializeNominalValue({ authority, mint });

      try {
        await initializeNominalValue({ authority, mint }, { nominalValueDecimals: 9 });
        assert.fail("Expected second initialize to fail");
      } catch (err) {
        // `init` on an existing account fails in the System Program CPI, not as an AnchorError code.
        assert.isTrue(
          String(err).includes("already in use") || (err as any).logs?.some((l: string) => l.includes("already in use"))
        );
      }

      const stored = await getNominalValue(mint);
      assert.equal(stored.nominalValueDecimals, 6, "config must be unchanged");
    });

    it("initialize_nominal_value: fails with MissingRole when authority doesn't hold ROLE_ADMIN", async () => {
      await setRoles(mint, authority.publicKey, [ROLE_NOMINAL_VALUE]);
      await expectAnchorError(() => initializeNominalValue({ authority, mint }), "MissingRole");
    });

    it("initialize_nominal_value: fails with FunctionalityNotSupportedError when not enabled", async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [] });
      await expectAnchorError(() => initializeNominalValue({ authority, mint }), "FunctionalityNotSupportedError");
    });

    it("initialize_nominal_value: fails with AssetClassVersionNotFinalized when the version is a draft", async () => {
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: ALL_FUNCTIONALITIES,
      });
      await expectAnchorError(() => initializeNominalValue({ authority, mint }), "AssetClassVersionNotFinalized");
    });

    it("initialize_nominal_value: fails with MintPaused when mint is paused", async () => {
      await setMintPaused(mint, true);
      await expectAnchorError(() => initializeNominalValue({ authority, mint }), "MintPaused");
    });

    it("initialize_nominal_value: fails with Deactivated when mint has been deactivated", async () => {
      await setDeactivateMarker(mint);
      await expectAnchorError(() => initializeNominalValue({ authority, mint }), "Deactivated");
    });
  });

  describe("publish_nominal_value", () => {
    beforeEach(async () => {
      await initializeNominalValue({ authority, mint }, { nominalValuePublishType: PUBLISH_TYPE_UNIT });
    });

    it("publish_nominal_value: stores the value and datetime and emits NominalValuePublished", async () => {
      const nominalValue = new anchor.BN("340282366920938463463374607431768211455"); // u128::MAX
      const { signature } = await publishNominalValue({ authority, mint }, { nominalValue, effectiveDatetime: PAST_1 });

      const stored = await getNominalValue(mint);
      assert.equal(stored.nominalValue.toString(), nominalValue.toString());
      assert.equal(stored.effectiveDatetime.toString(), PAST_1.toString());

      const event = await getNominalValuePublishedEvent(signature);
      assert.isNotNull(event, "NominalValuePublished event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58());
      assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58());
      assert.equal(event!.nominalValue.toString(), nominalValue.toString());
      assert.equal(event!.effectiveDatetime.toString(), PAST_1.toString());
    });

    it("publish_nominal_value: advances to a later period, overwriting the previous one", async () => {
      await publishNominalValue({ authority, mint }, { nominalValue: new anchor.BN(10), effectiveDatetime: PAST_1 });
      await publishNominalValue({ authority, mint }, { nominalValue: new anchor.BN(20), effectiveDatetime: PAST_2 });

      const stored = await getNominalValue(mint);
      assert.equal(stored.nominalValue.toString(), "20");
      assert.equal(stored.effectiveDatetime.toString(), PAST_2.toString());
    });

    it("publish_nominal_value: fails with InvalidTimestamp when effective_datetime is zero", async () => {
      await expectAnchorError(
        () => publishNominalValue({ authority, mint }, { effectiveDatetime: new anchor.BN(0) }),
        "InvalidTimestamp"
      );
    });

    it("publish_nominal_value: fails with EffectiveDatetimeNotAfterCurrent when equal to the stored one", async () => {
      await publishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 });
      await expectAnchorError(
        () => publishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "EffectiveDatetimeNotAfterCurrent"
      );
    });

    it("publish_nominal_value: fails with EffectiveDatetimeNotAfterCurrent when earlier than the stored one", async () => {
      await publishNominalValue({ authority, mint }, { effectiveDatetime: PAST_2 });
      await expectAnchorError(
        () => publishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "EffectiveDatetimeNotAfterCurrent"
      );
    });

    it("publish_nominal_value: fails with EffectiveDatetimeNotInPast when effective_datetime is in the future", async () => {
      await expectAnchorError(
        () => publishNominalValue({ authority, mint }, { effectiveDatetime: FUTURE }),
        "EffectiveDatetimeNotInPast"
      );
    });

    it("publish_nominal_value: fails with MissingRole when authority doesn't hold ROLE_NOMINAL_VALUE", async () => {
      await setRoles(mint, authority.publicKey, [ROLE_ADMIN]);
      await expectAnchorError(
        () => publishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "MissingRole"
      );
    });

    it("publish_nominal_value: fails with FunctionalityNotSupportedError when not enabled", async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [NOMINAL_VALUE_REPUBLISH] });
      await expectAnchorError(
        () => publishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "FunctionalityNotSupportedError"
      );
    });

    it("publish_nominal_value: fails with MintPaused when mint is paused", async () => {
      await setMintPaused(mint, true);
      await expectAnchorError(
        () => publishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "MintPaused"
      );
    });

    it("publish_nominal_value: fails with Deactivated when mint has been deactivated", async () => {
      await setDeactivateMarker(mint);
      await expectAnchorError(
        () => publishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "Deactivated"
      );
    });
  });

  describe("republish_nominal_value", () => {
    beforeEach(async () => {
      await initializeNominalValue({ authority, mint });
      await publishNominalValue({ authority, mint }, { nominalValue: new anchor.BN(100), effectiveDatetime: PAST_1 });
    });

    it("republish_nominal_value: overwrites only the value and emits NominalValueRepublished", async () => {
      const { signature } = await republishNominalValue(
        { authority, mint },
        { nominalValue: new anchor.BN(105), effectiveDatetime: PAST_1 }
      );

      const stored = await getNominalValue(mint);
      assert.equal(stored.nominalValue.toString(), "105");
      assert.equal(stored.effectiveDatetime.toString(), PAST_1.toString(), "effective_datetime must not change");

      const event = await getNominalValueRepublishedEvent(signature);
      assert.isNotNull(event, "NominalValueRepublished event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58());
      assert.equal(event!.operator.toBase58(), authority.publicKey.toBase58());
      assert.equal(event!.nominalValue.toString(), "105");
      assert.equal(event!.effectiveDatetime.toString(), PAST_1.toString());
    });

    it("republish_nominal_value: fails with EffectiveDatetimeMismatch when targeting a different period", async () => {
      await expectAnchorError(
        () => republishNominalValue({ authority, mint }, { effectiveDatetime: PAST_2 }),
        "EffectiveDatetimeMismatch"
      );
    });

    it("republish_nominal_value: fails with EffectiveDatetimeMismatch for a sealed past period", async () => {
      await publishNominalValue({ authority, mint }, { effectiveDatetime: PAST_2 });
      await expectAnchorError(
        () => republishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "EffectiveDatetimeMismatch"
      );
    });

    it("republish_nominal_value: fails with InvalidTimestamp when effective_datetime is zero", async () => {
      await expectAnchorError(
        () => republishNominalValue({ authority, mint }, { effectiveDatetime: new anchor.BN(0) }),
        "InvalidTimestamp"
      );
    });

    it("republish_nominal_value: fails with EffectiveDatetimeMismatch before anything was published", async () => {
      await setNominalValuePda(mint, {
        nominalValueCurrency: EUR,
        nominalValuePublishType: PUBLISH_TYPE_UNIT,
        nominalValueDecimals: 6,
        nominalValue: new anchor.BN(0),
        effectiveDatetime: new anchor.BN(0),
      });
      await expectAnchorError(
        () => republishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "EffectiveDatetimeMismatch"
      );
    });

    it("republish_nominal_value: fails with MissingRole when authority doesn't hold ROLE_NOMINAL_VALUE", async () => {
      await setRoles(mint, authority.publicKey, [ROLE_ADMIN]);
      await expectAnchorError(
        () => republishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "MissingRole"
      );
    });

    it("republish_nominal_value: fails with FunctionalityNotSupportedError when not enabled", async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [NOMINAL_VALUE_PUBLISH] });
      await expectAnchorError(
        () => republishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "FunctionalityNotSupportedError"
      );
    });

    it("republish_nominal_value: fails with MintPaused when mint is paused", async () => {
      await setMintPaused(mint, true);
      await expectAnchorError(
        () => republishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "MintPaused"
      );
    });

    it("republish_nominal_value: fails with Deactivated when mint has been deactivated", async () => {
      await setDeactivateMarker(mint);
      await expectAnchorError(
        () => republishNominalValue({ authority, mint }, { effectiveDatetime: PAST_1 }),
        "Deactivated"
      );
    });
  });
});
