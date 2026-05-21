import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Mint } from "../target/types/mint";
import { Keypair, PublicKey, SendTransactionError, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAccount, getAccount, getMint } from "@solana/spl-token";
import { assert } from "chai";
import * as pdas from "./utils/pda_utils";
import { TransferControl } from "../target/types/transfer_control";
import { Pause } from "../target/types/pause";
import { Deactivate } from "../target/types/deactivate";
import { Snapshot } from "../target/types/snapshot";
import { Coupon } from "../target/types/coupon";
import {
  SYSTEM_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
} from "./utils/address_utils";
import { snapshotHolderBalancePdaWithBump, snapshotTotalSupplyPdaWithBump } from "./utils/pda_utils";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";

const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
const pauseProgram = anchor.workspace.Pause as Program<Pause>;

describe("mint", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // All programs cast to `any` to avoid Anchor 0.32's strict ResolvedAccounts
  // type excluding seeded/auto-derivable accounts from the explicit accounts map.
  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const mintProgram = anchor.workspace.Mint as Program<Mint>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;
  const transferControlProgram = anchor.workspace.TransferControl as Program<TransferControl>;
  const snapshotProgram = anchor.workspace.Snapshot as Program<Snapshot>;
  const couponProgram = anchor.workspace.Coupon as Program<Coupon>;
  const connection = provider.connection;
  const deployer = provider.wallet.publicKey;

  // ── Helper: deploy a fresh mint ────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
    mintAuthority: PublicKey;
    freezeAuthority: PublicKey;
    pausableAuthority: PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    const mintOwnerPda = pdas.mintOwnerPda(mint);
    const tempMintAuthority = pdas.tempMintAuthorityPda(mint);
    const mintAuthority = pdas.mintAuthorityPda(mint);
    const permanentDelegateAuthority = pdas.permanentDelegatePda(mint);
    const metadataUpdateAuthority = pdas.metadataUpdateAuthorityPda(mint);
    const pausableAuthority = pdas.pausableAuthorityPda(mint);
    const freezeAuthority = pdas.freezeAuthorityPda(mint);
    const transferHookAuthority = pdas.transferHookAuthorityPda(mint);
    const extraAccountMetaList = pdas.extraAccountMetaListPda(mint);

    const tx = await deployProgram.methods
      .deployMint({
        decimals: MINT_DECIMALS,
        name: MINT_NAME,
        symbol: MINT_SYMBOL,
        uri: MINT_URI,
        additionalMetadata: [],
      })
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        mint,
        tempMintAuthority,
        mintAuthority,
        permanentDelegateAuthority,
        metadataUpdateAuthority,
        pausableAuthority,
        freezeAuthority,
        transferHookAuthority,
        extraAccountMetaList,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([mintKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  deploy_mint tx:", tx);
    return { mint, mintOwnerPda, mintAuthority, freezeAuthority, pausableAuthority };
  }

  // ── Helper: all snapshot-related PDAs for a given mint ─────────────────────
  // Returns bumps too so assertions can verify them.
  function snapshotAccounts(
    mint: PublicKey,
    holderTokenAccount: PublicKey
  ): {
    snapshotCounterPda: PublicKey;
    totalSupplySnapshot: PublicKey;
    totalSupplySnapshotBump: number;
    holderBalanceSnapshot: PublicKey;
    holderBalanceSnapshotBump: number;
  } {
    const snapshotCounterPda = pdas.snapshotCounterPda(mint);
    const [totalSupplySnapshot, totalSupplySnapshotBump] = snapshotTotalSupplyPdaWithBump(mint);
    const [holderBalanceSnapshot, holderBalanceSnapshotBump] = snapshotHolderBalancePdaWithBump(
      mint,
      holderTokenAccount
    );
    return {
      snapshotCounterPda,
      totalSupplySnapshot,
      totalSupplySnapshotBump,
      holderBalanceSnapshot,
      holderBalanceSnapshotBump,
    };
  }

  // ── Helper: deterministic non-snapshot PDAs for a mint + destination pair ──
  function mintPdas(
    mint: PublicKey,
    destination: PublicKey
  ): {
    deactivatePda: PublicKey;
    transferControlModePda: PublicKey;
    destinationWhitelistPda: PublicKey;
  } {
    const deactivatePda = pdas.deactivatePda(mint);
    const transferControlModePda = pdas.transferControlModePda(mint);
    const destinationWhitelistPda = pdas.whitelistPda(mint, destination);
    return { deactivatePda, transferControlModePda, destinationWhitelistPda };
  }

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: mints tokens to a destination account and updates balance correctly", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair = provider.wallet.payer!;
    await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      destinationKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destinationKeypair.publicKey;

    const accountBefore = await getAccount(connection, destination, "confirmed", TOKEN_2022_PROGRAM_ID);
    const balanceBefore = accountBefore.amount;
    const mintInfoBefore = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const supplyBefore = mintInfoBefore.supply;

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Deployer:           ", deployer.toBase58());
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Mint authority PDA: ", mintAuthority.toBase58());
    console.log("  Mint owner PDA:     ", mintOwnerPda.toBase58());
    console.log("  Destination:        ", destination.toBase58());
    console.log("  Balance BEFORE:     ", balanceBefore.toString(), "(raw units)");
    console.log("  Supply BEFORE:      ", supplyBefore.toString(), "(raw units)");
    console.log("──────────────────────────────────────────────────────────\n");

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, destination);

    const tx = await mintProgram.methods
      .mint(MINT_AMOUNT)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        mintAuthority,
        destination,
        freezeAuthority,
        transferControlModePda,
        destinationWhitelistPda,
        snapshotCounterPda,
        totalSupplySnapshot,
        holderBalanceSnapshot,
        freezeProgram: FREEZE_PROGRAM_ID,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  mint tx:", tx);

    const accountAfter = await getAccount(connection, destination, "confirmed", TOKEN_2022_PROGRAM_ID);
    const balanceAfter = accountAfter.amount;
    const mintInfoAfter = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const supplyAfter = mintInfoAfter.supply;
    const humanReadable = (Number(balanceAfter) / 10 ** MINT_DECIMALS).toFixed(MINT_DECIMALS);

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Balance BEFORE:     ", balanceBefore.toString(), "(raw units)");
    console.log("  Balance AFTER:      ", balanceAfter.toString(), "(raw units)");
    console.log("  Supply BEFORE:      ", supplyBefore.toString(), "(raw units)");
    console.log("  Supply AFTER:       ", supplyAfter.toString(), "(raw units)");
    console.log("  Human-readable:     ", humanReadable, MINT_SYMBOL);
    console.log("  Expected:           ", MINT_AMOUNT.toString(), "(raw units)");
    console.log("──────────────────────────────────────────────────────────\n");

    assert.equal(balanceBefore.toString(), "0", "destination balance should be zero before minting");
    assert.equal(balanceAfter.toString(), MINT_AMOUNT.toString(), "destination balance should equal the minted amount");
    assert.equal(supplyBefore.toString(), "0", "total supply should be zero before minting");
    assert.equal(supplyAfter.toString(), MINT_AMOUNT.toString(), "total supply should equal the minted amount");
    assert.isTrue(accountAfter.isFrozen, "destination account should be re-frozen after minting");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, pausableAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair = provider.wallet.payer!;
    await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      destinationKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destinationKeypair.publicKey;
    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);

    const pauseTx: string = await pauseProgram.methods
      .pause()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        pausableAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:     ", mint.toBase58());
    console.log("  pause tx: ", pauseTx);
    console.log("══════════════════════════════════════════════════════════\n");

    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, destination);

    try {
      await mintProgram.methods
        .mint(MINT_AMOUNT)
        .accountsStrict({
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          mintAuthority,
          destination,
          freezeAuthority,
          transferControlModePda,
          destinationWhitelistPda,
          snapshotCounterPda,
          totalSupplySnapshot,
          holderBalanceSnapshot,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected mint-is-paused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const logs = (err as SendTransactionError).logs ?? [];
      console.log("  caught error:", (err as SendTransactionError).message);
      logs.forEach((log) => console.log("    ", log));
      assert.isTrue(
        logs.some((log) => log.includes("paused")),
        "logs should mention paused"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair = provider.wallet.payer!;
    await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      destinationKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destinationKeypair.publicKey;

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, destination);

    const deactivateTx = await deactivateProgram.methods
      .deactivate()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:           ", mint.toBase58());
    console.log("  Deactivate PDA: ", deactivatePda.toBase58());
    console.log("  deactivate tx:  ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await mintProgram.methods
        .mint(MINT_AMOUNT)
        .accountsStrict({
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          mintAuthority,
          destination,
          freezeAuthority,
          transferControlModePda,
          destinationWhitelistPda,
          snapshotCounterPda,
          totalSupplySnapshot,
          holderBalanceSnapshot,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected Deactivated error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      console.log("  caught error code:", anchorErr.error.errorCode.code);
      assert.equal(anchorErr.error.errorCode.code, "Deactivated");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair = provider.wallet.payer!;
    await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      destinationKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destinationKeypair.publicKey;

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, destination);

    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:          ", mint.toBase58());
    console.log("  Real deployer: ", deployer.toBase58());
    console.log("  Rogue signer:  ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await mintProgram.methods
        .mint(MINT_AMOUNT)
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          deactivatePda,
          mint,
          mintAuthority,
          destination,
          freezeAuthority,
          transferControlModePda,
          destinationWhitelistPda,
          snapshotCounterPda,
          totalSupplySnapshot,
          holderBalanceSnapshot,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .signers([rogueKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected UnauthorizedDeployer error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      console.log("  caught error code:", anchorErr.error.errorCode.code);
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: fails with NotWhitelisted when whitelist mode is active and destination is not whitelisted", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair = provider.wallet.payer!;
    await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      destinationKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destinationKeypair.publicKey;

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, destination);

    const setModeTx = await transferControlProgram.methods
      .setModes([{ whitelist: {} }])
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                      ", mint.toBase58());
    console.log("  Transfer Control Mode PDA: ", transferControlModePda.toBase58());
    console.log("  Destination:               ", destination.toBase58());
    console.log("  Destination whitelist PDA: ", destinationWhitelistPda.toBase58());
    console.log("  set_mode tx:               ", setModeTx);
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await mintProgram.methods
        .mint(MINT_AMOUNT)
        .accountsStrict({
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          mintAuthority,
          destination,
          freezeAuthority,
          transferControlModePda,
          destinationWhitelistPda,
          snapshotCounterPda,
          totalSupplySnapshot,
          holderBalanceSnapshot,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected NotWhitelisted error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      const anchorErr = err as AnchorError;
      console.log("  caught error code:", anchorErr.error.errorCode.code);
      assert.equal(anchorErr.error.errorCode.code, "NotWhitelisted");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("mint: snapshot taken before mint records destination balance of 0", async () => {
    // ── Deploy mint + create destination token account ────────────────────────
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority } = await deployMint();

    const destinationKeypair = Keypair.generate();
    const payerKeypair = provider.wallet.payer!;
    await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      destinationKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destinationKeypair.publicKey;

    const { deactivatePda, transferControlModePda, destinationWhitelistPda } = mintPdas(mint, destination);
    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, destination);

    // ── Take snapshot via create_coupon (counter 0 → 1) ──────────────────────
    const couponId = new anchor.BN(1);
    const couponAuthority = pdas.couponAuthorityPda(mint);
    const couponCounter = pdas.couponCounterPda(mint);
    const coupon = pdas.couponPda(mint, couponId);
    const snapshotTx = await couponProgram.methods
      .createCoupon(new anchor.BN(1_700_000_000), new anchor.BN(1_750_000_000), new anchor.BN(1_800_000_000), couponId)
      .accountsStrict({
        payer: deployer,
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        couponAuthority,
        couponCounter,
        coupon,
        snapshotCounter: snapshotCounterPda,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Mint:                  ", mint.toBase58());
    console.log("  Destination:           ", destination.toBase58());
    console.log("  totalSupplySnapshot: ", totalSupplySnapshot.toBase58());
    console.log("  holderBalanceSnapshot: ", holderBalanceSnapshot.toBase58());
    console.log("  create_coupon tx:      ", snapshotTx);
    console.log("──────────────────────────────────────────────────────────\n");

    // ── Mint tokens — snapshot CPIs fire and record pre-mint balance (= 0) ───
    const mintTx = await mintProgram.methods
      .mint(MINT_AMOUNT)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        mintAuthority,
        destination,
        freezeAuthority,
        transferControlModePda,
        destinationWhitelistPda,
        snapshotCounterPda,
        totalSupplySnapshot,
        holderBalanceSnapshot,
        freezeProgram: FREEZE_PROGRAM_ID,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  mint tx:", mintTx);

    // ── Assert snapshot values via get_*_snapshot_at ──────────────────────────
    const totalSupplyValue: anchor.BN = await snapshotProgram.methods
      .getTotalsupplySnapshotAt(new anchor.BN(1))
      .accountsStrict({
        mint,
        totalSupplySnapshot,
      })
      .view();
    const holderValue: anchor.BN = await snapshotProgram.methods
      .getHolderbalanceSnapshotAt(new anchor.BN(1))
      .accountsStrict({
        mint,
        holderBalanceSnapshot,
        holderTokenAccount: destination,
      })
      .view();

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  holderBalanceSnapshot[1].value: ", holderValue.toString());
    console.log("  totalSupplySnapshot[1].value:   ", totalSupplyValue.toString());
    console.log("  expected value:                 ", "0");
    console.log("──────────────────────────────────────────────────────────\n");

    assert.equal(holderValue.toString(), "0", "holder snapshot should record the balance before minting, which is 0");
    assert.equal(
      totalSupplyValue.toString(),
      "0",
      "total supply snapshot should record the balance before minting, which is 0"
    );
  });
});
