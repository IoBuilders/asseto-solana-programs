import * as anchor from "@anchor-lang/core";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy/deploy_instruction_helper";
import { getExtraAccountMetaEntries } from "./program_helpers/transfer_hook/transfer_hook_pda_helper";
import { FREEZE_PROGRAM_ID, HOLD_PROGRAM_ID } from "./utils/address_utils";

// spl-tlv-account-resolution encodings: a literal pubkey entry has discriminator 0;
// an external PDA entry has discriminator `128 + <index of its program account>`,
// and packs its seeds as `[1, len, ...bytes]` (literal) / `[3, index]` (account key).
const LITERAL_PUBKEY = 0;
const EXTERNAL_PDA_BASE = 128;
const SEED_LITERAL = 1;
const SEED_ACCOUNT_KEY = 3;

// The SPL interface fixes indices 0–4; metalist entry `i` is hook account `5 + i`.
const FIRST_EXTRA_INDEX = 5;

function literalSeed(bytes: string): number[] {
  return [SEED_LITERAL, bytes.length, ...Buffer.from(bytes)];
}

describe("transfer-hook", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  let mint: PublicKey;

  beforeEach(async () => {
    ({ mint } = await deployMint());
  });

  describe("initialize_extra_account_meta_list", () => {
    it("initialize_extra_account_meta_list: declares 14 extra accounts (one freed by the unified freeze_state PDA)", async () => {
      const entries = await getExtraAccountMetaEntries(mint);
      assert.equal(entries.length, 14, "metalist should hold exactly 14 extra entries");
      assert.isTrue(
        entries.every((entry) => !entry.isSigner && !entry.isWritable),
        "every metalist entry should be read-only and non-signer"
      );
    });

    it("initialize_extra_account_meta_list: resolves a single freeze_state PDA of the source via the freeze program", async () => {
      const entries = await getExtraAccountMetaEntries(mint);

      const freezeProgram = entries[15 - FIRST_EXTRA_INDEX];
      assert.equal(freezeProgram.discriminator, LITERAL_PUBKEY, "index 15 should be a literal pubkey");
      assert.equal(
        new PublicKey(freezeProgram.addressConfig).toBase58(),
        FREEZE_PROGRAM_ID.toBase58(),
        "index 15 should be the freeze program"
      );

      const freezeState = entries[16 - FIRST_EXTRA_INDEX];
      assert.equal(
        freezeState.discriminator,
        EXTERNAL_PDA_BASE + 15,
        "index 16 should be a PDA of the account at index 15"
      );
      const expectedSeeds = [...literalSeed("freeze_state"), SEED_ACCOUNT_KEY, 1, SEED_ACCOUNT_KEY, 0];
      assert.deepEqual(
        Array.from(freezeState.addressConfig.slice(0, expectedSeeds.length)),
        expectedSeeds,
        'index 16 should be seeded by ["freeze_state", mint@1, source_token@0]'
      );
      assert.isTrue(
        freezeState.addressConfig.slice(expectedSeeds.length).every((byte) => byte === 0),
        "no further seeds should follow"
      );

      const legacySeeds = ["frozen_account", "frozen_balance"].map((seed) => Buffer.from(literalSeed(seed)));
      for (const entry of entries) {
        const config = Buffer.from(entry.addressConfig);
        for (const legacy of legacySeeds) {
          assert.equal(config.indexOf(legacy), -1, "no entry should still use a legacy freeze seed");
        }
      }
    });

    it("initialize_extra_account_meta_list: keeps the hold_position entry pointing at the hold program after the shift", async () => {
      const entries = await getExtraAccountMetaEntries(mint);

      const holdProgram = entries[17 - FIRST_EXTRA_INDEX];
      assert.equal(holdProgram.discriminator, LITERAL_PUBKEY, "index 17 should be a literal pubkey");
      assert.equal(
        new PublicKey(holdProgram.addressConfig).toBase58(),
        HOLD_PROGRAM_ID.toBase58(),
        "index 17 should be the hold program"
      );

      const holdPosition = entries[18 - FIRST_EXTRA_INDEX];
      assert.equal(
        holdPosition.discriminator,
        EXTERNAL_PDA_BASE + 17,
        "index 18 should be a PDA of the hold program at index 17"
      );
      const expectedSeeds = [...literalSeed("hold_position"), SEED_ACCOUNT_KEY, 1, SEED_ACCOUNT_KEY, 0];
      assert.deepEqual(
        Array.from(holdPosition.addressConfig.slice(0, expectedSeeds.length)),
        expectedSeeds,
        'index 18 should be seeded by ["hold_position", mint@1, source_token@0]'
      );
    });
  });
});
