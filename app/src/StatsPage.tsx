import { useEffect, useState } from 'react';
import { AdminSections } from './AdminSections';
import { IS_LOCAL, NETWORK, UNREACHABLE_HINT } from './chain';
import { plural, Tile } from './CompaniesTab';
import { EmptyState } from './EmptyState';
import { formatDay, formatUsdc } from './format';
import { getStats, MAX_TRANSACTIONS, paidByDay, type Stats } from './stats';
import { Toasts, useToasts } from './Toasts';
import { Loading, TEXT_BUTTON } from './ui';
import { ConnectPrompt, DisconnectWallet, useWallet } from './Wallet';

// Wallets that may open /admin on Devnet, comma separated in app/.env.production. The panel only reads public
// chain data, so this hides it and does not secure anything. Local opens it for everyone.
const ADMIN_WALLETS = (import.meta.env.VITE_ADMIN_WALLETS ?? '')
  .split(',')
  .map((a: string) => a.trim())
  .filter(Boolean);

// /stats for everyone and /admin for us: app-wide numbers from the chain, read once on open and on Refresh.
export function StatsPage({ admin }: { admin: boolean }) {
  const [toasts, notify] = useToasts();
  const wallet = useWallet();
  const me = wallet?.connected?.signer?.address;
  const allowed = !admin || IS_LOCAL || (me !== undefined && ADMIN_WALLETS.includes(me));
  const [stats, setStats] = useState<Stats | null | 'failed'>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    setStats(null);
    getStats().then(
      (s) => alive && setStats(s),
      () => alive && setStats('failed'),
    );
    return () => {
      alive = false;
    };
  }, [allowed, tick]);

  return (
    <div className="min-h-screen bg-[#131313] pb-28 text-white">
      <header className="app-header flex min-h-[4.5rem] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-4">
          <a href="/" aria-label="Easy Pay home" className="shrink-0 rounded-sm">
            <img src="/brand/easy-pay-horizontal.svg" alt="Easy Pay" width="176" height="44" />
          </a>
          <span className="text-sm text-white/50">{NETWORK}</span>
        </div>
        <nav className="flex items-center gap-1">
          <a href="/stats" className={TEXT_BUTTON}>Stats</a>
          <a href="/app" className={TEXT_BUTTON}>App</a>
          {admin && !IS_LOCAL && me && <DisconnectWallet />}
        </nav>
      </header>

      <main className={`mx-auto mt-16 w-full px-4 ${admin ? 'max-w-[56rem]' : 'max-w-[39rem]'}`}>
        <div className="mb-2 flex items-center justify-between px-1">
          <h1 className="text-lg font-semibold">{admin ? 'Admin panel' : 'Easy Pay in numbers'}</h1>
          {allowed && (
            <button onClick={() => setTick((t) => t + 1)} disabled={stats === null} className={TEXT_BUTTON}>
              Refresh
            </button>
          )}
        </div>
        <section className="rounded-3xl border border-white/10 p-4">
          {!allowed && !me && <ConnectPrompt notify={notify} />}
          {!allowed && me && (
            <EmptyState title="Not an admin wallet" text="This wallet is not on the admin list. The public numbers are on Stats." />
          )}
          {allowed && stats === null && <Loading />}
          {allowed && stats === 'failed' && (
            <p className="px-1 text-sm text-white/50">Could not read the stats. {UNREACHABLE_HINT}</p>
          )}
          {allowed && stats && stats !== 'failed' && (
            <>
              <Overview stats={stats} />
              {admin && <AdminSections stats={stats} />}
            </>
          )}
        </section>
      </main>
      <Toasts toasts={toasts} />
    </div>
  );
}

// The public part: six totals and USDC claimed per day over the last 30 days.
function Overview({ stats }: { stats: Stats }) {
  const { totals } = stats;
  const days = paidByDay(stats.activity, stats.now);
  const max = days.reduce((m, d) => (d.amount > m ? d.amount : m), 0n);
  const month = days.reduce((s, d) => s + d.amount, 0n);

  return (
    <>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile label="companies">{totals.companies}</Tile>
        <Tile label="active contracts">{totals.activeContracts}</Tile>
        <Tile label="contractors working">{totals.contractors}</Tile>
        <Tile label="paid to contractors" className="text-[#40B66B]">
          {formatUsdc(totals.paidTotal)}
        </Tile>
        <Tile label="reserved for contractors">{formatUsdc(totals.lockedTotal)}</Tile>
        <Tile label="in all pools">{formatUsdc(totals.inPools)}</Tile>
      </dl>

      <div className="mt-4 rounded-2xl border border-white/10 p-4">
        <p className="text-sm text-white/50">Claimed in the last 30 days</p>
        <p className="text-lg font-semibold tabular-nums">{formatUsdc(month)}</p>
        <div className="mt-3 flex h-32 items-end gap-1" role="img" aria-label="USDC claimed per day, last 30 days">
          {days.map((d) => (
            <div
              key={d.day}
              title={`${formatDay(d.day)}: ${formatUsdc(d.amount)}`}
              className="flex-1 rounded-t bg-[#9945FF]/70 hover:bg-[#9945FF]"
              style={{ height: `${max ? Math.max(2, Number((d.amount * 100n) / max)) : 2}%` }}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs text-white/40">
          <span>{formatDay(days[0].day)}</span>
          <span>{formatDay(days[days.length - 1].day)}</span>
        </div>
        <p className="mt-2 text-xs text-white/40">
          From the newest {plural(MAX_TRANSACTIONS, 'transaction')} of the program.
        </p>
      </div>
    </>
  );
}
