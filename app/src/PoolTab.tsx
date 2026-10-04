import { useEffect, useRef, useState } from 'react';
import { explorerAddressUrl, USDC_DECIMALS, USDC_MINT, type PoolState, type SigningClient } from './chain';
import { byteLength, formatDay, formatMoment, formatUsdc, MAX_NAME_BYTES, parseUsdc, shortAddress, usdcText } from './format';
import { coveredUntil, covers, DAY, HOUR, locked, owed, settle, withdrawable } from './pay';
import { EmptyState } from './EmptyState';
import { ShortNote } from './ShortNote';
import type { Notify } from './Toasts';
import { sendWithToast } from './tx';
import { BUTTON, FIELD, INPUT, LABEL, Info, Loading, TEXT_BUTTON, Tabs, useStoredState } from './ui';

type Props = {
  client: SigningClient;
  pool: PoolState | null | undefined; // undefined while loading, null when the account has no pool
  walletUsdc?: bigint;
  chainTime?: number;
  notify: Notify;
  onDone: () => void; // re-reads the chain after a transaction
};

const VIEWS = ['Deposit', 'Withdraw', 'Summary'] as const;
// localStorage key of the open sub-tab, so a refresh keeps it. App resets it to Deposit from the runway banner.
export const POOL_VIEW_KEY = 'easypay.pool.view';

// Pool tab. Without a pool: the form that creates it. With a pool: the Deposit, Withdraw and Summary sub-tabs.
// Deposit and Withdraw show the big balance over their form, Summary what the balance is made of. The numbers come
// from chain time (pay.ts).
export function PoolTab({ client, pool, walletUsdc, chainTime, notify, onDone }: Props) {
  const [view, setView] = useStoredState(POOL_VIEW_KEY, 'Deposit', VIEWS);

  if (pool === null) return <CreatePool client={client} notify={notify} onDone={onDone} />;
  if (pool === undefined || chainTime === undefined)
    return <Loading />;
  const { fundedUntil, dry } = settle(pool, chainTime);
  return (
    <>
      <Tabs tabs={VIEWS} value={view} onChange={setView} label="Pool view" />
      {dry && <ShortNote fundedUntil={fundedUntil} />}
      {view === 'Summary' ? (
        <PoolSummary pool={pool} chainTime={chainTime} />
      ) : (
        <>
          <PoolBalance pool={pool} />
          {view === 'Deposit' ? (
            <DepositForm client={client} walletUsdc={walletUsdc} notify={notify} onDone={onDone} />
          ) : (
            <WithdrawForm client={client} max={withdrawable(pool, chainTime)} notify={notify} onDone={onDone} />
          )}
        </>
      )}
    </>
  );
}

// Empty state with the next step: the company name, then create_pool(name) for the current account and Circle's USDC.
// The name is whatever the company types, workers see it marked as not verified.
function CreatePool({ client, notify, onDone }: Pick<Props, 'client' | 'notify' | 'onDone'>) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const problem = !trimmed ? 'Enter a company name' : byteLength(trimmed) > MAX_NAME_BYTES ? 'Name is too long' : null;

  const create = async () => {
    if (problem) return;
    setBusy(true);
    const labels = { success: `Pool ${trimmed} created`, failure: 'Could not create the pool' };
    await sendWithToast(client, notify, labels, () =>
      client.easypay.instructions
        .createPool({ employer: client.identity, mint: USDC_MINT, name: trimmed })
        .sendTransaction(),
    );
    setBusy(false);
    onDone();
  };

  return (
    <EmptyState title="You have no pool" text="Create one and deposit USDC to pay your team every day.">
      <label className={`mb-2 block text-left ${FIELD}`}>
        <span className={LABEL}>
          Company name
          <Info text="Workers see it next to your address, marked as not verified" />
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Labs"
          className={`mt-1 block w-full text-lg ${INPUT}`}
        />
      </label>
      <button onClick={create} disabled={busy || problem !== null} className={BUTTON}>
        {busy ? 'Creating…' : (problem ?? 'Create pool')}
      </button>
    </EmptyState>
  );
}

