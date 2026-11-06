import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy/deploy_instruction_helper";
import { assetConfigurationPda } from "./program_helpers/deploy/deploy_pda_helper";
import { deactivatePda } from "./program_helpers/deactivate/deactivate_pda_helper";
import { transferControlModePda } from "./program_helpers/transfer_control/transfer_control_pda_helper";
import { getExtraAccountMetaEntries } from "./program_helpers/transfer_hook/transfer_hook_pda_helper";
import {
  DEACTIVATE_PROGRAM_ID,
  DEPLOY_PROGRAM_ID,
  FACTORY_PROGRAM_ID,
  FREEZE_PROGRAM_ID,
  HOLD_PROGRAM_ID,
  TRANSFER_CONTROL_PROGRAM_ID,
} from "./utils/address_utils";

// spl-tlv-account-resolution encodings: a literal pubkey entry has discriminator 0;
// an external PDA entry has discriminator `128 + <index of its program account>`,
// and packs its seeds as `[1, len, ...bytes]` (literal), `[4, index, offset, len]`
// (account data) or `[3, index]` (account key).
const LITERAL_PUBKEY = 0;
const EXTERNAL_PDA_BASE = 128;
const SEED_LITERAL = 1;
const SEED_ACCOUNT_DATA = 4;
const SEED_ACCOUNT_KEY = 3;

// The SPL interface fixes indices 0–4; metalist entry `i` is hook account `5 + i`.
const FIRST_EXTRA_INDEX = 5;

// AssetConfiguration layout: 8-byte discriminator, then config id and version id (u64 each).
const ASSET_CLASS_CONFIG_ID_OFFSET = 8;
const ASSET_CLASS_VERSION_ID_OFFSET = 16;

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
    it("initialize_extra_account_meta_list: declares 12 read-only extra accounts", async () => {
      const entries = await getExtraAccountMetaEntries(mint);
      assert.equal(entries.length, 12, "metalist should hold exactly 12 extra entries");
      assert.isTrue(
        entries.every((entry) => !entry.isSigner && !entry.isWritable),
        "every metalist entry should be read-only and non-signer"
      );
    });

    it("initialize_extra_account_meta_list: stores the mint-only PDAs as literal addresses of this mint", async () => {
      const entries = await getExtraAccountMetaEntries(mint);

      assertLiteral(entries, 5, assetConfigurationPda(mint), "this mint's asset_configuration_pda");
      assertLiteral(entries, 8, deactivatePda(mint), "this mint's deactivate_pda");
      assertLiteral(entries, 10, transferControlModePda(mint), "this mint's transfer_control_mode_pda");
    });

    it("initialize_extra_account_meta_list: no longer lists the deploy and deactivate programs", async () => {
      const entries = await getExtraAccountMetaEntries(mint);
      const literals = entries
        .filter((entry) => entry.discriminator === LITERAL_PUBKEY)
        .map((entry) => new PublicKey(entry.addressConfig).toBase58());

      assert.notInclude(literals, DEPLOY_PROGRAM_ID.toBase58(), "deploy program should not be in the metalist");
      assert.notInclude(literals, DEACTIVATE_PROGRAM_ID.toBase58(), "deactivate program should not be in the metalist");
    });

    it("initialize_extra_account_meta_list: resolves asset_class_version from the literal asset_configuration", async () => {
      const entries = await getExtraAccountMetaEntries(mint);

      assertLiteral(entries, 6, FACTORY_PROGRAM_ID, "the factory program");
      assertExternalPda(
        entries,
        7,
        6,
        [
          ...literalSeed("asset_class_version"),
          SEED_ACCOUNT_DATA,
          5,
          ASSET_CLASS_CONFIG_ID_OFFSET,
          8,
          SEED_ACCOUNT_DATA,
          5,
          ASSET_CLASS_VERSION_ID_OFFSET,
          8,
        ],
        '["asset_class_version", @5.config_id, @5.version_id]'
      );
    });

    it("initialize_extra_account_meta_list: resolves the per-token-account PDAs through their programs", async () => {
      const entries = await getExtraAccountMetaEntries(mint);

      assertLiteral(entries, 9, TRANSFER_CONTROL_PROGRAM_ID, "the transfer-control program");
      assertExternalPda(
        entries,
        11,
        9,
        [...literalSeed("control_list"), SEED_ACCOUNT_KEY, 1, SEED_ACCOUNT_KEY, 0],
        '["control_list", mint@1, source_token@0]'
      );
      assertExternalPda(
        entries,
        12,
        9,
        [...literalSeed("control_list"), SEED_ACCOUNT_KEY, 1, SEED_ACCOUNT_KEY, 2],
        '["control_list", mint@1, destination_token@2]'
      );

      assertLiteral(entries, 13, FREEZE_PROGRAM_ID, "the freeze program");
      assertExternalPda(
        entries,
        14,
        13,
        [...literalSeed("freeze_state"), SEED_ACCOUNT_KEY, 1, SEED_ACCOUNT_KEY, 0],
        '["freeze_state", mint@1, source_token@0]'
      );

      assertLiteral(entries, 15, HOLD_PROGRAM_ID, "the hold program");
      assertExternalPda(
        entries,
        16,
        15,
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

      for (const hookIndex of [5, 8, 10]) {
        assert.notEqual(
          new PublicKey(entryAt(entries, hookIndex).addressConfig).toBase58(),
          new PublicKey(entryAt(otherEntries, hookIndex).addressConfig).toBase58(),
          `index ${hookIndex} should differ between two mints`
        );
      }
      assertLiteral(otherEntries, 5, assetConfigurationPda(otherMint), "the other mint's asset_configuration_pda");
    });
  });
});
