import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import {
  createTokenAccount,
  getMint,
  getTokenAccount,
  mintTokensViaSurfpool,
  setMintPaused,
} from "./program_helpers/spl_token_helper";
import {
  batchBurnTokens,
  burnTokens,
  getControllerRedemptionEvent,
  getControllerRedemptionEvents,
} from "./program_helpers/burn/burn_instruction_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import { OPERATIONS_BURN } from "./utils/functionalities";
import { beforeEach } from "mocha";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_ADMIN, ROLE_CONTROLLER } from "./utils/roles";

describe("operations", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const authority = provider.wallet.payer;

  describe("burn ", async () => {
    let mint: PublicKey;
    let assetConfigurationPda: PublicKey;
    const MINT_DECIMALS = 6;

    // A fresh mint per test (unpaused + active out of the box) plus a fresh
    // asset-class version finalized with the burn functionality. Every
    // precondition burn cares about — token balances, partial-freeze markers,
    // active snapshots, paused/deactivated state — is then planted in isolation
    // via surfpool cheatcodes, so `burn` is the only instruction each test runs.
    beforeEach(async () => {
      ({ mint } = await deployMint({}, { decimals: MINT_DECIMALS }));
      assetConfigurationPda = pdaUtils.assetConfigurationPda(mint);
      await setAssetClassVersionForMint(mint, { functionalities: [OPERATIONS_BURN] });
      await setRoles(mint, authority!.publicKey, [ROLE_CONTROLLER]);
    });

    it("burn: removes tokens from the token account via permanent delegate", async () => {
      const mintAmount = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
      const burnAmount = new anchor.BN(100 * 10 ** MINT_DECIMALS);

      // Plant 1 000 tokens on the source account (owned by the mint-owner PDA).
      const source = await createTokenAccount({ mint, owner: assetConfigurationPda });
      await mintTokensViaSurfpool(mint, source, mintAmount);

      // ── Call burn ──────────────────────────────────────────────────────
      const { signature } = await burnTokens({ mint, tokenAccount: source, authority }, { amount: burnAmount });

      const sourceAfter = (await getTokenAccount(source)).amount;
      assert.equal(
        sourceAfter.toString(),
        (mintAmount.toNumber() - burnAmount.toNumber()).toString(),
        "source balance should be reduced by the transfer amount"
      );

      // ── Assertions: ControllerRedemption event ─────────────────────────────────
      const event = await getControllerRedemptionEvent(signature);
      assert.isNotNull(event, "ControllerRedemption event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the burned mint");
      assert.equal(event!.controller.toBase58(), authority!.publicKey.toBase58(), "controller should be the deployer");
      assert.equal(event!.from.toBase58(), source.toBase58(), "from should be the burned token account");
      assert.equal(event!.value.toString(), burnAmount.toString(), "value should match the burn amount");
    });

    it("burn: fails with MissingRole when authority does not have the controller role", async () => {
      const source = await createTokenAccount({ mint, owner: assetConfigurationPda });

      // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
      const rogueKeypair = Keypair.generate();
      await setRoles(mint, rogueKeypair.publicKey, [ROLE_ADMIN]); // rogue has admin but not controller role

      try {
        await burnTokens({
          mint,
          tokenAccount: source,
          authority: rogueKeypair,
          signers: [rogueKeypair],
        });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    it("burn: fails when mint is paused", async () => {
      const source = await createTokenAccount({ mint, owner: assetConfigurationPda });
      await mintTokensViaSurfpool(mint, source, new anchor.BN(1));
      await setMintPaused(mint, true);

      // The burn CPI into Token-2022 is rejected because the mint is paused.
      // This surfaces as a SendTransactionError (Token-2022 custom error 0x43),
      // not an AnchorError, because the rejection originates inside Token-2022.
      try {
        await burnTokens({ mint, tokenAccount: source, authority });
        assert.fail("Expected mint-is-paused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
        const sendErr = err as SendTransactionError;
        const logs = sendErr.logs ?? [];
        assert.isTrue(
          logs.some((log) => log.includes("paused")),
          "transaction logs should mention the mint is paused"
        );
      }
    });

    it("burn: fails with Deactivated when mint has been deactivated", async () => {
      const source = await createTokenAccount({ mint, owner: assetConfigurationPda });

      // ── Deactivate the mint ────────────────────────────────────────────────
      await setDeactivateMarker(mint);

      // ── Burn must now be rejected with Deactivated ─────────────────────────
      try {
        await burnTokens({ mint, tokenAccount: source, authority });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    it("burn: fails with FunctionalityNotSupportedError when the burn functionality is not enabled", async () => {
      const source = await createTokenAccount({ mint, owner: assetConfigurationPda });

      // Re-seed the asset-class version WITHOUT the burn functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await burnTokens({ mint, tokenAccount: source, authority });
        assert.fail("Expected FunctionalityNotSupportedError but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FunctionalityNotSupportedError",
          "error code should be FunctionalityNotSupportedError"
        );
      }
    });

    it("burn: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const source = await createTokenAccount({ mint, owner: assetConfigurationPda });

      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [OPERATIONS_BURN],
      });

      try {
        await burnTokens({ mint, tokenAccount: source, authority });
        assert.fail("Expected AssetClassVersionNotFinalized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AssetClassVersionNotFinalized",
          "error code should be AssetClassVersionNotFinalized"
        );
      }
    });
  });

  describe("batch_burn", async () => {
    let mint: PublicKey;
    const MINT_DECIMALS = 6;

    // A fresh mint per test (unpaused + active out of the box) plus a fresh
    // asset-class version finalized with the burn functionality, and the
    // controller role granted to the authority. Balances and every other
    // precondition are planted in isolation via surfpool cheatcodes, so
    // `batch_burn` is the only instruction each test runs.
    beforeEach(async () => {
      ({ mint } = await deployMint({}, { decimals: MINT_DECIMALS }));
      await setAssetClassVersionForMint(mint, { functionalities: [OPERATIONS_BURN] });
      await setRoles(mint, authority!.publicKey, [ROLE_CONTROLLER]);
    });

    it("batch_burn: burns the corresponding amount from each source and updates balances correctly", async () => {
      const sourceA = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
      const sourceB = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
      const sources = [sourceA, sourceB];
      const initialBalances = [new anchor.BN(1_000 * 10 ** MINT_DECIMALS), new anchor.BN(2_500 * 10 ** MINT_DECIMALS)];
      const amounts = [new anchor.BN(100 * 10 ** MINT_DECIMALS), new anchor.BN(500 * 10 ** MINT_DECIMALS)];

      // Plant an initial balance on each source before burning from it.
      for (let i = 0; i < sources.length; i++) {
        await mintTokensViaSurfpool(mint, sources[i], initialBalances[i]);
      }

      const supplyBefore = new anchor.BN((await getMint(mint)).supply.toString());

      const signature = await batchBurnTokens({ mint, authority, sources }, { amounts });

      // ── Each source was reduced by its corresponding amount and re-frozen ──
      for (let i = 0; i < sources.length; i++) {
        const account = await getTokenAccount(sources[i]);
        assert.equal(
          account.amount.toString(),
          initialBalances[i].sub(amounts[i]).toString(),
          `source ${i} balance should be reduced by its burned amount`
        );
        assert.isTrue(account.isFrozen, `source ${i} should be re-frozen after burning`);
      }

      // ── Total supply dropped by the sum of all burned amounts ──────────────
      const supplyAfter = new anchor.BN((await getMint(mint)).supply.toString());
      const totalBurned = amounts.reduce((sum, a) => sum.add(a), new anchor.BN(0));
      assert.equal(
        supplyAfter.toString(),
        supplyBefore.sub(totalBurned).toString(),
        "total supply should drop by the sum of all burned amounts"
      );

      // ── One ControllerRedemption event per source, with matching fields ────
      const events = await getControllerRedemptionEvents(signature);
      assert.equal(events.length, sources.length, "one ControllerRedemption event should be emitted per source");
      for (let i = 0; i < sources.length; i++) {
        const event = events.find((e) => e.from.toBase58() === sources[i].toBase58());
        assert.isDefined(event, `a ControllerRedemption event should be emitted for source ${i}`);
        assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the burned mint");
        assert.equal(
          event!.controller.toBase58(),
          authority!.publicKey.toBase58(),
          "event controller should be the authority"
        );
        assert.equal(event!.value.toString(), amounts[i].toString(), "event value should equal the burned amount");
      }
    });

    it("batch_burn: fails when mint is paused", async () => {
      const source = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
      await mintTokensViaSurfpool(mint, source, new anchor.BN(1));
      await setMintPaused(mint, true);

      // The burn CPI into Token-2022 is rejected because the mint is paused.
      // This surfaces as a SendTransactionError (Token-2022 custom error),
      // not an AnchorError, because the rejection originates inside Token-2022.
      try {
        await batchBurnTokens({ mint, authority, sources: [source] });
        assert.fail("Expected mint-is-paused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
        const logs = (err as SendTransactionError).logs ?? [];
        assert.isTrue(
          logs.some((log) => log.includes("paused")),
          "transaction logs should mention the mint is paused"
        );
      }
    });

    it("batch_burn: fails with Deactivated when mint has been deactivated", async () => {
      const source = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
      await setDeactivateMarker(mint);

      try {
        await batchBurnTokens({ mint, authority, sources: [source] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated");
      }
    });

    it("batch_burn: fails with MissingRole when authority does not have the controller role", async () => {
      const source = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
      const rogueKeypair = Keypair.generate();
      await setRoles(mint, rogueKeypair.publicKey, [ROLE_ADMIN]); // rogue has admin but not controller role

      try {
        await batchBurnTokens({
          mint,
          authority: rogueKeypair,
          sources: [source],
          signers: [rogueKeypair],
        });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole");
      }
    });

    it("batch_burn: fails with FunctionalityNotSupportedError when the burn functionality is not enabled", async () => {
      const source = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

      // Re-seed the asset-class version WITHOUT the burn functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await batchBurnTokens({ mint, authority, sources: [source] });
        assert.fail("Expected FunctionalityNotSupportedError but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "FunctionalityNotSupportedError",
          "error code should be FunctionalityNotSupportedError"
        );
      }
    });

    it("batch_burn: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const source = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [OPERATIONS_BURN],
      });

      try {
        await batchBurnTokens({ mint, authority, sources: [source] });
        assert.fail("Expected AssetClassVersionNotFinalized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AssetClassVersionNotFinalized",
          "error code should be AssetClassVersionNotFinalized"
        );
      }
    });

    it("batch_burn: fails with EmptyBatch when no sources are provided", async () => {
      try {
        await batchBurnTokens({ mint, authority, sources: [] });
        assert.fail("Expected EmptyBatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "EmptyBatch");
      }
    });

    it("batch_burn: fails with InvalidRemainingAccounts when the wrong number of remaining accounts is passed", async () => {
      const source = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

      try {
        await batchBurnTokens(
          { mint, authority, sources: [source] },
          {
            // One source expects one remaining account, but two are passed.
            remainingAccounts: [
              { pubkey: source, isWritable: true, isSigner: false },
              { pubkey: source, isWritable: true, isSigner: false },
            ],
          }
        );
        assert.fail("Expected InvalidRemainingAccounts error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError);
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "InvalidRemainingAccounts");
      }
    });
  });
});
