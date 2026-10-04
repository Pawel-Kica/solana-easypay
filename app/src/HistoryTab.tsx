import type { Address, Option } from '@solana/kit';
import { useEffect, useState, type ReactNode } from 'react';
import { BalancesView } from './BalancesView';
import { downloadCertificate } from './certificate';
import {
  ASSET_NAMES,
  explorerTxUrl,
  getChainTime,
  getHistory,
  getSplit,
  UNREACHABLE_HINT,
  type HistoryEntry,
  type HistoryInstruction,
} from './chain';
import { EmptyState } from './EmptyState';
import { getIncome } from './events';
import { decryptLabels } from './labels';
import {
  contractTitle,
  formatAsset,
  formatChainDate,
  formatNotice,
  formatRowDate,
  formatUsdc,
  shortAddress,
} from './format';
import { EasypayInstruction, Period } from './generated';
import { DAY, HOUR } from './pay';
import { downloadTaxCsv } from './taxCsv';
import {
  CoinIcon,
  CompanyLine,
  Loading,
  RecipientIcon,
  SMALL_BUTTON,
  Tabs,
  TEXT_BUTTON,
  useStoredState,
  WalletIcon,
} from './ui';

const VIEWS = ['General', 'Balances'] as const;

// "Frontend dev", or "1 USDC per day" for an untitled contract, from propose or accept data or an Accepted event.
const titleOf = ({ title, rate, period }: { title: string; rate: bigint; period: Period }) =>
  contractTitle({ title, rate, period: period === Period.Hour ? HOUR : DAY });

// Round icon left of a row: its glyph and colours.
const ICONS = {
  claim: ['↓', 'bg-green-400/10 text-green-400'],
  accept: ['✓', 'bg-[#9945FF]/15 text-[#B98BFF]'],
  split: ['%', 'bg-white/5 text-white/75'],
  end: ['×', 'bg-red-500/10 text-red-300'],
  failed: ['!', 'bg-red-500/10 text-red-300'],
  pool: ['+', 'bg-white/5 text-white/75'],
  deposit: ['↑', 'bg-white/5 text-white/75'],
  withdraw: ['↓', 'bg-white/5 text-white/75'],
  offer: ['→', 'bg-white/5 text-white/75'],
  cancel: ['×', 'bg-white/5 text-white/75'],
  exchange: ['⇄', 'bg-white/5 text-white/75'],
} as const;

type Line = [label: ReactNode, value: ReactNode] | 'Where it went';

// One instruction as a row: title and subtitle on the left, an amount (green when it reached the owner) or a muted
// note on the right. `lines` fill the card the row opens, above the date, fee and transaction every card has.
type Row = {
  icon: keyof typeof ICONS;
  title: string;
  sub?: string;
  amount?: string;
  incoming?: boolean;
  side?: string;
  auto?: boolean;
  lines: Line[];
};

type Context = {
  owner: Address;
  name: (address: Address) => string; // a split address by its label, "Taxes", or short
  contract: { title: string; label: string } | undefined; // the claimed contract, see claimTitles
};

// A line label with its split icon in front.
const withIcon = (icon: ReactNode, label: ReactNode) => (
  <span className="flex items-center gap-2">
    {icon}
    {label}
  </span>
);

const chip = (address: string) => (
  <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-white/55">{shortAddress(address)}</span>
);

// The terms of a proposed or accepted contract.
function termLines(d: { rate: bigint; period: Period; weekdaysOnly: boolean; start: bigint; end: Option<bigint>; notice: number }): Line[] {
  const hourly = d.period === Period.Hour;
  return [
    ['Rate', `${formatUsdc(d.rate)} per ${hourly ? 'hour' : 'day'}`],
    ['Pays', d.weekdaysOnly ? 'Mon to Fri' : 'Every day'],
    ['Starts', formatChainDate(Number(d.start))],
    ['Ends', d.end.__option === 'Some' ? formatChainDate(Number(d.end.value)) : 'No end date'],
    ['Notice', formatNotice(d.notice, hourly ? HOUR : DAY)],
  ];
}

