import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { shortAddress } from './format';

// Shared look, so every tab matches. New UI uses these instead of its own class strings.

// Full-width primary action at the bottom of a card.
export const BUTTON =
  'flex h-12 w-full items-center justify-center rounded-2xl bg-[#9945FF] text-base font-semibold text-white transition hover:bg-[#8a3ef0] active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-[#9945FF]/15 disabled:text-[#B98BFF]/70 disabled:active:scale-100';

// Small pill action inside a row, like Accept or Cancel.
export const SMALL_BUTTON =
  'rounded-full px-4 py-1.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40';

// Secondary action as purple text, like Max, Details or End contract. Never grey, so it reads as a button.
export const TEXT_BUTTON =
  'rounded-full px-2 py-1 text-sm font-semibold text-[#B98BFF] transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';

// Wrapper for a LABEL heading and its INPUT, or a row of numbers. No border of its own: the card and the input
// already have one.
export const FIELD = 'py-2';

// Small heading above an input.
export const LABEL = 'text-sm font-medium text-white';

// Every text, number, date and select input, inside a FIELD. Its own thin box so you can see where to type.
// Add the width at the call site.
export const INPUT =
  'rounded-xl border border-white/20 bg-transparent px-3 py-2 outline-none placeholder:text-white/30 [color-scheme:dark] focus:border-[#9945FF]/60';

// Value persisted in localStorage under `key`. A stored value that `valid` rejects falls back to `initial`.
export function useStoredState<T extends string>(key: string, initial: T, valid: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    const saved = localStorage.getItem(key) as T | null;
    return saved && valid.includes(saved) ? saved : initial;
  });
  const set = (next: T) => {
    localStorage.setItem(key, next);
    setValue(next);
  };
  return [value, set] as const;
}

type TabsProps<T extends string> = {
  tabs: readonly T[];
  value: T;
  onChange: (tab: T) => void;
  label: string; // read by screen readers
  names?: Partial<Record<T, ReactNode>>; // shown content when it differs from the value, like a name with a dot
  size?: 'md' | 'sm';
};

// Pill tabs. Arrow keys move between them, only the selected one is in the Tab order.
export function Tabs<T extends string>({ tabs, value, onChange, label, names, size = 'sm' }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = (tabs.indexOf(value) + step + tabs.length) % tabs.length;
    onChange(tabs[i]);
    refs.current[i]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1">
      {tabs.map((t, i) => (
        <button
          key={t}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          aria-selected={t === value}
          tabIndex={t === value ? 0 : -1}
          onClick={() => onChange(t)}
          className={`rounded-full font-medium transition-colors ${size === 'md' ? 'px-4 py-2 text-base' : 'px-3 py-1 text-sm'} ${
            t === value ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white'
          }`}
        >
          {names?.[t] ?? t}
        </button>
      ))}
    </div>
  );
}

// Small colored circle with a letter, number or icon, like the account avatars in the header.
export const Badge = ({ bg, small, children }: { bg: string; small?: boolean; children: ReactNode }) => (
  <span
    aria-hidden
    className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${bg} ${
      small ? 'h-3.5 w-3.5 text-[9px]' : 'h-6 w-6 text-xs'
    }`}
  >
    {children}
  </span>
);

const COINS: Record<string, { bg: string; glyph: string }> = {
  SOL: { bg: 'bg-gradient-to-br from-[#9945FF] to-[#14F195]', glyph: '◎' },
  USDC: { bg: 'bg-[#2775CA]', glyph: '$' },
  BTC: { bg: 'bg-[#F7931A]', glyph: '₿' },
  ETH: { bg: 'bg-[#627EEA]', glyph: 'Ξ' },
};

// Coin icon by ticker: SOL, USDC, BTC or ETH.
export const CoinIcon = ({ name, small }: { name: string; small?: boolean }) => (
  <Badge bg={COINS[name]?.bg ?? 'bg-white/20'} small={small}>
    {COINS[name]?.glyph ?? name[0]}
  </Badge>
);

// Placeholder while a tab reads the chain. Same height as an empty state, so the card doesn't jump.
export const Loading = () => (
  <div aria-busy="true" aria-label="Loading" className="flex h-44 items-center justify-center">
    <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-[#B98BFF]" />
  </div>
);

// Small "i" icon that shows `text` in a bubble on hover or focus. Use it instead of a description line under a field.
// A click does nothing, so inside a label it doesn't toggle the checkbox.
export const Info = ({ text }: { text: string }) => (
  <span
    tabIndex={0}
    aria-label={text}
    onClick={(e) => e.preventDefault()}
    className="group relative ml-1 inline-flex align-middle outline-none"
  >
    <span className="flex h-4 w-4 items-center justify-center rounded-full border border-white/30 text-[10px] font-semibold text-white/50 group-hover:text-white group-focus:text-white">
      i
    </span>
    <span
      role="tooltip"
      className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-56 -translate-x-1/2 rounded-xl bg-[#1b1b1f] px-3 py-2 text-xs text-white/80 opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover:opacity-100 group-focus:opacity-100"
    >
      {text}
    </span>
  </span>
);

export const NOT_VERIFIED = 'Name set by the company, not verified';

// A company as the app shows it: the name it gave its pool with an info icon saying nobody checked it, then its
// address in its own chip.
export const CompanyLine = ({ name, address }: { name: string; address: string }) => (
  <span className="flex items-center gap-2 text-sm">
    <span className="text-white/75">
      {name || 'Unnamed company'}
      <Info text={NOT_VERIFIED} />
    </span>
    <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-white/55">{shortAddress(address)}</span>
  </span>
);

// The worker's wallet and a numbered split recipient, the circles the Split view shows. History puts them, and
// CoinIcon for the invested asset, next to a split's or a claim's lines.
export const WalletIcon = () => (
  <Badge bg="bg-[#9945FF]">
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M16 14.5h1" />
    </svg>
  </Badge>
);

const RECIPIENT_COLORS = ['bg-pink-500', 'bg-emerald-500', 'bg-sky-500'];

// Recipient `index` of a split, 0-based, shown 1-based.
export const RecipientIcon = ({ index }: { index: number }) => (
  <Badge bg={RECIPIENT_COLORS[index] ?? 'bg-white/20'}>{index + 1}</Badge>
);
