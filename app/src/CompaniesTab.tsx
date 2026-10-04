import { isAddress, type Address } from '@solana/kit';
import { useEffect, useState, type ReactNode } from 'react';
import { explorerAddressUrl, getFirstSeen, getPool, IS_LOCAL, UNREACHABLE_HINT, type CompanyRecord, type PoolState } from './chain';
import { formatUsdc } from './format';
import { covers, DAY, HOUR } from './pay';
import { loadDemoCompanies } from './seed';
import type { Notify } from './Toasts';
import { FIELD, INPUT, LABEL, Info, Loading, NOT_VERIFIED, TEXT_BUTTON, Tabs, useStoredState } from './ui';
import { ConnectPrompt } from './Wallet';

// The score a company gets from its pool counters. Display only, the program knows nothing about it.
// Fewer than 3 contracts is "New", so a fresh wallet can't look perfect. Otherwise 100 minus 25 per dry spell.
export function scoreOf({ contractsTotal, ranDryCount }: Pick<CompanyRecord, 'contractsTotal' | 'ranDryCount'>) {
  return contractsTotal < 3 ? 'New' : Math.max(0, 100 - 25 * ranDryCount);
}

const GREEN = 'bg-[#40B66B]/15 text-[#40B66B]';
const AMBER = 'bg-amber-500/15 text-amber-300';

