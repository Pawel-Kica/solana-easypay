import { unwrapOption, type Address, type Signature } from '@solana/kit';
import { useEffect, useState } from 'react';
import {
  ASSET_NAMES,
  AUTOCLAIM_KEY,
  claimedIn,
  getContracts,
  getLandedTransaction,
  getSplit,
  signText,
  UNREACHABLE_HINT,
  USDC_DECIMALS,
  type Contract,
  type SigningClient,
} from './chain';
import { sendClaim } from './claim';
import { EmptyState } from './EmptyState';
import { formatDuration, formatUsdc, shortAddress } from './format';
import { Asset, type Split } from './generated';
import { decryptLabels, LABELS_LEN } from './labels';
import { claimable, ended, nextPay, settle } from './pay';
import { ShortNote } from './ShortNote';
import { SplitView, walletPct } from './SplitView';
import type { Notify } from './Toasts';
import { sendWithToast } from './tx';
import { BUTTON, Loading, TEXT_BUTTON, Tabs, useStoredState } from './ui';

const VIEWS = ['Claim', 'Split'] as const;

type Props = {
  client: SigningClient;
  owner: Address;
  chainTime?: number;
  notify: Notify;
  onDone: () => void; // re-reads balances after a transaction
};

// Claim tab: what the account can claim as a worker, summed over its contracts in every pool, a bar to the
// soonest next pay, where the claim goes, and Claim. The Split view edits where it goes. Contracts and the split
// are read when the tab opens and after a transaction. The numbers come from
// chain time with the program's formula (pay.ts), so they only change when a day or hour completes.
export function ClaimTab({ client, owner, chainTime, notify, onDone }: Props) {
  const [contracts, setContracts] = useState<Contract[] | null>(); // undefined while loading, null if it failed
  const [split, setSplit] = useState<Split | null>(null); // null: no split saved, everything goes to the wallet
  const [labels, setLabels] = useState<string[]>([]); // the split's decrypted labels, in recipient order
  const [view, setView] = useStoredState('easypay.claim.view', 'Claim', VIEWS);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([getContracts(owner), getSplit(owner)]).then(
      ([{ contracts }, split]) => {
        if (!alive) return;
        setContracts(contracts.filter((c) => c.employee === owner));
        setSplit(split);
        // Asks the wallet for a signature only when the split has labels and this browser has no key yet.
        if (split) decryptLabels(owner, split.labels, signText(client.identity)).then((l) => alive && setLabels(l));
      },
      () => alive && setContracts(null),
    );
    return () => {
      alive = false;
    };
  }, [owner, tick, client]);

  if (contracts === undefined || chainTime === undefined)
    return <Loading />;
  if (contracts === null) return <EmptyState title="Could not read your contracts" text={UNREACHABLE_HINT} />;
  const tabs = (
    <div className="mb-1">
      <Tabs tabs={VIEWS} value={view} onChange={setView} label="Claim or split" />
    </div>
  );
  if (view === 'Split')
    return (
      <>
        {tabs}
        <SplitView
          key={`${tick}-${labels.join('\n')}`}
          client={client}
          owner={owner}
          split={split}
          labels={labels}
          notify={notify}
          onSaved={() => {
            setTick((t) => t + 1);
            setView('Claim');
          }}
        />
      </>
    );
  if (!contracts.length)
    return (
      <>
        {tabs}
        <EmptyState title="Nothing to claim" text="Pay from your contracts shows up here after each completed day or hour." />
      </>
    );

  // Each pool settles on its own: a short pool pays its contracts only up to its shared full hour.
  const pay = contracts.map((c) => ({ contract: c, ...settle(c.funding, chainTime) }));
  const due = pay.filter(({ contract, fundedUntil }) => claimable(contract, fundedUntil) > 0n);
  const total = due.reduce((sum, { contract, fundedUntil }) => sum + claimable(contract, fundedUntil), 0n);
  // One note per short pool. A worker usually has one.
  const short = [...new Map(pay.filter((p) => p.dry).map((p) => [p.contract.pool, p.fundedUntil])).values()];
  // Ended contracts have no next pay. Without a running contract the bar is hidden.
  const running = contracts.filter((c) => !ended(c, chainTime));
  const pays = running.map((c) => ({ at: nextPay(c, chainTime), period: c.period }));
  const soonest = pays.length ? pays.reduce((a, b) => (b.at < a.at ? b : a)) : null;
  // Share of the current day or hour gone. 0 for a contract that has not started yet.
  const progress = soonest ? Math.min(Math.max((chainTime - (soonest.at - soonest.period)) / soonest.period, 0), 1) : 0;

  // Where the claim goes: each split address and the invest share their percent, rounded down like the program does
  // (per contract there, so a base unit may differ), the wallet the rest.
  const recipients = split?.recipients ?? [];
  const shares = recipients.map((r) => ({ ...r, amount: (total * BigInt(r.pct)) / 100n }));
  const investPct = split?.investPct ?? 0;
  const invest = (total * BigInt(investPct)) / 100n;
  const toWallet = total - invest - shares.reduce((sum, r) => sum + r.amount, 0n);

  // One transaction for every contract with something to pay, built in claim.ts. When the exchange could not swap,
  // the Claimed events say so and the worker hears the invest share came as USDC.
  const claim = async () => {
    setBusy(true);
    const labels = { success: `Claimed ${formatUsdc(total)}`, failure: 'Claim failed' };
    let signature: Signature | undefined;
    const ok = await sendWithToast(client, notify, labels, async () => {
      const sent = await sendClaim(
        client,
        owner,
        split,
        due.map(({ contract: c }) => ({ pool: c.pool, slot: c.slot })),
      );
      signature = sent.context.signature;
      return sent;
    });
    if (ok && signature && investPct > 0) {
      const landed = await getLandedTransaction(signature).catch(() => null);
      if (landed && claimedIn(landed.logs).some((e) => e.fellBack))
        notify({ title: 'Exchange unavailable, you got USDC', error: true });
    }
    setBusy(false);
    setTick((t) => t + 1);
    onDone();
  };

  // The auto-claim switch: set_split with the same split and claimer set to our server's key, or none. Only the
  // worker signs it. The server then claims within a minute of each completed day or hour, the worker still can.
  const autoClaim = split !== null && unwrapOption(split.claimer) === AUTOCLAIM_KEY;
  const toggleAutoClaim = async () => {
    setBusy(true);
    const on = !autoClaim;
    await sendWithToast(
      client,
      notify,
      { success: `Auto-claim ${on ? 'on' : 'off'}`, failure: 'Changing auto-claim failed' },
      async () =>
        client.sendTransaction([
          await client.easypay.instructions.setSplit({
            employee: client.identity,
            recipients: split?.recipients ?? [],
            investPct: split?.investPct ?? 0,
            investAsset: split?.investAsset ?? Asset.Sol,
            claimer: on ? AUTOCLAIM_KEY : null,
            labels: split?.labels ?? new Uint8Array(LABELS_LEN),
          }),
        ]),
    );
    setBusy(false);
    setTick((t) => t + 1);
    onDone();
  };

  const usdc = Number(total) / 10 ** USDC_DECIMALS;
  return (
    <>
      {tabs}
      <div className="pt-6 pb-2 text-center">
        <p className="text-sm text-white/50">Claimable</p>
        <p
          data-testid="claimable"
          className={`mt-1 text-5xl font-semibold tabular-nums ${total > 0n ? 'text-[#40B66B]' : 'text-white/40'}`}
        >
          {usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          <span className="ml-2 text-2xl text-white/40">USDC</span>
        </p>
      </div>
      {short.map((fundedUntil) => (
        <ShortNote key={fundedUntil} fundedUntil={fundedUntil} />
      ))}
      {soonest && (
        <div className="mt-4 rounded-2xl border border-white/10 p-4">
          <div className="h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-[#9945FF] transition-[width] duration-700" style={{ width: `${progress * 100}%` }} />
          </div>
          <p data-testid="next-pay" className="mt-2 text-sm text-white/50">
            Next pay in {formatDuration(soonest.at - chainTime)}
          </p>
        </div>
      )}
      <div className="mt-4 rounded-2xl border border-white/10 p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-white/50">Where it goes</p>
          <button onClick={() => setView('Split')} className={TEXT_BUTTON}>
            Edit
          </button>
        </div>
        <ul data-testid="where-it-goes" className="mt-2 space-y-1 text-sm">
          <li className="flex justify-between">
            <span>My wallet</span>
            <span className="tabular-nums">
              {walletPct(split)}% · {formatUsdc(toWallet)}
            </span>
          </li>
          {shares.map((r, i) => (
            <li key={r.owner} className="flex justify-between">
              <span>
                {labels[i] || 'Address'} <span className="font-mono text-sm text-white/55">{shortAddress(r.owner)}</span>
              </span>
              <span className="tabular-nums">
                {r.pct}% · {formatUsdc(r.amount)}
              </span>
            </li>
          ))}
          {investPct > 0 && split && (
            <li className="flex justify-between">
              <span>Invest in {ASSET_NAMES[split.investAsset]}</span>
              <span className="tabular-nums">
                {investPct}% · {formatUsdc(invest)}
              </span>
            </li>
          )}
        </ul>
      </div>
      <label className="mt-4 flex items-center justify-between rounded-2xl border border-white/10 p-4 text-sm">
        <span>
          Auto-claim every day
          <span className="block text-sm text-white/55">Our server claims for you, following your split</span>
        </span>
        <input
          type="checkbox"
          data-testid="auto-claim"
          checked={autoClaim}
          disabled={busy}
          onChange={toggleAutoClaim}
          className="h-5 w-5 accent-[#9945FF]"
        />
      </label>
      <button onClick={claim} disabled={total === 0n || busy} className={`${BUTTON} mt-2`}>
        {busy ? 'Claiming…' : total > 0n ? 'Claim' : 'Nothing to claim yet'}
      </button>
    </>
  );
}