// One Easy Pay instruction as `owner` sees it. A new instruction adds its case here, tsc fails until it does.
function describe(ix: HistoryInstruction, { owner, name, contract }: Context): Row {
  switch (ix.instructionType) {
    case EasypayInstruction.CreatePool:
      return { icon: 'pool', title: ix.data.name ? `Created pool ${ix.data.name}` : 'Created pool', lines: [] };
    case EasypayInstruction.Deposit:
      return { icon: 'deposit', title: `Deposited ${formatUsdc(ix.data.amount)}`, lines: [] };
    case EasypayInstruction.Withdraw:
      return { icon: 'withdraw', title: `Withdrew ${formatUsdc(ix.data.amount)}`, lines: [] };
    // The proposer sees their propose. The employer also sees one from a worker, it lists them and their pool.
    // A worker never sees the employer's: their address is in its data, not its accounts.
    case EasypayInstruction.Propose: {
      const { proposer, employer } = ix.accounts;
      const title = titleOf(ix.data);
      const terms = termLines(ix.data);
      if (proposer.address !== owner)
        return { icon: 'offer', title: `Worker ${shortAddress(proposer.address)} proposed ${title}`, lines: [['From', chip(proposer.address)], ...terms] };
      const other = proposer.address === employer.address ? ix.data.employee : employer.address;
      return { icon: 'offer', title: `Proposed ${title}`, lines: [['To', chip(other)], ...terms] };
    }
    // Both sides see an accept: both are in its accounts.
    case EasypayInstruction.Accept: {
      const { signer, employer, proposer } = ix.accounts;
      const title = ix.data.title || 'contract';
      const side = `${formatUsdc(ix.data.rate)} per ${ix.data.period === Period.Hour ? 'hour' : 'day'}`;
      if (signer.address === owner)
        return { icon: 'accept', title: `Started ${title}`, side, lines: [...termLines(ix.data), ['Offer from', chip(proposer.address)]] };
      const who = `${employer.address === owner ? 'Worker' : 'Employer'} ${shortAddress(signer.address)}`;
      return { icon: 'accept', title: `${who} accepted ${title}`, side, lines: termLines(ix.data) };
    }
    // Only the proposer sees a cancel: the offer is gone, so the other side is not in it.
    case EasypayInstruction.CancelOffer:
      return { icon: 'cancel', title: 'Cancelled offer', lines: [] };
    // claim takes no amount, so it comes from the Claimed event: the gross amount, and with a split where it went.
    // A failed claim moved nothing. The company sees its workers' claims too, they touch its pool, but not the
    // worker's split.
    case EasypayInstruction.Claim: {
      const { employee, signer } = ix.accounts;
      // Signed by someone else than the worker: the auto-claim server did it.
      const auto = signer.address !== employee.address;
      // A titled contract names the row, "Claimed QA Tester". An untitled one only shows its rate in the card.
      const what = contract?.title ? ` ${contract.title}` : '';
      const contractLine: Line[] = contract ? [['Contract', contract.label]] : [];
      if (employee.address !== owner) {
        const worker = `Worker ${shortAddress(employee.address)}`;
        if (!ix.claimed) return { icon: 'failed', title: `${worker} tried to claim${what}`, auto, lines: contractLine };
        return { icon: 'claim', title: `${worker} claimed${what}`, amount: formatUsdc(ix.claimed.amount), auto, lines: contractLine };
      }
      if (!ix.claimed) return { icon: 'failed', title: `Claim${what}`, auto, lines: contractLine };
      const { amount, recipients, toWorker, invested, asset, assetAmount, fellBack } = ix.claimed;
      const lines: Line[] = [...contractLine, ['Claimed by', auto ? 'Auto-claim server' : 'You'], 'Where it went', [withIcon(<WalletIcon />, 'You'), formatUsdc(toWorker)]];
      recipients.forEach((r, i) => {
        const label = name(r.owner);
        const who = label === shortAddress(r.owner) ? chip(r.owner) : <>{label} {chip(r.owner)}</>;
        lines.push([withIcon(<RecipientIcon index={i} />, who), formatUsdc(r.amount)]);
      });
      if (invested > 0n)
        lines.push([
          withIcon(<CoinIcon name={ASSET_NAMES[asset]} />, `${ASSET_NAMES[asset]} bought`),
          <>
            {formatAsset(assetAmount, asset)}
            <span className="block text-xs text-white/55">for {formatUsdc(invested)}</span>
          </>,
        ]);
      if (fellBack) lines.push(['Exchange', 'Unavailable, you got USDC']);
      lines.push(['Total', <b>{formatUsdc(amount)}</b>]);
      return { icon: 'claim', title: `Claimed${what}`, amount: `+${formatUsdc(amount)}`, incoming: true, auto, lines };
    }
    // Only the worker sees their split saves, nobody else is in its accounts.
    case EasypayInstruction.SetSplit: {
      const { recipients, investPct, investAsset, claimer } = ix.data;
      const you = 100 - investPct - recipients.reduce((sum, r) => sum + r.pct, 0);
      type Part = [who: string, pct: number, icon: ReactNode];
      const parts: Part[] = [['You', you, <WalletIcon />]];
      recipients.forEach((r, i) => parts.push([name(r.owner), r.pct, <RecipientIcon index={i} />]));
      if (investPct > 0) parts.push([ASSET_NAMES[investAsset], investPct, <CoinIcon name={ASSET_NAMES[investAsset]} />]);
      const auto = claimer.__option === 'Some';
      return {
        icon: 'split',
        title: 'Saved split',
        sub: parts.map(([who, pct]) => `${who} ${pct}%`).join(' · '),
        side: `auto-claim ${auto ? 'on' : 'off'}`,
        lines: [...parts.map(([who, pct, icon]): Line => [withIcon(icon, who), `${pct}%`]), ['Auto-claim', auto ? 'On' : 'Off']],
      };
    }
    // The local app sets up the exchange once per chain, signed by the company test account.
    case EasypayInstruction.InitExchange:
      return { icon: 'exchange', title: 'Set up the exchange', lines: [] };
    // Either side can end a contract. Both see it: the other side is in its accounts too.
    case EasypayInstruction.EndContract: {
      const { signer, employer, employee } = ix.accounts;
      const isEmployer = employer.address === owner;
      const other = shortAddress(isEmployer ? employee.address : employer.address);
      const end: Line = ['Pay stops', ix.data.end.__option === 'Some' ? formatChainDate(Number(ix.data.end.value)) : 'Earliest allowed end'];
      return signer.address === owner
        ? { icon: 'end', title: `Ended contract with ${other}`, lines: [['Ended by', 'You'], end] }
        : { icon: 'end', title: `${isEmployer ? 'Worker' : 'Employer'} ${other} ended your contract`, lines: [['Ended by', other], end] };
    }
  }
}