// "Score 92/100" pill, green at 80 and above. Amber for a lower score, "New", and "No history" (record null).
export function ScoreBadge({ record }: { record: CompanyRecord | null }) {
  const score = record && scoreOf(record);
  const [text, colour] =
    score === null
      ? ['No history', AMBER]
      : score === 'New'
        ? ['New', AMBER]
        : [`Score ${score}/100`, score >= 80 ? GREEN : AMBER];
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${colour}`}>{text}</span>;
}

type Props = {
  query: string; // the address field, kept in App so "See record" on an offer can fill it
  onQuery: (text: string) => void;
  owner?: Address; // the signed-in account, for My company
  chainTime?: number;
  notify: Notify;
};

// localStorage key of the open sub-tab, so a refresh keeps it. App resets it to Search for "See record".
export const COMPANIES_VIEW_KEY = 'easypay.companies.view';

// Companies tab. Search: paste an employer address (the one the account button copies) and see its record from the
// chain. My company: the same card for the signed-in account, so a company sees what workers see before they sign.
// The pool sits at the employer's PDA. No pool there shows a "No history" warning. On Local after "seed demo",
// the demo companies sit under the field as quick picks.
export function CompaniesTab({ query, onQuery, owner, chainTime, notify }: Props) {
  const [view, setView] = useStoredState(COMPANIES_VIEW_KEY, 'Search', ['Search', 'My company'] as const);
  const demo = IS_LOCAL ? loadDemoCompanies() : [];
  const typed = query.trim();
  const employer = isAddress(typed) ? typed : null;

  return (
    <>
      <div className="mb-2">
        <Tabs tabs={['Search', 'My company'] as const} value={view} onChange={setView} label="Companies view" />
      </div>
      {view === 'My company' ? (
        owner ? (
          <CompanyCard key={owner} employer={owner} chainTime={chainTime} />
        ) : (
          <ConnectPrompt notify={notify} />
        )
      ) : (
        <>
          <label className={`block ${FIELD}`}>
            <span className={LABEL}>Company address</span>
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Paste a company's address"
              spellCheck={false}
              className={`mt-1 block w-full font-mono text-sm ${INPUT}`}
            />
          </label>
          {demo.length > 0 && (
            <p className="flex flex-wrap gap-3 px-1 text-sm text-white/50">
              Demo:
              {demo.map((d) => (
                <button key={d.address} onClick={() => onQuery(d.address)} className={TEXT_BUTTON}>
                  {d.name}
                </button>
              ))}
            </p>
          )}
          {typed && !employer && <p className="mt-2 px-1 text-sm text-white/50">Invalid address</p>}
          {employer && <CompanyCard key={employer} employer={employer} chainTime={chainTime} />}
        </>
      )}
    </>
  );
}

// The card for one employer, read once when the address is entered: name, score and six tiles from the pool.
// "On Easy Pay" counts from the pool's first transaction, the rest are the pool's counters, balance and contracts.
function CompanyCard({ employer, chainTime }: { employer: Address; chainTime?: number }) {
  const [pool, setPool] = useState<PoolState | null | 'failed'>(); // undefined while loading, null without a pool
  const [since, setSince] = useState<number | null>(); // first transaction of the pool, undefined while loading

  useEffect(() => {
    let alive = true;
    getPool(employer).then(
      (p) => {
        if (!alive) return;
        setPool(p);
        if (p) getFirstSeen(p.address).then((t) => alive && setSince(t), () => alive && setSince(null));
      },
      () => alive && setPool('failed'),
    );
    return () => {
      alive = false;
    };
  }, [employer]);

  if (pool === undefined) return <Loading />;
  if (pool === 'failed') return <p className="mt-2 px-1 text-sm text-white/50">Could not read the company. {UNREACHABLE_HINT}</p>;
  if (pool === null)
    return (
      <div className="mt-2 rounded-2xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
        <p className="font-semibold">No history</p>
        <p className="mt-0.5 text-amber-200/80">
          This address has never paid anyone through Easy Pay. It may be a new company, or one that moved to a fresh
          wallet.
        </p>
      </div>
    );

  const runway = chainTime === undefined ? undefined : covers(pool, chainTime);
  const unit = runway?.period === HOUR ? 'hour' : 'day';
  const age = since == null || chainTime === undefined ? null : Math.max(0, Math.floor((chainTime - since) / DAY));

  return (
    <div className="mt-2 rounded-2xl border border-white/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg font-semibold break-words">
            {pool.name || 'Unnamed company'}
            <Info text={NOT_VERIFIED} />
          </p>
          <p className="font-mono text-sm break-all text-white/55">{employer}</p>
        </div>
        <ScoreBadge record={pool} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2">
        <Tile label={`contracts, ${runway?.running ?? 0} active`}>{pool.contractsTotal}</Tile>
        <Tile label="paid to workers" className="text-[#40B66B]">
          {formatUsdc(pool.paidTotal)}
        </Tile>
        <Tile label="ran out of money" className={pool.ranDryCount ? 'text-amber-300' : ''}>
          {pool.ranDryCount}×
        </Tile>
        <Tile label="in the pool now">{formatUsdc(pool.balance)}</Tile>
        <Tile label={runway ? `of pay left, at ${formatUsdc(runway.teamRate)} a ${unit}` : 'of pay left, no active contracts'}>
          {runway === undefined ? '…' : runway ? plural(Number(runway.periods), unit) : '-'}
        </Tile>
        <Tile label="on Easy Pay">{since === undefined ? '…' : age === null ? '-' : plural(age, 'day')}</Tile>
      </dl>
      <p className="mt-3 text-sm text-white/55">
        Data from the Pool account.{' '}
        <a href={explorerAddressUrl(pool.address)} target="_blank" rel="noreferrer" className={TEXT_BUTTON}>
          Check it in Explorer ↗
        </a>
      </p>
    </div>
  );
}

export const plural = (n: number, unit: string) => `${n.toLocaleString('en-US')} ${unit}${n === 1 ? '' : 's'}`;

// One number with its label under it. dt comes first in the markup, flex-col-reverse puts the number on top.
export const Tile = ({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) => (
  <div className="flex flex-col-reverse justify-end rounded-2xl border border-white/10 px-3 py-2.5">
    <dt className="text-sm text-white/50">{label}</dt>
    <dd className={`text-lg font-semibold tabular-nums ${className}`}>{children}</dd>
  </div>
);
