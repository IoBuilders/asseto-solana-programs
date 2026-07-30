import * as anchor from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deployMint } from "./program_helpers/deploy_helper";
import { setRoles } from "./program_helpers/access_control/access_control_pda_helper";
import { ROLE_ADMIN, ROLE_ISSUER } from "./utils/roles";
import { setAssetClassVersionForMint } from "./program_helpers/factory/factory_pda_helper";
import { MINT_MINT, TRANSFER_HOOK_EXECUTE } from "./utils/functionalities";
import { createTokenAccount, getTokenAccount } from "./program_helpers/spl_token_helper";
import { mintTokens } from "./program_helpers/mint/mint_instruction_helper";
import { Address, address, createClient, createKeyPairSignerFromBytes, KeyPairSigner } from "@solana/kit";
import { solanaLocalRpc } from "@solana/kit-plugin-rpc";
import { signer } from "@solana/kit-plugin-signer";
import { findSubscriptionAuthorityPda, findFixedDelegationPda, subscriptionsProgram } from "@solana/subscriptions";
import { requestAirdrop } from "./program_helpers/account_helper";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  setTransferControlModeMarker,
  setWhitelistMarker,
} from "./program_helpers/transfer_control/transfer_control_pda_helper";
import { TRANSFER_CONTROL_WHITELIST } from "./program_helpers/transfer_control/transfer_control_instruction_helper";
import { assert } from "chai";

const MINT_DECIMALS = 2;
const MINT_AMOUNT = new anchor.BN(1_000 * 10 ** MINT_DECIMALS);

const TOKEN_2022_ADDRESS = address(TOKEN_2022_PROGRAM_ID.toString());

// Both delegations reuse nonce 0: the delegatee is part of the fixed-delegation
// PDA seeds, so one nonce per delegatee still yields two distinct PDAs.
const DELEGATION_NONCE = 0;
const DELEGATION_AMOUNT = BigInt(MINT_AMOUNT.toString());
const DELEGATION_EXPIRY_TS = BigInt(Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30);

