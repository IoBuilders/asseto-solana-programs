import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Mint } from "../target/types/mint";
import { TransferControl } from "../target/types/transfer_control";
import { Freeze } from "../target/types/freeze";
import { Pause } from "../target/types/pause";
import { Transfer } from "../target/types/transfer";
import { Deactivate } from "../target/types/deactivate";
import { Snapshot } from "../target/types/snapshot";
import { Coupon } from "../target/types/coupon";
import { AccountMeta, Keypair, PublicKey, SYSVAR_RENT_PUBKEY, SendTransactionError } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAccount, getAccount, getMint } from "@solana/spl-token";
import { assert } from "chai";
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
const TRANSFER_AMOUNT = new anchor.BN(400 * 10 ** MINT_DECIMALS);
const FUND_AMOUNT_IN_LAMPORT = anchor.web3.LAMPORTS_PER_SOL * 0.01;

describe("transfer", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const sourceOwnerKeypair = Keypair.generate();
  const destinationOwnerKeypair = Keypair.generate();

  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const mintProgram = anchor.workspace.Mint as Program<Mint>;
  const freezeProgram = anchor.workspace.Freeze as Program<Freeze>;
  const pauseProgram = anchor.workspace.Pause as Program<Pause>;
  const transferProgram = anchor.workspace.Transfer as Program<Transfer>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;
  const transferControlProgram = anchor.workspace.TransferControl as Program<TransferControl>;
  const snapshotProgram = anchor.workspace.Snapshot as Program<Snapshot>;
  const couponProgram = anchor.workspace.Coupon as Program<Coupon>;
  const connection = provider.connection;
  const deployer = provider.wallet.publicKey;
  const sourceOwner = sourceOwnerKeypair.publicKey;
  const destinationOwner = destinationOwnerKeypair.publicKey;
  const payerKeypair = provider.wallet.payer!;

  // ── Helper: derive snapshot-related PDAs for mint/burn operations ──────────
  function snapshotAccounts(mint: PublicKey, holderTokenAccount: PublicKey) {
    return {
      snapshotCounterPda: pdaUtils.snapshotCounterPda(mint),
      totalSupplySnapshot: pdaUtils.snapshotTotalSupplyPda(mint),
      holderBalanceSnapshot: pdaUtils.snapshotHolderBalancePda(mint, holderTokenAccount),
    };
  }

  // ── Helper: derive snapshot PDAs required by the transfer instruction ───────
  function transferSnapshotAccounts(mint: PublicKey, source: PublicKey, destination: PublicKey) {
    return {
      snapshotCounterPda: pdaUtils.snapshotCounterPda(mint),
      senderSnapshot: pdaUtils.snapshotHolderBalancePda(mint, source),
      receiverSnapshot: pdaUtils.snapshotHolderBalancePda(mint, destination),
    };
  }

  // ── Helper: fund the transfer hook authority PDA ────────────────────────────
  async function fundTransferHookAuthority(transferHookAuthority: PublicKey): Promise<void> {
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payerKeypair.publicKey,
        toPubkey: transferHookAuthority,
        lamports: FUND_AMOUNT_IN_LAMPORT,
      })
    );
    await anchor.web3.sendAndConfirmTransaction(connection, tx, [payerKeypair], { commitment: "confirmed" });
  }

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
    mintAuthority: PublicKey;
    freezeAuthority: PublicKey;
    transferAuthority: PublicKey;
    pausableAuthority: PublicKey;
    extraAccountMetaList: PublicKey;
    transferHookAuthority: PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    const mintOwnerPda = pdaUtils.mintOwnerPda(mint);
    const tempMintAuthority = pdaUtils.tempMintAuthorityPda(mint);
    const mintAuthority = pdaUtils.mintAuthorityPda(mint);
    const operationsAuthority = pdaUtils.permanentDelegatePda(mint);
    const transferAuthority = pdaUtils.transferAuthorityPda(mint);
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
    return {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      pausableAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    };
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

    const { snapshotCounterPda, totalSupplySnapshot, holderBalanceSnapshot } = snapshotAccounts(mint, destination);
    const deactivatePda = pdaUtils.deactivatePda(mint);
    const transferControlModePda = pdaUtils.transferControlModePda(mint);
    const destinationWhitelistPda = pdaUtils.whitelistPda(mint, destination);

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

  // ── Helper: derive the PDAs verify_transfer needs ──────────────────────────
  function verifyTransferPdas(mint: PublicKey, source: PublicKey, destination: PublicKey) {
    return {
      mintOwnerPda: pdaUtils.mintOwnerPda(mint),
      deactivatePda: pdaUtils.deactivatePda(mint),
      transferControlModePda: pdaUtils.transferControlModePda(mint),
      sourceWhitelistPda: pdaUtils.whitelistPda(mint, source),
      destinationWhitelistPda: pdaUtils.whitelistPda(mint, destination),
      sourceFrozenPda: pdaUtils.frozenAccountPda(mint, source),
      sourceFrozenBalancePda: pdaUtils.frozenBalancePda(mint, source),
    };
  }

  // ── Helper: build a verify_transfer instruction for the given transfer ─────
  async function buildVerifyTransferIx(
    source: PublicKey,
    destination: PublicKey,
    mint: PublicKey,
    amount: anchor.BN,
    sourceOwnerOverride?: PublicKey,
    deployerOverride?: PublicKey
  ): Promise<anchor.web3.TransactionInstruction> {
    const pdas = verifyTransferPdas(mint, source, destination);
    return await transferProgram.methods
      .verifyTransfer(amount)
      .accountsStrict({
        sourceOwner: sourceOwnerOverride ?? sourceOwner,
        source,
        destination,
        mint,
        deployer: deployerOverride ?? deployer,
        ...pdas,
      })
      .instruction();
  }

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: moves tokens from source to destination", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    // Mint 1 000 tokens to the source account (owned by sourceOwner).
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create a destination token account (owned by destinationOwner).
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    const sourceBefore = (await getAccount(connection, source, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const destBefore = (await getAccount(connection, destination, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const supplyBefore = (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Mint:                  ", mint.toBase58());
    console.log("  Transfer authority:    ", transferAuthority.toBase58());
    console.log("  Source:                ", source.toBase58());
    console.log("  Destination:           ", destination.toBase58());
    console.log("  Source balance BEFORE: ", sourceBefore.toString(), "(raw)");
    console.log("  Dest   balance BEFORE: ", destBefore.toString(), "(raw)");
    console.log("  Supply BEFORE:         ", supplyBefore.toString(), "(raw)");
    console.log("──────────────────────────────────────────────────────────\n");

    // Fund transferHookAuthority PDA so it can pay for accounts if needed
    await fundTransferHookAuthority(transferHookAuthority);

    // ── Call transfer ──────────────────────────────────────────────────────
    const { snapshotCounterPda, senderSnapshot, receiverSnapshot } = transferSnapshotAccounts(
      mint,
      source,
      destination
    );

    const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT);

    const tx = await transferProgram.methods
      .transfer(TRANSFER_AMOUNT)
      .accountsStrict({
        sourceOwner,
        source,
        destination,
        mint,
        transferAuthority,
        transferHookAuthority,
        freezeAuthority,
        extraAccountMetaList,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        freezeProgram: FREEZE_PROGRAM_ID,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        snapshotCounterPda,
        senderSnapshot,
        receiverSnapshot,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
      .signers([sourceOwnerKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  transfer tx:", tx);

    const sourceAfter = (await getAccount(connection, source, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const destAfter = (await getAccount(connection, destination, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
    const supplyAfter = (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Source balance AFTER:  ", sourceAfter.toString(), "(raw)");
    console.log("  Dest   balance AFTER:  ", destAfter.toString(), "(raw)");
    console.log("  Supply AFTER:          ", supplyAfter.toString(), "(raw)");
    console.log("──────────────────────────────────────────────────────────\n");

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
    assert.equal(supplyAfter.toString(), supplyBefore.toString(), "total supply should be unchanged after a transfer");
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: snapshot 1 captures post-transfer balances (source = minted - transferred, destination = transferred)", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    const deactivatePda = pdaUtils.deactivatePda(mint);
    const { snapshotCounterPda, senderSnapshot, receiverSnapshot } = transferSnapshotAccounts(
      mint,
      source,
      destination
    );

    // ── Take snapshot via create_coupon (counter: 0 → 1) ─────────────────────
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

    console.log("  create_coupon tx:", snapshotTx);

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Mint:                  ", mint.toBase58());
    console.log("  Source:                ", source.toBase58());
    console.log("  Destination:           ", destination.toBase58());
    console.log("  Sender snapshot PDA:   ", senderSnapshot.toBase58());
    console.log("  Receiver snapshot PDA: ", receiverSnapshot.toBase58());
    console.log("──────────────────────────────────────────────────────────\n");

    // ── Fund and transfer ─────────────────────────────────────────────────────
    await fundTransferHookAuthority(transferHookAuthority);

    const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT);

    const tx = await transferProgram.methods
      .transfer(TRANSFER_AMOUNT)
      .accountsStrict({
        sourceOwner,
        source,
        destination,
        mint,
        transferAuthority,
        transferHookAuthority,
        freezeAuthority,
        extraAccountMetaList,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        freezeProgram: FREEZE_PROGRAM_ID,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        snapshotCounterPda,
        senderSnapshot,
        receiverSnapshot,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
      .signers([sourceOwnerKeypair])
      .rpc({ commitment: "confirmed" });

    console.log("  transfer tx:", tx);

    // ── Assert snapshot values via get_holderbalance_snapshot_at ─────────────
    const senderValue: anchor.BN = await snapshotProgram.methods
      .getHolderbalanceSnapshotAt(new anchor.BN(1))
      .accountsStrict({
        mint,
        holderBalanceSnapshot: senderSnapshot,
        holderTokenAccount: source,
      })
      .view();
    const receiverValue: anchor.BN = await snapshotProgram.methods
      .getHolderbalanceSnapshotAt(new anchor.BN(1))
      .accountsStrict({
        mint,
        holderBalanceSnapshot: receiverSnapshot,
        holderTokenAccount: destination,
      })
      .view();

    console.log("\n──────────────────────────────────────────────────────────");
    console.log("  Sender snapshot value:   ", senderValue.toString());
    console.log("  Receiver snapshot value: ", receiverValue.toString());
    console.log("──────────────────────────────────────────────────────────\n");

    assert.equal(
      receiverValue.toString(),
      "0",
      "receiver snapshot should be 0: Token-2022 credits destination after the hook returns"
    );
    assert.equal(
      senderValue.toString(),
      MINT_AMOUNT.toNumber().toString(),
      "sender snapshot should equal post-debit balance: Token-2022 debits source before invoking the hook"
    );
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: fails when there is no previous instruction", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    // Mint 1 000 tokens to the source account (owned by sourceOwner).
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create a destination token account (owned by destinationOwner).
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    // Fund transferHookAuthority PDA so it can pay for accounts if needed
    await fundTransferHookAuthority(transferHookAuthority);

    // ── Call transfer ──────────────────────────────────────────────────────
    const { snapshotCounterPda, senderSnapshot, receiverSnapshot } = transferSnapshotAccounts(
      mint,
      source,
      destination
    );

    try {
      await transferProgram.methods
        .transfer(TRANSFER_AMOUNT)
        .accountsStrict({
          sourceOwner,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda: snapshotCounterPda,
          senderSnapshot: senderSnapshot,
          receiverSnapshot: receiverSnapshot,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .signers([sourceOwnerKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected NoPreviousInstruction error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(
        anchorErr.error.errorCode.code,
        "NoPreviousInstruction",
        "error code should be NoPreviousInstruction"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: fails when previous instruction program is not verify program", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    // Mint 1 000 tokens to the source account (owned by sourceOwner).
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create a destination token account (owned by destinationOwner).
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    // Fund transferHookAuthority PDA so it can pay for accounts if needed
    await fundTransferHookAuthority(transferHookAuthority);

    // ── Call transfer ──────────────────────────────────────────────────────
    const { snapshotCounterPda, senderSnapshot, receiverSnapshot } = transferSnapshotAccounts(
      mint,
      source,
      destination
    );

    const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT);
    try {
      await transferProgram.methods
        .transfer(TRANSFER_AMOUNT)
        .accountsStrict({
          sourceOwner,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda: snapshotCounterPda,
          senderSnapshot: senderSnapshot,
          receiverSnapshot: receiverSnapshot,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .preInstructions([verifyIx, anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .signers([sourceOwnerKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected PrevInstructionWrongProgram error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(
        anchorErr.error.errorCode.code,
        "PrevInstructionWrongProgram",
        "error code should be PrevInstructionWrongProgram"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: fails when previous instruction method does not have the proper input arguments", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    // Mint 1 000 tokens to the source account (owned by sourceOwner).
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create a destination token account (owned by destinationOwner).
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    // Fund transferHookAuthority PDA so it can pay for accounts if needed
    await fundTransferHookAuthority(transferHookAuthority);

    // ── Call transfer ──────────────────────────────────────────────────────
    const { snapshotCounterPda, senderSnapshot, receiverSnapshot } = transferSnapshotAccounts(
      mint,
      source,
      destination
    );

    const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT.sub(new anchor.BN(1))); // Update this part
    try {
      await transferProgram.methods
        .transfer(TRANSFER_AMOUNT)
        .accountsStrict({
          sourceOwner,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda: snapshotCounterPda,
          senderSnapshot: senderSnapshot,
          receiverSnapshot: receiverSnapshot,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
        .signers([sourceOwnerKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected PrevInstructionArgumentMismatch error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(
        anchorErr.error.errorCode.code,
        "PrevInstructionArgumentMismatch",
        "error code should be PrevInstructionArgumentMismatch"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: fails when signer is not token holder", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create a destination token account (owned by destinationOwner).
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    // A keypair that has nothing to do with this mint — it is NOT the recorded deployer.
    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    const {
      snapshotCounterPda: sc1,
      senderSnapshot: ss1,
      receiverSnapshot: rs1,
    } = transferSnapshotAccounts(mint, source, destination);

    await fundTransferHookAuthority(transferHookAuthority);
    try {
      // verify_transfer is also called with the rogue signer; it does not check
      // source ownership (Token-2022 does that during transfer_checked), so it
      // succeeds. The OwnerMismatch then comes from Token-2022 below.
      const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT, rogueKeypair.publicKey);

      // ── Call transfer ──────────────────────────────────────────────────────
      await transferProgram.methods
        .transfer(TRANSFER_AMOUNT)
        .accountsStrict({
          sourceOwner: rogueKeypair.publicKey,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda: sc1,
          senderSnapshot: ss1,
          receiverSnapshot: rs1,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
        .signers([rogueKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected owner-mismatch error but instruction succeeded");
    } catch (err) {
      // Ownership of the source token account is enforced natively by Token-2022
      // during transfer_checked (before the hook runs), so the error surfaces as
      // a Token-2022 OwnerMismatch (SendTransactionError) rather than an AnchorError.
      assert.instanceOf(err, SendTransactionError, "error should be a SendTransactionError");
      const sendErr = err as SendTransactionError;
      const logs = sendErr.logs ?? [];
      console.log("  caught error:       ", sendErr.message);
      console.log("  transaction logs:");
      logs.forEach((log) => console.log("    ", log));

      assert.isTrue(
        logs.some((log) => log.toLowerCase().includes("owner does not match")),
        "transaction logs should mention Token-2022 owner mismatch"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: fails when mint is paused", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      pausableAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create a destination token account (owned by destinationOwner).
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;
    const deactivatePda = pdaUtils.deactivatePda(mint);

    // Pause the mint via pause
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
    console.log("  Mint:               ", mint.toBase58());
    console.log("  pause tx:           ", pauseTx);
    console.log("══════════════════════════════════════════════════════════\n");

    const {
      snapshotCounterPda: sc2,
      senderSnapshot: ss2,
      receiverSnapshot: rs2,
    } = transferSnapshotAccounts(mint, source, destination);

    await fundTransferHookAuthority(transferHookAuthority);
    try {
      // verify_transfer does not check the Pausable extension (Token-2022 does
      // that natively during transfer_checked), so it succeeds. The error then
      // comes from Token-2022 in the next instruction.
      const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT);

      // ── Call transfer ──────────────────────────────────────────────────────
      await transferProgram.methods
        .transfer(TRANSFER_AMOUNT)
        .accountsStrict({
          sourceOwner,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda: sc2,
          senderSnapshot: ss2,
          receiverSnapshot: rs2,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
        .signers([sourceOwnerKeypair])
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
  it("transfer: fails with AccountFrozen when source account has been frozen", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create a destination token account (owned by destinationOwner).
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    const deactivatePda = pdaUtils.deactivatePda(mint);
    const sourceFrozenPda = pdaUtils.frozenAccountPda(mint, source);

    // ── Freeze the source account via freeze ─────────────────────────
    const freezeTx = await freezeProgram.methods
      .freezeAccount()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: source,
        deactivatePda,
        frozenAccountPda: sourceFrozenPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Source:             ", source.toBase58());
    console.log("  Source frozen PDA:  ", sourceFrozenPda.toBase58());
    console.log("  freeze_account tx:  ", freezeTx);
    console.log("══════════════════════════════════════════════════════════\n");

    // ── Transfer must now be rejected with AccountFrozen ──────────────────
    const {
      snapshotCounterPda: sc3,
      senderSnapshot: ss3,
      receiverSnapshot: rs3,
    } = transferSnapshotAccounts(mint, source, destination);

    await fundTransferHookAuthority(transferHookAuthority);
    try {
      // verify_transfer runs the AccountFrozen check (via freeze) on its
      // own; it throws here before the hook ever runs.
      const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT);

      await transferProgram.methods
        .transfer(TRANSFER_AMOUNT)
        .accountsStrict({
          sourceOwner,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda: sc3,
          senderSnapshot: ss3,
          receiverSnapshot: rs3,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
        .signers([sourceOwnerKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected AccountFrozen error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "AccountFrozen", "error code should be AccountFrozen");
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: fails with Deactivated when mint has been deactivated", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create a destination token account (owned by destinationOwner).
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

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

    // ── Mint must now be rejected with Deactivated ─────────────────────────
    const {
      snapshotCounterPda: sc4,
      senderSnapshot: ss4,
      receiverSnapshot: rs4,
    } = transferSnapshotAccounts(mint, source, destination);

    await fundTransferHookAuthority(transferHookAuthority);
    try {
      // verify_transfer runs the Deactivated check on its own and throws.
      const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT);

      await transferProgram.methods
        .transfer(TRANSFER_AMOUNT)
        .accountsStrict({
          sourceOwner,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda: sc4,
          senderSnapshot: ss4,
          receiverSnapshot: rs4,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
        .signers([sourceOwnerKeypair])
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
  it("transfer: succeeds when transfer is within unfrozen balance, then fails with InsufficientUnfrozenBalance when it exceeds it", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    const TOTAL_AMOUNT = new anchor.BN(100 * 10 ** MINT_DECIMALS);
    const FROZEN_AMOUNT = new anchor.BN(50 * 10 ** MINT_DECIMALS);
    const FIRST_TRANSFER = new anchor.BN(40 * 10 ** MINT_DECIMALS); // 50 available >= 40 ✓
    const SECOND_TRANSFER = new anchor.BN(20 * 10 ** MINT_DECIMALS); // 10 available < 20  ✗

    // ── Mint 100 tokens to source account (owned by sourceOwner) ─────────────
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, TOTAL_AMOUNT);

    // ── Create destination token account ──────────────────────────────────────
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    // ── Derive PDAs ───────────────────────────────────────────────────────────
    const deactivatePda = pdaUtils.deactivatePda(mint);
    const frozenBalancePda = pdaUtils.frozenBalancePda(mint, source);

    // ── Partially freeze 50 tokens ────────────────────────────────────────────
    const partialFreezeTx = await freezeProgram.methods
      .partiallyFreezeAccount(FROZEN_AMOUNT)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: source,
        deactivatePda,
        frozenBalancePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                 ", mint.toBase58());
    console.log("  Source:               ", source.toBase58());
    console.log("  Frozen balance PDA:   ", frozenBalancePda.toBase58());
    console.log("  partially_freeze tx:  ", partialFreezeTx);
    console.log("══════════════════════════════════════════════════════════\n");

    // ── Transfer 40 tokens — succeeds (available = 100 - 50 = 50 >= 40) ──────
    const {
      snapshotCounterPda: sc5,
      senderSnapshot: ss5,
      receiverSnapshot: rs5,
    } = transferSnapshotAccounts(mint, source, destination);

    await fundTransferHookAuthority(transferHookAuthority);
    const verifyIx5 = await buildVerifyTransferIx(source, destination, mint, FIRST_TRANSFER);
    const transferTx = await transferProgram.methods
      .transfer(FIRST_TRANSFER)
      .accountsStrict({
        sourceOwner,
        source,
        destination,
        mint,
        transferAuthority,
        transferHookAuthority,
        freezeAuthority,
        extraAccountMetaList,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        freezeProgram: FREEZE_PROGRAM_ID,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        snapshotCounterPda: sc5,
        senderSnapshot: ss5,
        receiverSnapshot: rs5,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx5])
      .signers([sourceOwnerKeypair])
      .rpc({ commitment: "confirmed" });

    const sourceAfter = (await getAccount(connection, source, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  transfer tx:          ", transferTx);
    console.log(
      "  Source balance after: ",
      sourceAfter.toString(),
      "(raw) — expected",
      (TOTAL_AMOUNT.toNumber() - FIRST_TRANSFER.toNumber()).toString()
    );
    console.log(
      "  Available after:      ",
      (Number(sourceAfter) - FROZEN_AMOUNT.toNumber()).toString(),
      "(raw) — 10 tokens"
    );
    console.log("══════════════════════════════════════════════════════════\n");

    assert.equal(
      sourceAfter.toString(),
      (TOTAL_AMOUNT.toNumber() - FIRST_TRANSFER.toNumber()).toString(),
      "source balance should be 60 tokens after transferring 40"
    );

    // ── Transfer 20 tokens — fails (available = 60 - 50 = 10 < 20) ───────────
    try {
      // verify_transfer runs the InsufficientUnfrozenBalance check on its own.
      const verifyIx = await buildVerifyTransferIx(source, destination, mint, SECOND_TRANSFER);

      await transferProgram.methods
        .transfer(SECOND_TRANSFER)
        .accountsStrict({
          sourceOwner,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda: sc5,
          senderSnapshot: ss5,
          receiverSnapshot: rs5,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
        .signers([sourceOwnerKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected InsufficientUnfrozenBalance error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(
        anchorErr.error.errorCode.code,
        "InsufficientUnfrozenBalance",
        "error code should be InsufficientUnfrozenBalance"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: fails with TransferControlDenied when whitelist mode is active and destination is not whitelisted", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    // Mint tokens to source before activating whitelist mode
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create destination token account
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    // Derive PDAs
    const deactivatePda = pdaUtils.deactivatePda(mint);
    const transferControlModePda = pdaUtils.transferControlModePda(mint);
    const sourceWhitelistPda = pdaUtils.whitelistPda(mint, source);
    const { snapshotCounterPda, senderSnapshot, receiverSnapshot } = transferSnapshotAccounts(
      mint,
      source,
      destination
    );

    // Activate whitelist mode
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

    // Add source to whitelist — destination is NOT whitelisted
    await transferControlProgram.methods
      .addToWhitelist()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: source,
        deactivatePda,
        whitelistPda: sourceWhitelistPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                      ", mint.toBase58());
    console.log("  Source:                    ", source.toBase58());
    console.log("  Destination:               ", destination.toBase58());
    console.log("  set_mode({ whitelist }) tx:", setModeTx);
    console.log("  (destination NOT whitelisted)");
    console.log("══════════════════════════════════════════════════════════\n");

    await fundTransferHookAuthority(transferHookAuthority);
    try {
      // verify_transfer runs the TransferControlDenied check on its own.
      const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT);

      await transferProgram.methods
        .transfer(TRANSFER_AMOUNT)
        .accountsStrict({
          sourceOwner,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda,
          senderSnapshot,
          receiverSnapshot,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
        .signers([sourceOwnerKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected TransferControlDenied error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(
        anchorErr.error.errorCode.code,
        "TransferControlDenied",
        "error code should be TransferControlDenied"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: fails with TransferControlDenied when whitelist mode is active and source is not whitelisted", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    // Mint tokens to source before activating whitelist mode
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create destination token account
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    // Derive PDAs
    const deactivatePda = pdaUtils.deactivatePda(mint);
    const transferControlModePda = pdaUtils.transferControlModePda(mint);
    const destinationWhitelistPda = pdaUtils.whitelistPda(mint, destination);
    const { snapshotCounterPda, senderSnapshot, receiverSnapshot } = transferSnapshotAccounts(
      mint,
      source,
      destination
    );

    // Activate whitelist mode
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

    // Add destination to whitelist — source is NOT whitelisted
    await transferControlProgram.methods
      .addToWhitelist()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: destination,
        deactivatePda,
        whitelistPda: destinationWhitelistPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                      ", mint.toBase58());
    console.log("  Source:                    ", source.toBase58());
    console.log("  Destination:               ", destination.toBase58());
    console.log("  set_mode(false) tx:        ", setModeTx);
    console.log("  (source NOT whitelisted)");
    console.log("══════════════════════════════════════════════════════════\n");

    await fundTransferHookAuthority(transferHookAuthority);
    try {
      // verify_transfer runs the TransferControlDenied check on its own.
      const verifyIx = await buildVerifyTransferIx(source, destination, mint, TRANSFER_AMOUNT);

      await transferProgram.methods
        .transfer(TRANSFER_AMOUNT)
        .accountsStrict({
          sourceOwner,
          source,
          destination,
          mint,
          transferAuthority,
          transferHookAuthority,
          freezeAuthority,
          extraAccountMetaList,
          transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
          freezeProgram: FREEZE_PROGRAM_ID,
          snapshotProgram: SNAPSHOT_PROGRAM_ID,
          snapshotCounterPda,
          senderSnapshot,
          receiverSnapshot,
          instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), verifyIx])
        .signers([sourceOwnerKeypair])
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected TransferControlDenied error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(
        anchorErr.error.errorCode.code,
        "TransferControlDenied",
        "error code should be TransferControlDenied"
      );
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  it("transfer: fails with TransferControlDenied when clearing mode is active and signer is not the deployer", async () => {
    const {
      mint,
      mintOwnerPda,
      mintAuthority,
      freezeAuthority,
      transferAuthority,
      extraAccountMetaList,
      transferHookAuthority,
    } = await deployMint();

    // Mint tokens to source before activating clearing mode
    const source = await mintTokens(mint, mintOwnerPda, mintAuthority, freezeAuthority, MINT_AMOUNT);

    // Create destination token account
    const destKeypair = Keypair.generate();
    await createAccount(
      connection,
      payerKeypair,
      mint,
      destinationOwner,
      destKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );
    const destination = destKeypair.publicKey;

    // Derive PDAs
    const deactivatePda = pdaUtils.deactivatePda(mint);
    const transferControlModePda = pdaUtils.transferControlModePda(mint);

    const { snapshotCounterPda, senderSnapshot, receiverSnapshot } = transferSnapshotAccounts(
      mint,
      source,
      destination
    );

    // Activate clearing mode
    const setModeTx = await transferControlProgram.methods
      .setModes([{ clearing: {} }])
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        deactivatePda,
        transferControlModePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // A rogue keypair that is NOT the recorded deployer
    const rogueKeypair = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(rogueKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "confirmed");

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("  set_mode({ clearing: {} }) tx: ", setModeTx);
    console.log("══════════════════════════════════════════════════════════\n");

    // The clearing-mode signer check now lives in `verify_transfer`, not in
    // `transfer.transfer`. `deployer` is `UncheckedAccount` in the Rust
    // struct, so Anchor never marks it isSigner. We build verify_transfer with
    // the rogue pubkey as deployer override and manually flip its isSigner
    // flag — otherwise Solana rejects the tx with "unknown signer" before
    // verify_deployer runs.
    await fundTransferHookAuthority(transferHookAuthority);

    const verifyIx = await buildVerifyTransferIx(
      source,
      destination,
      mint,
      TRANSFER_AMOUNT,
      undefined,
      rogueKeypair.publicKey
    );
    const deployerIdxInVerify = verifyIx.keys.findIndex((k: AccountMeta) => k.pubkey.equals(rogueKeypair.publicKey));
    verifyIx.keys[deployerIdxInVerify].isSigner = true;

    const ix = await transferProgram.methods
      .transfer(TRANSFER_AMOUNT)
      .accountsStrict({
        sourceOwner,
        source,
        destination,
        mint,
        transferAuthority,
        transferHookAuthority,
        freezeAuthority,
        extraAccountMetaList,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        freezeProgram: FREEZE_PROGRAM_ID,
        snapshotProgram: SNAPSHOT_PROGRAM_ID,
        snapshotCounterPda,
        senderSnapshot,
        receiverSnapshot,
        instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .instruction();

    const { blockhash: txBlockhash } = await connection.getLatestBlockhash("confirmed");
    const rawTx = new anchor.web3.Transaction();
    rawTx.recentBlockhash = txBlockhash;
    rawTx.feePayer = provider.wallet.publicKey;
    rawTx.add(anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    rawTx.add(verifyIx);
    rawTx.add(ix);
    await provider.wallet.signTransaction(rawTx);
    rawTx.partialSign(sourceOwnerKeypair, rogueKeypair);

    try {
      await connection.sendRawTransaction(rawTx.serialize(), { preflightCommitment: "confirmed" });
      assert.fail("Expected TransferControlDenied error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, SendTransactionError, "should fail as SendTransactionError");
      const logs = (err as SendTransactionError).logs ?? [];
      const anchorErr = AnchorError.parse(logs);
      assert.isNotNull(anchorErr, "expected AnchorError in transaction logs");
      console.log("  caught error code:  ", anchorErr!.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr!.error.errorMessage);
      assert.equal(
        anchorErr!.error.errorCode.code,
        "TransferControlDenied",
        "error code should be TransferControlDenied"
      );
    }
  });
});
