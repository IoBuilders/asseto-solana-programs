import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";
import { assert } from "chai";
import * as pdaUtils from "./utils/pda_utils";
import { deployMint } from "./program_helpers/deploy_helper";
import { pauseMint } from "./program_helpers/pause/pause_instruction_helper";
import { deactivateMint } from "./program_helpers/deactivate_helper";
import { createTokenAccount } from "./program_helpers/spl_token_helper";
import {
  addToWhitelist,
  getAccountRemovedFromWhitelistEvent,
  getAccountWhitelistedEvent,
  getTransferControlModeByPda,
  getTransferControlModesSetEvent,
  getWhitelistStatusByPda,
  removeFromWhitelist,
  setTransferControlModes,
  TRANSFER_CONTROL_CLEARING,
  TRANSFER_CONTROL_WHITELIST,
} from "./program_helpers/transfer_control_helper";
import { getAccountInfo, getBalanceForRentExeption } from "./program_helpers/account_helper";

describe("transfer-control", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

  // 8 discriminator + 4 vec-length prefix + 1 byte per TransferMode variant + 1 bump
  function getSizeOfTransferControlModePda(numModes: number): number {
    return 8 + 4 + numModes + 1;
  }

  // ── Happy-path: set_modes creates the PDA and sets modes = [Clearing] ───────────
  it("set_modes: creates the transfer_control_mode PDA with modes = [Clearing]", async () => {
    const modes = [TRANSFER_CONTROL_CLEARING];
    const { mint } = await deployMint({ deployer });
    const transferControlModePda = pdaUtils.transferControlModePda(mint);
    const [, expectedBump] = pdaUtils.transferControlModePdaWithBump(mint);

    // ── Verify the PDA does not exist before the instruction ────────────────
    const stateBefore = await getTransferControlModeByPda(transferControlModePda);

    // ── Call set_modes(TRANSFER_CONTROL_CLEARING) ────────────────────────────────────
    const { signature } = await setTransferControlModes({ deployer, mint }, { modes });

    // ── Fetch and verify the PDA ─────────────────────────────────────────────
    const stateAfter = await getTransferControlModeByPda(transferControlModePda);
    const accountInfo = await getAccountInfo(transferControlModePda);

    const expectedSize = getSizeOfTransferControlModePda(modes.length);

    assert.isNull(stateBefore, "transfer_control_mode PDA should not exist before set_modes");
    assert.isNotNull(stateAfter, "transfer_control_mode PDA should exist after set_modes");
    assert.deepEqual(stateAfter.modes, modes, `modes should be ${modes}`);
    assert.equal(stateAfter.bump, expectedBump, "bump should match the canonical bump");
    assert.equal(accountInfo.data.length, expectedSize, `PDA size should be ${expectedSize} bytes`);

    const modesSetEvent = await getTransferControlModesSetEvent(signature);
    assert.isNotNull(modesSetEvent, "TransferControlModesSet event should be emitted");
    assert.equal(modesSetEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
    assert.equal(modesSetEvent!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
    assert.deepEqual(modesSetEvent!.modes, modes, `event modes should be ${modes}`);
  });

  // ── Happy-path: set_modes expands the PDA when a mode is added ────────────────────
  it("set_modes: adds mode to an existing transfer_control_mode PDA", async () => {
    const initialModes = [TRANSFER_CONTROL_CLEARING];
    const newModes = [...initialModes, TRANSFER_CONTROL_WHITELIST];
    const { mint } = await deployMint({ deployer });
    const transferControlModePda = pdaUtils.transferControlModePda(mint);

    // ── First call: create with modes = [Clearing] ────────────────────────────
    await setTransferControlModes({ deployer, mint }, { modes: initialModes });

    const stateAfterFirst = await getTransferControlModeByPda(transferControlModePda);
    const accountInfoBefore = await getAccountInfo(transferControlModePda);
    const dataSizeBefore = accountInfoBefore.data.length;
    const lamportsBefore = accountInfoBefore.lamports;
    const expectedSizeBefore = getSizeOfTransferControlModePda(initialModes.length);
    const expectedLamportsBefore = await getBalanceForRentExeption(expectedSizeBefore);

    assert.deepEqual(stateAfterFirst.modes, initialModes, `modes should be ${initialModes} after first call`);
    assert.equal(dataSizeBefore, expectedSizeBefore, `PDA size before should be ${expectedSizeBefore} bytes`);
    assert.equal(
      lamportsBefore,
      expectedLamportsBefore,
      `PDA lamports should be rent-exempt for ${expectedSizeBefore} bytes`
    );

    // ── Second call: Add Whitelist to modes ──────────────────
    await setTransferControlModes({ deployer, mint }, { modes: newModes });

    const stateAfterUpdate = await getTransferControlModeByPda(transferControlModePda);

    const accountInfoAfter = await getAccountInfo(transferControlModePda);
    const lamportsAfter = accountInfoAfter.lamports;
    const dataSizeAfter = accountInfoAfter.data.length;
    const expectedSizeAfter = getSizeOfTransferControlModePda(newModes.length);
    const expectedLamportsAfter = await getBalanceForRentExeption(expectedSizeAfter);

    assert.deepEqual(stateAfterUpdate.modes, newModes, `modes should be ${newModes} after update`);
    assert.equal(dataSizeAfter, expectedSizeAfter, `PDA size after should be ${expectedSizeAfter} bytes`);
    assert.ok(dataSizeAfter > dataSizeBefore, `PDA data size should increase (${dataSizeBefore} → ${dataSizeAfter})`);
    assert.equal(
      lamportsAfter,
      expectedLamportsAfter,
      `PDA lamports should be rent-exempt for ${expectedSizeAfter} bytes`
    );
    assert.ok(lamportsAfter > lamportsBefore, `PDA lamports should increase (${lamportsBefore} → ${lamportsAfter})`);
  });

  // ── Happy-path: set_modes shrinks the PDA when a mode is removed ──────────────
  it("set_modes: removes a mode from an existing transfer_control_mode PDA", async () => {
    const initialModes = [TRANSFER_CONTROL_CLEARING, TRANSFER_CONTROL_WHITELIST] as any[];
    const newModes = [TRANSFER_CONTROL_CLEARING];
    const { mint } = await deployMint({ deployer });
    const transferControlModePda = pdaUtils.transferControlModePda(mint);

    // ── First call: create with modes = [Clearing, Whitelist] ────────────────
    await setTransferControlModes({ deployer, mint }, { modes: initialModes });

    const stateAfterFirst = await getTransferControlModeByPda(transferControlModePda);
    const accountInfoBefore = await getAccountInfo(transferControlModePda);
    const dataSizeBefore = accountInfoBefore.data.length;
    const lamportsBefore = accountInfoBefore.lamports;
    const expectedSizeBefore = getSizeOfTransferControlModePda(initialModes.length);
    const expectedLamportsBefore = await getBalanceForRentExeption(expectedSizeBefore);

    assert.deepEqual(stateAfterFirst.modes, initialModes, `modes should be ${initialModes} after first call`);
    assert.equal(dataSizeBefore, expectedSizeBefore, `PDA size before should be ${expectedSizeBefore} bytes`);
    assert.equal(
      lamportsBefore,
      expectedLamportsBefore,
      `PDA lamports should be rent-exempt for ${expectedSizeBefore} bytes`
    );

    // ── Second call: remove Whitelist, keeping only [Clearing] ───────────────
    await setTransferControlModes({ deployer, mint }, { modes: newModes });

    const stateAfterUpdate = await getTransferControlModeByPda(transferControlModePda);

    const accountInfoAfter = await getAccountInfo(transferControlModePda);
    const dataSizeAfter = accountInfoAfter.data.length;
    const lamportsAfter = accountInfoAfter.lamports;
    const expectedSizeAfter = getSizeOfTransferControlModePda(newModes.length);
    const expectedLamportsAfter = await getBalanceForRentExeption(expectedSizeAfter);

    assert.deepEqual(stateAfterUpdate.modes, newModes, "modes should be [Clearing] after removing Whitelist");
    assert.equal(dataSizeAfter, expectedSizeAfter, `PDA size after should be ${expectedSizeAfter} bytes`);
    assert.ok(dataSizeAfter < dataSizeBefore, `PDA data size should decrease (${dataSizeBefore} → ${dataSizeAfter})`);
    assert.equal(
      lamportsAfter,
      expectedLamportsAfter,
      `PDA lamports should be rent-exempt for ${expectedSizeAfter} bytes`
    );
    assert.ok(lamportsAfter < lamportsBefore, `PDA lamports should decrease (${lamportsBefore} → ${lamportsAfter})`);
  });

  // ── Happy-path: set_modes(null) removes an existing transfer_control_mode PDA ──
  it("set_modes: closes the transfer_control_mode PDA when called with empty vector", async () => {
    const { mint } = await deployMint({ deployer });
    const transferControlModePda = pdaUtils.transferControlModePda(mint);

    // ── First: create the PDA with any mode ────────────────────────────────
    await setTransferControlModes({ deployer, mint });

    const stateAfterCreate = await getTransferControlModeByPda(transferControlModePda);
    assert.isNotNull(stateAfterCreate, "transfer_control_mode PDA should exist after set_modes([clearing])");

    // ── Then: remove it by passing empty vector ────────────────────
    await setTransferControlModes({ deployer, mint }, { modes: [] });

    // ── Verify the PDA has been closed ────────────────────────────────────
    const stateAfterRemove = await getTransferControlModeByPda(transferControlModePda);
    assert.isNull(stateAfterRemove, "transfer_control_mode PDA should not exist after set_modes([])");
  });

  // ── Happy-path: add_to_whitelist ─────────────────────────────────────────────
  it("add_to_whitelist: creates the whitelist PDA for a token account", async () => {
    const { mint } = await deployMint({ deployer });
    const tokenAccount = await createTokenAccount({ mint, owner: deployer });
    const whitelistPda = pdaUtils.whitelistPda(mint, tokenAccount);
    const [, expectedBump] = pdaUtils.whitelistPdaWithBump(mint, tokenAccount);

    // ── Verify the PDA does not exist before the instruction ────────────────
    const stateBefore = await getWhitelistStatusByPda(whitelistPda);

    // ── Call add_to_whitelist ───────────────────────────────────────────────
    const { signature } = await addToWhitelist({ deployer, mint, account: tokenAccount });

    // ── Fetch and verify the PDA ─────────────────────────────────────────────
    const stateAfter = await getWhitelistStatusByPda(whitelistPda);
    assert.isNull(stateBefore, "whitelist PDA should not exist before add_to_whitelist");
    assert.isNotNull(stateAfter, "whitelist PDA should exist after add_to_whitelist");
    assert.equal(stateAfter.bump, expectedBump, "bump should match the canonical bump");

    const whitelistedEvent = await getAccountWhitelistedEvent(signature);
    assert.isNotNull(whitelistedEvent, "AccountWhitelisted event should be emitted");
    assert.equal(whitelistedEvent!.mint.toBase58(), mint.toBase58(), "event mint should match the deployed mint");
    assert.equal(
      whitelistedEvent!.account.toBase58(),
      tokenAccount.toBase58(),
      "event account should match the whitelisted token account"
    );
    assert.equal(whitelistedEvent!.operator.toBase58(), deployer.toBase58(), "event operator should match deployer");
  });

  // ── Happy-path: remove_from_whitelist ────────────────────────────────────────
  it("remove_from_whitelist: closes the whitelist PDA for a token account", async () => {
    const { mint } = await deployMint({ deployer });
    const tokenAccount = await createTokenAccount({ mint, owner: deployer });
    const whitelistPda = pdaUtils.whitelistPda(mint, tokenAccount);

    // ── First: add to whitelist ─────────────────────────────────────────────
    await addToWhitelist({ deployer, mint, account: tokenAccount });

    const stateAfterAdd = await getWhitelistStatusByPda(whitelistPda);
    assert.isNotNull(stateAfterAdd, "whitelist PDA should exist after add_to_whitelist");

    // ── Then: remove from whitelist ─────────────────────────────────────────
    const { signature } = await removeFromWhitelist({ deployer, mint, account: tokenAccount });

    // ── Verify the PDA has been closed ──────────────────────────────────────
    const stateAfterRemove = await getWhitelistStatusByPda(whitelistPda);
    assert.isNull(stateAfterRemove, "whitelist PDA should not exist after remove_from_whitelist");

    const accountRemovedFromWhitelistEvent = await getAccountRemovedFromWhitelistEvent(signature);
    assert.isNotNull(accountRemovedFromWhitelistEvent, "AccountRemovedFromWhitelist event should be emitted");
    assert.equal(
      accountRemovedFromWhitelistEvent!.mint.toBase58(),
      mint.toBase58(),
      "event mint should match the deployed mint"
    );
    assert.equal(
      accountRemovedFromWhitelistEvent!.account.toBase58(),
      tokenAccount.toBase58(),
      "event account should match the token account removed from the whitelist"
    );
    assert.equal(
      accountRemovedFromWhitelistEvent!.operator.toBase58(),
      deployer.toBase58(),
      "event operator should match deployer"
    );
  });

  // ── Error case: set_modes — UnauthorizedDeployer ──────────────────────────────
  it("set_modes: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint } = await deployMint({ deployer });
    const rogueKeypair = Keypair.generate();

    try {
      await setTransferControlModes({ deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ── Error case: set_modes — MintPaused ────────────────────────────────────────
  it("set_modes: fails with MintPaused when mint is paused", async () => {
    const { mint } = await deployMint({ deployer });
    await pauseMint({ deployer, mint });

    try {
      await setTransferControlModes({ deployer, mint });
      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MintPaused");
    }
  });

  // ── Error case: set_modes — Deactivated ───────────────────────────────────────
  it("set_modes: fails with Deactivated when mint has been deactivated", async () => {
    const { mint } = await deployMint({ deployer });
    await deactivateMint({ deployer, mint });

    try {
      await setTransferControlModes({ deployer, mint });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  // ── Error case: add_to_whitelist — UnauthorizedDeployer ──────────────────────
  it("add_to_whitelist: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint } = await deployMint({ deployer });
    const rogueKeypair = Keypair.generate();

    try {
      await setTransferControlModes({ deployer: rogueKeypair.publicKey, mint, signers: [rogueKeypair] });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ── Error case: add_to_whitelist — MintPaused ────────────────────────────────
  it("add_to_whitelist: fails with MintPaused when mint is paused", async () => {
    const { mint } = await deployMint({ deployer });
    const tokenAccount = await createTokenAccount({ mint, owner: deployer });
    await pauseMint({ deployer, mint });

    try {
      await addToWhitelist({ deployer, mint, account: tokenAccount });
      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MintPaused");
    }
  });

  // ── Error case: add_to_whitelist — Deactivated ───────────────────────────────
  it("add_to_whitelist: fails with Deactivated when mint has been deactivated", async () => {
    const { mint } = await deployMint({ deployer });
    const tokenAccount = await createTokenAccount({ mint, owner: deployer });
    await deactivateMint({ deployer, mint });

    try {
      await addToWhitelist({ deployer, mint, account: tokenAccount });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  // ── Error case: remove_from_whitelist — UnauthorizedDeployer ─────────────────
  it("remove_from_whitelist: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint } = await deployMint({ deployer });
    const tokenAccount = await createTokenAccount({ mint, owner: deployer });
    await addToWhitelist({ deployer, mint, account: tokenAccount });
    const rogueKeypair = Keypair.generate();

    try {
      await removeFromWhitelist({
        deployer: rogueKeypair.publicKey,
        mint,
        account: tokenAccount,
        signers: [rogueKeypair],
      });
      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ── Error case: remove_from_whitelist — MintPaused ───────────────────────────
  it("remove_from_whitelist: fails with MintPaused when mint is paused", async () => {
    const { mint } = await deployMint({ deployer });
    const tokenAccount = await createTokenAccount({ mint, owner: deployer });
    await addToWhitelist({ deployer, mint, account: tokenAccount });
    await pauseMint({ deployer, mint });

    try {
      await removeFromWhitelist({ deployer, mint, account: tokenAccount });
      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MintPaused");
    }
  });

  // ── Error case: remove_from_whitelist — Deactivated ──────────────────────────
  it("remove_from_whitelist: fails with Deactivated when mint has been deactivated", async () => {
    const { mint } = await deployMint({ deployer });
    const tokenAccount = await createTokenAccount({ mint, owner: deployer });
    await addToWhitelist({ deployer, mint, account: tokenAccount });
    await deactivateMint({ deployer, mint });

    try {
      await removeFromWhitelist({ deployer, mint, account: tokenAccount });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });
});
