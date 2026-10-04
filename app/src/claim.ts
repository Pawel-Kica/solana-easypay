import type { Address } from '@solana/kit';
import { IS_LOCAL, refreshPythPrices, type SigningClient } from './chain';
import { claimInstructions } from './core';
import type { Split } from './generated';

// The app's claim sender. The transaction itself is built in core.ts, the same one the auto-claim server sends.

// Dev knob for the stale price check: with this set in localStorage, Local skips the price refresh and the
// exchange falls back to USDC.
const SKIP_PRICE_REFRESH_KEY = 'easypay.skipPriceRefresh';

// Claims everything `owner` can claim from `contracts` in one transaction, paid out by `split`. On Local the Pyth
// price refresh goes first, so the swap sees a fresh price.
export async function sendClaim(
  client: SigningClient,
  owner: Address,
  split: Split | null,
  contracts: { pool: Address; slot: number }[],
) {
  const investing = (split?.investPct ?? 0) > 0;
  if (IS_LOCAL && investing && !localStorage.getItem(SKIP_PRICE_REFRESH_KEY)) await refreshPythPrices();
  return client.sendTransaction(await claimInstructions(client.identity, owner, split, contracts));
}
