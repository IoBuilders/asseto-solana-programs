import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { beforeEach } from "mocha";
import { deployMint } from "./program_helpers/deploy_helper";
import { setAssetClassVersionForMint } from "./program_helpers/factory/factory_pda_helper";
import {
  HOLD_CREATE_HOLD,
  MINT_MINT,
  OPERATIONS_BURN,
  OPERATIONS_CONTROLLER_TRANSFER,
  TRANSFER_CONTROL_ADD_TO_WHITELIST,
  TRANSFER_CONTROL_INITIALIZE,
  TRANSFER_HOOK_EXECUTE,
} from "./utils/functionalities";
import {
  batchBurnTokens,
  burnTokens,
  controllerTransfer,
} from "./program_helpers/operations/operations_instruction_helper";
import {
  createTokenAccount,
  getTokenAccount,
  mintTokensViaSurfpool,
  setMintPaused,
} from "./program_helpers/spl_token_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setFrozenAccountPda, setFrozenBalancePda } from "./program_helpers/freeze/freeze_pda_helper";
import {
  setTransferControlModeMarker,
  setWhitelistMarker,
} from "./program_helpers/transfer_control/transfer_control_pda_helper";
import { TRANSFER_CONTROL_WHITELIST } from "./program_helpers/transfer_control/transfer_control_instruction_helper";
import { splTransfer } from "./program_helpers/transfer_helper";
import { requestAirdrop } from "./program_helpers/account_helper";
import {
  getHold,
  getHoldPosition,
  getHoldPositionNullable,
  holdPositionPda,
  setHoldRecord,
} from "./program_helpers/hold/hold_pda_helper";
import {
  controllerCreateHold,
  createHold,
  defaultExpiration,
  executeHold,
  getControllerHoldCreatedEvent,
  getHoldCreatedEvent,
  getHoldExecutedEvent,
  getHoldReclaimedEvent,
  getHoldReleasedEvent,
  reclaimHold,
  releaseHold,
} from "./program_helpers/hold/hold_instruction_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_ADMIN, ROLE_CONTROLLER } from "./utils/roles";

const MINT_DECIMALS = 6;
const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
const HOLD_AMOUNT = new anchor.BN(400 * 10 ** MINT_DECIMALS);

