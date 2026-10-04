// Browser smoke test of the main flow, once per batch of tickets, not per ticket. Run it with
// `bash scripts/chain.sh smoke`: that starts a fresh stack on its own ports, runs this file and stops the stack.
// Headless Chromium in the devcontainer. Company creates a pool and deposits, proposes a contract to Pawel with 14
// days notice, Pawel accepts and sees the notice, a day later claims. Company sees the notice reserve,
// withdraws the rest (Max leaves earned pay and the reserve) and ends the contract at the earliest date the picker
// offers. Details show the last paid day, and after the notice Pawel claims the 14 days.
// PORT is the chain's RPC port, the app is on 5173 + (PORT - 8899), like in chain.sh.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const PORT = Number(process.env.PORT ?? 38899);
const RPC = `http://127.0.0.1:${PORT}`;
const APP = `http://localhost:${5173 + PORT - 8899}/app`;
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const started = Date.now();
const step = (label) => console.log(`${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s  ${label}`);

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()).result;
}
const lamports = async (a) => (await rpc('getBalance', [a, { commitment: 'confirmed' }])).value;
// Chain time from the Clock sysvar, unix_timestamp at byte 32. Time travel moves it away from the machine clock.
const chainTime = async () => {
  const { value } = await rpc('getAccountInfo', ['SysvarC1ock11111111111111111111111111111111', { encoding: 'base64' }]);
  return Number(Buffer.from(value.data[0], 'base64').readBigInt64LE(32));
};
// Moves chain time to `unix` seconds, like the dev footer's +1 day.
const travelTo = (unix) => rpc('surfnet_timeTravel', [{ absoluteTimestamp: unix * 1000 }]);
// "Oct 20", formatDay in app/src/format.ts.
const day = (unix) => new Date(unix * 1000).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const until = async (fn) => {
  while (!(await fn())) await new Promise((r) => setTimeout(r, 300));
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(APP).origin });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

const tab = (name) => page.getByRole('tab', { name, exact: true }).first().click();
const panel = () => page.getByRole('tabpanel').first();
// Opens Details on a contract row, waits until the dialog's `label` row reads `text`, then closes it.
const expectDetail = async (row, label, text) => {
  await row.getByRole('button', { name: 'Details' }).click();
  const dialog = page.getByRole('dialog', { name: 'Contract details' });
  await dialog.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).filter({ hasText: text }).waitFor();
  await dialog.getByRole('button', { name: 'Close' }).click();
};
const as = (role) => page.getByRole('button', { name: role, exact: true }).click();
// Waits for the toast and fails with its text when it is the failure one.
const expectToast = async (success, failure) => {
  const toast = page.getByRole('status').filter({ hasText: new RegExp(`${success}|${failure}`) }).first();
  await toast.waitFor();
  const text = await toast.innerText();
  if (!text.includes(success)) throw new Error(`Expected "${success}", got: ${text}`);
};
const copyAddress = async () => {
  await page.getByTitle('Copy address').click();
  return page.evaluate(() => navigator.clipboard.readText());
};

