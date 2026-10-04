import { isAddress, type Address } from '@solana/kit';
import { useEffect, useState, type ReactNode } from 'react';
import {
  getContracts,
  getPool,
  UNREACHABLE_HINT,
  USDC_MINT,
  type Contract,
  type PendingOffer,
  type PoolState,
  type SigningClient,
} from './chain';
import { ScoreBadge } from './CompaniesTab';
import { EmptyState } from './EmptyState';
import {
  byteLength,
  contractTitle,
  formatDay,
  formatMoment,
  formatNotice,
  formatUsdc,
  MAX_NAME_BYTES,
  parseUsdc,
  shortAddress,
} from './format';
import { Period } from './generated';
import { claimable, DAY, earliestEnd, ended, HOUR, lastFull, MAX_END_AHEAD, settle } from './pay';
import type { Notify } from './Toasts';
import { sendWithToast } from './tx';
import { BUTTON, FIELD, INPUT, LABEL, Info, Loading, NOT_VERIFIED, SMALL_BUTTON, TEXT_BUTTON, Tabs, useStoredState } from './ui';

type Props = {
  client: SigningClient;
  owner: Address;
  pool: PoolState | null | undefined; // undefined while loading, null when the account has no pool
  chainTime?: number;
  notify: Notify;
  onDone: () => void; // re-reads balances after a transaction
  onOpenCompany: (employer: Address) => void; // "See record": opens Companies with the employer filled in
};

type Data = { offers: PendingOffer[]; contracts: Contract[] };

// Contracts tab, the same for every account: offers and contracts on both sides, plus the New contract form.
// The list is read from the chain when the tab opens and after each transaction.
export function ContractsTab({ client, owner, pool, chainTime, notify, onDone, onOpenCompany }: Props) {
  const [view, setView] = useStoredState('easypay.contracts.view', 'list', ['list', 'new'] as const);
  const [data, setData] = useState<Data | null>(); // undefined while loading, null if it failed
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    getContracts(owner).then(
      (d) => alive && setData(d),
      () => alive && setData(null),
    );
    return () => {
      alive = false;
    };
  }, [owner, tick]);

  const reload = () => {
    setTick((t) => t + 1);
    onDone();
  };

  return (
    <>
      <div className="mb-2">
        <Tabs
          tabs={['list', 'new'] as const}
          value={view}
          onChange={setView}
          label="Contracts view"
          names={{ list: 'Contracts', new: 'New contract' }}
        />
      </div>
      {view === 'list' ? (
        <ContractList
          client={client}
          owner={owner}
          data={data}
          chainTime={chainTime}
          notify={notify}
          onDone={reload}
          onOpenCompany={onOpenCompany}
        />
      ) : (
        <NewContract
          client={client}
          owner={owner}
          pool={pool}
          chainTime={chainTime}
          notify={notify}
          onProposed={() => {
            setView('list');
            reload();
          }}
        />
      )}
    </>
  );
}

type ListProps = Pick<Props, 'client' | 'owner' | 'chainTime' | 'notify' | 'onDone' | 'onOpenCompany'> & {
  data: Data | null | undefined;
};

