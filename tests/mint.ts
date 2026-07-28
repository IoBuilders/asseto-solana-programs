import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_ADMIN, ROLE_ISSUER } from "./utils/roles";
import {
  createTokenAccount,
  getMint,
  getTokenAccount,
  mintTokensViaSurfpool,
  setMintPaused,
} from "./program_helpers/spl_token_helper";
import {
  mintTokens,
  getIssuedEvent,
  batchMintTokens,
  getIssuedEvents,
} from "./program_helpers/mint/mint_instruction_helper";
import { TRANSFER_CONTROL_WHITELIST } from "./program_helpers/transfer_control/transfer_control_instruction_helper";
import { beforeEach } from "mocha";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import {
  CAP_MAX_SUPPLY,
  COUPON_CREATE_COUPON,
  DEACTIVATE_DEACTIVATE,
  MINT_MINT,
  PAUSE_PAUSE,
  TRANSFER_CONTROL_INITIALIZE,
} from "./utils/functionalities";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import {
  setTransferControlModeMarker,
  setWhitelistMarker,
  whitelistPda,
} from "./program_helpers/transfer_control/transfer_control_pda_helper";
import { setMaxSupplyPda } from "./program_helpers/cap/cap_pda_helper";
import { U64_MAX } from "./constants";

describe("mint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const authority = provider.wallet.payer;
  const MINT_DECIMALS = 6;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint());
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        PAUSE_PAUSE,
        TRANSFER_CONTROL_INITIALIZE,
        COUPON_CREATE_COUPON,
        DEACTIVATE_DEACTIVATE,
        MINT_MINT,
      ],
    });
    await setRoles(mint, authority!.publicKey, [ROLE_ISSUER]);
  });

  it("mint: mints tokens to a destination account and updates balance correctly", async () => {
    const destination = await createTokenAccount({ mint, owner: authority.publicKey });
    const accountBefore = await getTokenAccount(destination);
    const balanceBefore = accountBefore.amount;
    const mintInfoBefore = await getMint(mint);
    const supplyBefore = mintInfoBefore.supply;
    const mintAmount = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);

    const signature = await mintTokens({ mint, destination, authority }, { amount: mintAmount });

    const accountAfter = await getTokenAccount(destination);
    const balanceAfter = accountAfter.amount;
    const mintInfoAfter = await getMint(mint);
    const supplyAfter = mintInfoAfter.supply;

    assert.equal(balanceBefore.toString(), "0", "destination balance should be zero before minting");
    assert.equal(balanceAfter.toString(), mintAmount.toString(), "destination balance should equal the minted amount");
    assert.equal(supplyBefore.toString(), "0", "total supply should be zero before minting");
    assert.equal(supplyAfter.toString(), mintAmount.toString(), "total supply should equal the minted amount");
    assert.isTrue(accountAfter.isFrozen, "destination account should be re-frozen after minting");

    const issued = await getIssuedEvent(signature);
    assert.isNotNull(issued, "an Issued event should be emitted");
    assert.equal(issued!.mint.toBase58(), mint.toBase58(), "event mint should match the minted mint");
    assert.equal(issued!.operator.toBase58(), authority!.publicKey.toBase58(), "event operator should be the deployer");
    assert.equal(issued!.to.toBase58(), destination.toBase58(), "event destination should match the token account");
    assert.equal(issued!.value.toString(), mintAmount.toString(), "event value should equal the minted amount");
  });

  it("mint: fails with MintPaused when mint is paused", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    await setMintPaused(mint, true);

    try {
      await mintTokens({ mint, destination, authority });
      assert.fail("Expected mint-is-paused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const logs = (err as SendTransactionError).logs ?? [];
      assert.isTrue(
        logs.some((log) => log.includes("paused")),
        "logs should mention paused"
      );
    }
  });

  it("mint: fails with Deactivated when mint has been deactivated", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    await setDeactivateMarker(mint);

    try {
      await mintTokens({ mint, destination, authority });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  it("mint: fails with MissingRole when authority does not have the issuer role", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const rogueKeypair = Keypair.generate();
    await setRoles(mint, rogueKeypair.publicKey, [ROLE_ADMIN]); // rogue has admin but not issuer role

    try {
      await mintTokens({ mint, destination, authority: rogueKeypair, signers: [rogueKeypair] });
      assert.fail("Expected MissingRole error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MissingRole");
    }
  });

  it("mint: fails with NotWhitelisted when whitelist mode is active and destination is not whitelisted", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);

    try {
      await mintTokens({ mint, destination, authority });
      assert.fail("Expected NotWhitelisted error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with FunctionalityNotSupportedError when the mint functionality is not enabled", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

    // Re-seed the asset-class version WITHOUT the mint functionality.
    await setAssetClassVersionForMint(mint, { functionalities: [] });

    try {
      await mintTokens({ mint, destination, authority });
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
  it("mint: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

    // Re-seed the asset-class version WITHOUT finalizing it.
    await setAssetClassVersionForMint(mint, {
      state: ASSET_CLASS_VERSION_STATE_DRAFT,
      functionalities: [MINT_MINT],
    });

    try {
      await mintTokens({ mint, destination, authority });
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
  it("mint: mints tokens when a max supply is set and the resulting supply stays within it", async () => {
    const destination = await createTokenAccount({ mint, owner: authority.publicKey });
    const mintAmount = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
    const maxSupply = new anchor.BN(5_000 * 10 ** MINT_DECIMALS);
    await setMaxSupplyPda(mint, maxSupply);

    await mintTokens({ mint, destination, authority }, { amount: mintAmount });

    const account = await getTokenAccount(destination);
    assert.equal(account.amount.toString(), mintAmount.toString(), "destination should receive the minted amount");
    const mintInfo = await getMint(mint);
    assert.equal(mintInfo.supply.toString(), mintAmount.toString(), "total supply should equal the minted amount");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with MaxSupplyExceeded when the resulting supply would exceed the max supply", async () => {
    const destination = await createTokenAccount({ mint, owner: authority.publicKey });
    const maxSupply = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
    await setMaxSupplyPda(mint, maxSupply);

    try {
      await mintTokens({ mint, destination, authority }, { amount: maxSupply.add(new anchor.BN(1)) });
      assert.fail("Expected MaxSupplyExceeded error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MaxSupplyExceeded", "error code should be MaxSupplyExceeded");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with MaxSupplyNotSet when the cap functionality is enabled but no max supply PDA exists", async () => {
    const destination = await createTokenAccount({ mint, owner: authority.publicKey });

    // Cap functionality enabled, but `set_max_supply` was never called for this mint.
    await setAssetClassVersionForMint(mint, { functionalities: [MINT_MINT, CAP_MAX_SUPPLY] });

    try {
      await mintTokens({ mint, destination, authority });
      assert.fail("Expected MaxSupplyNotSet error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MaxSupplyNotSet", "error code should be MaxSupplyNotSet");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with MaxSupplyExceeded when the resulting supply would overflow u64", async () => {
    // Plant a supply just short of u64::MAX and set the cap to u64::MAX, so the
    // cap comparison itself can't fire — only the overflow branch can.
    const holder = await createTokenAccount({ mint, owner: authority.publicKey });
    await mintTokensViaSurfpool(mint, holder, U64_MAX.sub(new anchor.BN(10)));
    await setMaxSupplyPda(mint, U64_MAX);

    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

    try {
      await mintTokens({ mint, destination, authority }, { amount: new anchor.BN(100) });
      assert.fail("Expected MaxSupplyExceeded error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MaxSupplyExceeded", "error code should be MaxSupplyExceeded");
    }
  });
});

describe("batch_mint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const authority = provider.wallet.payer;
  const MINT_DECIMALS = 6;
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint());
    await setAssetClassVersionForMint(mint, {
      functionalities: [
        PAUSE_PAUSE,
        COUPON_CREATE_COUPON,
        TRANSFER_CONTROL_INITIALIZE,
        DEACTIVATE_DEACTIVATE,
        MINT_MINT,
      ],
    });
    await setRoles(mint, authority!.publicKey, [ROLE_ISSUER]);
  });

  it("batch_mint: mints the corresponding amount to each destination and updates balances correctly", async () => {
    const destinationA = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const destinationB = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const destinations = [destinationA, destinationB];
    const amounts = [new anchor.BN(1_000 * 10 ** MINT_DECIMALS), new anchor.BN(2_500 * 10 ** MINT_DECIMALS)];

    const mintInfoBefore = await getMint(mint);
    assert.equal(mintInfoBefore.supply.toString(), "0", "total supply should be zero before minting");

    const signature = await batchMintTokens({ mint, authority, destinations }, { amounts });

    // ── Each destination received its corresponding amount and was re-frozen ──
    for (let i = 0; i < destinations.length; i++) {
      const account = await getTokenAccount(destinations[i]);
      assert.equal(
        account.amount.toString(),
        amounts[i].toString(),
        `destination ${i} balance should equal its minted amount`
      );
      assert.isTrue(account.isFrozen, `destination ${i} should be re-frozen after minting`);
    }

    // ── Total supply equals the sum of all amounts ────────────────────────────
    const mintInfoAfter = await getMint(mint);
    const expectedSupply = amounts.reduce((sum, a) => sum.add(a), new anchor.BN(0));
    assert.equal(
      mintInfoAfter.supply.toString(),
      expectedSupply.toString(),
      "total supply should equal the sum of all minted amounts"
    );

    // ── One Issued event per destination, with matching fields ────────────────
    const issuedEvents = await getIssuedEvents(signature);
    assert.equal(issuedEvents.length, destinations.length, "one Issued event should be emitted per destination");
    for (let i = 0; i < destinations.length; i++) {
      const issued = issuedEvents.find((e) => e.to.toBase58() === destinations[i].toBase58());
      assert.isDefined(issued, `an Issued event should be emitted for destination ${i}`);
      assert.equal(issued!.mint.toBase58(), mint.toBase58(), "event mint should match the minted mint");
      assert.equal(
        issued!.operator.toBase58(),
        authority!.publicKey.toBase58(),
        "event operator should be the authority"
      );
      assert.equal(issued!.value.toString(), amounts[i].toString(), "event value should equal the minted amount");
    }
  });

  it("batch_mint: succeeds when whitelist mode is active and every destination is whitelisted", async () => {
    const destinationA = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const destinationB = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const amounts = [new anchor.BN(1_000 * 10 ** MINT_DECIMALS), new anchor.BN(2_500 * 10 ** MINT_DECIMALS)];
    const destinations = [destinationA, destinationB];
    await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);
    for (const destination of destinations) {
      await setWhitelistMarker(mint, destination);
    }

    await batchMintTokens({ mint, authority, destinations }, { amounts });

    for (let i = 0; i < destinations.length; i++) {
      const account = await getTokenAccount(destinations[i]);
      assert.equal(
        account.amount.toString(),
        amounts[i].toString(),
        "each whitelisted destination should receive its amount"
      );
    }
  });

  it("batch_mint: fails with MintPaused when mint is paused", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    await setMintPaused(mint, true);

    try {
      await batchMintTokens({ mint, authority, destinations: [destination] });
      assert.fail("Expected mint-is-paused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const logs = (err as SendTransactionError).logs ?? [];
      assert.isTrue(
        logs.some((log) => log.includes("paused")),
        "logs should mention paused"
      );
    }
  });

  it("batch_mint: fails with Deactivated when mint has been deactivated", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    await setDeactivateMarker(mint);

    try {
      await batchMintTokens({ mint, authority, destinations: [destination] });
      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  it("batch_mint: fails with MissingRole when authority does not have the issuer role", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const rogueKeypair = Keypair.generate();
    await setRoles(mint, rogueKeypair.publicKey, [ROLE_ADMIN]); // rogue has admin but not issuer role

    try {
      await batchMintTokens({
        mint,
        authority: rogueKeypair,
        destinations: [destination],
        signers: [rogueKeypair],
      });
      assert.fail("Expected MissingRole error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MissingRole");
    }
  });

  it("batch_mint: fails with NotWhitelisted when whitelist mode is active and a destination is not whitelisted", async () => {
    const whitelisted = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const notWhitelisted = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);
    await setWhitelistMarker(mint, whitelisted); // only the first destination is whitelisted

    try {
      await batchMintTokens({ mint, authority, destinations: [whitelisted, notWhitelisted] });
      assert.fail("Expected NotWhitelisted error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted");
    }
  });

  it("batch_mint: fails with FunctionalityNotSupportedError when the mint functionality is not enabled", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

    // Re-seed the asset-class version WITHOUT the mint functionality.
    await setAssetClassVersionForMint(mint, { functionalities: [] });

    try {
      await batchMintTokens({ mint, authority, destinations: [destination] });
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

  it("batch_mint: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

    // Re-seed the asset-class version WITHOUT finalizing it.
    await setAssetClassVersionForMint(mint, {
      state: ASSET_CLASS_VERSION_STATE_DRAFT,
      functionalities: [MINT_MINT],
    });

    try {
      await batchMintTokens({ mint, authority, destinations: [destination] });
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

  it("batch_mint: fails with EmptyBatch when no destinations are provided", async () => {
    try {
      await batchMintTokens({ mint, authority, destinations: [] });
      assert.fail("Expected EmptyBatch error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "EmptyBatch");
    }
  });

  it("batch_mint: fails with InvalidRemainingAccounts when the wrong number of remaining accounts is passed", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

    try {
      await batchMintTokens(
        { mint, authority, destinations: [destination] },
        {
          // One destination expects two remaining accounts, but only one is passed.
          remainingAccounts: [{ pubkey: destination, isWritable: true, isSigner: false }],
        }
      );
      assert.fail("Expected InvalidRemainingAccounts error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "InvalidRemainingAccounts");
    }
  });

  it("batch_mint: fails with WhitelistPdaMismatch when a remaining whitelist PDA is not the derived one", async () => {
    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const other = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    // The whitelist PDA is only checked when whitelist mode is active.
    await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);

    try {
      await batchMintTokens(
        { mint, authority, destinations: [destination] },
        {
          // Destination matches, but the whitelist PDA is derived for a different account.
          remainingAccounts: [
            { pubkey: destination, isWritable: true, isSigner: false },
            { pubkey: whitelistPda(mint, other), isWritable: false, isSigner: false },
          ],
        }
      );
      assert.fail("Expected WhitelistPdaMismatch error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "WhitelistPdaMismatch");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("batch_mint: mints when a max supply is set and the batch total stays within it", async () => {
    const destinationA = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const destinationB = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const destinations = [destinationA, destinationB];
    const amounts = [new anchor.BN(1_000 * 10 ** MINT_DECIMALS), new anchor.BN(2_500 * 10 ** MINT_DECIMALS)];
    const maxSupply = new anchor.BN(5_000 * 10 ** MINT_DECIMALS);
    await setMaxSupplyPda(mint, maxSupply);

    await batchMintTokens({ mint, authority, destinations }, { amounts });

    for (let i = 0; i < destinations.length; i++) {
      const account = await getTokenAccount(destinations[i]);
      assert.equal(account.amount.toString(), amounts[i].toString(), `destination ${i} should receive its amount`);
    }
    const mintInfo = await getMint(mint);
    assert.equal(mintInfo.supply.toString(), "3500000000", "total supply should equal the sum of all amounts");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("batch_mint: fails with MaxSupplyExceeded when the batch total would exceed the max supply", async () => {
    const destinationA = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const destinationB = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const destinations = [destinationA, destinationB];
    // Each amount fits under the cap on its own; only their sum breaches it.
    const amounts = [new anchor.BN(1_000 * 10 ** MINT_DECIMALS), new anchor.BN(2_500 * 10 ** MINT_DECIMALS)];
    const maxSupply = new anchor.BN(3_000 * 10 ** MINT_DECIMALS);
    await setMaxSupplyPda(mint, maxSupply);

    try {
      await batchMintTokens({ mint, authority, destinations }, { amounts });
      assert.fail("Expected MaxSupplyExceeded error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MaxSupplyExceeded", "error code should be MaxSupplyExceeded");
    }

    // Nothing may have landed — not even the destination whose amount fits.
    const mintInfo = await getMint(mint);
    assert.equal(mintInfo.supply.toString(), "0", "total supply should be unchanged after a rejected batch");
    for (const destination of destinations) {
      const account = await getTokenAccount(destination);
      assert.equal(account.amount.toString(), "0", "no destination should have received tokens");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("batch_mint: fails with MaxSupplyNotSet when the cap functionality is enabled but no max supply PDA exists", async () => {
    const destinationA = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const destinationB = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });
    const destinations = [destinationA, destinationB];
    const amounts = [new anchor.BN(1_000 * 10 ** MINT_DECIMALS), new anchor.BN(2_500 * 10 ** MINT_DECIMALS)];

    // Cap functionality enabled, but `set_max_supply` was never called for this mint.
    await setAssetClassVersionForMint(mint, { functionalities: [MINT_MINT, CAP_MAX_SUPPLY] });

    try {
      await batchMintTokens({ mint, authority, destinations }, { amounts });
      assert.fail("Expected MaxSupplyNotSet error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MaxSupplyNotSet", "error code should be MaxSupplyNotSet");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("batch_mint: fails with MaxSupplyExceeded when the resulting supply would overflow u64", async () => {
    // Plant a supply just short of u64::MAX and set the cap to u64::MAX, so the
    // cap comparison itself can't fire — only the overflow branch can.
    const holder = await createTokenAccount({ mint, owner: authority.publicKey });
    await mintTokensViaSurfpool(mint, holder, U64_MAX.sub(new anchor.BN(10)));
    await setMaxSupplyPda(mint, U64_MAX);

    const destination = await createTokenAccount({ mint, owner: Keypair.generate().publicKey });

    try {
      await batchMintTokens({ mint, authority, destinations: [destination] }, { amounts: [new anchor.BN(100)] });
      assert.fail("Expected MaxSupplyExceeded error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      assert.equal(anchorErr.error.errorCode.code, "MaxSupplyExceeded", "error code should be MaxSupplyExceeded");
    }
  });
});