try {
  const requests = [];
  const record = (request) => requests.push(request.url());
  page.on('request', record);
  await page.goto(new URL(APP).origin);
  await page.getByRole('heading', { name: 'Work gets done. Pay should follow.' }).waitFor();
  assert.equal(requests.some((url) => new URL(url).port === String(PORT)), false, 'Landing must not contact the chain');
  page.off('request', record);
  await page.getByRole('link', { name: 'Go to the app' }).click();
  await page.waitForURL(APP);
  await page.getByTitle('Copy address').waitFor();
  await page.reload();
  await page.getByTitle('Copy address').waitFor();
  step('landing opens the app, direct refresh works');
  await as('Pawel');
  const pawel = await copyAddress();
  await as('Company');
  const company = await copyAddress();
  await until(async () => (await lamports(company)) > 0 && (await lamports(pawel)) > 0);
  step('app loaded, test accounts funded');

  await tab('Pool');
  await page.getByLabel('Company name').fill('Smoke Labs');
  await page.getByRole('button', { name: 'Create pool' }).click();
  await expectToast('created', 'Could not create the pool');
  await page.getByPlaceholder('0').fill('500');
  await page.getByRole('button', { name: 'Deposit', exact: true }).click();
  await expectToast('Deposited 500 USDC', 'failed');
  step('pool created, 500 USDC deposited');

  await tab('Contracts');
  await panel().getByRole('tab', { name: 'New contract' }).click();
  await page.getByLabel('Worker address').fill(pawel);
  await page.getByLabel('Daily rate').fill('10');
  await page.getByLabel('Notice in days').fill('14');
  await page.getByRole('button', { name: 'Propose' }).click();
  await expectToast(`Proposed contract to ${short(pawel)}`, 'Could not propose');
  await as('Pawel');
  await tab('Contracts');
  const offer = panel().getByRole('listitem').filter({ hasText: `Offer from ${short(company)}` });
  await offer.getByRole('button', { name: 'Accept' }).click();
  await expectToast(`Accepted contract from ${short(company)}`, 'Could not accept');
  await expectDetail(panel().getByRole('listitem').filter({ hasText: 'Active' }), 'Notice', '14 days notice');
  step('contract proposed and accepted, 10 USDC a day, 14 days notice shown');

  const before = await chainTime();
  await page.getByRole('button', { name: '+1 day' }).click();
  await until(async () => (await chainTime()) >= before + 86_400);
  await tab('Claim');
  await page.waitForFunction(() => document.querySelector('[data-testid=claimable]')?.textContent.startsWith('10.00'));
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await expectToast('Claimed 10 USDC', 'Claim failed');
  step('+1 day, Pawel claimed 10 USDC');

  // 490 in the vault, nothing earned and unclaimed, the reserve is today plus 13 more days: 140. 350 can go back.
  await as('Company');
  await tab('Pool');
  await panel().getByRole('tab', { name: 'Summary' }).click();
  // First match: "Withdrawable" is a tile and a bar legend entry, same number.
  const number = (label) => page.locator('dl > div').filter({ hasText: label }).locator('dd').first();
  await until(async () => (await number('Notice reserve').innerText()) === '140 USDC');
  await until(async () => (await number('Withdrawable').innerText()) === '350 USDC');
  await panel().getByRole('tab', { name: 'Withdraw' }).click();
  await page.getByRole('button', { name: 'Max' }).click();
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expectToast('Withdrew 350 USDC', 'Withdraw failed');
  step('Pool shows 140 USDC notice reserve, Max withdrew 350 USDC');

  // The picker opens at the earliest end: the last midnight plus 14 days.
  const lastMidnight = (await chainTime()) - ((await chainTime()) % 86_400);
  const end = lastMidnight + 14 * 86_400;
  await tab('Contracts');
  const row = panel().getByRole('listitem').filter({ hasText: short(pawel) });
  await row.getByRole('button', { name: 'End contract' }).click();
  await row.getByRole('button', { name: 'Confirm end' }).click();
  await expectToast(`Ended contract with ${short(pawel)}`, 'Could not end the contract');
  await expectDetail(row, 'End', `Last paid day ${day(end - 1)}`);
  step(`Company ended the contract, Details show "Last paid day ${day(end - 1)}"`);

  // A day past the end: the worker claims all 14 days of notice.
  await travelTo(end + 86_400);
  await until(async () => (await chainTime()) >= end + 86_400);
  await as('Pawel');
  await tab('Claim');
  await page.waitForFunction(() => document.querySelector('[data-testid=claimable]')?.textContent.startsWith('140'));
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await expectToast('Claimed 140 USDC', 'Claim failed');
  step('after the notice Pawel claimed 140 USDC');

  await tab('History');
  await page.getByRole('button', { name: /^. Claimed/ }).first().click();
  await page.getByText('Claimed by').waitFor();
  step('History opens the newest claim as a card');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Income certificate', exact: true }).click();
  const certificate = await download;
  assert.match(certificate.suggestedFilename(), /^easypay-income-.*\.pdf$/);
  await certificate.saveAs('/tmp/easypay-smoke-certificate.pdf');
  step('income certificate downloaded with the new brand');

  if (errors.length) throw new Error(`Page errors: ${errors.join(' | ')}`);
  console.log('SMOKE OK');
} catch (e) {
  console.error('SMOKE FAILED:', String(e).split('\n')[0]);
  console.error('toasts:', JSON.stringify(await page.getByRole('status').allInnerTexts().catch(() => [])));
  console.error('panel:', JSON.stringify((await panel().innerText().catch(() => '')).slice(0, 500)));
  process.exitCode = 1;
} finally {
  await browser.close();
}
