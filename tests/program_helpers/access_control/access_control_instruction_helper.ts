import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccessControl } from "../../../target/types/access_control";
import { SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import * as pdaUtils from "../../utils/pda_utils";
import { BaseWriteContext, MintContext } from "../base_helper";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { assetClassVersionPdaForMint } from "../factory/factory_pda_helper";
import { rolesPda } from "./access_control_pda_helper";

export function getAccessControlProgram(): Program<AccessControl> {
  return anchor.workspace.AccessControl as Program<AccessControl>;
}

// ── grantRoles ───────────────────────────────────────────────────────────────

export type GrantRolesContext = BaseWriteContext &
  MintContext & {
    account: PublicKey;
    // The caller — must hold ROLE_ADMIN. Defaults to the provider wallet.
    authority?: Keypair;
    payer?: PublicKey;
  };

type GrantRolesArgs = {
  roles: number[];
};

export async function grantRoles(callContext: GrantRolesContext, args: GrantRolesArgs): Promise<{ signature: string }> {
  const program = getAccessControlProgram();
  const authority = callContext.authority ?? program.provider.wallet.payer;
  const payer = callContext.payer ?? program.provider.publicKey!;
  const { mint, account } = callContext;

  const signature = await program.methods
    .grantRoles(args.roles)
    .accountsStrict({
      payer,
      authority: authority.publicKey,
      mintOwnerPda: pdaUtils.mintOwnerPda(mint),
      authorityRolesPda: rolesPda(mint, authority.publicKey),
      account,
      deactivatePda: deactivatePda(mint),
      mint,
      rolesPda: rolesPda(mint, account),
      systemProgram: SYSTEM_PROGRAM_ID,
      assetClassVersionPda: await assetClassVersionPdaForMint(mint),
    })
    .signers(callContext.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

// ── revokeRoles ──────────────────────────────────────────────────────────────

export type RevokeRolesContext = BaseWriteContext &
  MintContext & {
    account: PublicKey;
    // The caller — must hold ROLE_ADMIN. Defaults to the provider wallet.
    authority?: Keypair;
  };

type RevokeRolesArgs = {
  roles: number[];
};

export async function revokeRoles(
  callContext: RevokeRolesContext,
  args: RevokeRolesArgs
): Promise<{ signature: string }> {
  const program = getAccessControlProgram();
  const authority = callContext.authority ?? program.provider.wallet.payer;
  const { mint, account } = callContext;

  const signature = await program.methods
    .revokeRoles(args.roles)
    .accountsStrict({
      authority: authority.publicKey,
      mintOwnerPda: pdaUtils.mintOwnerPda(mint),
      authorityRolesPda: rolesPda(mint, authority.publicKey),
      account,
      deactivatePda: deactivatePda(mint),
      mint,
      rolesPda: rolesPda(mint, account),
      assetClassVersionPda: await assetClassVersionPdaForMint(mint),
    })
    .signers(callContext.signers ?? [authority])
    .rpc({ commitment: "confirmed" });

  return { signature };
}
