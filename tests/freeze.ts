import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint } from "./program_helpers/pause/pause_instruction_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import {
  freezeAccount,
  getFrozenAccountStatusByPda,
  getFrozenBalanceByPda,
  partiallyFreezeAccount,
  removePartialFreeze,
  unfreezeAccount,
  getAccountFrozenEvent,
  getAccountUnfrozenEvent,
  getAccountPartiallyFrozenEvent,
  getAccountPartialFreezeRemovedEvent,
} from "./program_helpers/freeze_helper";
import { createTokenAccount } from "./program_helpers/spl_token_helper";
import { requestAirdrop } from "./program_helpers/account_helper";
import { beforeEach } from "mocha";
import { setAssetClassVersionForMint } from "./program_helpers/factory/factory_pda_helper";
import { PAUSE_PAUSE } from "./utils/functionalities";

describe("freeze", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint({ deployer }));
    await setAssetClassVersionForMint(mint, { functionalities: [PAUSE_PAUSE] });
  });

  describe("freeze_account", () => {
    // ── Happy-path: freeze_account ───────────────────────────────────────────────
    it("freeze_account: creates the frozen_account PDA for a token account", async () => {
      // ── Create a token account to use as the freeze target ──────────────────
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });

      // ── Verify the PDA does not exist before the instruction ────────────────
      const [frozenAccountPda, expectedBump] = pdaUtils.frozenAccountPdaWithBump(mint, tokenAccount);
      const statusBefore = await getFrozenAccountStatusByPda(frozenAccountPda);

      // ── Call freeze_account ──────────────────────────────────────────────────
      const { signature } = await freezeAccount({ deployer, mint, account: tokenAccount });

      // ── Verify the frozen_account PDA was created with the correct bump ──────
      const statusAfter = await getFrozenAccountStatusByPda(frozenAccountPda);
      assert.isNull(statusBefore, "frozen_account PDA should not exist before freeze_account");
      assert.isNotNull(statusAfter, "frozen_account PDA should exist after freeze_account");
      assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");

      const event = await getAccountFrozenEvent(signature);

      assert.isNotNull(event, "Account frozen event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(event!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
    });

    // ── Error case: freeze_account — already frozen ─────────────────────────────
    it("freeze_account: fails when account is already frozen", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });

      // ── Freeze the account once (succeeds) ───────────────────────────────────
      await freezeAccount({ deployer, mint, account: tokenAccount });

      // ── Attempt to freeze again — frozen_account_pda already exists ──────────
      try {
        await freezeAccount({ deployer, mint, account: tokenAccount });
        assert.fail("Expected already-in-use error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
        const sendErr = err as SendTransactionError;
        const logs = sendErr.logs ?? [];
        assert.isTrue(
          logs.some((log) => log.includes("already in use")),
          "transaction logs should mention the account is already in use"
        );
      }
    });

    // ── Happy-path: unfreeze_account ─────────────────────────────────────────────
    it("unfreeze_account: closes the frozen_account PDA for a token account", async () => {
      const { mint } = await deployMint({ deployer });

      // ── Create a token account to use as the freeze target ──────────────────
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });

      // ── First: freeze the account ────────────────────────────────────────────
      const frozenAccountPda = pdaUtils.frozenAccountPda(mint, tokenAccount);
      await freezeAccount({ deployer, mint, account: tokenAccount });

      const statusAfterFreeze = await getFrozenAccountStatusByPda(frozenAccountPda);
      assert.isNotNull(statusAfterFreeze, "frozen_account PDA should exist after freeze_account");

      // ── Then: unfreeze the account ───────────────────────────────────────────
      const { signature } = await unfreezeAccount({ deployer, mint, account: tokenAccount });

      // ── Verify the frozen_account PDA has been closed ────────────────────────
      const statusAfterUnfreeze = await getFrozenAccountStatusByPda(frozenAccountPda);

      assert.isNull(statusAfterUnfreeze, "frozen_account PDA should not exist after unfreeze_account");

      const event = await getAccountUnfrozenEvent(signature);

      assert.isNotNull(event, "Account unfrozen event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(event!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
    });

    // ── Error case: freeze_account — UnauthorizedDeployer ───────────────────────
    it("freeze_account: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      const rogueKeypair = Keypair.generate();
      await requestAirdrop(rogueKeypair.publicKey);

      try {
        await freezeAccount({ deployer: rogueKeypair.publicKey, mint, account: tokenAccount, signers: [rogueKeypair] });

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

    // ── Error case: freeze_account — MintPaused ─────────────────────────────────
    it("freeze_account: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });

      // ── Pause the mint ────────────────────────────────────────────────────────
      await pauseMint({ deployer, mint });

      try {
        await freezeAccount({ deployer, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: freeze_account — Deactivated ────────────────────────────────
    it("freeze_account: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });

      // ── Deactivate the mint ───────────────────────────────────────────────────
      await deactivateMint({ deployer, mint });

      try {
        await freezeAccount({ deployer, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });
  });

  describe("unfreeze_account", () => {
    // ── Error case: unfreeze_account — account not frozen ───────────────────────
    it("unfreeze_account: fails with AccountNotInitialized when account is not frozen", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });

      try {
        await unfreezeAccount({ deployer, mint, account: tokenAccount });
        assert.fail("Expected AccountNotInitialized error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AccountNotInitialized",
          "error code should be AccountNotInitialized"
        );
      }
    });

    // ── Error case: unfreeze_account — UnauthorizedDeployer ─────────────────────
    it("unfreeze_account: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      await freezeAccount({ deployer, mint, account: tokenAccount });
      const rogueKeypair = Keypair.generate();

      try {
        await unfreezeAccount({
          deployer: rogueKeypair.publicKey,
          mint,
          account: tokenAccount,
          signers: [rogueKeypair],
        });
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

    // ── Error case: unfreeze_account — MintPaused ───────────────────────────────
    it("unfreeze_account: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      await freezeAccount({ deployer, mint, account: tokenAccount });
      await pauseMint({ deployer, mint });

      try {
        await unfreezeAccount({ deployer, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: unfreeze_account — Deactivated ──────────────────────────────
    it("unfreeze_account: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      await freezeAccount({ deployer, mint, account: tokenAccount });
      await deactivateMint({ deployer, mint });

      try {
        await unfreezeAccount({ deployer, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });
  });

  describe("partially_freeze_account", () => {
    // ── Happy-path: partially_freeze_account ────────────────────────────────────
    it("partially_freeze_account: creates the frozen_balance PDA with the given balance", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      const [frozenBalancePda, expectedBump] = pdaUtils.frozenBalancePdaWithBump(mint, tokenAccount);

      // ── Verify the PDA does not exist before the instruction ─────────────────
      const statusBefore = await getFrozenBalanceByPda(frozenBalancePda);

      // ── Call partially_freeze_account ─────────────────────────────────────────
      const frozenBalance = new anchor.BN(500_000_000);
      const { signature } = await partiallyFreezeAccount(
        { deployer, mint, account: tokenAccount },
        { balance: frozenBalance }
      );

      // ── Verify the frozen_balance PDA was created with the correct fields ─────
      const statusAfter = await getFrozenBalanceByPda(frozenBalancePda);

      assert.isNull(statusBefore, "frozen_balance PDA should not exist before partially_freeze_account");
      assert.isNotNull(statusAfter, "frozen_balance PDA should exist after partially_freeze_account");
      assert.equal(
        statusAfter.balance.toString(),
        frozenBalance.toString(),
        "balance should match the value passed to partially_freeze_account"
      );
      assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");

      const event = await getAccountPartiallyFrozenEvent(signature);

      assert.isNotNull(event, "Account partially frozen event should be emitted");

      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(
        event!.frozenBalance.toString(),
        frozenBalance.toString(),
        "event frozenBalance should match the balance"
      );
      assert.equal(event!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
    });

    // ── Error case: partially_freeze_account — UnauthorizedDeployer ─────────────
    it("partially_freeze_account: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      const rogueKeypair = Keypair.generate();
      await requestAirdrop(rogueKeypair.publicKey);

      try {
        await partiallyFreezeAccount({
          deployer: rogueKeypair.publicKey,
          mint,
          account: tokenAccount,
          signers: [rogueKeypair],
        });
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

    // ── Error case: partially_freeze_account — MintPaused ───────────────────────
    it("partially_freeze_account: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      await pauseMint({ deployer, mint });

      try {
        await partiallyFreezeAccount({ deployer, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });
  });

  describe("remove_partial_freeze", async () => {
    // ── Happy-path: remove_partial_freeze ───────────────────────────────────────
    it("remove_partial_freeze: closes the frozen_balance PDA for a token account", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      const frozenBalancePda = pdaUtils.frozenBalancePda(mint, tokenAccount);

      // ── First: partially freeze the account ──────────────────────────────────
      const frozenBalance = new anchor.BN(500_000_000);
      await partiallyFreezeAccount({ deployer, mint, account: tokenAccount }, { balance: frozenBalance });

      const statusAfterFreeze = await getFrozenBalanceByPda(frozenBalancePda);
      assert.isNotNull(statusAfterFreeze, "frozen_balance PDA should exist after partially_freeze_account");

      // ── Then: remove the partial freeze ──────────────────────────────────────
      const { signature } = await removePartialFreeze({ deployer, mint, account: tokenAccount });

      // ── Verify the frozen_balance PDA has been closed ────────────────────────
      const statusAfterRemove = await getFrozenBalanceByPda(frozenBalancePda);
      assert.isNull(statusAfterRemove, "frozen_balance PDA should not exist after remove_partial_freeze");

      const event = await getAccountPartialFreezeRemovedEvent(signature);

      assert.isNotNull(event, "Account partial freeze removed event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
      assert.equal(event!.account.toBase58(), tokenAccount.toBase58(), "event account should match the token account");
      assert.equal(event!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
    });

    // ── Error case: remove_partial_freeze — UnauthorizedDeployer ────────────────
    it("remove_partial_freeze: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });

      // ── Partially freeze the account so frozen_balance_pda exists ────────────
      await partiallyFreezeAccount({ deployer, mint, account: tokenAccount });

      const rogueKeypair = Keypair.generate();
      await requestAirdrop(rogueKeypair.publicKey);

      try {
        await removePartialFreeze({
          deployer: rogueKeypair.publicKey,
          mint,
          account: tokenAccount,
          signers: [rogueKeypair],
        });
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

    // ── Error case: remove_partial_freeze — MintPaused ──────────────────────────
    it("remove_partial_freeze: fails with MintPaused when mint is paused", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      await partiallyFreezeAccount({ deployer, mint, account: tokenAccount });
      await pauseMint({ deployer, mint });

      try {
        await removePartialFreeze({ deployer, mint, account: tokenAccount });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    // ── Error case: remove_partial_freeze — Deactivated ─────────────────────────
    it("remove_partial_freeze: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      await partiallyFreezeAccount({ deployer, mint, account: tokenAccount });
      await deactivateMint({ deployer, mint });

      try {
        await removePartialFreeze({ deployer, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });
  });

  describe("partially_freeze_account account", async () => {
    // ── Error case: partially_freeze_account — Deactivated ──────────────────────
    it("partially_freeze_account: fails with Deactivated when mint has been deactivated", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      await deactivateMint({ deployer, mint });

      try {
        await partiallyFreezeAccount({ deployer, mint, account: tokenAccount });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });

    // ── partially_freeze_account overwrites without prior unfreeze ──
    it("partially_freeze_account: a second call on the same account overwrites the balance without remove_partial_freeze", async () => {
      const tokenAccount = await createTokenAccount({ mint, owner: deployer });
      const [frozenBalancePda, expectedBump] = pdaUtils.frozenBalancePdaWithBump(mint, tokenAccount);
      const FIRST_BALANCE = new anchor.BN(500_000_000);
      const SECOND_BALANCE = new anchor.BN(300_000_000);

      // ── First call: creates the PDA with FIRST_BALANCE ───────────────────────
      await partiallyFreezeAccount({ deployer, mint, account: tokenAccount }, { balance: FIRST_BALANCE });

      const stateAfterFirst = await getFrozenBalanceByPda(frozenBalancePda);
      assert.equal(
        stateAfterFirst.balance.toString(),
        FIRST_BALANCE.toString(),
        "balance after first call should equal FIRST_BALANCE"
      );

      // ── Second call (same PDA, new value): MUST overwrite, NOT fail ──────────
      await partiallyFreezeAccount({ deployer, mint, account: tokenAccount }, { balance: SECOND_BALANCE });
      const stateAfterSecond = await getFrozenBalanceByPda(frozenBalancePda);

      assert.equal(
        stateAfterSecond.balance.toString(),
        SECOND_BALANCE.toString(),
        "balance after second call should overwrite to SECOND_BALANCE (not add, not keep first)"
      );
      assert.equal(stateAfterSecond.bump, expectedBump, "bump should remain the canonical bump after overwrite");
    });
  });
});
