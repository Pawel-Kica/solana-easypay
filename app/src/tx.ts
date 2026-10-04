import {
  isSolanaError,
  SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT,
  type Signature,
} from '@solana/kit';
import { getLandedTransaction, IS_LOCAL, type SigningClient } from './chain';
import type { Notify } from './Toasts';

type Sent = { context: { signature: Signature } };
type Labels = { success: string; failure: string };

// On Devnet the reasons say where to get more.
const NOT_ENOUGH_SOL = `not enough SOL for the fee and rent${IS_LOCAL ? '' : '. Get devnet SOL at faucet.solana.com'}`;
const NOT_ENOUGH_USDC = `not enough USDC in your wallet${IS_LOCAL ? '' : '. Get devnet USDC at faucet.circle.com'}`;

// Sends one transaction from `client` and reports it as a toast, on success and on failure.
// A transaction that failed on chain still has a signature, so its toast links to Explorer too.
// Returns true on success.
export async function sendWithToast(
  client: SigningClient,
  notify: Notify,
  labels: Labels,
  send: () => Promise<Sent>,
): Promise<boolean> {
  try {
    // With skipPreflight a payer without SOL still gets its transaction sent. It never lands and
    // the app would wait about a minute for the blockhash to expire, so check the payer first.
    const { value: lamports } = await client.rpc.getBalance(client.payer.address).send();
    if (lamports === 0n) {
      notify({ title: `${labels.failure}: ${NOT_ENOUGH_SOL}`, error: true });
      return false;
    }
    const { context } = await send();
    notify({ title: labels.success, signature: context.signature });
    return true;
  } catch (error) {
    const signature = signatureOf(error);
    const landed = signature ? await getLandedTransaction(signature).catch(() => null) : null;
    // Waiting for confirmation can fail while the transaction itself landed fine.
    if (landed && !landed.failed) {
      notify({ title: labels.success, signature });
      return true;
    }
    notify({ title: `${labels.failure}: ${readableError(error, landed?.logs ?? [])}`, signature, error: true });
    return false;
  }
}

// Signature of a transaction that was signed and sent but failed. Kit keeps it on the plan result.
function signatureOf(error: unknown): Signature | undefined {
  if (!isSolanaError(error, SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION)) return undefined;
  type WithSignature = { transactionPlanResult?: { context?: { signature?: Signature } } };
  return (error.context as WithSignature).transactionPlanResult?.context?.signature;
}

// Errors that mean the fee payer is short on SOL. Kit codes, so they survive minified production messages.
const NO_SOL = [
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND, // the payer never had any SOL
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_RENT,
] as const;

// One short reason for the toast, from the program logs and the error with its causes.
function readableError(error: unknown, logs: readonly string[]): string {
  const chain = causes(error);
  const text = [...logs, ...chain.map((e) => e.message)].join('\n');

  if (/reject/i.test(text)) return 'you rejected it in your wallet';
  // "insufficient lamports" is the System Program failing to take rent for a new account.
  if (chain.some((e) => NO_SOL.some((code) => isSolanaError(e, code))) || /insufficient lamports/i.test(text))
    return NOT_ENOUGH_SOL;
  // The Token Program's own message when the sender has less than the amount.
  if (/insufficient funds/i.test(text)) return NOT_ENOUGH_USDC;
  if (/already in use/i.test(text)) return 'it already exists';
  if (/failed to fetch/i.test(text))
    return IS_LOCAL ? 'the local chain is unreachable. Is pnpm dev running?' : 'devnet RPC did not answer, try again';
  // Errors from our program: Anchor logs them as "... Error Message: <text>."
  const anchor = text.match(/Error Message: (.+?)\.?$/m);
  if (anchor) return anchor[1];
  return logs.length ? 'the program rejected it, the logs are in Explorer' : (chain[0]?.message ?? String(error));
}

// The error and the errors it wraps. Kit puts the real reason a few levels deep.
function causes(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let e = error; e instanceof Error && chain.length < 5; e = e.cause) chain.push(e);
  return chain;
}
