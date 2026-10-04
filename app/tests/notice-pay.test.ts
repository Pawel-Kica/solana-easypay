import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coveredUntil, covers, DAY, earliestEnd, HOUR, locked, withdrawable, type Slot } from '../src/pay';

// pay.ts mirrors Pool::locked and Slot::end_at. Same numbers as the Rust unit tests in state.rs.

const USDC = 1_000_000n;
const OCT1 = Date.UTC(2026, 9, 1) / 1000; // Thursday
const daily = (notice: number, more: Partial<Slot> = {}): Slot => ({
  rate: 100n * USDC,
  period: DAY,
  weekdaysOnly: false,
  start: OCT1,
  end: null,
  claimed: 0n,
  notice,
  ...more,
});

test('locked is earned plus notice minus claimed, weekends and ends included', () => {
  const now = OCT1 + 2 * DAY + 12 * HOUR;
  assert.equal(locked([daily(14, { claimed: 50n * USDC }), daily(0)], now), (16n * 100n - 50n + 200n) * USDC);
  assert.equal(locked([daily(14, { end: OCT1 + 5 * DAY })], OCT1), 500n * USDC);
  assert.equal(locked([daily(14, { weekdaysOnly: true })], OCT1), 1000n * USDC);
  assert.equal(locked([daily(2, { period: HOUR, rate: 10n * USDC })], OCT1 + 3 * HOUR + 59), 50n * USDC);
});

test('withdrawable leaves the reserve, covers still counts it as runway', () => {
  const funding = { balance: 2000n * USDC, fundedUntil: OCT1, contracts: [daily(14)] };
  const now = OCT1 + DAY + HOUR;
  assert.equal(withdrawable(funding, now), 500n * USDC);
  assert.equal(covers(funding, now)!.periods, 19n);
  assert.equal(coveredUntil(funding, now), OCT1 + 20 * DAY);
});

test('coveredUntil skips weekends when every contract is weekdays only', () => {
  // Thursday, 7 weekdays of pay left: Thu, Fri, Mon to Fri. Ends the next Saturday midnight.
  const funding = { balance: 700n * USDC, fundedUntil: OCT1, contracts: [daily(0, { weekdaysOnly: true })] };
  assert.equal(coveredUntil(funding, OCT1), OCT1 + 9 * DAY);
});

test('earliestEnd: notice for the employer, now for the worker, never past the end', () => {
  const now = OCT1 + 2 * DAY + 12 * HOUR;
  assert.equal(earliestEnd(daily(14), true, now), OCT1 + 16 * DAY);
  assert.equal(earliestEnd(daily(14), false, now), OCT1 + 2 * DAY);
  assert.equal(earliestEnd(daily(14, { end: OCT1 + 5 * DAY }), true, now), OCT1 + 5 * DAY);
});
