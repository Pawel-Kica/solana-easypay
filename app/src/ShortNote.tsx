import { formatChainDate } from './format';

// Shown while a pool is dry: the vault can't cover everything earned, so every contract is paid up to the same
// full hour (funded_until from settle in pay.ts). A deposit pays the gap.
export const ShortNote = ({ fundedUntil }: { fundedUntil: number }) => (
  <p data-testid="short-note" className="mt-4 rounded-2xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
    Pool ran short. Contracts are paid up to {formatChainDate(fundedUntil)}
  </p>
);
