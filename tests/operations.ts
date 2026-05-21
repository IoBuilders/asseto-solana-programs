import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Mint } from "../target/types/mint";
import { Keypair, PublicKey, SendTransactionError, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAccount, getAccount } from "@solana/spl-token";
import { assert } from "chai";
import { Operations } from "../target/types/operations";
import { Pause } from "../target/types/pause";
import { Deactivate } from "../target/types/deactivate";
import { Snapshot } from "../target/types/snapshot";
import { Coupon } from "../target/types/coupon";
import * as pdaUtils from "./utils/pda_utils";
import {
  SYSTEM_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  SNAPSHOT_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
} from "./utils/address_utils";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";

const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);
const BURN_AMOUNT = new anchor.BN(300 * 10 ** MINT_DECIMALS);

describe("operations", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sourceOwnerKeypair = Keypair.generate();

  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const mintProgram = anchor.workspace.Mint as Program<Mint>;
  const operationsProgram = anchor.workspace.Operations as Program<Operations>;
  const pauseProgram = anchor.workspace.Pause as Program<Pause>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;
  const snapshotProgram = anchor.workspace.Snapshot as Program<Snapshot>;
  const couponProgram = anchor.workspace.Coupon as Program<Coupon>;
  const connection = provider.connection;
  const deployer = provider.wallet.publicKey;
  const sourceOwner = sourceOwnerKeypair.publicKey;
  const payerKeypair = provider.wallet.payer!;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
    mintAuthority: PublicKey;
    freezeAuthority: PublicKey;
    operationsAuthority: PublicKey;
    pausableAuthority: PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);
    const tempMintAuthority = pdaUtils.tempMintAuthorityPda(mint);
    const mintAuthority = pdaUtils.mintAuthorityPda(mint);
    const operationsAuthority = pdaUtils.permanentDelegatePda(mint);
    const metadataUpdateAuthority = pdaUtils.metadataUpdateAuthorityPda(mint);
    const pausableAuthority = pdaUtils.pausableAuthorityPda(mint);
    const freezeAuthority = pdaUtils.freezeAuthorityPda(mint);
    const transferHookAuthority = pdaUtils.transferHookAuthorityPda(mint);
    const extraAccountMetaList = pdaUtils.extraAccountMetaListPda(mint);

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
        permanentDelegateAuthority: operationsAuthority,
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
    return { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority, pausableAuthority };
  }

  // ── Helper: mint tokens to a fresh token account ────────────────────────────
  async function mintTokens(
    mint: PublicKey,
    mintOwnerPda: PublicKey,
    mintAuthority: PublicKey,
    freezeAuthority: PublicKey,
    amount: anchor.BN
  ): Promise<PublicKey> {
    const destinationKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      sourceOwner,
      destinationKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destinationKeypair.publicKey;

    const deactivatePda = pdaUtils.deactivatePda(mint);
    const transferControlModePda = pdaUtils.transferControlModePda(mint);
    const destinationWhitelistPda = pdaUtils.whitelistPda(mint, destination);
    const snapshotCounterPda = pdaUtils.snapshotCounterPda(mint);
    const totalSupplySnapshot = pdaUtils.snapshotTotalSupplyPda(mint);
    const holderBalanceSnapshot = pdaUtils.snapshotHolderBalancePda(mint, destination);

    const tx = await mintProgram.methods
      .mint(amount)
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
    return destination;
  }

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: removes tokens from source via permanent delegate", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority } = await deployMint();

    const deactivatePda = pdaUtils.deactivatePda(mint);

    // Mint 1 000 tokens to the source account (owned by deployer wallet).
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    const sourceBefore = (await getAccount(connection, source, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Deployer:           ", deployer.toBase58());
    console.log("  Mint:                 ", mint.toBase58());
    console.log("  Operations authority: ", operationsAuthority.toBase58());
    console.log("  Mint owner PDA:     ", mintOwnerPda.toBase58());
    console.log("  Source:               ", source.toBase58());
    console.log("  Source balance BEFORE:", sourceBefore.toString(), "(raw)");
    console.log("──────────────────────────────────────────────────────────\n");

    const snapshotCounterPda = pdaUtils.snapshotCounterPda(mint);
    const totalSupplySnapshot = pdaUtils.snapshotTotalSupplyPda(mint);
    const holderBalanceSnapshot = pdaUtils.snapshotHolderBalancePda(mint, source);

    // ── Call burn ──────────────────────────────────────────────────────
    const tx = await operationsProgram.methods
      .burn(BURN_AMOUNT)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        tokenAccount: source,
        operationsAuthority,
        freezeAuthority,
        snapshotCounterPda,
        totalSupplySnapshot,
        holderBalanceSnapshot,
        freezeProgram: FREEZE_PROGRAM_ID,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  burn tx:", tx);

    const sourceAfter = (await getAccount(connection, source, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Source balance AFTER: ", sourceAfter.toString(), "(raw)");
    console.log("──────────────────────────────────────────────────────────\n");

    assert.equal(
      sourceAfter.toString(),
      (MINT_AMOUNT.toNumber() - BURN_AMOUNT.toNumber()).toString(),
      "source balance should be reduced by the transfer amount"
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority } = await deployMint();
    const deactivatePda = pdaUtils.deactivatePda(mint);

    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    const snapshotCounterPda = pdaUtils.snapshotCounterPda(mint);
    const totalSupplySnapshot = pdaUtils.snapshotTotalSupplyPda(mint);
    const holderBalanceSnapshot = pdaUtils.snapshotHolderBalancePda(mint, source);

    try {
      await operationsProgram.methods
        .burn(BURN_AMOUNT)
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          deactivatePda,
          mint,
          tokenAccount: source,
          operationsAuthority,
          freezeAuthority,
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
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "UnauthorizedDeployer", "error code should be UnauthorizedDeployer");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: fails when mint is paused", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority, pausableAuthority } =
      await deployMint();
    const deactivatePda = pdaUtils.deactivatePda(mint);

    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Pause the mint via pause
    const pauseTx: string = await pauseProgram.methods
      .pause()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        pausableAuthority,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  pause tx:           ", pauseTx);
    console.log("══════════════════════════════════════════════════════════\n");

    const snapshotCounterPda = pdaUtils.snapshotCounterPda(mint);
    const totalSupplySnapshot = pdaUtils.snapshotTotalSupplyPda(mint);
    const holderBalanceSnapshot = pdaUtils.snapshotHolderBalancePda(mint, source);

    // The burn CPI into Token-2022 is rejected because the mint is paused.
    // This surfaces as a SendTransactionError (Token-2022 custom error 0x43),
    // not an AnchorError, because the rejection originates inside Token-2022.
    try {
      await operationsProgram.methods
        .burn(BURN_AMOUNT)
        .accountsStrict({
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          tokenAccount: source,
          operationsAuthority,
          freezeAuthority,
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
      const sendErr = err as SendTransactionError;
      const logs = sendErr.logs ?? [];

      console.log("  caught error:       ", sendErr.message);
      console.log("  transaction logs:");
      logs.forEach((log) => console.log("    ", log));

      assert.isTrue(
        logs.some((log) => log.includes("paused")),
        "transaction logs should mention the mint is paused"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: fails with Deactivated when mint has been deactivated", async () => {
    // ── Deploy a fresh mint ────────────────────────────────────────────────
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority } = await deployMint();

    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    const deactivatePda = pdaUtils.deactivatePda(mint);

    // ── Deactivate the mint ────────────────────────────────────────────────
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
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Deactivate PDA:     ", deactivatePda.toBase58());
    console.log("  deactivate tx:      ", deactivateTx);
    console.log("══════════════════════════════════════════════════════════\n");

    const snapshotCounterPda = pdaUtils.snapshotCounterPda(mint);
    const totalSupplySnapshot = pdaUtils.snapshotTotalSupplyPda(mint);
    const holderBalanceSnapshot = pdaUtils.snapshotHolderBalancePda(mint, source);

    // ── Mint must now be rejected with Deactivated ─────────────────────────
    try {
      await operationsProgram.methods
        .burn(BURN_AMOUNT)
        .accountsStrict({
          deployer,
          mintOwnerPda,
          deactivatePda,
          mint,
          tokenAccount: source,
          operationsAuthority,
          freezeAuthority,
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
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("burn: snapshot taken before burn records holder balance at time of snapshot", async () => {
    const { mint, mintOwnerPda, mintAuthority, freezeAuthority, operationsAuthority } = await deployMint();

    // Mint MINT_AMOUNT tokens (no snapshot active yet → snapshot CPIs exit silently)
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    const snapshotCounterPda = pdaUtils.snapshotCounterPda(mint);
    const totalSupplySnapshot = pdaUtils.snapshotTotalSupplyPda(mint);
    const holderBalanceSnapshot = pdaUtils.snapshotHolderBalancePda(mint, source);
    const deactivatePda = pdaUtils.deactivatePda(mint);

    // Take snapshot via create_coupon (counter 0 → 1); subsequent operations will record pre-op balances
    const couponId = new anchor.BN(1);
    const couponAuthority = pdaUtils.couponAuthorityPda(mint);
    const couponCounter = pdaUtils.couponCounterPda(mint);
    const coupon = pdaUtils.couponPda(mint, couponId);

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
    console.log("  Source:                ", source.toBase58());
    console.log("  holderBalanceSnapshot: ", holderBalanceSnapshot.toBase58());
    console.log("  create_coupon tx:      ", snapshotTx);
    console.log("──────────────────────────────────────────────────────────\n");

    // Burn — snapshot CPI fires and records pre-burn balance (= MINT_AMOUNT)
    const burnTx = await operationsProgram.methods
      .burn(BURN_AMOUNT)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        deactivatePda,
        mint,
        tokenAccount: source,
        operationsAuthority,
        freezeAuthority,
        snapshotCounterPda,
        totalSupplySnapshot,
        holderBalanceSnapshot,
        freezeProgram: FREEZE_PROGRAM_ID,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  burn tx:", burnTx);

    // ── Assert snapshot values via get_*_snapshot_at ──────────────────────────
    const holderValue: anchor.BN = await snapshotProgram.methods
      .getHolderbalanceSnapshotAt(new anchor.BN(1))
      .accountsStrict({
        mint,
        holderBalanceSnapshot,
        holderTokenAccount: source,
      })
      .view();
    const totalSupplyValue: anchor.BN = await snapshotProgram.methods
      .getTotalsupplySnapshotAt(new anchor.BN(1))
      .accountsStrict({
        mint,
        totalSupplySnapshot,
      })
      .view();

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  holderBalanceSnapshot[1].value: ", holderValue.toString());
    console.log("  totalSupplySnapshot[1].value:   ", totalSupplyValue.toString());
    console.log("  expected value:                 ", MINT_AMOUNT.toString());
    console.log("──────────────────────────────────────────────────────────\n");

    assert.equal(
      holderValue.toString(),
      MINT_AMOUNT.toString(),
      "holder snapshot should record the balance before burning, which equals MINT_AMOUNT"
    );
    assert.equal(
      totalSupplyValue.toString(),
      MINT_AMOUNT.toString(),
      "total supply snapshot should record the total supply before burning, which equals MINT_AMOUNT"
    );
  });
});
