// TS mirror of the program's pay rules (Slot::earned, Pool::owed, Pool::locked, Pool::settle, Slot::notice_end and
// Period::last_full in programs/easypay/src/state.rs, the withdraw cap in instructions/withdraw.rs).
// The app shows what Claim pays before anyone sends a transaction, from chain time, so these must match
// the program to the base unit. A ticket that changes the formula in Rust changes it here too.

// Seconds in a UTC day. Contracts start at a midnight UTC, a multiple of this.
export const DAY = 86_400;
// Seconds in an hour. A short pool pays every contract up to the same full hour.
export const HOUR = 3_600;
const WEEK = 7 * DAY;

// The terms earned is computed from: base units per period, the period in seconds (DAY or HOUR), whether only
// Monday to Friday UTC pay (daily only), the start midnight in unix seconds, and the end pay stops at (null while
// open-ended).
type Terms = { rate: bigint; period: number; weekdaysOnly: boolean; start: number; end: number | null };
// A contract as the pool's slot holds it: the terms, the base units the worker already claimed, and the notice:
// periods pay keeps running after the employer ends it.
export type Slot = Terms & { claimed: bigint; notice: number };
// What settle reads from a pool: its vault balance, the stored funded_until and its contracts.
// Stored funded_until only moves on a transaction, so the app settles again from chain time.
export type Funding = { balance: bigint; fundedUntil: number; contracts: Slot[] };

// The last full period at or before `now`: the last midnight UTC for DAY, the last full hour for HOUR.
// Pay counts completed periods only.
export const lastFull = (period: number, now: number) => now - (((now % period) + period) % period);

// The period of a pool's contracts. A pool holds one period only, DAY while it has no contracts.
const poolPeriod = (contracts: Slot[]) => contracts[0]?.period ?? DAY;

// Monday to Friday seconds between Monday 29 Dec 1969 UTC and `t` (weekday_secs in the program).
// Unix time 0 was a Thursday, so that Monday is 3 days before it.
function weekdaySecs(t: number) {
  const sinceMonday = t + 3 * DAY;
  const rest = ((sinceMonday % WEEK) + WEEK) % WEEK;
  return ((sinceMonday - rest) / WEEK) * 5 * DAY + Math.min(rest, 5 * DAY);
}

// Pay earned from start up to `until` or the end, whichever comes first, in base units. Zero before the start.
// A weekdays contract counts only Monday to Friday seconds.
// Multiplies before dividing, like the program does in u128. bigint never overflows.
export function earned({ rate, period, weekdaysOnly, start, end }: Terms, until: number) {
  const stop = end === null ? until : Math.min(end, until);
  if (stop <= start) return 0n;
  const secs = weekdaysOnly ? weekdaySecs(stop) - weekdaySecs(start) : stop - start;
  return (rate * BigInt(secs)) / BigInt(period);
}

// True once the contract's end has passed: it earns nothing more, what it earned stays claimable.
export const ended = ({ end }: Terms, now: number) => end !== null && end <= now;

// What claim(slot) pays: earned up to the pool's funded_until (from settle) minus what was already claimed.
export function claimable(contract: Slot, fundedUntil: number) {
  const left = earned(contract, fundedUntil) - contract.claimed;
  return left > 0n ? left : 0n;
}

// What the pool owes its workers at `until`: claimable summed over its contracts (Pool::owed in the program).
export const owed = (contracts: Slot[], until: number) => contracts.reduce((sum, c) => sum + claimable(c, until), 0n);

// Pool::settle at chain time `now`: funded_until is the last full period if the vault covers everything earned by
// then. If not, the pool is dry and funded_until is the latest full hour it covers, the same for every contract.
export function settle({ balance, fundedUntil, contracts }: Funding, now: number) {
  const target = lastFull(poolPeriod(contracts), now);
  if (owed(contracts, target) <= balance) return { fundedUntil: target, dry: false };
  let [lo, hi] = [Math.floor(fundedUntil / HOUR), target / HOUR];
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (owed(contracts, mid * HOUR) <= balance) lo = mid;
    else hi = mid;
  }
  return { fundedUntil: lo * HOUR, dry: true };
}