// The contract of each claim, by `${signature}:${instruction index}`: its title, empty when it has none, and its
// label, the title or "1 USDC per day". A claim carries only pool and slot, so this comes from the last Accepted
// event on that slot before it: an ended contract frees its slot for a later one.
function claimTitles(entries: HistoryEntry[]) {
  const bySlot = new Map<string, { title: string; label: string }>();
  const titles = new Map<string, { title: string; label: string }>();
  for (const { signature, accepted, instructions } of [...entries].reverse()) {
    for (const a of accepted) bySlot.set(`${a.pool}:${a.slot}`, { title: a.title, label: titleOf(a) });
    instructions.forEach((ix, i) => {
      if (ix.instructionType !== EasypayInstruction.Claim) return;
      const title = bySlot.get(`${ix.accounts.pool.address}:${ix.data.slot}`);
      if (title) titles.set(`${signature}:${i}`, title);
    });
  }
  return titles;
}

// A button that builds a file in the browser and downloads it: the income certificate PDF or the tax CSV.
function DownloadButton({ label, error, download }: { label: string; error: string; download: () => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const run = async () => {
    setState('busy');
    try {
      await download();
      setState('idle');
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      {state === 'failed' && <span className="text-sm text-red-300">{error}</span>}
      <button className={SMALL_BUTTON} disabled={state === 'busy'} onClick={run}>
        {state === 'busy' ? 'Building…' : label}
      </button>
    </>
  );
}

// The certificate is built from the worker's Accepted and Claimed events.
async function downloadIncomeCertificate(owner: Address) {
  const [contracts, now] = await Promise.all([getIncome(owner), getChainTime()]);
  await downloadCertificate(owner, contracts, now);
}

// History tab: a General | Balances switch. General lists the owner's Easy Pay actions, one row per instruction,
// newest first, read from the chain when the tab opens. A click opens the row's card with everything about it,
// Explorer is a link at the bottom of the card. Split addresses show by their label when this browser already has
// the labels key (no wallet prompt here). Balances is BalancesView.
export function HistoryTab({ owner }: { owner: Address }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(); // undefined while loading, null if it failed
  const [labels, setLabels] = useState(new Map<string, string>()); // split address -> label
  const [view, setView] = useStoredState('easypay.history.view', 'General', VIEWS);

  useEffect(() => {
    let alive = true;
    getHistory(owner).then(
      (list) => alive && setEntries(list),
      () => alive && setEntries(null),
    );
    getSplit(owner)
      .then(async (split) => {
        if (!split) return;
        const names = await decryptLabels(owner, split.labels);
        if (alive) setLabels(new Map(split.recipients.map((r, i) => [r.owner, names[i] ?? ''])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [owner]);

  const name = (address: Address) => labels.get(address) || shortAddress(address);
  // A worker with at least one contract gets the CSV export and the certificate.
  const isWorker = !!entries?.some(
    (e) =>
      !e.failed &&
      e.instructions.some(
        (ix) => ix.instructionType === EasypayInstruction.Accept && ix.accounts.employee.address === owner,
      ),
  );

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <Tabs tabs={VIEWS} value={view} onChange={setView} label="History or balances" />
        {isWorker && (
          <div className="flex items-center gap-3">
            <DownloadButton label="Export CSV" error="Could not build the CSV" download={() => downloadTaxCsv(owner)} />
            <DownloadButton
              label="Income certificate"
              error="Could not build the certificate"
              download={() => downloadIncomeCertificate(owner)}
            />
          </div>
        )}
      </div>
      {view === 'Balances' ? (
        <BalancesView owner={owner} />
      ) : entries === undefined ? (
        <Loading />
      ) : entries === null ? (
        <EmptyState title="Could not read your history" text={UNREACHABLE_HINT} />
      ) : !entries.length ? (
        <EmptyState title="No transactions yet" text="Your Easy Pay transactions show up here." />
      ) : (
        <History entries={entries} owner={owner} name={name} />
      )}
    </>
  );
}

function History({ entries, owner, name }: { entries: HistoryEntry[]; owner: Address; name: (address: Address) => string }) {
  const [open, setOpen] = useState<string | null>(null);
  const titles = claimTitles(entries);
  return (
    <ul>
      {entries.flatMap((entry) =>
        entry.instructions.map((ix, i) => {
          const key = `${entry.signature}:${i}`;
          const row = describe(ix, { owner, name, contract: titles.get(key) });
          const isOpen = open === key;
          const [glyph, colors] = ICONS[entry.failed ? 'failed' : row.icon];
          return (
            <li key={key}>
              <button
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : key)}
                className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-white/5 ${isOpen ? 'bg-white/5' : ''}`}
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-semibold ${colors}`}>{glyph}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 font-medium">
                    {row.title}
                    {entry.failed && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-300">Failed</span>}
                    {row.auto && <span className="rounded-full bg-[#9945FF]/15 px-2 py-0.5 text-xs text-[#B98BFF]">auto-claim</span>}
                  </span>
                  {(row.sub ?? entry.company) && (
                    <span className="truncate text-sm text-white/55">{row.sub ?? (entry.company?.name || 'Unnamed company')}</span>
                  )}
                </span>
                <span className="text-right whitespace-nowrap">
                  {row.amount && !entry.failed && (
                    <span className={`block font-semibold ${row.incoming ? 'text-green-400' : ''}`}>{row.amount}</span>
                  )}
                  {row.side && <span className="block text-sm text-white/55">{row.side}</span>}
                  {entry.time !== null && <span className="block text-xs text-white/55">{formatRowDate(entry.time)}</span>}
                </span>
                <span className={`text-white/35 transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
              </button>
              {isOpen && <Card entry={entry} row={row} />}
            </li>
          );
        }),
      )}
    </ul>
  );
}

// What a row opens: its own lines, then the company, date, fee and transaction, and Explorer as a small link.
function Card({ entry, row }: { entry: HistoryEntry; row: Row }) {
  const { signature, time, failed, fee, company, instructions } = entry;
  const others = instructions.length - 1;
  const line = ([label, value]: [ReactNode, ReactNode], i: number) => (
    <div key={i} className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-white/55">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
  const common: [ReactNode, ReactNode][] = [
    ['Date', time === null ? '' : formatChainDate(time)],
    ['Network fee', fee === null ? '' : `${(Number(fee) / 1e9).toLocaleString('en-US', { maximumSignificantDigits: 3 })} SOL`],
    [
      'Transaction',
      <span className="flex items-center gap-1">
        <span className="font-mono">{shortAddress(signature)}</span>
        <CopyButton text={signature} />
      </span>,
    ],
  ];
  return (
    <div className="animate-fade-in pt-1 pr-3 pb-4 pl-[3.75rem]">
      {company && line(['Company', <CompanyLine name={company.name} address={company.address} />], -1)}
      {failed && <p className="my-1.5 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">Nothing moved, only the fee was paid.</p>}
      {row.lines.map((l, i) =>
        l === 'Where it went' ? (
          <p key={i} className="mt-2.5 mb-0.5 text-xs font-semibold tracking-wide text-white/40 uppercase">
            Where it went
          </p>
        ) : (
          line(l, i)
        ),
      )}
      <div className="my-1.5 border-t border-white/10" />
      {common.map((l, i) => line(l, 100 + i))}
      {others > 0 && (
        <p className="mt-2 rounded-xl bg-white/5 px-3 py-2 text-sm text-white/55">
          One transaction with {others} more {others === 1 ? 'action' : 'actions'}, one fee for all.
        </p>
      )}
      <div className="mt-2 flex justify-end">
        <a href={explorerTxUrl(signature)} target="_blank" rel="noreferrer" className={TEXT_BUTTON}>
          Explorer ↗
        </a>
      </div>
    </div>
  );
}

// Copies `text`, shows a tick for a moment.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button aria-label="Copy transaction" onClick={copy} className="rounded px-1 text-white/40 hover:text-white">
      {copied ? '✓' : '⧉'}
    </button>
  );
}
