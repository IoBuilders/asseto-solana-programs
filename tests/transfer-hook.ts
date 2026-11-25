import * as anchor from "@anchor-lang/core";
import { AnchorError, Program } from "@anchor-lang/core";
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy/deploy_instruction_helper";
import { deactivatePda } from "./program_helpers/deactivate/deactivate_pda_helper";
import { transferControlModePda } from "./program_helpers/transfer_control/transfer_control_pda_helper";
import {
  extraAccountMetaListPda,
  getExtraAccountMetaEntries,
  getMintCompliance,
  mintCompliancePda,
  mintCompliancePdaWithBump,
} from "./program_helpers/transfer_hook/transfer_hook_pda_helper";
import { setAssetClassVersion } from "./program_helpers/factory/factory_pda_helper";
import { TRANSFER_HOOK_EXECUTE } from "./utils/functionalities";
import {
  DEACTIVATE_PROGRAM_ID,
  DEPLOY_PROGRAM_ID,
  FACTORY_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  HOLD_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TRANSFER_CONTROL_PROGRAM_ID,
} from "./utils/address_utils";
import { TransferHook } from "../target/types/transfer_hook";

// spl-tlv-account-resolution encodings: a literal pubkey entry has discriminator 0;
// an external PDA entry has discriminator `128 + <index of its program account>`,
// and packs its seeds as `[1, len, ...bytes]` (literal) or `[3, index]` (account key).
const LITERAL_PUBKEY = 0;
const EXTERNAL_PDA_BASE = 128;
const SEED_LITERAL = 1;
const SEED_ACCOUNT_KEY = 3;

// The SPL interface fixes indices 0–4; metalist entry `i` is hook account `5 + i`.
const FIRST_EXTRA_INDEX = 5;

// Version ids private to this suite so deploying against them can't collide with others.
const COMPLIANCE_ASSET_CLASS_CONFIG_ID = new anchor.BN(7_100);
const VERSION_WITHOUT_EXECUTE = new anchor.BN(1);
const VERSION_WITH_EXECUTE = new anchor.BN(2);

type Entry = Awaited<ReturnType<typeof getExtraAccountMetaEntries>>[number];

function literalSeed(bytes: string): number[] {
  return [SEED_LITERAL, bytes.length, ...Buffer.from(bytes)];
}

function entryAt(entries: Entry[], hookIndex: number): Entry {
  return entries[hookIndex - FIRST_EXTRA_INDEX];
}

function assertLiteral(entries: Entry[], hookIndex: number, expected: PublicKey, name: string) {
  const entry = entryAt(entries, hookIndex);
  assert.equal(entry.discriminator, LITERAL_PUBKEY, `index ${hookIndex} should be a literal pubkey`);
  assert.equal(
    new PublicKey(entry.addressConfig).toBase58(),
    expected.toBase58(),
    `index ${hookIndex} should be ${name}`
  );
}

function assertExternalPda(entries: Entry[], hookIndex: number, programIndex: number, seeds: number[], name: string) {
  const entry = entryAt(entries, hookIndex);
  assert.equal(
    entry.discriminator,
    EXTERNAL_PDA_BASE + programIndex,
    `index ${hookIndex} should be a PDA of the program at index ${programIndex}`
  );
  assert.deepEqual(
    Array.from(entry.addressConfig.slice(0, seeds.length)),
    seeds,
    `index ${hookIndex} should be seeded as ${name}`
  );
  assert.isTrue(
    entry.addressConfig.slice(seeds.length).every((byte) => byte === 0),
    `index ${hookIndex}: no further seeds should follow`
  );
}

