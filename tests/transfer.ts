import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_FREEZE_MANAGER } from "./utils/roles";
import {
  freezeAccount,
  partiallyFreezeAccount,
  removePartialFreeze,
} from "./program_helpers/freeze/freeze_instruction_helper";
import { getFrozenBalanceByPda } from "./program_helpers/freeze/freeze_pda_helper";
import * as freezePdaUtils from "./program_helpers/freeze/freeze_pda_helper";
import {
  burnTokensViaSurfpool,
  createTokenAccount,
  getMint,
  getTokenAccount,
  mintTokensViaSurfpool,
  setMintPaused,
} from "./program_helpers/spl_token_helper";
import { getHolderBalanceSnapshotAt } from "./program_helpers/snapshot/snapshot_instruction_helper";
import { TRANSFER_CONTROL_WHITELIST } from "./program_helpers/transfer_control/transfer_control_instruction_helper";
import { buildVerifyTransferInstruction, transfer, verifyTransfer } from "./program_helpers/transfer_helper";
import { beforeEach } from "mocha";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import {
  COUPON_CREATE_COUPON,
  DEACTIVATE_DEACTIVATE,
  FREEZE_FREEZE_ACCOUNT,
  FREEZE_PARTIALLY_FREEZE_ACCOUNT,
  FREEZE_REMOVE_PARTIAL_FREEZE,
  MINT_MINT,
  OPERATIONS_BURN,
  PAUSE_PAUSE,
  TRANSFER_CONTROL_ADD_TO_WHITELIST,
  TRANSFER_CONTROL_INITIALIZE,
  TRANSFER_HOOK_EXECUTE,
} from "./utils/functionalities";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setCoupon } from "./program_helpers/coupon/coupon_pda_helper";
import {
  setTransferControlModeMarker,
  setWhitelistMarker,
} from "./program_helpers/transfer_control/transfer_control_pda_helper";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
const TRANSFER_AMOUNT = new anchor.BN(400 * 10 ** MINT_DECIMALS);
const FUND_AMOUNT_IN_LAMPORT = anchor.web3.LAMPORTS_PER_SOL * 0.01;

