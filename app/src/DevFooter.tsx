import { useState } from 'react';
import { resetTestAccounts } from './accounts';
import { RPC_URL, timeTravel } from './chain';
import { formatChainDate } from './format';
import { seedDemo } from './seed';
import type { Notify } from './Toasts';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

type Props = {
  chainTime?: number;
  offline: boolean;
  accountsShown: boolean;
  onToggleAccounts: () => void;
  notify: Notify;
  onDone: () => void;
};

// Local-only dev tools, styled apart from the product: chain date, time travel, the test account switcher toggle,
// and fresh test accounts, empty (reset) or with demo data (seed demo, see seed.ts). Time goes through Surfpool
// cheatcodes. onDone re-reads the chain.
export function DevFooter({ chainTime, offline, accountsShown, onToggleAccounts, notify, onDone }: Props) {
  const [busy, setBusy] = useState<string>(); // the label of the running button

  // Runs one button's action. Failures become a red toast.
  const run = (label: string, action: () => Promise<void>) => async () => {
    setBusy(label);
    try {
      await action();
    } catch (e) {
      notify({ title: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy(undefined);
      onDone();
    }
  };
  const travel = (label: string, seconds: number) => run(label, () => timeTravel(seconds));
  // New accounts mean new signers everywhere, so the page reloads on the Company account.
  const fresh = (label: string, action: () => Promise<unknown>) =>
    run(label, async () => {
      await action();
      localStorage.setItem('easypay.role', 'Company');
      location.reload();
    });

  const locked = !!busy || offline;
  const buttons: [string, () => void, boolean][] = [
    ['+1 day', travel('+1 day', DAY), locked],
    ['+10 days', travel('+10 days', 10 * DAY), locked],
    ['+100 days', travel('+100 days', 100 * DAY), locked],
    ['+1 hour', travel('+1 hour', HOUR), locked],
    [accountsShown ? 'hide accounts' : 'show accounts', onToggleAccounts, false],
    ['seed demo', fresh('seed demo', seedDemo), locked],
    ['reset', fresh('reset', resetTestAccounts), locked],
  ];

  return (
    <footer className="fixed inset-x-0 bottom-0 z-10 border-t border-dashed border-amber-400/40 bg-[#0b0b0b] font-mono text-xs">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
        <span className="rounded bg-amber-400/15 px-2 py-0.5 font-semibold tracking-wider text-amber-300">DEV</span>
        <span data-testid="chain-date" className="whitespace-nowrap text-amber-100/80">
          {offline
            ? `Local chain unreachable at ${RPC_URL}. Is pnpm dev running?`
            : chainTime
              ? `Chain time: ${formatChainDate(chainTime)}`
              : 'Chain time: ...'}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {buttons.map(([label, onClick, disabled]) => (
            <button
              key={label}
              onClick={onClick}
              disabled={disabled}
              className="rounded border border-amber-400/30 px-3 py-1 whitespace-nowrap text-amber-200 hover:bg-amber-400/10 disabled:opacity-40"
            >
              {busy === label ? `${label}…` : label}
            </button>
          ))}
        </div>
      </div>
    </footer>
  );
}