describe("hold", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const holderKeypair = Keypair.generate();
  const holder = holderKeypair.publicKey;
  const escrowKeypair = Keypair.generate();
  const recipientOwnerKeypair = Keypair.generate();
  const controllerKeypair = Keypair.generate();
  const payerKeypair = provider.wallet.payer!;

  let mint: PublicKey;
  let holderTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;

  // `create_hold` defaults `payer` to the holder, which here is not the provider
  // wallet, so the holder needs SOL to fund its own `hold_position` + `hold`.
  // Once is enough: these keypairs live for the whole suite.
  before(async () => {
    await requestAirdrop(holder);
  });

  beforeEach(async () => {
    ({ mint } = await deployMint(undefined, { decimals: MINT_DECIMALS }));
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        HOLD_CREATE_HOLD,
        MINT_MINT,
        TRANSFER_HOOK_EXECUTE,
        TRANSFER_CONTROL_INITIALIZE,
        TRANSFER_CONTROL_ADD_TO_WHITELIST,
        OPERATIONS_CONTROLLER_TRANSFER,
        OPERATIONS_BURN,
      ],
    });

    holderTokenAccount = await createTokenAccount({ mint, owner: holder });
    recipientTokenAccount = await createTokenAccount({ mint, owner: recipientOwnerKeypair.publicKey });
    await mintTokensViaSurfpool(mint, holderTokenAccount, MINT_AMOUNT);
  });

  // ── create_hold ────────────────────────────────────────────────────────────

  describe("create_hold", () => {
    it("create_hold: records the lien and the hold without moving any tokens", async () => {
      const expiration = defaultExpiration();
      const { signature, holdId } = await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount, payer: payerKeypair.publicKey },
        { amount: HOLD_AMOUNT, expiration, escrow: escrowKeypair.publicKey, destination: recipientTokenAccount }
      );

      assert.equal(holdId.toNumber(), 0, "first hold on a position gets id 0");

      // The whole point of the lien model: the balance is untouched.
      const tokenAccount = await getTokenAccount(holderTokenAccount);
      assert.equal(tokenAccount.amount.toString(), MINT_AMOUNT.toString());

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toString(), HOLD_AMOUNT.toString());
      assert.equal(position.nextHoldId.toNumber(), 1);
      assert.equal(position.mint.toBase58(), mint.toBase58());
      assert.equal(position.tokenAccount.toBase58(), holderTokenAccount.toBase58());

      const hold = await getHold(mint, holderTokenAccount, holdId);
      assert.equal(hold.escrow.toBase58(), escrowKeypair.publicKey.toBase58());
      assert.equal(hold.destination!.toBase58(), recipientTokenAccount.toBase58());
      assert.equal(hold.initialAmount.toString(), HOLD_AMOUNT.toString());
      assert.equal(hold.currentAmount.toString(), HOLD_AMOUNT.toString());
      assert.equal(hold.expiration.toString(), expiration.toString());
      assert.deepEqual(hold.status, { active: {} });

      const event = await getHoldCreatedEvent(signature);
      assert.isNotNull(event, "HoldCreated event should be emitted");
      assert.equal(event!.mint.toBase58(), mint.toBase58());
      assert.equal(event!.holdId.toNumber(), 0);
      assert.equal(event!.amount.toString(), HOLD_AMOUNT.toString());
      assert.equal(event!.escrow.toBase58(), escrowKeypair.publicKey.toBase58());
    });

    it("create_hold: a second hold gets the next id and accumulates on the same position", async () => {
      const context = { authority: holderKeypair, mint, tokenAccount: holderTokenAccount };
      await createHold(context, { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey });
      const { holdId } = await createHold(context, {
        amount: new anchor.BN(100),
        escrow: escrowKeypair.publicKey,
      });

      assert.equal(holdId.toNumber(), 1);
      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.nextHoldId.toNumber(), 2);
      assert.equal(position.heldAmount.toString(), HOLD_AMOUNT.add(new anchor.BN(100)).toString());
    });

    it("create_hold: leaves destination unset when none is pinned", async () => {
      const { holdId } = await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey, destination: null }
      );

      const hold = await getHold(mint, holderTokenAccount, holdId);
      assert.isNull(hold.destination, "destination should stay open for the escrow to pick at execution");
    });

    it("create_hold: fails with ZeroAmount for a zero-amount hold", async () => {
      await assertFails("ZeroAmount", () =>
        createHold({ authority: holderKeypair, mint, tokenAccount: holderTokenAccount }, { amount: new anchor.BN(0) })
      );
    });

    it("create_hold: fails with ExpirationInThePast when the expiration has already lapsed", async () => {
      await assertFails("ExpirationInThePast", () =>
        createHold(
          { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
          { amount: HOLD_AMOUNT, expiration: new anchor.BN(Math.floor(Date.now() / 1000) - 60) }
        )
      );
    });

    it("create_hold: fails with HoldIdMismatch when the supplied id is not the next one", async () => {
      await assertFails("HoldIdMismatch", () =>
        createHold(
          { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
          { holdId: new anchor.BN(7), amount: HOLD_AMOUNT }
        )
      );
    });

    it("create_hold: fails with InsufficientAvailableBalance when the amount exceeds the balance", async () => {
      await assertFails("InsufficientAvailableBalance", () =>
        createHold(
          { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
          { amount: MINT_AMOUNT.add(new anchor.BN(1)) }
        )
      );
    });

    it("create_hold: fails with InsufficientAvailableBalance when a partial freeze covers the balance", async () => {
      // Freeze all but one unit, so a 400-token hold no longer fits.
      await setFrozenBalancePda(mint, holderTokenAccount, MINT_AMOUNT.sub(new anchor.BN(1)));

      await assertFails("InsufficientAvailableBalance", () =>
        createHold({ authority: holderKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT })
      );
    });

    it("create_hold: fails with InsufficientAvailableBalance when an existing hold covers the balance", async () => {
      const context = { authority: holderKeypair, mint, tokenAccount: holderTokenAccount };
      await createHold(context, { amount: MINT_AMOUNT });

      await assertFails("InsufficientAvailableBalance", () => createHold(context, { amount: new anchor.BN(1) }));
    });

    it("create_hold: fails with AccountFrozen when the holder's account is frozen", async () => {
      await setFrozenAccountPda(mint, holderTokenAccount);

      await assertFails("AccountFrozen", () =>
        createHold({ authority: holderKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT })
      );
    });

    it("create_hold: fails with MintPaused when the mint is paused", async () => {
      await setMintPaused(mint, true);

      await assertFails("MintPaused", () =>
        createHold({ authority: holderKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT })
      );
    });

    it("create_hold: fails with Deactivated when the mint is deactivated", async () => {
      await setDeactivateMarker(mint);

      await assertFails("Deactivated", () =>
        createHold({ authority: holderKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT })
      );
    });

    it("create_hold: fails with FunctionalityNotSupportedError when the functionality bit is disabled", async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      await assertFails("FunctionalityNotSupportedError", () =>
        createHold({ authority: holderKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT })
      );
    });

    it("create_hold: fails with NotWhitelisted when the holder is not eligible", async () => {
      await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);

      await assertFails("NotWhitelisted", () =>
        createHold({ authority: holderKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT })
      );
    });

    it("create_hold: fails with NotWhitelisted when the pinned destination is not eligible", async () => {
      await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);
      await setWhitelistMarker(mint, holderTokenAccount);

      await assertFails("NotWhitelisted", () =>
        createHold(
          { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
          { amount: HOLD_AMOUNT, destination: recipientTokenAccount }
        )
      );
    });

    it("create_hold: succeeds in whitelist mode once both accounts are eligible", async () => {
      await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);
      await setWhitelistMarker(mint, holderTokenAccount);
      await setWhitelistMarker(mint, recipientTokenAccount);

      const { holdId } = await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey, destination: recipientTokenAccount }
      );

      const hold = await getHold(mint, holderTokenAccount, holdId);
      assert.equal(hold.destination!.toBase58(), recipientTokenAccount.toBase58());
    });
  });

  // ── controller_create_hold ─────────────────────────────────────────────────

  describe("controller_create_hold", () => {
    it("controller_create_hold: a controller imposes a lien with no holder signature", async () => {
      await setRoles(mint, controllerKeypair.publicKey, [ROLE_CONTROLLER]);

      const expiration = defaultExpiration();
      const { signature, holdId } = await controllerCreateHold(
        { authority: controllerKeypair, mint, tokenAccount: holderTokenAccount, payer: payerKeypair.publicKey },
        { amount: HOLD_AMOUNT, expiration, escrow: escrowKeypair.publicKey }
      );

      // The holder never signed, yet its balance is now encumbered.
      const tokenAccount = await getTokenAccount(holderTokenAccount);
      assert.equal(tokenAccount.amount.toString(), MINT_AMOUNT.toString());

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toString(), HOLD_AMOUNT.toString());
      assert.equal(position.nextHoldId.toNumber(), 1);

      const hold = await getHold(mint, holderTokenAccount, holdId);
      assert.equal(hold.tokenAccount.toBase58(), holderTokenAccount.toBase58());
      assert.equal(hold.escrow.toBase58(), escrowKeypair.publicKey.toBase58());
      assert.equal(hold.initialAmount.toString(), HOLD_AMOUNT.toString());
      assert.deepEqual(hold.status, { active: {} });

      const event = await getControllerHoldCreatedEvent(signature);
      assert.isNotNull(event, "ControllerHoldCreated event should be emitted");
      assert.equal(event!.controller.toBase58(), controllerKeypair.publicKey.toBase58());
      assert.equal(event!.tokenAccount.toBase58(), holderTokenAccount.toBase58());
      assert.equal(event!.amount.toString(), HOLD_AMOUNT.toString());
    });

    it("controller_create_hold: rejects a signer without ROLE_CONTROLLER", async () => {
      await setRoles(mint, controllerKeypair.publicKey, [ROLE_ADMIN]);

      await assertFails("MissingRole", () =>
        controllerCreateHold(
          { authority: controllerKeypair, mint, tokenAccount: holderTokenAccount, payer: payerKeypair.publicKey },
          { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
        )
      );
    });

    it("controller_create_hold: shares the id counter with holder-created holds", async () => {
      await setRoles(mint, controllerKeypair.publicKey, [ROLE_CONTROLLER]);

      await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
      );

      const { holdId } = await controllerCreateHold(
        { authority: controllerKeypair, mint, tokenAccount: holderTokenAccount, payer: payerKeypair.publicKey },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
      );

      assert.equal(holdId.toNumber(), 1, "picks up next_hold_id left by create_hold");

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toString(), HOLD_AMOUNT.muln(2).toString());
      assert.equal(position.nextHoldId.toNumber(), 2);
    });

    it("controller_create_hold: cannot exceed the available balance", async () => {
      await setRoles(mint, controllerKeypair.publicKey, [ROLE_CONTROLLER]);

      await assertFails("InsufficientAvailableBalance", () =>
        controllerCreateHold(
          { authority: controllerKeypair, mint, tokenAccount: holderTokenAccount, payer: payerKeypair.publicKey },
          { amount: MINT_AMOUNT.addn(1), escrow: escrowKeypair.publicKey }
        )
      );
    });

    it("controller_create_hold: is refused on a non-whitelisted target, unlike controller_transfer", async () => {
      await setRoles(mint, controllerKeypair.publicKey, [ROLE_CONTROLLER]);
      await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);

      await assertFails("NotWhitelisted", () =>
        controllerCreateHold(
          { authority: controllerKeypair, mint, tokenAccount: holderTokenAccount, payer: payerKeypair.publicKey },
          { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
        )
      );
    });

    it("controller_create_hold: an escrow can release a controller-imposed hold", async () => {
      await setRoles(mint, controllerKeypair.publicKey, [ROLE_CONTROLLER]);

      const { holdId } = await controllerCreateHold(
        { authority: controllerKeypair, mint, tokenAccount: holderTokenAccount, payer: payerKeypair.publicKey },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
      );

      await releaseHold(
        { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount },
        { holdId, amount: HOLD_AMOUNT }
      );

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toNumber(), 0, "the resolution paths do not care who created the hold");

      const hold = await getHold(mint, holderTokenAccount, holdId);
      assert.deepEqual(hold.status, { closed: {} });
    });
  });

  // ── the lien as seen by the transfer hook ──────────────────────────────────

  describe("hook enforcement", () => {
    it("hold: the un-held part of the balance stays transferable", async () => {
      await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
      );

      const spendable = MINT_AMOUNT.sub(HOLD_AMOUNT);
      await splTransfer(
        {
          mint,
          source: holderTokenAccount,
          sourceOwner: holder,
          destination: recipientTokenAccount,
          signers: [holderKeypair],
        },
        { amount: spendable }
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), HOLD_AMOUNT.toString(), "only the held balance should remain");
    });

    it("hold: a transfer that would dip into the held balance is rejected by the hook", async () => {
      await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
      );

      await assertFails("InsufficientUnfrozenBalance", () =>
        splTransfer(
          {
            mint,
            source: holderTokenAccount,
            sourceOwner: holder,
            destination: recipientTokenAccount,
            signers: [holderKeypair],
          },
          { amount: MINT_AMOUNT.sub(HOLD_AMOUNT).add(new anchor.BN(1)) }
        )
      );
    });
  });

  // ── execute_hold ───────────────────────────────────────────────────────────

  describe("execute_hold", () => {
    beforeEach(async () => {
      await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey, destination: recipientTokenAccount }
      );
    });

    it("execute_hold: moves the full amount to the destination and closes the hold", async () => {
      const { signature } = await executeHold(
        { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount, destination: recipientTokenAccount },
        { amount: HOLD_AMOUNT }
      );

      const source = await getTokenAccount(holderTokenAccount);
      const destination = await getTokenAccount(recipientTokenAccount);
      assert.equal(source.amount.toString(), MINT_AMOUNT.sub(HOLD_AMOUNT).toString());
      assert.equal(destination.amount.toString(), HOLD_AMOUNT.toString());

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toNumber(), 0, "the lien should be gone");

      const hold = await getHold(mint, holderTokenAccount, new anchor.BN(0));
      assert.equal(hold.currentAmount.toNumber(), 0);
      assert.deepEqual(hold.status, { closed: {} });

      const event = await getHoldExecutedEvent(signature);
      assert.isNotNull(event, "HoldExecuted event should be emitted");
      assert.equal(event!.amount.toString(), HOLD_AMOUNT.toString());
      assert.equal(event!.remainingAmount.toNumber(), 0);
      assert.equal(event!.destination.toBase58(), recipientTokenAccount.toBase58());
    });

    it("execute_hold: a partial execution leaves the hold active with the remainder", async () => {
      const half = HOLD_AMOUNT.divn(2);

      await executeHold(
        { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount, destination: recipientTokenAccount },
        { amount: half }
      );

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toString(), HOLD_AMOUNT.sub(half).toString());

      const hold = await getHold(mint, holderTokenAccount, new anchor.BN(0));
      assert.equal(hold.currentAmount.toString(), HOLD_AMOUNT.sub(half).toString());
      assert.equal(hold.initialAmount.toString(), HOLD_AMOUNT.toString(), "initial_amount must not move");
      assert.deepEqual(hold.status, { active: {} });
    });

    it("execute_hold: fails with NotTheEscrow when anyone other than the escrow signs", async () => {
      await assertFails("NotTheEscrow", () =>
        executeHold(
          { escrow: holderKeypair, mint, tokenAccount: holderTokenAccount, destination: recipientTokenAccount },
          { amount: HOLD_AMOUNT }
        )
      );
    });

    it("execute_hold: fails with AmountExceedsHold when executing more than the hold holds", async () => {
      await assertFails("AmountExceedsHold", () =>
        executeHold(
          { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount, destination: recipientTokenAccount },
          { amount: HOLD_AMOUNT.add(new anchor.BN(1)) }
        )
      );
    });

    it("execute_hold: fails with DestinationMismatch when the destination is pinned to another account", async () => {
      const otherDestination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

      await assertFails("DestinationMismatch", () =>
        executeHold(
          { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount, destination: otherDestination },
          { amount: HOLD_AMOUNT }
        )
      );
    });

    it("execute_hold: fails with HoldExpired once the expiration has lapsed", async () => {
      await setHoldRecord(mint, holderTokenAccount, new anchor.BN(0), {
        escrow: escrowKeypair.publicKey,
        destination: recipientTokenAccount,
        initialAmount: HOLD_AMOUNT,
        currentAmount: HOLD_AMOUNT,
        createdAt: new anchor.BN(Math.floor(Date.now() / 1000) - 7200),
        expiration: new anchor.BN(Math.floor(Date.now() / 1000) - 60),
      });

      await assertFails("HoldExpired", () =>
        executeHold(
          { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount, destination: recipientTokenAccount },
          { amount: HOLD_AMOUNT }
        )
      );
    });

    it("execute_hold: fails when the destination is not whitelisted, even though the delegate bypasses the hook", async () => {
      // The permanent delegate skips the hook's compliance suite entirely, so this
      // asserts the check hold::execute_hold runs in its place.
      await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);
      await setWhitelistMarker(mint, holderTokenAccount);

      await assertFails("NotWhitelisted", () =>
        executeHold(
          { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount, destination: recipientTokenAccount },
          { amount: HOLD_AMOUNT }
        )
      );
    });

    it("execute_hold: fails with Deactivated when the mint is deactivated", async () => {
      await setDeactivateMarker(mint);

      await assertFails("Deactivated", () =>
        executeHold(
          { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount, destination: recipientTokenAccount },
          { amount: HOLD_AMOUNT }
        )
      );
    });

    it("execute_hold: fails with FunctionalityNotSupportedError when the functionality bit is disabled", async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      await assertFails("FunctionalityNotSupportedError", () =>
        executeHold(
          { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount, destination: recipientTokenAccount },
          { amount: HOLD_AMOUNT }
        )
      );
    });
  });

  // ── release_hold ───────────────────────────────────────────────────────────

  describe("release_hold", () => {
    beforeEach(async () => {
      await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
      );
    });

    it("release_hold: drops the lien without moving any tokens", async () => {
      const { signature } = await releaseHold(
        { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT }
      );

      const tokenAccount = await getTokenAccount(holderTokenAccount);
      assert.equal(tokenAccount.amount.toString(), MINT_AMOUNT.toString(), "release moves no tokens");

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toNumber(), 0);

      const hold = await getHold(mint, holderTokenAccount, new anchor.BN(0));
      assert.deepEqual(hold.status, { closed: {} });

      const event = await getHoldReleasedEvent(signature);
      assert.isNotNull(event, "HoldReleased event should be emitted");
      assert.equal(event!.amount.toString(), HOLD_AMOUNT.toString());
      assert.equal(event!.remainingAmount.toNumber(), 0);
    });

    it("release_hold: a partial release frees only that part of the lien", async () => {
      const half = HOLD_AMOUNT.divn(2);

      await releaseHold({ escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount }, { amount: half });

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toString(), HOLD_AMOUNT.sub(half).toString());

      const hold = await getHold(mint, holderTokenAccount, new anchor.BN(0));
      assert.deepEqual(hold.status, { active: {} });
    });

    it("release_hold: fails with NotTheEscrow when the holder tries to release its own hold", async () => {
      await assertFails("NotTheEscrow", () =>
        releaseHold({ escrow: holderKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT })
      );
    });

    it("release_hold: still works while the mint is paused, so a lien is never stuck", async () => {
      await setMintPaused(mint, true);

      await releaseHold({ escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT });

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toNumber(), 0);
    });

    it("release_hold: still works after the mint is deactivated, so a lien is never stuck", async () => {
      await setDeactivateMarker(mint);

      await releaseHold({ escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT });

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toNumber(), 0);
    });

    // The functionality gate covers the whole capability, matching the single
    // EVM facet and the API's `{Name: "Hold"}` check on all four operations.
    it("release_hold: fails with FunctionalityNotSupportedError when the functionality bit is disabled", async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      await assertFails("FunctionalityNotSupportedError", () =>
        releaseHold({ escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount }, { amount: HOLD_AMOUNT })
      );
    });
  });

  // ── reclaim_hold ───────────────────────────────────────────────────────────

  describe("reclaim_hold", () => {
    beforeEach(async () => {
      await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
      );
    });

    it("reclaim_hold: fails with HoldNotExpired before the expiration", async () => {
      await assertFails("HoldNotExpired", () =>
        reclaimHold({ caller: payerKeypair, mint, tokenAccount: holderTokenAccount })
      );
    });

    it("reclaim_hold: fails with FunctionalityNotSupportedError when the functionality bit is disabled", async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      await assertFails("FunctionalityNotSupportedError", () =>
        reclaimHold({ caller: payerKeypair, mint, tokenAccount: holderTokenAccount })
      );
    });

    it("reclaim_hold: anyone can clear an expired lien", async () => {
      await setHoldRecord(mint, holderTokenAccount, new anchor.BN(0), {
        escrow: escrowKeypair.publicKey,
        initialAmount: HOLD_AMOUNT,
        currentAmount: HOLD_AMOUNT,
        createdAt: new anchor.BN(Math.floor(Date.now() / 1000) - 7200),
        expiration: new anchor.BN(Math.floor(Date.now() / 1000) - 60),
      });

      // A stranger, not the holder and not the escrow.
      const stranger = Keypair.generate();
      await requestAirdrop(stranger.publicKey);

      const { signature } = await reclaimHold({ caller: stranger, mint, tokenAccount: holderTokenAccount });

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toNumber(), 0);

      const hold = await getHold(mint, holderTokenAccount, new anchor.BN(0));
      assert.equal(hold.currentAmount.toNumber(), 0);
      assert.deepEqual(hold.status, { expired: {} });

      const event = await getHoldReclaimedEvent(signature);
      assert.isNotNull(event, "HoldReclaimed event should be emitted");
      assert.equal(event!.caller.toBase58(), stranger.publicKey.toBase58());
      assert.equal(event!.amount.toString(), HOLD_AMOUNT.toString());
    });

    it("reclaim_hold: the freed balance becomes transferable again", async () => {
      await setHoldRecord(mint, holderTokenAccount, new anchor.BN(0), {
        escrow: escrowKeypair.publicKey,
        initialAmount: HOLD_AMOUNT,
        currentAmount: HOLD_AMOUNT,
        createdAt: new anchor.BN(Math.floor(Date.now() / 1000) - 7200),
        expiration: new anchor.BN(Math.floor(Date.now() / 1000) - 60),
      });
      await reclaimHold({ caller: payerKeypair, mint, tokenAccount: holderTokenAccount });

      await splTransfer(
        {
          mint,
          source: holderTokenAccount,
          sourceOwner: holder,
          destination: recipientTokenAccount,
          signers: [holderKeypair],
        },
        { amount: MINT_AMOUNT }
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), "0");
    });
  });

  // ── the lien on the paths the hook does not cover ───────────────────────────
  //
  // `controller_transfer` signs as the permanent delegate, which the hook exempts;
  // a burn fires no hook at all. All three enforce the lien themselves. Without
  // that, any of them could push `held` above the balance and leave every later
  // transfer — hold executions included — failing the hook's cover check.

  describe("permanent-delegate paths respect the lien", () => {
    const FREE_AMOUNT = MINT_AMOUNT.sub(HOLD_AMOUNT);

    beforeEach(async () => {
      await setRoles(mint, controllerKeypair.publicKey, [ROLE_CONTROLLER]);
      await createHold(
        { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey, destination: recipientTokenAccount }
      );
    });

    it("controller_transfer: cannot seize tokens covered by a hold", async () => {
      await assertFails("InsufficientSpendableBalance", () =>
        controllerTransfer(
          { authority: controllerKeypair, mint, from: holderTokenAccount, to: recipientTokenAccount },
          { amount: FREE_AMOUNT.addn(1) }
        )
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), MINT_AMOUNT.toString(), "balance must be untouched");
    });

    it("controller_transfer: can still seize the whole un-held part", async () => {
      await controllerTransfer(
        { authority: controllerKeypair, mint, from: holderTokenAccount, to: recipientTokenAccount },
        { amount: FREE_AMOUNT }
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), HOLD_AMOUNT.toString(), "only the lien is left");
    });

    it("controller_transfer: seizing the free part leaves the hold executable", async () => {
      await controllerTransfer(
        { authority: controllerKeypair, mint, from: holderTokenAccount, to: recipientTokenAccount },
        { amount: FREE_AMOUNT }
      );

      // The regression this whole block exists for: before the lien check, a
      // seizure could drop the balance below `held` and this execution would fail
      // the hook's cover check, stranding the hold.
      await executeHold(
        { escrow: escrowKeypair, mint, tokenAccount: holderTokenAccount, destination: recipientTokenAccount },
        { amount: HOLD_AMOUNT }
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), "0");

      const position = await getHoldPosition(mint, holderTokenAccount);
      assert.equal(position.heldAmount.toNumber(), 0);
    });

    it("burn: cannot burn tokens covered by a hold", async () => {
      await assertFails("InsufficientSpendableBalance", () =>
        burnTokens(
          { authority: controllerKeypair, mint, tokenAccount: holderTokenAccount },
          { amount: FREE_AMOUNT.addn(1) }
        )
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), MINT_AMOUNT.toString(), "nothing was burnt");
    });

    it("burn: can still burn the whole un-held part", async () => {
      await burnTokens(
        { authority: controllerKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: FREE_AMOUNT }
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), HOLD_AMOUNT.toString());
    });

    it("batch_burn: cannot burn tokens covered by a hold", async () => {
      await assertFails("InsufficientSpendableBalance", () =>
        batchBurnTokens(
          { authority: controllerKeypair, mint, sources: [holderTokenAccount] },
          { amounts: [FREE_AMOUNT.addn(1)] }
        )
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), MINT_AMOUNT.toString(), "nothing was burnt");
    });

    it("batch_burn: can still burn the whole un-held part", async () => {
      await batchBurnTokens(
        { authority: controllerKeypair, mint, sources: [holderTokenAccount] },
        { amounts: [FREE_AMOUNT] }
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), HOLD_AMOUNT.toString());
    });

    it("batch_burn: rejects a caller that substitutes another account's hold position", async () => {
      // The remaining accounts cannot be validated by a `seeds` constraint, so the
      // program re-derives the hold position. Pointing the lien reader at an
      // unrelated (empty) PDA would otherwise fake a zero lien.
      await assertFails("HoldPositionPdaMismatch", () =>
        batchBurnTokens(
          { authority: controllerKeypair, mint, sources: [holderTokenAccount] },
          {
            amounts: [MINT_AMOUNT],
            remainingAccounts: [
              { pubkey: holderTokenAccount, isWritable: true, isSigner: false },
              { pubkey: holdPositionPda(mint, recipientTokenAccount), isWritable: false, isSigner: false },
            ],
          }
        )
      );
    });

    it("controller_transfer: still reaches a partially frozen balance", async () => {
      // Deliberate, and matching ATS: a hold is a commitment between parties and
      // outranks the controller; a partial freeze is an administrative measure the
      // controller may override. Only the hold lien gates these paths.
      await setFrozenBalancePda(mint, holderTokenAccount, MINT_AMOUNT);

      await controllerTransfer(
        { authority: controllerKeypair, mint, from: holderTokenAccount, to: recipientTokenAccount },
        { amount: FREE_AMOUNT }
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), HOLD_AMOUNT.toString());
    });

    it("burn: still reaches a partially frozen balance", async () => {
      await setFrozenBalancePda(mint, holderTokenAccount, MINT_AMOUNT);

      await burnTokens(
        { authority: controllerKeypair, mint, tokenAccount: holderTokenAccount },
        { amount: FREE_AMOUNT }
      );

      const source = await getTokenAccount(holderTokenAccount);
      assert.equal(source.amount.toString(), HOLD_AMOUNT.toString());
    });
  });

  // ── isolation ──────────────────────────────────────────────────────────────

  it("hold: a position is scoped to its (mint, token account) pair", async () => {
    await createHold(
      { authority: holderKeypair, mint, tokenAccount: holderTokenAccount },
      { amount: HOLD_AMOUNT, escrow: escrowKeypair.publicKey }
    );

    const otherAccount = await createTokenAccount({ mint, owner: holder });
    assert.isNull(
      await getHoldPositionNullable(mint, otherAccount),
      "a second token account of the same owner carries no lien"
    );
  });

  async function assertFails(expectedCode: string, call: () => Promise<unknown>): Promise<void> {
    try {
      await call();
      assert.fail(`Expected ${expectedCode} but the instruction succeeded`);
    } catch (err) {
      assert.instanceOf(err, AnchorError, `expected an AnchorError, got: ${err}`);
      assert.equal((err as AnchorError).error.errorCode.code, expectedCode);
    }
  }
});