// The last full period at `now` plus the contract's notice: the earliest end the employer can set, and how far ahead
// the pool keeps its pay locked (Slot::notice_end).
export const noticeEnd = ({ period, notice }: Slot, now: number) => lastFull(period, now) + notice * period;

// The earliest end end_contract allows at `now`: the notice end for the employer, the last full period for the
// worker, never later than the current end (Slot::end_at). A later end must sit on a full period, at most
// MAX_END_AHEAD past the last full period.
export function earliestEnd(contract: Slot, byEmployer: boolean, now: number) {
  const floor = byEmployer ? noticeEnd(contract, now) : lastFull(contract.period, now);
  return contract.end === null ? floor : Math.min(contract.end, floor);
}
export const MAX_END_AHEAD = 366 * DAY;

// What withdraw must leave in the vault at `now`: per contract, earned up to its notice end (or its end, if sooner)
// minus claimed (Pool::locked). Accept also needs the vault to cover it.
export const locked = (contracts: Slot[], now: number) =>
  contracts.reduce((sum, c) => sum + claimable(c, noticeEnd(c, now)), 0n);

// What withdraw lets the employer take now: the vault minus what is locked for earned pay and notice.
export function withdrawable({ balance, contracts }: Funding, now: number) {
  const keep = locked(contracts, now);
  return balance > keep ? balance - keep : 0n;
}

// How long the vault minus what is owed still pays the running contracts: whole periods (days, or hours in an hourly
// pool) and whole days, with the team pay per period and per day (an hourly rate times 24). null without running
// contracts. The notice reserve counts as runway, so this is not `withdrawable`.
// The Pool tab's "Covers", the Companies card and the runway alerts all read it.
export function covers(funding: Funding, now: number) {
  const running = funding.contracts.filter((c) => !ended(c, now));
  const teamRate = running.reduce((sum, c) => sum + c.rate, 0n);
  if (teamRate === 0n) return null;
  const period = poolPeriod(funding.contracts);
  const perDay = (teamRate * BigInt(DAY)) / BigInt(period);
  const due = owed(funding.contracts, settle(funding, now).fundedUntil);
  const free = funding.balance > due ? funding.balance - due : 0n;
  return { running: running.length, period, teamRate, perDay, periods: free / teamRate, days: Number(free / perDay) };
}

// True on Saturday and Sunday UTC. Unix day 0 was a Thursday.
const isWeekend = (t: number) => Math.floor(t / DAY + 3) % 7 >= 5;

// Unix time the runway from `covers` runs out: its periods counted from the settled funded_until, skipping weekends
// when every running contract is weekdays only. The Pool Summary's "paid through" date. null without running contracts.
export function coveredUntil(funding: Funding, now: number) {
  const runway = covers(funding, now);
  if (!runway) return null;
  let t = settle(funding, now).fundedUntil;
  const weekdays = funding.contracts.filter((c) => !ended(c, now)).every((c) => c.weekdaysOnly);
  if (!weekdays) return t + Number(runway.periods) * runway.period;
  // Whole weeks of 5 paid days first, then day by day.
  let left = Number(runway.periods % 5n);
  t += Number(runway.periods / 5n) * WEEK;
  for (; left > 0; t += DAY) if (!isWeekend(t)) left--;
  return t;
}

// Unix time of the contract's next pay: the end of the current day or hour, or of the first one if it has not
// started. A weekdays contract skips to the end of the next Monday over the weekend.
export function nextPay({ period, weekdaysOnly, start }: Terms, now: number) {
  let from = Math.max(lastFull(period, now), start);
  while (weekdaysOnly && isWeekend(from)) from += DAY;
  return from + period;
}
