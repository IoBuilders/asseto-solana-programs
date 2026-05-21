import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Deploy } from "../target/types/deploy";
import { Freeze } from "../target/types/freeze";
import { Pause } from "../target/types/pause";
import { Deactivate } from "../target/types/deactivate";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAccount } from "@solana/spl-token";
import { assert } from "chai";
import * as pdas from "./utils/pda_utils";
import { SYSTEM_PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID } from "./utils/address_utils";

// ── Mint parameters ────────────────────────────────────────────────────────────
const MINT_DECIMALS = 6;
const MINT_NAME = "CMTAT Test Token";
const MINT_SYMBOL = "CMTAT";
const MINT_URI = "https://example.com/metadata.json";

describe("freeze", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const deployProgram = anchor.workspace.Deploy as Program<Deploy>;
  const freezeProgram = anchor.workspace.Freeze as Program<Freeze>;
  const pauseProgram = anchor.workspace.Pause as Program<Pause>;
  const deactivateProgram = anchor.workspace.Deactivate as Program<Deactivate>;

  const connection = provider.connection;
  const deployer = provider.wallet.publicKey;

  // ── Helper: deploy a fresh mint ─────────────────────────────────────────────
  async function deployMint(): Promise<{
    mint: PublicKey;
    mintOwnerPda: PublicKey;
  }> {
    const mintKeypair = Keypair.generate();
    const mint = mintKeypair.publicKey;

    const mintOwnerPda = pdas.mintOwnerPda(mint);
    const tempMintAuthority = pdas.tempMintAuthorityPda(mint);
    const mintAuthority = pdas.mintAuthorityPda(mint);
    const operationsAuthority = pdas.permanentDelegatePda(mint);
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
    return { mint, mintOwnerPda };
  }

  // ── Happy-path: freeze_account ───────────────────────────────────────────────
  it("freeze_account: creates the frozen_account PDA for a token account", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    // ── Create a token account to use as the freeze target ──────────────────
    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const [frozenAccountPda, expectedBump] = pdas.frozenAccountPdaWithBump(mint, tokenAccount);

    // ── Verify the PDA does not exist before the instruction ────────────────
    const statusBefore = await freezeProgram.account.frozenAccountStatus.fetchNullable(frozenAccountPda);

    // ── Call freeze_account ──────────────────────────────────────────────────
    const tx = await freezeProgram.methods
      .freezeAccount()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  freeze_account tx:", tx);

    // ── Verify the frozen_account PDA was created with the correct bump ──────
    const statusAfter = await freezeProgram.account.frozenAccountStatus.fetch(frozenAccountPda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:              ", mint.toBase58());
    console.log("  Token account:     ", tokenAccount.toBase58());
    console.log("  Frozen account PDA:", frozenAccountPda.toBase58());
    console.log("  PDA bump:          ", statusAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(statusBefore, "frozen_account PDA should not exist before freeze_account");
    assert.isNotNull(statusAfter, "frozen_account PDA should exist after freeze_account");
    assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");
  });

  // ── Happy-path: unfreeze_account ─────────────────────────────────────────────
  it("unfreeze_account: closes the frozen_account PDA for a token account", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    // ── Create a token account to use as the freeze target ──────────────────
    const payerKeypair = provider.wallet.payer as Keypair;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenAccountPda = pdas.frozenAccountPda(mint, tokenAccount);

    // ── First: freeze the account ────────────────────────────────────────────
    const freezeTx = await freezeProgram.methods
      .freezeAccount()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  freeze_account tx: ", freezeTx);

    const statusAfterFreeze = await freezeProgram.account.frozenAccountStatus.fetch(frozenAccountPda);
    assert.isNotNull(statusAfterFreeze, "frozen_account PDA should exist after freeze_account");

    // ── Then: unfreeze the account ───────────────────────────────────────────
    const unfreezeTx = await freezeProgram.methods
      .unfreezeAccount()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenAccountPda,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  unfreeze_account tx:", unfreezeTx);

    // ── Verify the frozen_account PDA has been closed ────────────────────────
    const statusAfterUnfreeze = await freezeProgram.account.frozenAccountStatus.fetchNullable(frozenAccountPda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:              ", mint.toBase58());
    console.log("  Token account:     ", tokenAccount.toBase58());
    console.log("  Frozen account PDA:", frozenAccountPda.toBase58());
    console.log("  PDA after unfreeze:", statusAfterUnfreeze);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(statusAfterUnfreeze, "frozen_account PDA should not exist after unfreeze_account");
  });

  // ── Error case: freeze_account — UnauthorizedDeployer ───────────────────────
  it("freeze_account: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenAccountPda = pdas.frozenAccountPda(mint, tokenAccount);

    const rogueKeypair = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(rogueKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "confirmed");

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await freezeProgram.methods
        .freezeAccount()
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenAccountPda,
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

  // ── Error case: freeze_account — MintPaused ─────────────────────────────────
  it("freeze_account: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const pausableAuthority = pdas.pausableAuthorityPda(mint);
    const deactivatePda = pdas.deactivatePda(mint);
    const frozenAccountPda = pdas.frozenAccountPda(mint, tokenAccount);

    // ── Pause the mint ────────────────────────────────────────────────────────
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

    try {
      await freezeProgram.methods
        .freezeAccount()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenAccountPda,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
    }
  });

  // ── Error case: freeze_account — Deactivated ────────────────────────────────
  it("freeze_account: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenAccountPda = pdas.frozenAccountPda(mint, tokenAccount);

    // ── Deactivate the mint ───────────────────────────────────────────────────
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

    try {
      await freezeProgram.methods
        .freezeAccount()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenAccountPda,
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

  // ── Error case: unfreeze_account — UnauthorizedDeployer ─────────────────────
  it("unfreeze_account: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenAccountPda = pdas.frozenAccountPda(mint, tokenAccount);

    // ── Freeze the account first ──────────────────────────────────────────────
    await freezeProgram.methods
      .freezeAccount()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    const rogueKeypair = Keypair.generate();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await freezeProgram.methods
        .unfreezeAccount()
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenAccountPda,
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

  // ── Error case: unfreeze_account — MintPaused ───────────────────────────────
  it("unfreeze_account: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const pausableAuthority = pdas.pausableAuthorityPda(mint);
    const deactivatePda = pdas.deactivatePda(mint);
    const frozenAccountPda = pdas.frozenAccountPda(mint, tokenAccount);

    // ── Freeze the account first ──────────────────────────────────────────────
    await freezeProgram.methods
      .freezeAccount()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // ── Pause the mint ────────────────────────────────────────────────────────
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

    try {
      await freezeProgram.methods
        .unfreezeAccount()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenAccountPda,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
    }
  });

  // ── Error case: unfreeze_account — Deactivated ──────────────────────────────
  it("unfreeze_account: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenAccountPda = pdas.frozenAccountPda(mint, tokenAccount);

    // ── Freeze the account first ──────────────────────────────────────────────
    await freezeProgram.methods
      .freezeAccount()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenAccountPda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // ── Deactivate the mint ───────────────────────────────────────────────────
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

    try {
      await freezeProgram.methods
        .unfreezeAccount()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenAccountPda,
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

  // ── Happy-path: partially_freeze_account ────────────────────────────────────
  it("partially_freeze_account: creates the frozen_balance PDA with the given balance", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const [frozenBalancePda, expectedBump] = pdas.frozenBalancePdaWithBump(mint, tokenAccount);

    const FROZEN_BALANCE = new anchor.BN(500_000_000);

    // ── Verify the PDA does not exist before the instruction ─────────────────
    const statusBefore = await freezeProgram.account.frozenBalance.fetchNullable(frozenBalancePda);

    // ── Call partially_freeze_account ─────────────────────────────────────────
    const tx = await freezeProgram.methods
      .partiallyFreezeAccount(FROZEN_BALANCE)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  partially_freeze_account tx:", tx);

    // ── Verify the frozen_balance PDA was created with the correct fields ─────
    const statusAfter = await freezeProgram.account.frozenBalance.fetch(frozenBalancePda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                 ", mint.toBase58());
    console.log("  Token account:        ", tokenAccount.toBase58());
    console.log("  Frozen balance PDA:   ", frozenBalancePda.toBase58());
    console.log("  PDA balance:          ", statusAfter.balance.toString());
    console.log("  PDA bump:             ", statusAfter.bump);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(statusBefore, "frozen_balance PDA should not exist before partially_freeze_account");
    assert.isNotNull(statusAfter, "frozen_balance PDA should exist after partially_freeze_account");
    assert.equal(
      statusAfter.balance.toString(),
      FROZEN_BALANCE.toString(),
      "balance should match the value passed to partially_freeze_account"
    );
    assert.equal(statusAfter.bump, expectedBump, "bump should match the canonical bump");
  });

  // ── Error case: partially_freeze_account — UnauthorizedDeployer ─────────────
  it("partially_freeze_account: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenBalancePda = pdas.frozenBalancePda(mint, tokenAccount);

    const rogueKeypair = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(rogueKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "confirmed");

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await freezeProgram.methods
        .partiallyFreezeAccount(new anchor.BN(500_000_000))
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenBalancePda,
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

  // ── Error case: partially_freeze_account — MintPaused ───────────────────────
  it("partially_freeze_account: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const pausableAuthority = pdas.pausableAuthorityPda(mint);
    const deactivatePda = pdas.deactivatePda(mint);
    const frozenBalancePda = pdas.frozenBalancePda(mint, tokenAccount);

    // ── Pause the mint ────────────────────────────────────────────────────────
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

    try {
      await freezeProgram.methods
        .partiallyFreezeAccount(new anchor.BN(500_000_000))
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenBalancePda,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
    }
  });

  // ── Happy-path: remove_partial_freeze ───────────────────────────────────────
  it("remove_partial_freeze: closes the frozen_balance PDA for a token account", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenBalancePda = pdas.frozenBalancePda(mint, tokenAccount);

    const FROZEN_BALANCE = new anchor.BN(500_000_000);

    // ── First: partially freeze the account ──────────────────────────────────
    const partialFreezeTx = await freezeProgram.methods
      .partiallyFreezeAccount(FROZEN_BALANCE)
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  partially_freeze_account tx:", partialFreezeTx);

    const statusAfterFreeze = await freezeProgram.account.frozenBalance.fetch(frozenBalancePda);
    assert.isNotNull(statusAfterFreeze, "frozen_balance PDA should exist after partially_freeze_account");

    // ── Then: remove the partial freeze ──────────────────────────────────────
    const removeFreezeTx = await freezeProgram.methods
      .removePartialFreeze()
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    console.log("  remove_partial_freeze tx:   ", removeFreezeTx);

    // ── Verify the frozen_balance PDA has been closed ────────────────────────
    const statusAfterRemove = await freezeProgram.account.frozenBalance.fetchNullable(frozenBalancePda);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:                 ", mint.toBase58());
    console.log("  Token account:        ", tokenAccount.toBase58());
    console.log("  Frozen balance PDA:   ", frozenBalancePda.toBase58());
    console.log("  PDA after remove:     ", statusAfterRemove);
    console.log("══════════════════════════════════════════════════════════\n");

    assert.isNull(statusAfterRemove, "frozen_balance PDA should not exist after remove_partial_freeze");
  });

  // ── Error case: remove_partial_freeze — UnauthorizedDeployer ────────────────
  it("remove_partial_freeze: fails with UnauthorizedDeployer when signer is not the deployer", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenBalancePda = pdas.frozenBalancePda(mint, tokenAccount);

    // ── Partially freeze the account so frozen_balance_pda exists ────────────
    await freezeProgram.methods
      .partiallyFreezeAccount(new anchor.BN(500_000_000))
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    const rogueKeypair = Keypair.generate();
    const airdropSig = await connection.requestAirdrop(rogueKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "confirmed");

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  Mint:               ", mint.toBase58());
    console.log("  Real deployer:      ", deployer.toBase58());
    console.log("  Rogue signer:       ", rogueKeypair.publicKey.toBase58());
    console.log("══════════════════════════════════════════════════════════\n");

    try {
      await freezeProgram.methods
        .removePartialFreeze()
        .accountsStrict({
          deployer: rogueKeypair.publicKey,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenBalancePda,
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

  // ── Error case: remove_partial_freeze — MintPaused ──────────────────────────
  it("remove_partial_freeze: fails with MintPaused when mint is paused", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const pausableAuthority = pdas.pausableAuthorityPda(mint);
    const deactivatePda = pdas.deactivatePda(mint);
    const frozenBalancePda = pdas.frozenBalancePda(mint, tokenAccount);

    // ── Partially freeze the account so frozen_balance_pda exists ────────────
    await freezeProgram.methods
      .partiallyFreezeAccount(new anchor.BN(500_000_000))
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // ── Pause the mint ────────────────────────────────────────────────────────
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

    try {
      await freezeProgram.methods
        .removePartialFreeze()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenBalancePda,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc({ commitment: "confirmed" });

      assert.fail("Expected MintPaused error but instruction succeeded");
    } catch (err) {
      assert.instanceOf(err, AnchorError, "error should be an AnchorError");
      const anchorErr = err as AnchorError;
      console.log("  caught error code:  ", anchorErr.error.errorCode.code);
      console.log("  caught error msg:   ", anchorErr.error.errorMessage);
      assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
    }
  });

  // ── Error case: partially_freeze_account — Deactivated ──────────────────────
  it("partially_freeze_account: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenBalancePda = pdas.frozenBalancePda(mint, tokenAccount);

    // ── Deactivate the mint ───────────────────────────────────────────────────
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

    try {
      await freezeProgram.methods
        .partiallyFreezeAccount(new anchor.BN(500_000_000))
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenBalancePda,
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

  // ── Error case: remove_partial_freeze — Deactivated ─────────────────────────
  it("remove_partial_freeze: fails with Deactivated when mint has been deactivated", async () => {
    const { mint, mintOwnerPda } = await deployMint();

    const payerKeypair = provider.wallet.payer!;
    const accountKeypair = Keypair.generate();
    const tokenAccount = await createAccount(
      connection,
      payerKeypair,
      mint,
      deployer,
      accountKeypair,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    const deactivatePda = pdas.deactivatePda(mint);
    const frozenBalancePda = pdas.frozenBalancePda(mint, tokenAccount);

    // ── Partially freeze the account so frozen_balance_pda exists ────────────
    await freezeProgram.methods
      .partiallyFreezeAccount(new anchor.BN(500_000_000))
      .accountsStrict({
        deployer,
        mintOwnerPda,
        mint,
        account: tokenAccount,
        deactivatePda,
        frozenBalancePda,
        systemProgram: SYSTEM_PROGRAM_ID,
      })
      .rpc({ commitment: "confirmed" });

    // ── Deactivate the mint ───────────────────────────────────────────────────
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

    try {
      await freezeProgram.methods
        .removePartialFreeze()
        .accountsStrict({
          deployer,
          mintOwnerPda,
          mint,
          account: tokenAccount,
          deactivatePda,
          frozenBalancePda,
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
});
