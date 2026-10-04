import type { Address } from '@solana/kit';
import { useEffect, useState } from 'react';
import { explorerAddressUrl, getWalletBalances, UNREACHABLE_HINT, type WalletBalance } from './chain';
import { EmptyState } from './EmptyState';
import { Loading } from './ui';

const usd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// Balances view of the History tab: the USD total, then SOL, USDC, BTC and ETH with amount and USD value, zeros
// dimmed. Each row opens its account in Explorer. Read once when the view opens.
export function BalancesView({ owner }: { owner: Address }) {
  const [rows, setRows] = useState<WalletBalance[] | null>(); // undefined while loading, null if it failed

  useEffect(() => {
    let alive = true;
    getWalletBalances(owner).then(
      (list) => alive && setRows(list),
      () => alive && setRows(null),
    );
    return () => {
      alive = false;
    };
  }, [owner]);

  if (rows === undefined) return <Loading />;
  if (rows === null) return <EmptyState title="Could not read your balances" text={UNREACHABLE_HINT} />;

  const total = rows.reduce((sum, r) => sum + (r.usd ?? 0), 0);
  return (
    <>
      <div className="pt-4 pb-4 text-center">
        <p className="text-sm text-white/50">Total</p>
        <p data-testid="balances-total" className="mt-1 text-5xl font-semibold tabular-nums">
          {usd(total)}
        </p>
      </div>
      <ul data-testid="all-balances">
        {rows.map((r) => (
          <li key={r.name} className={r.amount === 0n ? 'opacity-40' : ''}>
            <a
              href={explorerAddressUrl(r.account)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-4 rounded-2xl px-3 py-3 transition-colors hover:bg-white/5"
            >
              <span className="font-medium">{r.name}</span>
              <span className="text-right tabular-nums">
                {(Number(r.amount) / 10 ** r.decimals).toLocaleString('en-US', { maximumSignificantDigits: 6 })}
                <span className="block text-sm text-white/55">{r.usd === null ? 'no price' : usd(r.usd)}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
