import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_DOCUMENT_MANAGER } from "./utils/roles";
import { DOCUMENT_REMOVE_DOCUMENT, DOCUMENT_SET_DOCUMENT } from "./utils/functionalities";
import {
  ASSET_CLASS_VERSION_STATE_DRAFT,
  setAssetClassVersionForMint,
} from "./program_helpers/factory/factory_pda_helper";
import { getAccountInfo, getBalanceForRentExeption } from "./program_helpers/account_helper";
import { setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setMintPaused } from "./program_helpers/spl_token_helper";
import { DOCUMENT_PROGRAM_ID } from "./utils/address_utils";
import {
  documentPda,
  getDocument,
  getDocumentNullable,
  nameToBytes,
} from "./program_helpers/document/document_pda_helper";
import {
  getDocumentRemovedEvent,
  getDocumentUpdatedEvent,
  removeDocument,
  setDocument,
} from "./program_helpers/document/document_instruction_helper";

describe("document", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const authority = provider.wallet.payer!;
  const payerKeypair = provider.wallet.payer!;
  let mint: PublicKey;

  // `deployMint` records config 0 / version 0 on the mint's asset_configuration,
  // so every test's set_document/remove_document derives the asset-class
  // version PDA at (0, 0). Seed it here — Ready and with both document
  // functionality bits enabled — so require_functionality passes by default;
  // individual tests that need a different state re-seed it themselves.
  beforeEach(async () => {
    ({ mint } = await deployMint());
    await setRoles(mint, authority.publicKey, [ROLE_DOCUMENT_MANAGER]);
    await setAssetClassVersionForMint(mint, {
      functionalities: [DOCUMENT_SET_DOCUMENT, DOCUMENT_REMOVE_DOCUMENT],
    });
  });

  describe("set_document", () => {
    it("set_document: creates the document at exactly Document::space(uri.length) on first call", async () => {
      const name = nameToBytes("prospectus");
      const uri = "https://example.com/prospectus.pdf";
      const documentHash = new Array(32).fill(7);

      const { signature } = await setDocument({ authority, mint }, { name, uri, documentHash });

      const pda = documentPda(mint, name);
      const info = await getAccountInfo(pda);
      assert.isNotNull(info, "document account should exist");
      const expectedSpace = 8 + 32 + 32 + 32 + 1 + 4 + Buffer.byteLength(uri, "utf-8");
      assert.equal(info!.data.length, expectedSpace, "account size should match Document::space(uri.len())");
      assert.equal(info!.owner.toBase58(), DOCUMENT_PROGRAM_ID.toBase58());
      assert.equal(
        info!.lamports,
        await getBalanceForRentExeption(expectedSpace),
        "account should hold exactly the rent-exempt minimum for its size"
      );

      const stored = await getDocument(mint, name);
      assert.equal(stored.mint.toBase58(), mint.toBase58());
      assert.deepEqual(Array.from(stored.name), name);
      assert.equal(stored.uri, uri);
      assert.deepEqual(Array.from(stored.documentHash), documentHash);

      const updatedEvent = await getDocumentUpdatedEvent(signature);
      assert.isNotNull(updatedEvent, "DocumentUpdated event should be emitted");
      assert.equal(updatedEvent!.mint.toBase58(), mint.toBase58(), "event mint should match deployed mint");
      assert.equal(
        updatedEvent!.operator.toBase58(),
        authority.publicKey.toBase58(),
        "event operator should match authority"
      );
      assert.equal(updatedEvent!.uri, uri, "event uri should match");
    });

    it("set_document: grows the account and debits the payer when the new uri is longer", async () => {
      const name = nameToBytes("prospectus");
      await setDocument({ authority, mint }, { name, uri: "short" });
      const pda = documentPda(mint, name);
      const before = await getAccountInfo(pda);

      const longerUri = "https://example.com/" + "a".repeat(200);
      await setDocument({ authority, mint }, { name, uri: longerUri });

      const after = await getAccountInfo(pda);
      const expectedSpace = 8 + 97 + 4 + Buffer.byteLength(longerUri, "utf-8");
      assert.equal(after!.data.length, expectedSpace, "account should have grown to fit the longer uri");
      assert.isTrue(after!.data.length > before!.data.length, "account should be larger than before");
      assert.equal(
        after!.lamports,
        await getBalanceForRentExeption(after!.data.length),
        "account should hold exactly the new rent-exempt minimum"
      );

      const stored = await getDocument(mint, name);
      assert.equal(stored.uri, longerUri);
    });

    it("set_document: shrinks the account and refunds the payer when the new uri is shorter", async () => {
      const name = nameToBytes("prospectus");
      const longerUri = "https://example.com/" + "a".repeat(200);
      await setDocument({ authority, mint }, { name, uri: longerUri });
      const pda = documentPda(mint, name);

      const payerBefore = await provider.connection.getBalance(payerKeypair.publicKey);
      const shorterUri = "short";
      await setDocument({ authority, mint }, { name, uri: shorterUri });
      const payerAfter = await provider.connection.getBalance(payerKeypair.publicKey);

      const after = await getAccountInfo(pda);
      const expectedSpace = 8 + 97 + 4 + Buffer.byteLength(shorterUri, "utf-8");
      assert.equal(after!.data.length, expectedSpace, "account should have shrunk to fit the shorter uri");
      assert.equal(
        after!.lamports,
        await getBalanceForRentExeption(after!.data.length),
        "account should hold exactly the new (lower) rent-exempt minimum"
      );
      // The refund must land back with the payer (net of the tx fee), not be
      // stranded in the document account — this is the D-6 assertion.
      assert.isTrue(
        payerAfter > payerBefore - 10_000,
        "payer should have been refunded the excess rent, not just paid the tx fee"
      );
    });

    it("set_document: does not move lamports or resize when the uri length is unchanged", async () => {
      const name = nameToBytes("prospectus");
      await setDocument({ authority, mint }, { name, uri: "https://a.example/x" });
      const pda = documentPda(mint, name);
      const before = await getAccountInfo(pda);

      await setDocument({ authority, mint }, { name, uri: "https://b.example/y" }); // same byte length

      const after = await getAccountInfo(pda);
      assert.equal(after!.data.length, before!.data.length, "account size should be unchanged");
      assert.equal(after!.lamports, before!.lamports, "account lamports should be unchanged");
    });

    it("set_document: succeeds via the transfer/allocate/assign path when the PDA address was pre-funded", async () => {
      const name = nameToBytes("griefed-doc");
      const pda = documentPda(mint, name);

      const griefTx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payerKeypair.publicKey,
          toPubkey: pda,
          lamports: anchor.web3.LAMPORTS_PER_SOL * 0.01,
        })
      );
      await anchor.web3.sendAndConfirmTransaction(provider.connection, griefTx, [payerKeypair], {
        commitment: "confirmed",
      });

      const preInfo = await getAccountInfo(pda);
      assert.isNotNull(preInfo, "griefed address should hold lamports already");
      assert.equal(
        preInfo!.owner.toBase58(),
        anchor.web3.SystemProgram.programId.toBase58(),
        "griefed address should still be System-owned before set_document"
      );

      const uri = "https://example.com/prospectus.pdf";
      await setDocument({ authority, mint }, { name, uri });

      const postInfo = await getAccountInfo(pda);
      assert.equal(
        postInfo!.owner.toBase58(),
        DOCUMENT_PROGRAM_ID.toBase58(),
        "document account should end up owned by the document program"
      );
      const stored = await getDocument(mint, name);
      assert.equal(stored.uri, uri, "document should be created despite the pre-funded address");
    });

    it("set_document: fails with EmptyUri when uri is empty", async () => {
      try {
        await setDocument({ authority, mint }, { uri: "" });
        assert.fail("Expected EmptyUri error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "EmptyUri", "error code should be EmptyUri");
      }
    });

    it("set_document: fails with MissingRole when authority doesn't have the required role", async () => {
      await setRoles(mint, authority.publicKey, []);
      try {
        await setDocument({ authority, mint });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    it("set_document: fails with FunctionalityNotSupportedError when the functionality bit is disabled", async () => {
      await setAssetClassVersionForMint(mint, { functionalities: [] });
      try {
        await setDocument({ authority, mint });
        assert.fail("Expected FunctionalityNotSupportedError error but instruction succeeded");
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

    it("set_document: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [DOCUMENT_SET_DOCUMENT, DOCUMENT_REMOVE_DOCUMENT],
      });
      try {
        await setDocument({ authority, mint });
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

    it("set_document: fails with MintPaused when the mint is paused", async () => {
      await setMintPaused(mint, true);
      try {
        await setDocument({ authority, mint });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    it("set_document: fails with Deactivated when the mint has been deactivated", async () => {
      await setDeactivateMarker(mint);
      try {
        await setDocument({ authority, mint });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });
  });

  describe("remove_document", () => {
    it("remove_document: closes the account, refunds the payer, and emits DocumentRemoved", async () => {
      const name = nameToBytes("prospectus");
      const uri = "https://example.com/prospectus.pdf";
      const documentHash = new Array(32).fill(9);
      await setDocument({ authority, mint }, { name, uri, documentHash });

      const pda = documentPda(mint, name);
      const payerBefore = await provider.connection.getBalance(payerKeypair.publicKey);
      const rentBefore = (await getAccountInfo(pda))!.lamports;

      const { signature } = await removeDocument({ authority, mint }, { name });

      const info = await getAccountInfo(pda);
      assert.isNull(info, "document account should be closed");

      const payerAfter = await provider.connection.getBalance(payerKeypair.publicKey);
      assert.isTrue(
        payerAfter > payerBefore + rentBefore - 10_000,
        "payer should have been refunded the account's rent"
      );

      const removedEvent = await getDocumentRemovedEvent(signature);
      assert.isNotNull(removedEvent, "DocumentRemoved event should be emitted");
      assert.equal(removedEvent!.mint.toBase58(), mint.toBase58(), "event mint should match deployed mint");
      assert.equal(
        removedEvent!.operator.toBase58(),
        authority.publicKey.toBase58(),
        "event operator should match authority"
      );
      assert.equal(removedEvent!.uri, uri, "event uri should carry the closed record's uri");
      assert.deepEqual(
        Array.from(removedEvent!.documentHash),
        documentHash,
        "event documentHash should carry the closed record's hash"
      );
    });

    it("remove_document: fails at account resolution when no document exists for (mint, name)", async () => {
      const name = nameToBytes("never-set");
      try {
        await removeDocument({ authority, mint }, { name });
        assert.fail("Expected an account-resolution error but instruction succeeded");
      } catch (err) {
        // Not `AnchorError`: `Account<Document>` fails to deserialize a
        // zero-length account before the handler body ever runs, so Anchor
        // raises `AccountNotInitialized` at account-resolution time.
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(
          anchorErr.error.errorCode.code,
          "AccountNotInitialized",
          "error code should be AccountNotInitialized"
        );
      }

      const stored = await getDocumentNullable(mint, name);
      assert.isNull(stored, "no document should have ever existed for this name");
    });

    it("remove_document: fails with MissingRole when authority doesn't have the required role", async () => {
      const name = nameToBytes("prospectus");
      await setDocument({ authority, mint }, { name });
      await setRoles(mint, authority.publicKey, []);
      try {
        await removeDocument({ authority, mint }, { name });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MissingRole", "error code should be MissingRole");
      }
    });

    it("remove_document: fails with FunctionalityNotSupportedError when the functionality bit is disabled", async () => {
      const name = nameToBytes("prospectus");
      await setDocument({ authority, mint }, { name });
      await setAssetClassVersionForMint(mint, { functionalities: [] });
      try {
        await removeDocument({ authority, mint }, { name });
        assert.fail("Expected FunctionalityNotSupportedError error but instruction succeeded");
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

    it("remove_document: fails with AssetClassVersionNotFinalized when the asset-class version is not finalized", async () => {
      const name = nameToBytes("prospectus");
      await setDocument({ authority, mint }, { name });
      await setAssetClassVersionForMint(mint, {
        state: ASSET_CLASS_VERSION_STATE_DRAFT,
        functionalities: [DOCUMENT_SET_DOCUMENT, DOCUMENT_REMOVE_DOCUMENT],
      });
      try {
        await removeDocument({ authority, mint }, { name });
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

    it("remove_document: fails with MintPaused when the mint is paused", async () => {
      const name = nameToBytes("prospectus");
      await setDocument({ authority, mint }, { name });
      await setMintPaused(mint, true);
      try {
        await removeDocument({ authority, mint }, { name });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "MintPaused", "error code should be MintPaused");
      }
    });

    it("remove_document: fails with Deactivated when the mint has been deactivated", async () => {
      const name = nameToBytes("prospectus");
      await setDocument({ authority, mint }, { name });
      await setDeactivateMarker(mint);
      try {
        await removeDocument({ authority, mint }, { name });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        const anchorErr = err as AnchorError;
        assert.equal(anchorErr.error.errorCode.code, "Deactivated", "error code should be Deactivated");
      }
    });
  });

  describe("cross-cutting", () => {
    it("multiple documents per mint: distinct names produce independent PDAs", async () => {
      const prospectusName = nameToBytes("prospectus");
      const kycName = nameToBytes("kyc-policy");

      await setDocument({ authority, mint }, { name: prospectusName, uri: "https://example.com/prospectus.pdf" });
      await setDocument({ authority, mint }, { name: kycName, uri: "https://example.com/kyc-policy.pdf" });

      const prospectus = await getDocument(mint, prospectusName);
      const kyc = await getDocument(mint, kycName);
      assert.equal(prospectus.uri, "https://example.com/prospectus.pdf");
      assert.equal(kyc.uri, "https://example.com/kyc-policy.pdf");

      await removeDocument({ authority, mint }, { name: kycName });

      const prospectusAfter = await getDocument(mint, prospectusName);
      assert.equal(
        prospectusAfter.uri,
        "https://example.com/prospectus.pdf",
        "removing kyc-policy should not affect prospectus"
      );
      const kycAfter = await getDocumentNullable(mint, kycName);
      assert.isNull(kycAfter, "kyc-policy should be gone after remove_document");
    });

    it("enumeration: getProgramAccounts + memcmp(offset=8, mint) finds every document for a mint", async () => {
      const otherMint = (await deployMint()).mint;
      await setRoles(otherMint, authority.publicKey, [ROLE_DOCUMENT_MANAGER]);
      await setAssetClassVersionForMint(otherMint, {
        functionalities: [DOCUMENT_SET_DOCUMENT, DOCUMENT_REMOVE_DOCUMENT],
      });

      const nameA = nameToBytes("doc-a");
      const nameB = nameToBytes("doc-b");
      const otherName = nameToBytes("doc-a"); // same name, different mint — must not collide

      await setDocument({ authority, mint }, { name: nameA, uri: "https://example.com/a.pdf" });
      await setDocument({ authority, mint }, { name: nameB, uri: "https://example.com/b.pdf" });
      await setDocument({ authority, mint: otherMint }, { name: otherName, uri: "https://example.com/other.pdf" });

      const accounts = await provider.connection.getProgramAccounts(DOCUMENT_PROGRAM_ID, {
        filters: [{ memcmp: { offset: 8, bytes: mint.toBase58() } }],
      });

      assert.equal(accounts.length, 2, "should find exactly the two documents belonging to `mint`");
      const pdas = accounts.map((a) => a.pubkey.toBase58()).sort();
      const expected = [documentPda(mint, nameA).toBase58(), documentPda(mint, nameB).toBase58()].sort();
      assert.deepEqual(pdas, expected, "enumerated PDAs should be exactly mint's two documents");
    });
  });
});