describe("allowance", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // The account holding ROLE_ADMIN + ROLE_ISSUER; signs the mint below.
  const authority = Keypair.generate();
  // The account the tokens are minted to (owner of `holderTokenAccount`).
  const holder = Keypair.generate();
  const delegatee1 = Keypair.generate();
  const delegatee2 = Keypair.generate();
  const destination = Keypair.generate();

  let mint: PublicKey;
  let holderTokenAccount: PublicKey;
  let destinationTokenAccount: PublicKey;
  let holderSigner: KeyPairSigner;
  let delegatee1Signer: KeyPairSigner;
  let delegatee2Signer: KeyPairSigner;

  let client: ReturnType<typeof buildSubscriptionsClient>;
  let tokenMint: Address;
  let holderAta: Address;
  let destinationAta: Address;
  let delegation1Pda: Address;
  let delegation2Pda: Address;

  function buildSubscriptionsClient(payer: KeyPairSigner) {
    return createClient()
      .use(signer(payer))
      .use(solanaLocalRpc({ rpcUrl: provider.connection.rpcEndpoint }))
      .use(subscriptionsProgram());
  }

  /** Grants `delegatee` a fixed delegation over the holder's balance and returns its delegation PDA. */
  async function grantFixedDelegation(delegatee: Address): Promise<Address> {
    await client.subscriptions.instructions
      .createFixedDelegation({
        tokenMint,
        delegatee,
        nonce: DELEGATION_NONCE,
        amount: DELEGATION_AMOUNT,
        expiryTs: DELEGATION_EXPIRY_TS,
      })
      .sendTransaction();

    const [subscriptionAuthority] = await findSubscriptionAuthorityPda({
      user: holderSigner.address,
      tokenMint,
    });

    const [delegationPda] = await findFixedDelegationPda({
      subscriptionAuthority,
      delegator: holderSigner.address,
      delegatee,
      nonce: DELEGATION_NONCE,
    });

    return delegationPda;
  }

  beforeEach(async () => {
    await requestAirdrop(holder.publicKey);
    await requestAirdrop(delegatee1.publicKey);
    await requestAirdrop(delegatee2.publicKey);

    ({ mint } = await deployMint({}, { decimals: MINT_DECIMALS }));
    await setAssetClassVersionForMint(mint, { functionalities: [MINT_MINT, TRANSFER_HOOK_EXECUTE] });
    await setRoles(mint, authority.publicKey, [ROLE_ISSUER]);

    holderTokenAccount = await createTokenAccount({ mint, owner: holder.publicKey, createATA: true });
    await mintTokens({ mint, destination: holderTokenAccount, authority }, { amount: MINT_AMOUNT });

    destinationTokenAccount = await createTokenAccount({ mint, owner: destination.publicKey, createATA: true });

    holderSigner = await createKeyPairSignerFromBytes(holder.secretKey);
    delegatee1Signer = await createKeyPairSignerFromBytes(delegatee1.secretKey);
    delegatee2Signer = await createKeyPairSignerFromBytes(delegatee2.secretKey);

    tokenMint = address(mint.toString());
    holderAta = address(holderTokenAccount.toString());
    destinationAta = address(destinationTokenAccount.toString());

    client = buildSubscriptionsClient(holderSigner);

    await client.subscriptions.instructions
      .initSubscriptionAuthority({
        tokenMint,
        tokenProgram: TOKEN_2022_ADDRESS,
        userAta: holderAta,
      })
      .sendTransaction();

    delegation1Pda = await grantFixedDelegation(address(delegatee1.publicKey.toString()));
    delegation2Pda = await grantFixedDelegation(address(delegatee2.publicKey.toString()));
  });

  it("subscription: delegate transfer success", async () => {
    const TRANSFER_AMOUNT = 1;

    const balanceHolderBefore = (await getTokenAccount(holderTokenAccount)).amount;
    const balanceDestinationBefore = (await getTokenAccount(destinationTokenAccount)).amount;

    await client.subscriptions.instructions
      .transferFixed({
        delegatee: delegatee1Signer,
        delegator: holderSigner.address,
        delegatorAta: holderAta,
        tokenMint,
        delegationPda: delegation1Pda,
        amount: TRANSFER_AMOUNT,
        receiverAta: destinationAta,
        tokenProgram: TOKEN_2022_ADDRESS,
      })
      .sendTransaction();

    const balanceHolderAfter = (await getTokenAccount(holderTokenAccount)).amount;
    const balanceDestinationAfter = (await getTokenAccount(destinationTokenAccount)).amount;

    assert.equal(
      balanceHolderAfter.toString(),
      (parseInt(balanceHolderBefore.toString()) - TRANSFER_AMOUNT).toString(),
      "holder balance should be reduced by the transfer amount"
    );

    assert.equal(
      balanceDestinationAfter.toString(),
      (parseInt(balanceDestinationBefore.toString()) + TRANSFER_AMOUNT).toString(),
      "destination balance should be increased by the transfer amount"
    );
  });

  it("subscription: delegate transfer success when whitelist mode is active and both accounts are whitelisted", async () => {
    const TRANSFER_AMOUNT = 1;

    // The hook resolves the whitelist markers at metalist indices 13/14 from the
    // transfer's own accounts, so they are keyed by *token account*, not by owner.
    await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);
    await setWhitelistMarker(mint, holderTokenAccount);
    await setWhitelistMarker(mint, destinationTokenAccount);

    const balanceHolderBefore = (await getTokenAccount(holderTokenAccount)).amount;
    const balanceDestinationBefore = (await getTokenAccount(destinationTokenAccount)).amount;

    await client.subscriptions.instructions
      .transferFixed({
        delegatee: delegatee1Signer,
        delegator: holderSigner.address,
        delegatorAta: holderAta,
        tokenMint,
        delegationPda: delegation1Pda,
        amount: TRANSFER_AMOUNT,
        receiverAta: destinationAta,
        tokenProgram: TOKEN_2022_ADDRESS,
      })
      .sendTransaction();

    const balanceHolderAfter = (await getTokenAccount(holderTokenAccount)).amount;
    const balanceDestinationAfter = (await getTokenAccount(destinationTokenAccount)).amount;

    assert.equal(
      balanceHolderAfter.toString(),
      (parseInt(balanceHolderBefore.toString()) - TRANSFER_AMOUNT).toString(),
      "holder balance should be reduced by the transfer amount"
    );
    assert.equal(
      balanceDestinationAfter.toString(),
      (parseInt(balanceDestinationBefore.toString()) + TRANSFER_AMOUNT).toString(),
      "destination balance should be increased by the transfer amount"
    );
  });

  it("subscription: delegate transfer fails with NotWhitelisted when the destination is not whitelisted", async () => {
    const TRANSFER_AMOUNT = 1;

    await setTransferControlModeMarker(mint, TRANSFER_CONTROL_WHITELIST);
    await setWhitelistMarker(mint, holderTokenAccount);

    try {
      await client.subscriptions.instructions
        .transferFixed({
          delegatee: delegatee1Signer,
          delegator: holderSigner.address,
          delegatorAta: holderAta,
          tokenMint,
          delegationPda: delegation1Pda,
          amount: TRANSFER_AMOUNT,
          receiverAta: destinationAta,
          tokenProgram: TOKEN_2022_ADDRESS,
        })
        .sendTransaction();
      assert.fail("Expected NotWhitelisted error but the transfer succeeded");
    } catch (err) {
      // Kit's `sendTransaction` raises a `SolanaError` carrying the preflight
      // simulation result — it does not parse Anchor logs into an `AnchorError`,
      // so the error code is asserted against the logs the hook emitted.
      const logs: string[] = (err as { context?: { logs?: string[] } }).context?.logs ?? [];
      assert.isTrue(
        logs.some((l) => l.includes("NotWhitelisted")),
        `expected a NotWhitelisted rejection, got:\n${logs.length ? logs.join("\n") : String(err)}`
      );
    }
  });

  it("subscription: delegate transfer fails when the delagate acocunt is NotWhitelisted", async () => {
    assert(false);
  });
});