// Pending offers first, then contracts. A row shows the title, the rate and what the worker can claim now, Details
// opens every term in a table (DetailsDialog). The side an offer was sent to gets Accept, the side that sent it gets
// Cancel. The worker's side also shows the company's score and "See record". Both sides can end a running contract
// through the End form (EndPicker).
function ContractList({ client, owner, data, chainTime, notify, onDone, onOpenCompany }: ListProps) {
  const [busyOffer, setBusyOffer] = useState<Address>(); // the offer being accepted or cancelled
  const [confirming, setConfirming] = useState<string>(); // key of the contract whose End form is open
  const [ending, setEnding] = useState<string>();
  const [details, setDetails] = useState<PendingOffer | Contract>(); // the offer or contract whose Details are open

  if (data === undefined) return <Loading />;
  if (data === null) return <EmptyState title="Could not read your contracts" text={UNREACHABLE_HINT} />;
  if (!data.offers.length && !data.contracts.length)
    return <EmptyState title="No contracts yet" text="Offers you send or receive show up here." />;

  // Signs the offer as the side it was sent to: the program moves it into a pool slot and closes it.
  const accept = async (offer: PendingOffer) => {
    setBusyOffer(offer.address);
    const labels = {
      success: `Accepted contract from ${shortAddress(offer.proposer)}`,
      failure: 'Could not accept the contract',
    };
    const { employer, employee, proposer, rate, period, weekdaysOnly, start, end, title, notice } = offer;
    await sendWithToast(client, notify, labels, () =>
      client.easypay.instructions
        // The terms shown in the row. The program refuses if the proposer changed them since.
        .accept({
          signer: client.identity,
          employer,
          employee,
          proposer,
          mint: USDC_MINT,
          rate,
          period: period === HOUR ? Period.Hour : Period.Day,
          weekdaysOnly,
          start: BigInt(start),
          end: end === null ? null : BigInt(end),
          title,
          notice,
        })
        .sendTransaction(),
    );
    setBusyOffer(undefined);
    onDone();
  };

  // cancel_offer by the proposer: the offer closes and its rent comes back.
  const cancel = async (offer: PendingOffer) => {
    setBusyOffer(offer.address);
    const labels = { success: 'Cancelled offer', failure: 'Could not cancel the offer' };
    await sendWithToast(client, notify, labels, () =>
      client.easypay.instructions.cancelOffer({ proposer: client.identity, offer: offer.address }).sendTransaction(),
    );
    setBusyOffer(undefined);
    onDone();
  };

  // end_contract from either side at `at`, or at the earliest end the program allows when null. Earned pay stays
  // claimable.
  const end = async (c: Contract, key: string, at: number | null) => {
    setEnding(key);
    const other = shortAddress(c.employer === owner ? c.employee : c.employer);
    const labels = { success: `Ended contract with ${other}`, failure: 'Could not end the contract' };
    await sendWithToast(client, notify, labels, () =>
      client.easypay.instructions
        .endContract({
          signer: client.identity,
          employer: c.employer,
          employee: c.employee,
          slot: c.slot,
          end: at === null ? null : BigInt(at),
        })
        .sendTransaction(),
    );
    setEnding(undefined);
    setConfirming(undefined);
    onDone();
  };

  return (
    <>
      {data.offers.length > 0 && (
        <Section title="Pending offers">
          {data.offers.map((offer) => {
            const mine = offer.proposer === owner;
            const other = shortAddress(offer.employer === owner ? offer.employee : offer.employer);
            const busy = busyOffer === offer.address;
            return (
              <Row
                key={offer.address}
                title={rowTitle(offer)}
                party={mine ? `Offer to ${other}` : `Offer from ${other}`}
                summary={`${rateText(offer)} · Starts ${formatDay(offer.start)}`}
                pay={
                  offer.employer !== owner && (
                    <span className="mt-1.5 flex items-center gap-3">
                      <ScoreBadge record={offer.record} />
                      <button
                        onClick={() => onOpenCompany(offer.employer)}
                        className={TEXT_BUTTON}
                      >
                        See record →
                      </button>
                    </span>
                  )
                }
              >
                <span className="flex flex-col items-end gap-1.5">
                  {mine ? (
                    <button
                      onClick={() => cancel(offer)}
                      disabled={busyOffer !== undefined}
                      className={`${SMALL_BUTTON} border border-white/15 hover:bg-white/5`}
                    >
                      {busy ? 'Cancelling…' : 'Cancel'}
                    </button>
                  ) : (
                    <button
                      onClick={() => accept(offer)}
                      disabled={busyOffer !== undefined}
                      className={`${SMALL_BUTTON} bg-[#9945FF] hover:bg-[#8a3ef0]`}
                    >
                      {busy ? 'Accepting…' : 'Accept'}
                    </button>
                  )}
                  <DetailsButton onClick={() => setDetails(offer)} />
                </span>
              </Row>
            );
          })}
        </Section>
      )}
      {data.contracts.length > 0 && (
        <Section title="Contracts">
          {data.contracts.map((c) => {
            const key = `${c.pool}-${c.slot}`;
            return (
              <Row
                key={key}
                title={rowTitle(c)}
                party={c.employer === owner ? `Worker ${shortAddress(c.employee)}` : undefined}
                summary={
                  <>
                    {rateText(c)}
                    {chainTime !== undefined && (
                      <>
                        {' '}
                        · <Claimable contract={c} chainTime={chainTime} />
                      </>
                    )}
                  </>
                }
                below={
                  confirming === key &&
                  chainTime !== undefined && (
                    <EndPicker
                      contract={c}
                      byEmployer={c.employer === owner}
                      chainTime={chainTime}
                      busy={ending === key}
                      onEnd={(at) => end(c, key, at)}
                      onCancel={() => setConfirming(undefined)}
                    />
                  )
                }
              >
                <span className="flex flex-col items-end gap-1.5">
                  {chainTime !== undefined && ended(c, chainTime) ? (
                    <Badge text="Ended" className="border border-white/15 text-white/60" />
                  ) : (
                    <>
                      <Badge text="Active" className="bg-[#9945FF]/15 text-[#B98BFF]" />
                      {confirming !== key && (
                        <button onClick={() => setConfirming(key)} className={TEXT_BUTTON}>
                          End contract
                        </button>
                      )}
                    </>
                  )}
                  <DetailsButton onClick={() => setDetails(c)} />
                </span>
              </Row>
            );
          })}
        </Section>
      )}
      {details && (
        <DetailsDialog item={details} owner={owner} chainTime={chainTime} onClose={() => setDetails(undefined)} />
      )}
    </>
  );
}

