import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// Load the app's TS/TSX with its existing compiler. No validator or browser needed.
let server, pay, alerts, split, tax, events;
const storage = new Map();
const owner = '11111111111111111111111111111111';
const recipient = 'So11111111111111111111111111111111111111112';
const usdc = 1_000_000n;
const dayMs = 86_400_000;
const timestamp = (day) => Date.parse(day) / 1000;
const claim = (day, amount = 10n * usdc, signature = 'claim-signature') => ({
  time: timestamp(day), amount, signature,
});

before(async () => {
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  pay = await server.ssrLoadModule('/src/pay.ts');
  alerts = await server.ssrLoadModule('/src/Alerts.tsx');
  split = await server.ssrLoadModule('/src/SplitView.tsx');
  tax = await server.ssrLoadModule('/src/taxCsv.ts');
  events = await server.ssrLoadModule('/src/events.ts');
});

after(async () => {
  await server?.close();
  delete globalThis.localStorage;
});

const slot = (patch = {}) => ({
  rate: 10n * usdc, period: pay.DAY, weekdaysOnly: false,
  start: timestamp('2026-01-01'), end: null, claimed: 0n, ...patch,
});
const pool = (balance, contracts = [slot()]) => ({
  address: owner, balance, contracts, fundedUntil: timestamp('2026-01-01'),
});

function companyAlerts(funding, now = timestamp('2026-01-01')) {
  let result;
  function ReadAlerts() {
    result = alerts.useRunwayAlerts({ owner, pool: funding, chainTime: now, version: 0, onDeposit() {} });
    return createElement(alerts.Alerts, { alerts: result.alerts });
  }
  const html = renderToStaticMarkup(createElement(ReadAlerts));
  return { ...result, html };
}

test('runway excludes earned money and ended contracts', () => {
  const now = timestamp('2026-01-03');
  const funding = pool(100n * usdc, [slot(), slot({ end: timestamp('2026-01-02') })]);
  const result = pay.covers(funding, now);
  assert.equal(result.running, 1);
  assert.equal(result.days, 7); // 30 already earned, 70 available.
  assert.equal(pay.covers(pool(100n * usdc, []), now), null);
});

test('runway is quiet at seven days, amber below seven, red below one period', () => {
  assert.equal(companyAlerts(pool(70n * usdc)).alerts.length, 0);
  const amber = companyAlerts(pool(69n * usdc));
  assert.equal(amber.poolTone, 'amber');
  assert.equal(amber.alerts[0].title, 'Pool covers 6 more days');
  assert.match(amber.html, />Deposit<\/button>/);
  assert.equal(companyAlerts(pool(9n * usdc)).poolTone, 'red');
  assert.equal(companyAlerts(pool(0n)).alerts[0].title, 'Your pool is empty');
});

test('hourly runway uses 24 hours per day and turns red below one hour', () => {
  const hourly = (balance) => pool(balance * usdc, [slot({ rate: usdc, period: pay.HOUR })]);
  const runway = pay.covers(hourly(48n), timestamp('2026-01-01'));
  assert.equal(runway.days, 2);
  assert.equal(runway.periods, 48n);
  assert.equal(companyAlerts(hourly(5n)).poolTone, 'amber');
  assert.equal(companyAlerts(hourly(0n)).poolTone, 'red');
});

test('SOL alert threshold and Get SOL action', () => {
  assert.equal(alerts.solAlert(undefined, () => {}), undefined);
  assert.equal(alerts.solAlert(10_000_000n, () => {}), undefined);
  let clicked = false;
  const alert = alerts.solAlert(0n, () => { clicked = true; });
  assert.equal(alert.title, 'You have 0 SOL for fees');
  assert.ok(alerts.solAlert(9_999_999n, () => {}));
  assert.equal(alert.action.label, 'Get SOL');
  alert.action.onClick();
  assert.equal(clicked, true);
});

function splitHtml(recipients, labels = []) {
  return renderToStaticMarkup(createElement(split.SplitView, {
    owner, split: { recipients, investPct: 0, investAsset: 0 }, labels,
    client: {}, notify() {}, onSaved() {},
  }));
}

