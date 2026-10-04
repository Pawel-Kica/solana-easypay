import { useState } from 'react';
import { explorerAddressUrl, explorerTxUrl } from './chain';
import { formatRowDate, formatUsdc, shortAddress } from './format';
import type { CompanyStats, Stats } from './stats';
import { TEXT_BUTTON } from './ui';

// Pools whose runway is shorter than this many days show up under Running low.
const LOW_DAYS = 3;
const RECENT = 20;

const COLUMNS = [
  ['Company', 'name'],
  ['Active', 'active'],
  ['Contracts', 'contractsTotal'],
  ['Paid', 'paidTotal'],
  ['In pool', 'balance'],
  ['Days left', 'daysLeft'],
  ['Ran dry', 'ranDryCount'],
] as const;
type SortKey = (typeof COLUMNS)[number][1];

// Names sort A to Z, numbers biggest first. A pool without active contracts has no runway and sorts last.
function compare(a: CompanyStats, b: CompanyStats, key: SortKey) {
  if (key === 'name') return a.name.localeCompare(b.name);
  const value = (c: CompanyStats) => (key === 'daysLeft' ? (c.daysLeft ?? -1) : c[key]);
  const [x, y] = [value(a), value(b)];
  return x === y ? 0 : x < y ? 1 : -1;
}

// The admin part under the public numbers: pools running low, every company, and the latest activity.
export function AdminSections({ stats }: { stats: Stats }) {
  const [sort, setSort] = useState<SortKey>('paidTotal');
  const low = stats.companies.filter((c) => c.daysLeft !== null && c.daysLeft < LOW_DAYS);
  const rows = [...stats.companies].sort((a, b) => compare(a, b, sort));
  const names = new Map(stats.companies.map((c) => [c.pool, c.name]));

  return (
    <>
      <h2 className="mt-6 mb-2 px-1 font-semibold">Running low</h2>
      {low.length ? (
        <ul className="space-y-1">
          {low.map((c) => (
            <li key={c.pool} className="rounded-2xl bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
              {c.name || 'Unnamed company'}: {c.daysLeft === 0 ? 'less than a day' : `${c.daysLeft} days`} of pay left,{' '}
              {c.active} active
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 text-sm text-white/50">Every pool covers at least {LOW_DAYS} days.</p>
      )}

      <h2 className="mt-6 mb-2 px-1 font-semibold">Companies</h2>
      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="w-full text-sm tabular-nums">
          <thead className="text-left text-white/50">
            <tr>
              {COLUMNS.map(([label, key]) => (
                <th key={key} className="px-3 py-2 font-medium whitespace-nowrap">
                  <button onClick={() => setSort(key)} className={sort === key ? 'text-white' : 'hover:text-white'}>
                    {label}
                    {sort === key && ' ↓'}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.pool} className="border-t border-white/10">
                <td className="px-3 py-2">
                  <a href={explorerAddressUrl(c.pool)} target="_blank" rel="noreferrer" className="hover:underline">
                    {c.name || 'Unnamed company'}
                  </a>
                  <span className="block font-mono text-xs text-white/40">{shortAddress(c.employer)}</span>
                </td>
                <td className="px-3 py-2">{c.active}</td>
                <td className="px-3 py-2">{c.contractsTotal}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatUsdc(c.paidTotal)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatUsdc(c.balance)}</td>
                <td className={`px-3 py-2 ${c.daysLeft !== null && c.daysLeft < LOW_DAYS ? 'text-amber-300' : ''}`}>
                  {c.daysLeft ?? '-'}
                </td>
                <td className={`px-3 py-2 ${c.ranDryCount ? 'text-amber-300' : ''}`}>{c.ranDryCount}×</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="px-3 py-4 text-sm text-white/50">No companies yet.</p>}
      </div>

      <h2 className="mt-6 mb-2 px-1 font-semibold">Latest activity</h2>
      {stats.activity.length ? (
        <ul className="divide-y divide-white/10 rounded-2xl border border-white/10">
          {stats.activity.slice(0, RECENT).map((a, i) => (
            <li key={`${a.signature}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{a.kind}</span>{' '}
                <span className="text-white/50">{names.get(a.pool) || shortAddress(a.pool)}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                {a.amount !== null && formatUsdc(a.amount)}
                <a href={explorerTxUrl(a.signature)} target="_blank" rel="noreferrer" className={TEXT_BUTTON}>
                  {formatRowDate(a.time)} ↗
                </a>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 text-sm text-white/50">No transactions yet.</p>
      )}
    </>
  );
}