const DetailsButton = ({ onClick }: { onClick: () => void }) => (
  <button onClick={onClick} className={TEXT_BUTTON}>
    Details
  </button>
);

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="mt-4 first:mt-2">
    <h3 className="mb-2 px-1 text-sm text-white/50">{title}</h3>
    <ul className="flex flex-col gap-1">{children}</ul>
  </section>
);

// "Frontend dev · Acme Labs": the contract's title (or rate and period) and the company name. Never a worker name.
const rowTitle = (x: PendingOffer | Contract) => `${contractTitle(x)} · ${x.companyName || 'Unnamed company'}`;

type RowProps = {
  title: string;
  party?: string; // who it is with, when that is not just the company
  summary: ReactNode; // one short line: the rate and the start or what is claimable
  pay?: ReactNode;
  below?: ReactNode; // full width under the row, like the End form
  children: ReactNode;
};

// One offer or contract: title and company, who it is with, a short summary, an optional score line, and a badge or
// buttons on the right. The full terms are in Details.
const Row = ({ title, party, summary, pay, below, children }: RowProps) => (
  <li className="rounded-2xl border border-white/10 px-4 py-3">
    <div className="flex items-center justify-between gap-4">
      <span className="flex flex-col gap-1">
        <span className="block font-medium">{title}</span>
        {party && <span className="block text-sm text-white/60">{party}</span>}
        <span className="block text-sm text-white/55">{summary}</span>
        {pay}
      </span>
      {children}
    </div>
    {below}
  </li>
);

type EndPickerProps = {
  contract: Contract;
  byEmployer: boolean;
  chainTime: number;
  busy: boolean;
  onEnd: (at: number | null) => void; // null: the earliest end, computed again by the program
  onCancel: () => void;
};

// The End form under a running contract. A daily contract picks its last paid day (the program gets the midnight
// after it, like the propose form), an hourly one a full hour in UTC. Defaults to the earliest end the program
// allows: the last full period plus the notice for the employer, the last full period for the worker.
function EndPicker({ contract, byEmployer, chainTime, busy, onEnd, onCancel }: EndPickerProps) {
  const hourly = contract.period === HOUR;
  const earliest = earliestEnd(contract, byEmployer, chainTime);
  const toInput = (end: number) => (hourly ? toHourInput(end) : toDateInput(end - DAY));
  const [text, setText] = useState<string>(); // undefined until the user picks
  const value = text ?? toInput(earliest);
  const at = hourly ? Date.parse(`${value}Z`) / 1000 : Date.parse(`${value}T00:00:00Z`) / 1000 + DAY;
  const label = (end: number) => (hourly ? formatMoment(end) : formatDay(end - DAY));

  const problem = Number.isNaN(at)
    ? 'Pick a date'
    : at % contract.period !== 0
      ? 'Pick a full hour'
      : at < earliest
        ? `Earliest ${label(earliest)}`
        : at > lastFull(contract.period, chainTime) + MAX_END_AHEAD
          ? 'At most 366 days ahead'
          : null;
  const notice = formatNotice(contract.notice, contract.period);

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3">
      <label className="block">
        <span className={LABEL}>
          {hourly ? 'Pay stops at (UTC)' : 'Last paid day'}
          <Info
            text={
              byEmployer
                ? `${notice}: pay runs at least until ${label(earliest)}. You can pick a later date.`
                : 'You can stop now or pick a later date. Pay stops at the date you pick.'
            }
          />
        </span>
        <input
          type={hourly ? 'datetime-local' : 'date'}
          step={hourly ? 3600 : undefined}
          min={toInput(earliest)}
          value={value}
          onChange={(e) => setText(e.target.value)}
          className={`mt-1 block w-full text-sm ${INPUT}`}
        />
      </label>
      <span className="flex justify-end gap-3 text-sm">
        <button onClick={onCancel} className={TEXT_BUTTON}>
          Cancel
        </button>
        <button
          // An untouched or earliest pick sends null, so the end still holds if the day rolls over first.
          onClick={() => onEnd(text === undefined || at === earliest ? null : at)}
          disabled={busy || problem !== null}
          className="font-semibold text-red-300 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Ending…' : (problem ?? 'Confirm end')}
        </button>
      </span>
    </div>
  );
}