// Big vault balance. It counts up or down when the balance changes.
function PoolBalance({ pool }: { pool: PoolState }) {
  const target = Number(pool.balance) / 10 ** USDC_DECIMALS;
  const shown = useCountUp(target);

  return (
    <div className="pt-6 pb-2 text-center">
      <p className="text-sm text-white/50">Pool balance</p>
      <p
        data-testid="pool-balance"
        className={`mt-1 text-5xl font-semibold tabular-nums transition-colors ${shown === target ? '' : 'text-[#B98BFF]'}`}
      >
        {shown.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        <span className="ml-2 text-2xl text-white/40">USDC</span>
      </p>
      <a
        href={explorerAddressUrl(pool.vault)}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block font-mono text-sm text-white/55 hover:text-[#B98BFF]"
      >
        Vault {shortAddress(pool.vault)} ↗
      </a>
    </div>
  );
}

const COUNT_UP_MS = 700;

// Follows `target` with a short ease-out count, so a deposit visibly lands in the number.
function useCountUp(target: number) {
  const [shown, setShown] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min((now - start) / COUNT_UP_MS, 1);
      current.current = t < 1 ? from + (target - from) * (1 - (1 - t) ** 3) : target;
      setShown(current.current);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return shown;
}

// Summary sub-tab: what the balance is made of. The program keeps two parts locked: pay the workers earned and have
// not claimed, and the notice reserve, every contract's next N periods (pay.ts `locked` minus earned). The rest the
// employer can withdraw. Covers: whole days (hours in an hourly pool) of team pay the balance funds past what is
// earned, the notice reserve included, and the date they run out. The bar splits the three parts by size.
function PoolSummary({ pool, chainTime }: { pool: PoolState; chainTime: number }) {
  const earned = owed(pool.contracts, settle(pool, chainTime).fundedUntil);
  const reserve = locked(pool.contracts, chainTime) - earned;
  const free = withdrawable(pool, chainTime);
  const runway = covers(pool, chainTime);
  const until = coveredUntil(pool, chainTime);
  const unit = runway?.period === HOUR ? 'hour' : 'day';

  return (
    <>
      <dl className="mt-4 grid grid-cols-2 gap-2">
        <Tile label="Waiting to be claimed" value={formatUsdc(earned)} green={earned > 0n} />
        <Tile label="Withdrawable" value={formatUsdc(free)} />
        <Tile
          label="Covers"
          value={runway ? `${runway.periods} ${unit}${runway.periods === 1n ? '' : 's'}` : 'No contracts'}
          sub={until === null ? undefined : unit === 'hour' ? `until ${formatMoment(until)}` : `paid through ${formatDay(until - DAY)}`}
        />
        <Tile label="Team pay" value={formatUsdc(runway?.teamRate ?? 0n)} sub={`per ${unit}`} />
      </dl>
      <PoolBar parts={[earned, reserve, free]} />
      <dl className="mt-3 flex flex-col gap-1 text-sm text-white/50">
        {BAR.map(({ label, color, info }, i) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${color}`} />
            <dt>
              {label}
              {info && <Info text={info} />}
            </dt>
            <dd className="text-white">{formatUsdc([earned, reserve, free][i])}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

// The bar's parts in order, with their legend label. Green only for what workers earned.
const BAR = [
  { label: 'Earned', color: 'bg-[#40B66B]' },
  {
    label: 'Notice reserve',
    color: 'bg-white/40',
    info: "Pay for every contract's notice period. You can't withdraw it, so workers are paid even if you end their contract today",
  },
  { label: 'Withdrawable', color: 'bg-[#9945FF]' },
];

// One number of the Summary grid: a label, the value and an optional small line under it.
function Tile({ label, value, sub, green }: { label: string; value: string; sub?: string; green?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 p-3">
      <dt className="text-sm text-white/50">{label}</dt>
      <dd className={`mt-1 text-xl font-semibold tabular-nums ${green ? 'text-[#40B66B]' : ''}`}>
        {value}
        {sub && <span className="block text-sm font-normal text-white/55">{sub}</span>}
      </dd>
    </div>
  );
}

// Thick bar of earned, notice reserve and withdrawable, each as wide as its share. Empty pool: just the outline.
function PoolBar({ parts }: { parts: bigint[] }) {
  const total = parts.reduce((sum, p) => sum + p, 0n);
  return (
    <div className="mt-4 flex h-8 gap-0.5 overflow-hidden rounded-xl border border-white/10">
      {total > 0n &&
        parts.map((part, i) =>
          part > 0n ? (
            <span key={BAR[i].label} className={BAR[i].color} style={{ width: `${(Number(part) / Number(total)) * 100}%` }} />
          ) : null,
        )}
    </div>
  );
}

// Deposit sub-tab: an amount in USDC (up to 6 decimals), sent to deposit(amount) in base units.
function DepositForm({ client, walletUsdc, notify, onDone }: Omit<Props, 'pool' | 'chainTime'>) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const amount = parseUsdc(text);

  const deposit = async () => {
    if (!amount) return;
    setBusy(true);
    const labels = { success: `Deposited ${formatUsdc(amount)}`, failure: 'Deposit failed' };
    const ok = await sendWithToast(client, notify, labels, () =>
      client.easypay.instructions.deposit({ employer: client.identity, mint: USDC_MINT, amount }).sendTransaction(),
    );
    if (ok) setText('');
    setBusy(false);
    onDone();
  };

  return (
    <>
      <AmountInput
        label="You deposit"
        text={text}
        onChange={setText}
        hint={`Wallet: ${walletUsdc === undefined ? '…' : formatUsdc(walletUsdc)}`}
      />
      <button onClick={deposit} disabled={!amount || busy} className={`${BUTTON} mt-2`}>
        {busy ? 'Depositing…' : amount ? 'Deposit' : 'Enter an amount'}
      </button>
    </>
  );
}

type WithdrawProps = Pick<Props, 'client' | 'notify' | 'onDone'> & { max: bigint };

// Withdraw sub-tab: an amount sent to withdraw(amount), and Max with what the program allows now (`max`).
// A bigger amount is still sent: the program refuses it on chain and the toast says why.
function WithdrawForm({ client, max, notify, onDone }: WithdrawProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const amount = parseUsdc(text);

  const withdraw = async () => {
    if (!amount) return;
    setBusy(true);
    const labels = { success: `Withdrew ${formatUsdc(amount)}`, failure: 'Withdraw failed' };
    const ok = await sendWithToast(client, notify, labels, () =>
      client.easypay.instructions.withdraw({ employer: client.identity, mint: USDC_MINT, amount }).sendTransaction(),
    );
    if (ok) setText('');
    setBusy(false);
    onDone();
  };

  return (
    <>
      <AmountInput
        label="You withdraw"
        text={text}
        onChange={setText}
        hint={`Withdrawable: ${formatUsdc(max)}`}
        onMax={() => setText(usdcText(max))}
      />
      <button onClick={withdraw} disabled={!amount || busy} className={`${BUTTON} mt-2`}>
        {busy ? 'Withdrawing…' : amount ? 'Withdraw' : max > 0n ? 'Enter an amount' : 'Nothing to withdraw'}
      </button>
    </>
  );
}

type AmountProps = { label: string; text: string; onChange: (text: string) => void; hint: string; onMax?: () => void };

// The big USDC amount field of both sub-tabs. With onMax it gets a Max button.
function AmountInput({ label, text, onChange, hint, onMax }: AmountProps) {
  return (
    <label className={`block ${FIELD}`}>
      <span className={LABEL}>{label}</span>
      <span className="mt-1 flex items-center gap-2">
        <input
          inputMode="decimal"
          placeholder="0"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full min-w-0 text-4xl tabular-nums ${INPUT}`}
        />
        {onMax && (
          <button
            type="button"
            onClick={onMax}
            className={TEXT_BUTTON}
          >
            Max
          </button>
        )}
        <span className="text-lg font-semibold text-white/50">USDC</span>
      </span>
      <span className="mt-2 block text-sm text-white/55">{hint}</span>
    </label>
  );
}
