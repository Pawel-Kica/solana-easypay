import { ASSET_DECIMALS, ASSET_NAMES, USDC_DECIMALS } from './chain';
import type { Asset } from './generated';
import { HOUR } from './pay';

// Display helpers. Amounts stay bigint base units in code and become text only here.

export const shortAddress = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

const amount = (base: bigint, decimals: number) =>
  (Number(base) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 2 });

// "0.16 SOL" or "0.00024 BTC": two significant digits, since BTC amounts are tiny.
export const formatAsset = (base: bigint, asset: Asset) =>
  `${(Number(base) / 10 ** ASSET_DECIMALS[asset]).toLocaleString('en-US', { maximumSignificantDigits: 2 })} ${ASSET_NAMES[asset]}`;
export const formatSol = (lamports: bigint) => `${amount(lamports, 9)} SOL`;
export const usdcAmount = (base: bigint) => amount(base, USDC_DECIMALS); // "66" or "12.5", without the unit
export const formatUsdc = (base: bigint) => `${usdcAmount(base)} USDC`;

// "Sat, 3 Oct 2026, 18:12 UTC". The program counts days in UTC, so the UI does too.
export const formatChainDate = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' UTC';

// "1 Jul 2029 · 16:41", UTC: a History row's date, short enough for the right side.
export const formatRowDate = (unixSeconds: number) => {
  const date = new Date(unixSeconds * 1000);
  const day = date.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  return `${day} · ${date.toISOString().slice(11, 16)}`;
};

// "Oct 5": the UTC day of a unix time. Contracts start at a midnight UTC.
export const formatDay = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

// "Oct 17, 00:00 UTC": a moment pay starts or stops, like a contract end set with notice.
export const formatMoment = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }) + ' UTC';

// "14 days notice", "1 hour notice" or "No notice": a contract's notice in its periods.
export const formatNotice = (notice: number, period: number) =>
  notice ? `${notice} ${period === HOUR ? 'hour' : 'day'}${notice === 1 ? '' : 's'} notice` : 'No notice';

// "5h 12m" for a wait in seconds, "2d 5h" from a day up. Rounds up to the minute, so it never says 0m early.
export function formatDuration(seconds: number) {
  const minutes = Math.ceil(Math.max(seconds, 0) / 60);
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60];
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// USDC base units as text for an input, every decimal kept: 7_500_000n is "7.5". The reverse of parseUsdc.
export function usdcText(base: bigint) {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const fraction = (base % scale).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${base / scale}.${fraction}` : `${base / scale}`;
}

// Typed amount like "1000" or "12.5" to USDC base units. null unless it is above zero with at most 6 decimals.
export function parseUsdc(text: string): bigint | null {
  const [whole, fraction = '', ...rest] = text.trim().split('.');
  if (rest.length || !/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > USDC_DECIMALS) return null;
  const base = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, '0'));
  return base > 0n ? base : null;
}

// Bytes a pool name or contract title may have, the program refuses more. Bytes, not characters: "ł" takes 2.
export const MAX_NAME_BYTES = 32;
export const byteLength = (text: string) => new TextEncoder().encode(text).length;

// A contract's title, or its rate and period when it has none: "Frontend dev" or "1 USDC per day".
export const contractTitle = ({ title, rate, period }: { title: string; rate: bigint; period: number }) =>
  title || `${formatUsdc(rate)} per ${period === HOUR ? 'hour' : 'day'}`;
