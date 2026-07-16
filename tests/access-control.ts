import * as anchor from "@anchor-lang/core";
import { AnchorError } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { deployMint } from "./program_helpers/deploy_helper";
import { grantRoles, revokeRoles } from "./program_helpers/access_control/access_control_instruction_helper";
import {
  getRoles,
  isRoleGranted,
  ROLE_ADMIN,
  rolesPdaWithBump,
  setRoles,
} from "./program_helpers/access_control/access_control_pda_helper";
import { clearDeactivateMarker, setDeactivateMarker } from "./program_helpers/deactivate/deactivate_pda_helper";
import { setAssetClassVersionForMint } from "./program_helpers/factory/factory_pda_helper";
import { setMintPaused } from "./program_helpers/spl_token_helper";
import { ACCESS_CONTROL_GRANT_ROLES, ACCESS_CONTROL_REVOKE_ROLES } from "./utils/functionalities";

describe("access-control", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const deployer = provider.wallet.publicKey;

  // A role id that is past the mask capacity (valid ids are 0..=8191).
  const OUT_OF_BOUNDS_ROLE = 8192;

  // The mint is deployed once and shared. Each test gets a fresh `account` (the
  // grantee/target), so its `[mint, account]` roles PDA is unique and never
  // collides. `beforeEach` re-plants the mint-scoped baseline every test — mint
  // unpaused + active, the asset-class version finalized with both role
  // functionalities, and the deployer holding ROLE_ADMIN — so tests are fully
  // independent regardless of what the previous one changed. Individual tests
  // then override exactly one of those to drive an error.
  let mint: PublicKey;
  let account: PublicKey;

  before(async () => {
    ({ mint } = await deployMint({ deployer }));
  });

  beforeEach(async () => {
    account = Keypair.generate().publicKey;
    await setMintPaused(mint, false);
    await clearDeactivateMarker(mint);
    await setAssetClassVersionForMint(mint, {
      functionalities: [ACCESS_CONTROL_GRANT_ROLES, ACCESS_CONTROL_REVOKE_ROLES],
    });
    await setRoles(mint, deployer, [ROLE_ADMIN]);
  });

  describe("grant_roles", () => {
    // ──────────────────────────────────────────────────────────────────────
    it("creates the roles PDA and sets the requested role bits", async () => {
      const roles = [10, 200, 1000];

      await grantRoles({ mint, account }, { roles });

      const [, expectedBump] = rolesPdaWithBump(mint, account);
      const rolesAccount = await getRoles(mint, account);

      assert.equal(rolesAccount.bump, expectedBump, "stored bump should be the canonical PDA bump");
      for (const r of roles) {
        assert.isTrue(isRoleGranted(rolesAccount.mask, r), `role ${r} should be granted`);
      }
      assert.isFalse(isRoleGranted(rolesAccount.mask, 11), "an ungranted role should stay unset");
    });

    // ──────────────────────────────────────────────────────────────────────
    it("updates an existing roles PDA, merging new bits without clearing old ones", async () => {
      // Plant a pre-existing roles PDA so only grant_roles is exercised here.
      await setRoles(mint, account, [1, 3]);

      await grantRoles({ mint, account }, { roles: [5, 7] });

      const rolesAccount = await getRoles(mint, account);
      for (const r of [1, 3, 5, 7]) {
        assert.isTrue(isRoleGranted(rolesAccount.mask, r), `role ${r} should be granted after the merge`);
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("grant_roles: fails with AccountOwnedByWrongProgram when the authority does not even have a roles PDA", async () => {
      const rogue = Keypair.generate(); // no roles PDA planted → not an admin

      try {
        await grantRoles({ mint, account, authority: rogue }, { roles: [1] });
        assert.fail("Expected AccountOwnedByWrongProgram error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "AccountOwnedByWrongProgram");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("grant_roles: fails with MissingRole when the authority has a roles PDA without the admin role", async () => {
      const rogue = Keypair.generate();
      await setRoles(mint, rogue.publicKey, [5]); // holds some role, but NOT ROLE_ADMIN (bit 0)

      try {
        await grantRoles({ mint, account, authority: rogue }, { roles: [1] });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "MissingRole");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("grant_roles: fails with FunctionalityNotSupportedError when GRANT_ROLES is not enabled", async () => {
      // Re-seed the asset-class version WITHOUT the grant functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await grantRoles({ mint, account }, { roles: [1] });
        assert.fail("Expected FunctionalityNotSupportedError but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "FunctionalityNotSupportedError");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("grant_roles: fails with MintPaused when the mint is paused", async () => {
      await setMintPaused(mint, true);

      try {
        await grantRoles({ mint, account }, { roles: [1] });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "MintPaused");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("grant_roles: fails with Deactivated when the mint has been deactivated", async () => {
      await setDeactivateMarker(mint);

      try {
        await grantRoles({ mint, account }, { roles: [1] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("grant_roles: fails with RoleOutOfBounds when a role id exceeds the mask capacity", async () => {
      try {
        await grantRoles({ mint, account }, { roles: [OUT_OF_BOUNDS_ROLE] });
        assert.fail("Expected RoleOutOfBounds error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "RoleOutOfBounds");
      }
    });
  });

  describe("revoke_roles", () => {
    // ──────────────────────────────────────────────────────────────────────
    it("clears the requested role bits, leaving the others untouched", async () => {
      // Plant a pre-existing roles PDA so only revoke_roles is exercised here.
      await setRoles(mint, account, [2, 4, 6]);

      await revokeRoles({ mint, account }, { roles: [4] });

      const rolesAccount = await getRoles(mint, account);
      assert.isFalse(isRoleGranted(rolesAccount.mask, 4), "revoked role 4 should be cleared");
      assert.isTrue(isRoleGranted(rolesAccount.mask, 2), "role 2 should remain granted");
      assert.isTrue(isRoleGranted(rolesAccount.mask, 6), "role 6 should remain granted");
    });

    // ──────────────────────────────────────────────────────────────────────
    it("revoke_roles: fails when the roles PDA does not exist", async () => {
      // No roles PDA planted: the address resolves to a non-existent account,
      // which is still owned by the System Program, so the AccountLoader
      // constraint rejects it before the handler runs.
      try {
        await revokeRoles({ mint, account }, { roles: [1] });
        assert.fail("Expected the instruction to fail but it succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "AccountOwnedByWrongProgram");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("revoke_roles: fails with AccountOwnedByWrongProgram when the authority does not even have a roles PDA", async () => {
      await setRoles(mint, account, [1]); // target PDA must exist to reach the handler
      const rogue = Keypair.generate(); // no roles PDA planted → not an admin

      try {
        await revokeRoles({ mint, account, authority: rogue }, { roles: [1] });
        assert.fail("Expected AccountOwnedByWrongProgram error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "AccountOwnedByWrongProgram");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("revoke_roles: fails with MissingRole when the authority has a roles PDA without the admin role", async () => {
      await setRoles(mint, account, [1]); // target PDA must exist to reach the handler
      const rogue = Keypair.generate();
      await setRoles(mint, rogue.publicKey, [5]); // holds some role, but NOT ROLE_ADMIN (bit 0)

      try {
        await revokeRoles({ mint, account, authority: rogue }, { roles: [1] });
        assert.fail("Expected MissingRole error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "MissingRole");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("revoke_roles: fails with FunctionalityNotSupportedError when REVOKE_ROLES is not enabled", async () => {
      await setRoles(mint, account, [1]);
      // Re-seed the asset-class version WITHOUT the revoke functionality.
      await setAssetClassVersionForMint(mint, { functionalities: [] });

      try {
        await revokeRoles({ mint, account }, { roles: [1] });
        assert.fail("Expected FunctionalityNotSupportedError but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "FunctionalityNotSupportedError");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("revoke_roles: fails with MintPaused when the mint is paused", async () => {
      await setRoles(mint, account, [1]);
      await setMintPaused(mint, true);

      try {
        await revokeRoles({ mint, account }, { roles: [1] });
        assert.fail("Expected MintPaused error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "MintPaused");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("revoke_roles: fails with Deactivated when the mint has been deactivated", async () => {
      await setRoles(mint, account, [1]);
      await setDeactivateMarker(mint);

      try {
        await revokeRoles({ mint, account }, { roles: [1] });
        assert.fail("Expected Deactivated error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "Deactivated");
      }
    });

    // ──────────────────────────────────────────────────────────────────────
    it("revoke_roles: fails with RoleOutOfBounds when a role id exceeds the mask capacity", async () => {
      await setRoles(mint, account, [1]);

      try {
        await revokeRoles({ mint, account }, { roles: [OUT_OF_BOUNDS_ROLE] });
        assert.fail("Expected RoleOutOfBounds error but instruction succeeded");
      } catch (err) {
        assert.instanceOf(err, AnchorError, "error should be an AnchorError");
        assert.equal((err as AnchorError).error.errorCode.code, "RoleOutOfBounds");
      }
    });
  });
});