describe("transfer", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sourceOwnerKeypair = Keypair.generate();
  const sourceOwner = sourceOwnerKeypair.publicKey;
  const destinationOwnerKeypair = Keypair.generate();
  const destinationOwner = destinationOwnerKeypair.publicKey;
  const authority = provider.wallet.payer;
  const payerKeypair = provider.wallet.payer!;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint());
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        PAUSE_PAUSE,
        OPERATIONS_BURN,
        TRANSFER_CONTROL_INITIALIZE,
        TRANSFER_CONTROL_ADD_TO_WHITELIST,
        COUPON_CREATE_COUPON,
        DEACTIVATE_DEACTIVATE,
        FREEZE_FREEZE_ACCOUNT,
        FREEZE_PARTIALLY_FREEZE_ACCOUNT,
        FREEZE_REMOVE_PARTIAL_FREEZE,
        MINT_MINT,
        TRANSFER_HOOK_EXECUTE,
      ],
    });
  });

  // ── Helper: fund the transfer hook authority PDA ────────────────────────────
  async function fundTransferHookAuthority(mint: PublicKey): Promise<void> {
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payerKeypair.publicKey,
        toPubkey: pdaUtils.transferHookAuthorityPda(mint),
        lamports: FUND_AMOUNT_IN_LAMPORT,
      })
    );
    await anchor.web3.sendAndConfirmTransaction(provider.connection, tx, [payerKeypair], { commitment: "confirmed" });
  }

  describe("transfer", () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: moves tokens from source to destination", async () => {
      // Mint 1 000 tokens to the source account (owned by sourceOwner).
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });
      const supplyBefore = (await getMint(mint)).supply;

      // Fund transferHookAuthority PDA so it can pay for accounts if needed
      await fundTransferHookAuthority(mint);

      // ── Call transfer ──────────────────────────────────────────────────────
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: TRANSFER_AMOUNT }
      );

      const sourceAfter = (await getTokenAccount(source)).amount;
      const destAfter = (await getTokenAccount(destination)).amount;
      const supplyAfter = (await getMint(mint)).supply;

      assert.equal(
        sourceAfter.toString(),
        (MINT_AMOUNT.toNumber() - TRANSFER_AMOUNT.toNumber()).toString(),
        "source balance should be reduced by the transfer amount"
      );
      assert.equal(
        destAfter.toString(),
        TRANSFER_AMOUNT.toString(),
        "destination balance should equal the transfer amount"
      );
      assert.equal(
        supplyAfter.toString(),
        supplyBefore.toString(),
        "total supply should be unchanged after a transfer"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: snapshot captures pre-transfer balances (source = minted - transferred, destination = transferred)", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      const couponId = new anchor.BN(1);

      // ── Take snapshot via create_coupon (counter: 0 → 1) ─────────────────────
      await setCoupon(mint, couponId);

      // ── Fund and transfer ─────────────────────────────────────────────────────
      await fundTransferHookAuthority(mint);
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: TRANSFER_AMOUNT }
      );

      // ── Assert snapshot values via get_holderbalance_snapshot_at ─────────────
      // snapshot id is 0-based: coupon N triggers snapshot N-1.
      const snapshotId = couponId.sub(new anchor.BN(1));
      const senderValue = await getHolderBalanceSnapshotAt({ mint, holderTokenAccount: source }, { snapshotId });
      const receiverValue = await getHolderBalanceSnapshotAt({ mint, holderTokenAccount: destination }, { snapshotId });

      assert.equal(
        senderValue.toString(),
        MINT_AMOUNT.toNumber().toString(),
        "sender snapshot should equal pre-transfer balance"
      );
      assert.equal(receiverValue.toString(), "0", "receiver snapshot should equal pre-transfer balance");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: multiple sequential post-snapshot transfers do not corrupt snapshot data", async () => {
      const FIRST_TRANSFER = new anchor.BN(300 * 10 ** MINT_DECIMALS);
      const SECOND_TRANSFER = new anchor.BN(200 * 10 ** MINT_DECIMALS);
      const THIRD_TRANSFER = new anchor.BN(100 * 10 ** MINT_DECIMALS);

      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      const couponId1 = new anchor.BN(1);

      // ── Take snapshot 1 (counter: 0 → 1) ─────────────────────────────────────
      await setCoupon(mint, couponId1);

      await fundTransferHookAuthority(mint);

      // ── First transfer in snapshot period 1 (300 tokens) ──────────────────────
      // Hook writes: sender (key=1, value=MINT_AMOUNT), receiver (key=1, value=0).
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: FIRST_TRANSFER }
      );

      // ── Second transfer in snapshot period 1 (200 tokens) ─────────────────────
      // Counter still at 1: the hook must not overwrite the existing key=1 entries.
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: SECOND_TRANSFER }
      );

      // ── Live balances after both period-1 transfers ───────────────────────────
      const sourceAfterTwo = (await getTokenAccount(source)).amount;
      const destAfterTwo = (await getTokenAccount(destination)).amount;

      assert.equal(
        sourceAfterTwo.toString(),
        (MINT_AMOUNT.toNumber() - FIRST_TRANSFER.toNumber() - SECOND_TRANSFER.toNumber()).toString(),
        "source balance should be MINT_AMOUNT - 300 - 200 after two transfers"
      );
      assert.equal(
        destAfterTwo.toString(),
        (FIRST_TRANSFER.toNumber() + SECOND_TRANSFER.toNumber()).toString(),
        "destination balance should be 300 + 200 after two transfers"
      );

      // ── Snapshot 1 must reflect the pre-first-transfer state ──────────────────
      const senderAt1_afterTwo = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: source },
        { snapshotId: couponId1.sub(new anchor.BN(1)) }
      );
      const receiverAt1_afterTwo = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: destination },
        { snapshotId: couponId1.sub(new anchor.BN(1)) }
      );

      assert.equal(
        senderAt1_afterTwo.toString(),
        MINT_AMOUNT.toString(),
        "sender snapshot at key=1 should be MINT_AMOUNT after two period-1 transfers"
      );
      assert.equal(
        receiverAt1_afterTwo.toString(),
        "0",
        "receiver snapshot at key=1 should be 0 after two period-1 transfers"
      );

      // ── Take snapshot 2 (counter: 1 → 2) ─────────────────────────────────────
      const couponId2 = new anchor.BN(2);
      await setCoupon(mint, couponId2);

      // ── Third transfer in snapshot period 2 (100 tokens) ──────────────────────
      // Hook appends: sender (key=2, value=MINT_AMOUNT-300-200), receiver (key=2, value=300+200).
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: THIRD_TRANSFER }
      );

      // ── Live balances after all three transfers ───────────────────────────────
      const sourceAfterThree = (await getTokenAccount(source)).amount;
      const destAfterThree = (await getTokenAccount(destination)).amount;

      assert.equal(
        sourceAfterThree.toString(),
        (
          MINT_AMOUNT.toNumber() -
          FIRST_TRANSFER.toNumber() -
          SECOND_TRANSFER.toNumber() -
          THIRD_TRANSFER.toNumber()
        ).toString(),
        "source balance should be MINT_AMOUNT - 300 - 200 - 100 after three transfers"
      );
      assert.equal(
        destAfterThree.toString(),
        (FIRST_TRANSFER.toNumber() + SECOND_TRANSFER.toNumber() + THIRD_TRANSFER.toNumber()).toString(),
        "destination balance should be 300 + 200 + 100 after three transfers"
      );

      // ── Snapshot 1 must still be intact after the period-2 transfer ───────────
      const senderAt1_final = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: source },
        { snapshotId: couponId1.sub(new anchor.BN(1)) }
      );
      const receiverAt1_final = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: destination },
        { snapshotId: couponId1.sub(new anchor.BN(1)) }
      );

      assert.equal(
        senderAt1_final.toString(),
        MINT_AMOUNT.toString(),
        "snapshot 1 sender must be unchanged after the period-2 transfer"
      );
      assert.equal(
        receiverAt1_final.toString(),
        "0",
        "snapshot 1 receiver must be unchanged after the period-2 transfer"
      );

      // ── Snapshot 2 must capture the state at the start of period 2 ───────────
      // When the 3rd transfer's hook ran, Token-2022 had already settled balances:
      // source = MINT_AMOUNT-300-200-100, destination = 300+200+100.
      // The hook adjusts by the delta to recover the pre-transfer balances:
      // sender:   (MINT_AMOUNT-600) + 100 = MINT_AMOUNT-500   = 500 tokens
      // receiver: (300+200+100)     - 100 = 300+200           = 500 tokens
      const expectedSenderAt2 = MINT_AMOUNT.toNumber() - FIRST_TRANSFER.toNumber() - SECOND_TRANSFER.toNumber();
      const expectedReceiverAt2 = FIRST_TRANSFER.toNumber() + SECOND_TRANSFER.toNumber();

      const senderAt2 = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: source },
        { snapshotId: couponId2.sub(new anchor.BN(1)) }
      );
      const receiverAt2 = await getHolderBalanceSnapshotAt(
        { mint, holderTokenAccount: destination },
        { snapshotId: couponId2.sub(new anchor.BN(1)) }
      );

      assert.equal(
        senderAt2.toString(),
        expectedSenderAt2.toString(),
        "snapshot 2 sender should equal the pre-third-transfer source balance (500 tokens)"
      );
      assert.equal(
        receiverAt2.toString(),
        expectedReceiverAt2.toString(),
        "snapshot 2 receiver should equal the pre-third-transfer destination balance (500 tokens)"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails when there is no previous instruction", async () => {
      // Mint 1 000 tokens to the source account (owned by sourceOwner).
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Fund transferHookAuthority PDA so it can pay for accounts if needed
      await fundTransferHookAuthority(mint);

      try {
        await transfer({
          mint,
          source,
          sourceOwner,
          destination,
          preInstructions: [],
          signers: [sourceOwnerKeypair],
        });
        assert.fail("Expected NoPreviousInstruction error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "NoPreviousInstruction",
          "error code should be NoPreviousInstruction"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails when previous instruction program is not verify program", async () => {
      // Mint 1 000 tokens to the source account (owned by sourceOwner).
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Fund transferHookAuthority PDA so it can pay for accounts if needed
      await fundTransferHookAuthority(mint);

      // ── Call transfer ──────────────────────────────────────────────────────
      const verifyIx = await buildVerifyTransferInstruction(
        { mint, source, sourceOwner, destination },
        { amount: TRANSFER_AMOUNT }
      );
      try {
        const preInstructions = [verifyIx, anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
        await transfer(
          { mint, source, sourceOwner, destination, preInstructions, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected PrevInstructionWrongProgram error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "PrevInstructionWrongProgram",
          "error code should be PrevInstructionWrongProgram"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails when previous instruction method does not have the proper input arguments", async () => {
      // Mint 1 000 tokens to the source account (owned by sourceOwner).
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Fund transferHookAuthority PDA so it can pay for accounts if needed
      await fundTransferHookAuthority(mint);

      const verifyTransferAmount = TRANSFER_AMOUNT.sub(new anchor.BN(1));
      const verifyIx = await buildVerifyTransferInstruction(
        { mint, source, sourceOwner, destination },
        { amount: verifyTransferAmount }
      );
      try {
        const preInstructions = [anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx];
        await transfer(
          { mint, source, sourceOwner, destination, preInstructions, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected PrevInstructionArgumentMismatch error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "PrevInstructionArgumentMismatch",
          "error code should be PrevInstructionArgumentMismatch"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Re-seed the asset-class version WITHOUT finalizing it.
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [TRANSFER_HOOK_EXECUTE],
      });

      await fundTransferHookAuthority(mint);
      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
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

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails with FunctionalityNotSupportedError when the transfer_hook_execute functionality is not enabled", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Re-seed the asset-class version WITHOUT the transfer_hook_execute functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      await fundTransferHookAuthority(mint);
      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
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

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails when signer is not token holder", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
      const rogueKeypair = Keypair.generate();

      await fundTransferHookAuthority(mint);
      try {
        await transfer(
          { mint, source, sourceOwner: rogueKeypair.publicKey, destination, signers: [rogueKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected owner-mismatch error but instruction succeeded");
      } catch (err) {
        // Ownership of the source token account is enforced natively by Token-2022
        // during transfer_checked (before the hook runs), so the error surfaces as
        // a Token-2022 OwnerMismatch (SendTransactionError) rather than an AnchorError.
        assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
        const sendErr = err as SendTransactionError;
        const logs = sendErr.logs ?? [];
        assert.isTrue(
          logs.some((log) => log.toLowerCase().includes("owner does not match")),
          "transaction logs should mention Token-2022 owner mismatch"
        );
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails when mint is paused", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      await setMintPaused(mint, true);

      await fundTransferHookAuthority(mint);
      try {
        await transfer({ mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] });
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

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: fails with InsufficientUnfrozenBalance, then succeeds after partial freeze is updated", async () => {
      const TOTAL_AMOUNT = new anchor.BN(100 * 10 ** MINT_DECIMALS);
      const FROZEN_AMOUNT = new anchor.BN(80 * 10 ** MINT_DECIMALS); // 20 available
      const TRANSFER_AMOUNT = new anchor.BN(50 * 10 ** MINT_DECIMALS); // 50 > 20 → fails
      const UPDATED_FROZEN_AMOUNT = new anchor.BN(40 * 10 ** MINT_DECIMALS); // 60 available
      // same transfer amount retried after update — 50 <= 60 → succeeds

      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, TOTAL_AMOUNT);

      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      const frozenBalancePda = freezePdaUtils.frozenBalancePda(mint, source);

      // ── Partially freeze 80 tokens (only 20 available) ───────────────────────
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await partiallyFreezeAccount({ authority, mint, account: source }, { balance: FROZEN_AMOUNT });

      await fundTransferHookAuthority(mint);
      try {
        await verifyTransfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected InsufficientUnfrozenBalance error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "InsufficientUnfrozenBalance",
          "error code should be InsufficientUnfrozenBalance"
        );
      }

      // ── Update partial freeze to 40 tokens (60 now available) ────────────────
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await partiallyFreezeAccount({ authority, mint, account: source }, { balance: UPDATED_FROZEN_AMOUNT });

      const frozenBalanceAfterUpdate = await getFrozenBalanceByPda(frozenBalancePda);
      assert.equal(
        frozenBalanceAfterUpdate.balance.toString(),
        UPDATED_FROZEN_AMOUNT.toString(),
        "frozen balance PDA should reflect the updated frozen amount"
      );

      // ── Retry same transfer — succeeds (available = 60 >= 50) ────────────────
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: TRANSFER_AMOUNT }
      );

      const sourceAfter = (await getTokenAccount(source)).amount;
      const destAfter = (await getTokenAccount(destination)).amount;

      assert.equal(
        sourceAfter.toString(),
        (TOTAL_AMOUNT.toNumber() - TRANSFER_AMOUNT.toNumber()).toString(),
        "source should have 50 tokens after transferring 50"
      );
      assert.equal(destAfter.toString(), TRANSFER_AMOUNT.toString(), "destination should have received 50 tokens");
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("transfer: succeeds when transfer is within unfrozen balance, then fails with InsufficientUnfrozenBalance when it exceeds it", async () => {
      const TOTAL_AMOUNT = new anchor.BN(100 * 10 ** MINT_DECIMALS);
      const FROZEN_AMOUNT = new anchor.BN(50 * 10 ** MINT_DECIMALS);
      const FIRST_TRANSFER = new anchor.BN(40 * 10 ** MINT_DECIMALS); // 50 available >= 40 ✓
      const SECOND_TRANSFER = new anchor.BN(20 * 10 ** MINT_DECIMALS); // 10 available < 20  ✗

      // ── Mint 100 tokens to source account (owned by sourceOwner) ─────────────
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, TOTAL_AMOUNT);

      // ── Create destination token account ──────────────────────────────────────
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // ── Partially freeze 50 tokens ────────────────────────────────────────────
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await partiallyFreezeAccount({ authority, mint, account: source }, { balance: FROZEN_AMOUNT });

      // ── Transfer 40 tokens — succeeds (available = 100 - 50 = 50 >= 40) ──────
      await fundTransferHookAuthority(mint);
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: FIRST_TRANSFER }
      );

      const sourceAfter = (await getTokenAccount(source)).amount;

      assert.equal(
        sourceAfter.toString(),
        (TOTAL_AMOUNT.toNumber() - FIRST_TRANSFER.toNumber()).toString(),
        "source balance should be 60 tokens after transferring 40"
      );

      // ── Transfer 20 tokens — fails (available = 60 - 50 = 10 < 20) ───────────
      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: SECOND_TRANSFER }
        );
        assert.fail("Expected InsufficientUnfrozenBalance error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "InsufficientUnfrozenBalance",
          "error code should be InsufficientUnfrozenBalance"
        );
      }
    });

    // ── burn × partial freeze handled correctly (no panic, transfers stay blocked) ──
    it("transfer: burning below the partial-freeze amount leaves the frozen PDA stale and blocks all outbound transfers", async () => {
      const TOTAL_AMOUNT = new anchor.BN(100 * 10 ** MINT_DECIMALS);
      const FROZEN_AMOUNT = new anchor.BN(40 * 10 ** MINT_DECIMALS);
      const BURN_AMOUNT = new anchor.BN(80 * 10 ** MINT_DECIMALS);
      const TRANSFER_ATTEMPT = new anchor.BN(10 ** MINT_DECIMALS);
      const EXPECTED_REMAINDER = TOTAL_AMOUNT.sub(BURN_AMOUNT); // 20 tokens, < FROZEN_AMOUNT (40)

      // ── Mint 100 tokens to source ─────────────────────────────────────────────
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, TOTAL_AMOUNT);

      // ── Create destination token account ──────────────────────────────────────
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      const frozenBalancePda = freezePdaUtils.frozenBalancePda(mint, source);

      // ── Partially freeze 40 tokens (available = 60 of 100) ────────────────────
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await partiallyFreezeAccount({ authority, mint, account: source }, { balance: FROZEN_AMOUNT });

      // ── Burn 80 via permanent-delegate (issuer redemption) ────────────────────
      //
      // Operations::burn doesn't read or adjust frozen_balance_pda, so afterwards
      // we have: token_account.amount = 20, frozen_balance_pda.balance = 40.
      // `require_unfrozen_balance` uses saturating_sub → available = 0.
      await burnTokensViaSurfpool(mint, source, BURN_AMOUNT);

      const sourceAfterBurn = (await getTokenAccount(source)).amount;
      const frozenAfterBurn = await getFrozenBalanceByPda(frozenBalancePda);

      // (1) Burn succeeded — balance is now below the recorded frozen amount.
      assert.equal(sourceAfterBurn.toString(), EXPECTED_REMAINDER.toString(), "burn should leave 20 tokens (100 − 80)");

      // (2) PDA is stale — burn does not adjust frozen_balance_pda by design.
      assert.equal(
        frozenAfterBurn.balance.toString(),
        FROZEN_AMOUNT.toString(),
        "frozen_balance_pda should still record the original 40 (stale, as documented)"
      );

      // (3) Any positive outbound transfer must fail — saturating_sub clamps available to 0.
      await fundTransferHookAuthority(mint);
      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_ATTEMPT }
        );
        assert.fail("Expected InsufficientUnfrozenBalance error but transfer succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError raised by verify_transfer");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "InsufficientUnfrozenBalance",
          "available balance must clamp to 0 via saturating_sub, blocking the transfer"
        );
      }

      // (4) Recovery path — after remove_partial_freeze, the 20 remaining tokens transact normally.
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await removePartialFreeze({ mint, authority, account: source });
      await transfer(
        { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
        { amount: TRANSFER_ATTEMPT }
      );

      const sourceAfterRecovery = (await getTokenAccount(source)).amount;
      assert.equal(
        sourceAfterRecovery.toString(),
        EXPECTED_REMAINDER.sub(TRANSFER_ATTEMPT).toString(),
        "after remove_partial_freeze the remaining tokens transact normally"
      );
    });
  });

  describe("verify_transfer", async () => {
    // ────────────────────────────────────────────────────────────────────────────
    it("verify_transfer: fails with NotWhitelisted when whitelist mode is active and source is not whitelisted", async () => {
      // Mint tokens to source before activating whitelist mode
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create destination token account
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Activate whitelist mode
      await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);

      // Add destination to whitelist — source is NOT whitelisted
      await setWhitelistMarker(mint, destination);

      const sourceBefore = (await getTokenAccount(source)).amount;
      const destBefore = (await getTokenAccount(destination)).amount;

      await fundTransferHookAuthority(mint);
      try {
        await verifyTransfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected NotWhitelisted error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted", "error code should be NotWhitelisted");
      }

      const sourceAfter = (await getTokenAccount(source)).amount;
      const destAfter = (await getTokenAccount(destination)).amount;

      assert.equal(
        sourceAfter.toString(),
        sourceBefore.toString(),
        "source balance must be unchanged after rejected transfer"
      );
      assert.equal(
        destAfter.toString(),
        destBefore.toString(),
        "destination balance must be unchanged after rejected transfer"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("verify_transfer: fails with NotWhitelisted when whitelist mode is active and destination is not whitelisted", async () => {
      // Mint tokens to source before activating whitelist mode
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create destination token account
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // Activate whitelist mode
      await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);

      // Add source to whitelist — destination is NOT whitelisted
      await setWhitelistMarker(mint, source);

      const sourceBefore = (await getTokenAccount(source)).amount;
      const destBefore = (await getTokenAccount(destination)).amount;

      await fundTransferHookAuthority(mint);
      try {
        await transfer(
          { mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] },
          { amount: TRANSFER_AMOUNT }
        );
        assert.fail("Expected NotWhitelisted error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted", "error code should be NotWhitelisted");
      }

      const sourceAfter = (await getTokenAccount(source)).amount;
      const destAfter = (await getTokenAccount(destination)).amount;

      assert.equal(
        sourceAfter.toString(),
        sourceBefore.toString(),
        "source balance must be unchanged after rejected transfer"
      );
      assert.equal(
        destAfter.toString(),
        destBefore.toString(),
        "destination balance must be unchanged after rejected transfer"
      );
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("verify_transfer: fails with AccountFrozen when source account has been frozen", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);
      const destination = await createTokenAccount({ mint, owner: destinationOwner });
      await setRoles(mint, authority.publicKey, [ROLE_FREEZE_MANAGER]);
      await freezeAccount({ authority, mint, account: source });

      // ── Transfer must now be rejected with AccountFrozen ──────────────────
      await fundTransferHookAuthority(mint);
      try {
        await verifyTransfer({ mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] });
        assert.fail("Expected AccountFrozen error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "AccountFrozen", "error code should be AccountFrozen");
      }
    });

    // ────────────────────────────────────────────────────────────────────────────
    it("verify_transfer: fails with Deactivated when mint has been deactivated", async () => {
      const source = await createTokenAccount({ mint, owner: sourceOwner });
      await mintTokensViaSurfpool(mint, source, MINT_AMOUNT);

      // Create a destination token account (owned by destinationOwner).
      const destination = await createTokenAccount({ mint, owner: destinationOwner });

      // ── Deactivate the mint ────────────────────────────────────────────────
      await setDeactivateMarker(mint);

      // ── Mint must now be rejected with Deactivated ─────────────────────────
      await fundTransferHookAuthority(mint);
      try {
        await verifyTransfer({ mint, source, sourceOwner, destination, signers: [sourceOwnerKeypair] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });
  });
});