// "100 USDC claimable", or just "100 USDC" with `bare`. Green only while there is earned money to take.
function Claimable({ contract, chainTime, bare }: { contract: Contract; chainTime: number; bare?: boolean }) {
  const amount = claimable(contract, settle(contract.funding, chainTime).fundedUntil);
  return (
    <span className={amount > 0n ? 'text-[#40B66B]' : ''}>
      {formatUsdc(amount)}
      {!bare && ' claimable'}
    </span>
  );
}

// "1 USDC per day" or "0.1 USDC per hour".
const rateText = ({ rate, period }: { rate: bigint; period: number }) =>
  `${formatUsdc(rate)} per ${period === HOUR ? 'hour' : 'day'}`;

type DetailsProps = {
  item: PendingOffer | Contract;
  owner: Address;
  chainTime?: number;
  onClose: () => void;
};

// Every term of an offer or contract as a two-column table. Closes on Close, Escape or a click outside. Times are
// UTC. A daily end shows the last paid day, an hourly one the moment pay stops. Contracts add what is claimable
// and claimed.
function DetailsDialog({ item, owner, chainTime, onClose }: DetailsProps) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hourly = item.period === HOUR;
  const offer = 'proposer' in item ? item : null;
  const contract = 'claimed' in item ? item : null;
  const status = offer
    ? offer.proposer === owner
      ? 'Offer sent, waiting for the other side'
      : 'Offer received, waiting for you'
    : chainTime !== undefined && contract && ended(contract, chainTime)
      ? 'Ended'
      : 'Active';
  const end =
    item.end === null ? 'No end date' : hourly ? formatMoment(item.end) : `Last paid day ${formatDay(item.end - 1)}`;
  const address = (a: Address) => (
    <span className="font-mono text-sm break-all">
      {a}
      {a === owner && <span className="font-sans text-white/50"> (you)</span>}
    </span>
  );

  const rows: [string, ReactNode][] = [
    ['Status', status],
    ['Title', item.title || 'No title'],
    [
      'Company',
      <>
        {item.companyName || 'Unnamed company'}
        <Info text={NOT_VERIFIED} />
      </>,
    ],
    ['Company address', address(item.employer)],
    ['Worker address', address(item.employee)],
    ['Rate', rateText(item)],
    ['Pay days', hourly ? 'Every hour' : item.weekdaysOnly ? 'Mon-Fri, UTC' : 'Every day'],
    ['Notice', formatNotice(item.notice, item.period)],
    ['Start', formatMoment(item.start)],
    ['End', end],
  ];
  if (contract && chainTime !== undefined)
    rows.push(['Claimable', <Claimable contract={contract} chainTime={chainTime} bare />]);
  if (contract) rows.push(['Claimed', formatUsdc(contract.claimed)]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-label="Contract details"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-3xl border border-white/10 bg-[#131313] p-5">
        <p className="text-lg font-semibold">{rowTitle(item)}</p>
        <dl className="mt-4 divide-y divide-white/10 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[8.5rem_1fr] gap-3 py-2">
              <dt className="text-white/50">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className={`${SMALL_BUTTON} border border-white/15 hover:bg-white/5`}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

const Badge = ({ text, className }: { text: string; className: string }) => (
  <span className={`rounded-full px-3 py-1 text-xs font-medium ${className}`}>{text}</span>
);

// "2026-10-03", the UTC day of a unix time, as a date input wants it.
const toDateInput = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
// "2026-10-03T14:00", a UTC time as a datetime-local input wants it. The input has no zone, the form reads it as UTC.
const toHourInput = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 16);

type NewProps = Pick<Props, 'client' | 'owner' | 'pool' | 'chainTime' | 'notify'> & { onProposed: () => void };

type Side = 'hire' | 'work';
const SIDES: [Side, string][] = [
  ['hire', "I'm hiring"],
  ['work', "I'm working for"],
];

// New contract form. "I'm hiring" offers a worker a contract from the account's own pool, "I'm working for" asks a
// company for one from its pool. Then a plain address field (the worker's or the company's), an optional title like
// "Frontend dev", the pay period (day or hour), the rate per period, a weekdays-only toggle (daily only), the notice
// (7 days or 168 hours by default, 0 allowed), a start date in UTC (today on the chain by default) and an optional last
// working day. Propose sends propose(employee, rate, period, weekdaysOnly, start, end, title, notice) for the
// company's pool, signed by the account.
function NewContract({ client, owner, pool, chainTime, notify, onProposed }: NewProps) {
  const [side, setSide] = useState<Side>('hire');
  const [addressText, setAddressText] = useState('');
  const [titleText, setTitleText] = useState(''); // optional, like "Frontend dev"
  const [hourly, setHourly] = useState(false);
  const [rateText, setRateText] = useState('');
  const [weekdaysOnly, setWeekdaysOnly] = useState(false);
  const [noticeText, setNoticeText] = useState<string>(); // undefined until the user types: the period's default
  const [day, setDay] = useState<string>(); // undefined until the user picks a date
  const [lastDay, setLastDay] = useState(''); // empty for an open-ended contract
  const [busy, setBusy] = useState(false);

  const hiring = side === 'hire';
  const switcher = (
    <div className="mb-1 grid grid-cols-2 gap-1 rounded-2xl border border-white/10 p-1">
      {SIDES.map(([s, label]) => (
        <button
          key={s}
          onClick={() => setSide(s)}
          aria-pressed={s === side}
          className={`rounded-xl py-2 text-sm font-medium transition-colors ${
            s === side ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  // Hiring pays from the account's own pool, so it needs one. Working for a company does not.
  if (hiring && pool === undefined)
    return (
      <>
        {switcher}
        <Loading />
      </>
    );
  if (hiring && pool === null)
    return (
      <>
        {switcher}
        <EmptyState title="Create a pool first" text="Contracts are paid from your pool. Create it on the Pool tab." />
      </>
    );

  const typed = addressText.trim();
  const other = isAddress(typed) ? typed : null; // the worker when hiring, the company when working for one
  const rate = parseUsdc(rateText);
  const date = day ?? (chainTime === undefined ? '' : toDateInput(chainTime));
  // Midnight UTC of the picked day, in unix seconds. The program rejects any other time.
  const start = date ? Date.parse(`${date}T00:00:00Z`) / 1000 : NaN;
  // The program takes the midnight after the last working day: pay stops there.
  const end = lastDay ? Date.parse(`${lastDay}T00:00:00Z`) / 1000 + DAY : null;
  const title = titleText.trim();
  const noticeValue = noticeText ?? (hourly ? '168' : '7'); // 7 days either way
  // Periods, a u16 in the program.
  const notice = /^\d+$/.test(noticeValue) && Number(noticeValue) <= 65_535 ? Number(noticeValue) : null;

  const problem = !typed
    ? 'Enter an address'
    : !other
      ? 'Invalid address'
      : other === owner
        ? hiring
          ? "You can't hire yourself"
          : "You can't work for yourself"
        : !rate
          ? `Enter ${hourly ? 'an hourly' : 'a daily'} rate`
          : Number.isNaN(start)
            ? 'Pick a start date'
            : end !== null && !(end > start)
              ? 'Last working day is before the start'
              : byteLength(title) > MAX_NAME_BYTES
                ? 'Title is too long'
                : notice === null
                  ? 'Enter the notice as a whole number'
                  : null;

  const propose = async () => {
    if (problem || !other || !rate || notice === null) return;
    setBusy(true);
    const [employer, employee] = hiring ? [owner, other] : [other, owner];
    const labels = {
      success: `Proposed contract to ${shortAddress(other)}`,
      failure: 'Could not propose the contract',
    };
    // Without a pool the program fails with Anchor's generic "expected this account to be already initialized".
    if (!hiring && (await getPool(employer).catch(() => undefined)) === null) {
      notify({
        title: `${labels.failure}: ${shortAddress(employer)} has no pool yet`,
        error: true,
      });
      setBusy(false);
      return;
    }
    const ok = await sendWithToast(client, notify, labels, () =>
      client.easypay.instructions
        .propose({
          proposer: client.identity,
          employer,
          employee,
          rate,
          period: hourly ? Period.Hour : Period.Day,
          weekdaysOnly: !hourly && weekdaysOnly,
          start: BigInt(start),
          end: end === null ? null : BigInt(end),
          title,
          notice,
        })
        .sendTransaction(),
    );
    setBusy(false);
    if (ok) onProposed();
  };

  return (
    <div className="flex flex-col gap-1">
      {switcher}
      <label className={`block ${FIELD}`}>
        <span className={LABEL}>{hiring ? 'Worker address' : 'Company address'}</span>
        <input
          value={addressText}
          onChange={(e) => setAddressText(e.target.value)}
          placeholder={hiring ? "Paste the worker's address" : "Paste the company's address"}
          spellCheck={false}
          className={`mt-1 block w-full font-mono text-sm ${INPUT}`}
        />
      </label>
      <label className={`block ${FIELD}`}>
        <span className={LABEL}>Title (optional)</span>
        <input
          value={titleText}
          onChange={(e) => setTitleText(e.target.value)}
          placeholder="Frontend dev"
          className={`mt-1 block w-full text-sm ${INPUT}`}
        />
      </label>
      <label className={`flex items-center justify-between ${FIELD}`}>
        <span className={LABEL}>Pay period</span>
        <select
          value={hourly ? 'hour' : 'day'}
          onChange={(e) => setHourly(e.target.value === 'hour')}
          className={`text-sm font-medium ${INPUT}`}
        >
          <option value="day">Per day</option>
          <option value="hour">Per hour</option>
        </select>
      </label>
      <label className={`block ${FIELD}`}>
        <span className={LABEL}>{hourly ? 'Hourly rate' : 'Daily rate'}</span>
        <span className="mt-1 flex items-center gap-2">
          <input
            inputMode="decimal"
            placeholder="0"
            value={rateText}
            onChange={(e) => setRateText(e.target.value)}
            className={`w-full min-w-0 text-4xl tabular-nums ${INPUT}`}
          />
          <span className="text-lg font-semibold text-white/50">USDC</span>
        </span>
      </label>
      {!hourly && (
        <label className={`flex cursor-pointer items-center justify-between ${FIELD}`}>
          <span className={LABEL}>
            Weekdays only
            <Info text="Pays Monday to Friday, days counted in UTC" />
          </span>
          <input
            type="checkbox"
            checked={weekdaysOnly}
            onChange={(e) => setWeekdaysOnly(e.target.checked)}
            className="h-5 w-5 accent-[#9945FF]"
          />
        </label>
      )}
      <label className={`flex items-center justify-between ${FIELD}`}>
        <span className={LABEL}>
          {hourly ? 'Notice in hours' : 'Notice in days'}
          <Info text="Pay keeps running this long after the company ends the contract. The pool always keeps it. 0 for none" />
        </span>
        <input
          inputMode="numeric"
          value={noticeValue}
          onChange={(e) => setNoticeText(e.target.value)}
          className={`w-24 text-right text-sm tabular-nums ${INPUT}`}
        />
      </label>
      <label className={`block ${FIELD}`}>
        <span className={LABEL}>
          Start date
          <Info text="Pay starts at midnight UTC of this day" />
        </span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDay(e.target.value)}
          className={`mt-1 block w-full text-lg ${INPUT}`}
        />
      </label>
      <label className={`block ${FIELD}`}>
        <span className={LABEL}>
          Last working day (optional)
          <Info text="Last paid day, in UTC. Leave empty for no end date" />
        </span>
        <input
          type="date"
          value={lastDay}
          onChange={(e) => setLastDay(e.target.value)}
          className={`mt-1 block w-full text-lg ${INPUT}`}
        />
      </label>
      <button onClick={propose} disabled={problem !== null || busy} className={`${BUTTON} mt-1`}>
        {busy ? 'Proposing…' : (problem ?? 'Propose')}
      </button>
    </div>
  );
}
