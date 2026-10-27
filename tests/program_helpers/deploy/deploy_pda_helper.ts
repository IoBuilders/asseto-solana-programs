import { PublicKey } from "@solana/web3.js";
import { DEPLOY_PROGRAM_ID } from "../../utils/address_utils";
import { getDeployProgram } from "./deploy_instruction_helper";

// ── asset_configuration PDA ─────────────────────────────────────────────────────────────

export async function getAssetConfiguration(mint: PublicKey) {
  return await getDeployProgram().account.assetConfiguration.fetch(assetConfigurationPda(mint), "confirmed");
}

export function assetConfigurationPda(mint: PublicKey): PublicKey {
  return assetConfigurationPdaWithBump(mint)[0];
}

export function assetConfigurationPdaWithBump(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("asset_configuration"), mint.toBuffer()], DEPLOY_PROGRAM_ID);
}

// ── temp_mint_authority PDA ─────────────────────────────────────────────────────────────

export function tempMintAuthorityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("temp_mint_authority"), mint.toBuffer()], DEPLOY_PROGRAM_ID)[0];
}

// ── __event_authority PDA ─────────────────────────────────────────────────────────────

export function deployEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DEPLOY_PROGRAM_ID)[0];
}