describe("transfer-hook", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint());
  });

  describe("initialize_extra_account_meta_list", () => {
    it("initialize_extra_account_meta_list: declares 10 read-only extra accounts", async () => {
      const entries = await getExtraAccountMetaEntries(mint);
      assert.equal(entries.length, 10, "metalist should hold exactly 10 extra entries");
      assert.isTrue(
        entries.every((entry) => !entry.isSigner && !entry.isWritable),
        "every metalist entry should be read-only and non-signer"
      );
    });

    it("initialize_extra_account_meta_list: stores the mint-only PDAs as literal addresses of this mint", async () => {
      const entries = await getExtraAccountMetaEntries(mint);

      assertLiteral(entries, 5, mintCompliancePda(mint), "this mint's mint_compliance_pda");
      assertLiteral(entries, 6, deactivatePda(mint), "this mint's deactivate_pda");
      assertLiteral(entries, 8, transferControlModePda(mint), "this mint's transfer_control_mode_pda");
    });

    it("initialize_extra_account_meta_list: no longer lists the deploy, factory and deactivate programs", async () => {
      const entries = await getExtraAccountMetaEntries(mint);
      const literals = entries
        .filter((entry) => entry.discriminator === LITERAL_PUBKEY)
        .map((entry) => new PublicKey(entry.addressConfig).toBase58());

      assert.notInclude(literals, DEPLOY_PROGRAM_ID.toBase58(), "deploy program should not be in the metalist");
      assert.notInclude(literals, FACTORY_PROGRAM_ID.toBase58(), "factory program should not be in the metalist");
      assert.notInclude(literals, DEACTIVATE_PROGRAM_ID.toBase58(), "deactivate program should not be in the metalist");
    });

    it("initialize_extra_account_meta_list: resolves the per-token-account PDAs through their programs", async () => {
      const entries = await getExtraAccountMetaEntries(mint);

      assertLiteral(entries, 7, TRANSFER_CONTROL_PROGRAM_ID, "the transfer-control program");
      assertExternalPda(
        entries,
        9,
        7,
        [...literalSeed("control_list"), SEED_ACCOUNT_KEY, 1, SEED_ACCOUNT_KEY, 0],
        '["control_list", mint@1, source_token@0]'
      );
      assertExternalPda(
        entries,
        10,
        7,
        [...literalSeed("control_list"), SEED_ACCOUNT_KEY, 1, SEED_ACCOUNT_KEY, 2],
        '["control_list", mint@1, destination_token@2]'
      );

      assertLiteral(entries, 11, FREEZE_PROGRAM_ID, "the freeze program");
      assertExternalPda(
        entries,
        12,
        11,
        [...literalSeed("freeze_state"), SEED_ACCOUNT_KEY, 1, SEED_ACCOUNT_KEY, 0],
        '["freeze_state", mint@1, source_token@0]'
      );

      assertLiteral(entries, 13, HOLD_PROGRAM_ID, "the hold program");
      assertExternalPda(
        entries,
        14,
        13,
        [...literalSeed("hold_position"), SEED_ACCOUNT_KEY, 1, SEED_ACCOUNT_KEY, 0],
        '["hold_position", mint@1, source_token@0]'
      );
    });

    it("initialize_extra_account_meta_list: bakes each mint's own addresses into its metalist", async () => {
      const { mint: otherMint } = await deployMint();
      const [entries, otherEntries] = await Promise.all([
        getExtraAccountMetaEntries(mint),
        getExtraAccountMetaEntries(otherMint),
      ]);

      for (const hookIndex of [5, 6, 8]) {
        assert.notEqual(
          new PublicKey(entryAt(entries, hookIndex).addressConfig).toBase58(),
          new PublicKey(entryAt(otherEntries, hookIndex).addressConfig).toBase58(),
          `index ${hookIndex} should differ between two mints`
        );
      }
      assertLiteral(otherEntries, 5, mintCompliancePda(otherMint), "the other mint's mint_compliance_pda");
    });
  });

  describe("initialize_extra_account_meta_list: MintCompliance", () => {
    async function deployAgainstVersion(versionId: anchor.BN, functionalities: number[]): Promise<PublicKey> {
      await setAssetClassVersion(COMPLIANCE_ASSET_CLASS_CONFIG_ID, versionId, { functionalities });
      const { mint: deployed } = await deployMint(
        {},
        { assetClassConfigId: COMPLIANCE_ASSET_CLASS_CONFIG_ID, assetClassVersionId: versionId }
      );
      return deployed;
    }

    it("initialize_extra_account_meta_list: creates the mint's MintCompliance record", async () => {
      const [, expectedBump] = mintCompliancePdaWithBump(mint);
      const record = await getMintCompliance(mint);

      assert.isNotNull(record, "mint_compliance PDA should exist after deploy_mint");
      assert.equal(record!.mint.toBase58(), mint.toBase58(), "record should store its mint");
      assert.equal(record!.version, 1, "record should carry layout version 1");
      assert.equal(record!.bump, expectedBump, "record should store its canonical bump");
      assert.equal(record!.deactivated, 0, "a fresh mint is not deactivated");
      assert.equal(record!.transferMode, 0, "a fresh mint has no transfer-control mode");
    });

    it("initialize_extra_account_meta_list: copies TRANSFER_HOOK_EXECUTE when the version enables it", async () => {
      const deployed = await deployAgainstVersion(VERSION_WITH_EXECUTE, [TRANSFER_HOOK_EXECUTE]);

      assert.equal((await getMintCompliance(deployed))!.transferHookExecuteEnabled, 1);
    });

    it("initialize_extra_account_meta_list: leaves TRANSFER_HOOK_EXECUTE off when the version does not enable it", async () => {
      const deployed = await deployAgainstVersion(VERSION_WITHOUT_EXECUTE, []);

      assert.equal((await getMintCompliance(deployed))!.transferHookExecuteEnabled, 0);
    });

    it("initialize_extra_account_meta_list: fails with ConstraintSeeds when not signed by deploy's asset_configuration PDA", async () => {
      const program = anchor.workspace.TransferHook as Program<TransferHook>;
      const fakeMint = Keypair.generate().publicKey;
      const impostor = Keypair.generate();

      try {
        await program.methods
          .initializeExtraAccountMetaList(true)
          .accountsStrict({
            payer: provider.wallet.publicKey,
            assetConfigurationPda: impostor.publicKey,
            extraAccountMetaList: extraAccountMetaListPda(fakeMint),
            mintCompliancePda: mintCompliancePda(fakeMint),
            mint: fakeMint,
            systemProgram: SYSTEM_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          })
          .signers([impostor])
          .rpc({ commitment: "confirmed" });
        assert.fail("Expected ConstraintSeeds error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "ConstraintSeeds");
      }
    });
  });
});
