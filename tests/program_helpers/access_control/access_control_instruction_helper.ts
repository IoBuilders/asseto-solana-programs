import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { AccessControl } from "../../../target/types/access_control";
import { SYSTEM_PROGRAM_ID } from "../../utils/address_utils";
import * as pdaUtils from "../../utils/pda_utils";
import { BaseWriteContext, MintContext, MintWriteWithPayerContext } from "../base_helper";
import { deactivatePda } from "../deactivate/deactivate_pda_helper";
import { assetClassVersionPdaForMint } from "../factory/factory_pda_helper";
import { rolesPda } from "./access_control_pda_helper";

export function getAccessControlProgram(): Program<AccessControl> {
  return anchor.workspace.AccessControl as Program<AccessControl>;
}

// ── initialize ───────────────────────────────────────────────────────────────

export type InitializeContext = BaseWriteContext &
  MintContext & {
    // The account receiving ROLE_ADMIN — must sign (it is a `Signer` on-chain).
    account: Keypair;
    // The caller — on-chain it must be the deploy `temp_mint_authority` PDA, so
    // a direct invocation with any keypair here is rejected with `Unauthorized`.
    tempMintAuthority: Keypair;
    payer?: PublicKey;
  };

export async function initialize(callContext: InitializeContext): Promise<{ signature: string }> {
  const program = getAccessControlProgram();
  const payer = callContext.payer ?? program.provider.publicKey!;
  const { mint, account, tempMintAuthority } = callContext;

  const signature = await program.methods
    .initialize()
    .accountsStrict({
      payer,
      tempMintAuthority: tempMintAuthority.publicKey,
      account: account.publicKey,
      mint,
      rolesPda: rolesPda(mint, account.publicKey),
      systemProgram: SYSTEM_PROGRAM_ID,
    })
    .signers(callContext.signers ?? [tempMintAuthority, account])
    .rpc({ commitment: "confirmed" });

  return { signature };
}

// ── grantRoles ───────────────────────────────────────────────────────────────

export type GrantRolesContext = MintWriteWithPayerContext & {
  account: PublicKey;
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

export type RevokeRolesContext = MintWriteWithPayerContext & {
  account: PublicKey;
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