test('Taxes shortcut hides for an existing Taxes row or three recipients', () => {
  assert.match(splitHtml([]), /\+ Taxes/);
  assert.doesNotMatch(splitHtml([{ owner: recipient, pct: 25 }], ['Taxes']), /\+ Taxes/);
  assert.equal(split.walletPct({ recipients: [{ owner: recipient, pct: 25 }], investPct: 0 }), 75);
  assert.doesNotMatch(splitHtml(Array.from({ length: 3 }, () => ({ owner: recipient, pct: 10 }))), /\+ Taxes/);
});

function nbp(t, rates) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const [, from, to] = String(url).match(/usd\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})\//);
    assert.ok(Date.parse(to) - Date.parse(from) < 93 * dayMs);
    assert.ok(to <= new Date().toISOString().slice(0, 10));
    requests.push({ from, to });
    const found = rates.filter((r) => r.effectiveDate >= from && r.effectiveDate <= to);
    return found.length ? Response.json({ rates: found }) : new Response('', { status: 404 });
  });
  return requests;
}

test('CSV uses the preceding business day, gross amount, UTC and Local Explorer', async (t) => {
  nbp(t, [
    { effectiveDate: '2026-01-02', mid: 4 },
    { effectiveDate: '2026-01-05', mid: 5 },
  ]);
  const csv = await tax.buildTaxCsv([
    claim('2026-01-05T23:59:00Z', 12_345_678n), claim('2026-01-03T00:00:00Z'),
  ]);
  const rows = csv.trim().split('\n');
  assert.equal(rows.length, 3);
  assert.match(rows[1], /^2026-01-03 00:00,10,4,40.00,/);
  assert.match(rows[2], /^2026-01-05 23:59,12.345678,4,49.38,/);
  assert.match(rows[2], /https:\/\/explorer.solana.com\/tx\/claim-signature\?cluster=custom&customUrl=/);
});

test('CSV preserves rates for history older than a year', async (t) => {
  const requests = nbp(t, [
    { effectiveDate: '2024-01-05', mid: 4 },
    { effectiveDate: '2026-01-02', mid: 5 },
  ]);
  const rows = (await tax.buildTaxCsv([claim('2024-01-06'), claim('2026-01-03')])).trim().split('\n');
  assert.match(rows[1], /,10,4,40.00,/);
  assert.match(rows[2], /,10,5,50.00,/);
  assert.ok(requests.length > 1);
});

test('future Local claims use the last available rate', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-01-04T12:00:00Z'));
  const requests = nbp(t, [{ effectiveDate: '2026-01-02', mid: 4 }]);
  const csv = await tax.buildTaxCsv([claim('2026-02-01')]);
  assert.match(csv, /2026-02-01 00:00,10,4,40.00,/);
  assert.equal(requests.at(-1).to, '2026-01-04');
});

test('CSV keeps multiple claims from the same transaction', async (t) => {
  nbp(t, [{ effectiveDate: '2026-01-02', mid: 4 }]);
  const csv = await tax.buildTaxCsv([claim('2026-01-03'), claim('2026-01-03', 20n * usdc)]);
  assert.equal(csv.trim().split('\n').length, 3);
  assert.match(csv, /,20,4,80.00,/);
});

test('empty CSV needs no NBP call', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected request'); });
  assert.equal((await tax.buildTaxCsv([])).trim().split('\n').length, 1);
  assert.equal(fetch.mock.callCount(), 0);
});

test('missing prior rates and API failures fail instead of exporting a wrong amount', async (t) => {
  nbp(t, [{ effectiveDate: '2026-01-05', mid: 5 }]);
  await assert.rejects(tax.buildTaxCsv([claim('2026-01-05')]), /No NBP rate before/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  await assert.rejects(tax.buildTaxCsv([claim('2026-01-05')]), /NBP answered 500/);
});

test('income reads past 1,000 signatures and skips failed transactions', async (t) => {
  const requests = [];
  const signature = '1'.repeat(64);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'getMultipleAccounts') {
      assert.deepEqual(request.params[0], []);
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { context: { slot: 1 }, value: [] } });
    }
    assert.equal(request.method, 'getSignaturesForAddress');
    requests.push(request.params);
    const result = requests.length === 1
      ? Array.from({ length: 1000 }, () => ({ signature, err: { InstructionError: [0, 'InvalidArgument'] } }))
      : [];
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
  assert.deepEqual(await events.getIncome(owner), []);
  assert.equal(requests.length, 2);
  assert.equal(requests[1][1].before, signature);
});
