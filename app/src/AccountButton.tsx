import { useState, type ReactNode } from 'react';
import type { Role, TestAccount } from './accounts';
import type { Balances } from './chain';
import { formatSol, formatUsdc, shortAddress } from './format';
import type { Notify } from './Toasts';

const AVATAR: Record<Role, string> = {
  Company: 'bg-[#9945FF]',
  Pawel: 'bg-sky-500',
  Sebastian: 'bg-amber-500',
  Mom: 'bg-pink-500',
  Taxes: 'bg-emerald-500',
};

// Small colored circle with the role's first letter.
const Avatar = ({ role }: { role: Role }) => (
  <span
    aria-hidden
    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${AVATAR[role]}`}
  >
    {role[0]}
  </span>
);

const COPIED_MS = 1500;

type Props = {
  label: string; // who the address is, for the copy toast: "Company" or "Phantom"
  address: string;
  balances?: Balances;
  notify: Notify;
  children?: ReactNode; // rightmost control: the test account switcher on Local, Disconnect on Devnet
};

// Top-right account bar: the active account's SOL and USDC, its address (click copies it), then `children`.
// The control sits rightmost with a fixed width, so a balance update never moves it.
export function AccountButton({ label, address, balances, notify, children }: Props) {
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    await navigator.clipboard.writeText(address);
    notify({ title: `Copied ${label} address ${shortAddress(address)}` });
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className="flex items-center gap-3">
      <span
        data-testid="balances"
        aria-live="polite"
        className="text-sm whitespace-nowrap tabular-nums"
      >
        {balances ? (
          <>
            {formatSol(balances.lamports)}
            <span className="mx-1.5">·</span>
            {formatUsdc(balances.usdc)}
          </>
        ) : (
          <span className="inline-block h-3 w-32 animate-pulse rounded-full bg-white/10 align-middle" />
        )}
      </span>

      <button
        onClick={copyAddress}
        aria-label={`Copy ${label} address`}
        title="Copy address"
        className="flex items-center gap-1.5 rounded-full px-2 py-1 font-mono text-sm text-[#B98BFF] transition-colors hover:text-white"
      >
        {shortAddress(address)}
        <svg viewBox="0 0 24 24" aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
          {copied ? (
            <path d="M5 12l5 5L20 7" />
          ) : (
            <>
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </>
          )}
        </svg>
      </button>

      {children}
    </div>
  );
}

type SwitchProps = { accounts: TestAccount[]; active: Role; onSwitch: (role: Role) => void };

// Local only: one button per test account.
export const TestAccountSwitch = ({ accounts, active, onSwitch }: SwitchProps) => (
  <div role="group" aria-label="Test account" className="flex gap-1">
    {accounts.map(({ role }) => (
      <button
        key={role}
        onClick={() => onSwitch(role)}
        aria-pressed={role === active}
        className={`flex items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm whitespace-nowrap transition-colors ${
          role === active ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white'
        }`}
      >
        <Avatar role={role} />
        {role}
      </button>
    ))}
  </div>
);
