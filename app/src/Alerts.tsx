import type { Address } from '@solana/kit';
import { useEffect, useState } from 'react';
import { getContracts, type Contract, type PoolState } from './chain';
import { formatAsset, formatUsdc } from './format';
import { Asset } from './generated';
import { covers, ended, type Funding } from './pay';

// Runway under this many whole days turns the banner amber. Fixed, no setting.
const WARN_DAYS = 7;

// amber: act soon. red: already broken.
export type Tone = 'amber' | 'red';

// One banner above the card. App builds the list, a new kind of alert is one more entry in it.
export type Alert = {
  key: string;
  tone: Tone;
  title: string;
  text: string;
  action?: { label: string; onClick: () => void };
};

const BANNER: Record<Tone, string> = { amber: 'bg-amber-500/10 text-amber-200', red: 'bg-red-500/10 text-red-200' };
const DOT: Record<Tone, string> = { amber: 'bg-amber-400', red: 'bg-red-400' };

// The banners between the tabs and the card, on every tab, so nobody has to open the right tab to see them.
export function Alerts({ alerts }: { alerts: Alert[] }) {
  return alerts.map(({ key, tone, title, text, action }) => (
    <div
      key={key}
      role="alert"
      className={`animate-fade-in mb-2 flex items-center gap-3 rounded-2xl px-4 py-3 text-sm ${BANNER[tone]}`}
    >
      <div className="flex-1">
        <p className="font-semibold">{title}</p>
        <p className="mt-0.5 opacity-80">{text}</p>
      </div>
      {action && (
        <button
          onClick={action.onClick}
          className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-white/20"
        >
          {action.label}
        </button>
      )}
    </div>
  ));
}

// Small dot after a tab name, in the colour of its banner.
export const Dot = ({ tone }: { tone?: Tone }) =>
  tone ? <span aria-hidden className={`ml-1.5 inline-block h-2 w-2 rounded-full align-middle ${DOT[tone]}`} /> : null;

// Red if any of them is red, amber if any is amber.
const worst = (tones: Tone[]): Tone | undefined =>
  tones.includes('red') ? 'red' : tones.includes('amber') ? 'amber' : undefined;

// Red once the pool can't fund another full period (a day, or an hour in an hourly pool), amber under WARN_DAYS.
// undefined when it is fine or has no running contracts.
function runwayOf(funding: Funding, chainTime: number) {
  const runway = covers(funding, chainTime);
  if (!runway || runway.days >= WARN_DAYS) return undefined;
  return { ...runway, tone: (runway.periods === 0n ? 'red' : 'amber') as Tone };
}

// Under this much SOL the account may not cover the next fee. Fixed, no setting.
const MIN_LAMPORTS = 10_000_000n; // 0.01 SOL

// Amber "You have 0 SOL for fees" for the active account, or undefined while it has enough. getSol is the button.
export function solAlert(lamports: bigint | undefined, getSol: () => void): Alert | undefined {
  if (lamports === undefined || lamports >= MIN_LAMPORTS) return undefined;
  return {
    key: 'sol',
    tone: 'amber',
    title: `You have ${formatAsset(lamports, Asset.Sol)} for fees`,
    text: 'Every claim or deposit costs a tiny fee in SOL.',
    action: { label: 'Get SOL', onClick: getSol },
  };
}

// "Acme Labs'" or "Initech's".
const possessive = (name: string) => `${name}'${name.endsWith('s') ? '' : 's'}`;

const daysText = (days: number) => `Pool covers ${days} more day${days === 1 ? '' : 's'}`;

type Props = {
  owner?: Address;
  pool: PoolState | null | undefined; // the account's own pool, polled by App
  chainTime?: number;
  version: number; // changes after a transaction or time travel, re-reads the worker's contracts
  onDeposit: () => void; // the company's Deposit button
};

// Runway alerts for the active account: one for its own pool as the company (with Deposit), and one per pool where
// it has a running contract as the worker. poolTone and claimTone colour the dots on the Pool and Claim tabs.
// Poll too, so an employer's deposit updates the worker's banner without a reload.
export function useRunwayAlerts({ owner, pool, chainTime, version, onDeposit }: Props) {
  const [read, setRead] = useState<{ owner: Address; contracts: Contract[] }>();

  useEffect(() => {
    if (!owner) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const { contracts } = await getContracts(owner);
        if (alive) setRead({ owner, contracts: contracts.filter((c) => c.employee === owner) });
      } catch {
        // Keep the last list through a temporary RPC failure.
      } finally {
        if (alive) timer = setTimeout(refresh, 3000);
      }
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [owner, version]);

  const alerts: Alert[] = [];
  if (chainTime === undefined) return { alerts, poolTone: undefined, claimTone: undefined };

  const own = pool && runwayOf(pool, chainTime);
  if (own)
    alerts.push({
      key: 'runway-own',
      tone: own.tone,
      title: own.tone === 'red' ? 'Your pool is empty' : daysText(own.days),
      text:
        own.tone === 'red'
          ? 'Workers stopped earning. Deposit USDC to restart pay.'
          : `At ${formatUsdc(own.perDay)} per day for ${own.running} contract${own.running === 1 ? '' : 's'}. ` +
            'Deposit to keep paying.',
      action: { label: 'Deposit', onClick: onDeposit },
    });

  // One banner per pool the worker has a running contract in. Its own pool already has the company banner.
  const running = read && read.owner === owner ? read.contracts.filter((c) => !ended(c, chainTime)) : [];
  const pools = new Map(running.filter((c) => c.pool !== pool?.address).map((c) => [c.pool, c]));
  const workerTones: Tone[] = [];
  for (const { pool: address, funding, companyName } of pools.values()) {
    const runway = runwayOf(funding, chainTime);
    if (!runway) continue;
    workerTones.push(runway.tone);
    const company = companyName || 'your employer';
    alerts.push({
      key: `runway-${address}`,
      tone: runway.tone,
      title:
        runway.tone === 'red'
          ? `${companyName ? possessive(companyName) : "Your employer's"} pool is empty`
          : daysText(runway.days),
      text:
        runway.tone === 'red'
          ? 'You are not earning right now. What you earned so far is still yours to claim.'
          : `After that you stop earning until ${company} deposits more.`,
    });
  }

  return { alerts, poolTone: own?.tone, claimTone: worst(workerTones) };
}
