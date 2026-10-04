// Takes the README screenshots into docs/screenshots/. Clicks a story through the app on its own chain: Acme Labs
// funds a pool, hires Pawel and Sebastian, Pawel splits pay to Taxes and Mom, three days pass, Pawel claims.
// Run: `bash scripts/chain.sh start --port 48899 --no-build`, then in the container
// `PORT=48899 node app/tests/readme-shots.mjs`, then `bash scripts/chain.sh stop --port 48899`.
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT ?? 48899);
const RPC = `http://127.0.0.1:${PORT}`;
const APP = `http://localhost:${5173 + PORT - 8899}/app`;
const OUT = new URL('../../docs/screenshots/', import.meta.url).pathname;
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()).result;
}
const lamports = async (a) => (await rpc('getBalance', [a, { commitment: 'confirmed' }])).value;
const until = async (fn) => {
  while (!(await fn())) await new Promise((r) => setTimeout(r, 300));
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(APP).origin });
const page = await context.newPage();
page.setDefaultTimeout(60_000);

const tab = (name) => page.getByRole('tab', { name, exact: true }).first().click();
const sub = (name) => page.getByRole('tabpanel').first().getByRole('tab', { name, exact: true }).click();
const as = (role) => page.getByRole('button', { name: role, exact: true }).click();
const field = (label) => page.getByLabel(label);
const toast = async (text) => {
  await page.getByRole('status').filter({ hasText: text }).first().waitFor();
  await page.waitForTimeout(300);
};
const copyAddress = async () => {
  await page.getByTitle('Copy address').click();
  return page.evaluate(() => navigator.clipboard.readText());
};
// Waits for toasts to fade so they don't sit in the shot, then saves it.
const shot = async (name) => {
  await page.getByRole('status').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
  // App shots end just below the card, the landing keeps the whole screen.
  const card = page.getByRole('tabpanel').first();
  const box = name === '1-landing' ? null : await card.boundingBox();
  const clip = box ? { x: 0, y: 0, width: 1280, height: Math.min(860, box.y + box.height + 48) } : undefined;
  await page.screenshot({ path: `${OUT}${name}.png`, clip });
  console.log(`saved ${name}.png`);
};
const propose = async (to, rate, title) => {
  await tab('Contracts');
  await sub('New contract');
  await field('Worker address').fill(to);
  await field('Title').fill(title);
  await field('Daily rate').fill(String(rate));
  await field('Notice in days').fill('7');
  await page.getByRole('button', { name: 'Propose' }).click();
  await toast(`Proposed contract to ${short(to)}`);
};
const accept = async (from) => {
  await tab('Contracts');
  const offer = page.getByRole('tabpanel').first().getByRole('listitem').filter({ hasText: `Offer from ${short(from)}` });
  await offer.getByRole('button', { name: 'Accept' }).click();
  await toast(`Accepted contract from ${short(from)}`);
};

try {
  await page.goto(new URL(APP).origin);
  await page.getByRole('heading', { name: 'Work gets done. Pay should follow.' }).waitFor();
  await page.waitForTimeout(1500);
  await shot('1-landing');

  await page.goto(APP);
  await page.getByTitle('Copy address').waitFor();
  const addr = {};
  for (const role of ['Mom', 'Taxes', 'Sebastian', 'Pawel', 'Company']) {
    await as(role);
    addr[role] = await copyAddress();
  }
  await until(async () => (await lamports(addr.Company)) > 0 && (await lamports(addr.Sebastian)) > 0);

  await tab('Pool');
  await field('Company name').fill('Acme Labs');
  await page.getByRole('button', { name: 'Create pool' }).click();
  await toast('created');
  await sub('Deposit');
  await field('You deposit').fill('900');
  await page.getByRole('tabpanel').first().getByRole('button', { name: 'Deposit', exact: true }).click();
  await toast('Deposited 900 USDC');
  await propose(addr.Pawel, 40, 'Frontend developer');
  await propose(addr.Sebastian, 30, 'Designer');

  await as('Sebastian');
  await accept(addr.Company);
  await as('Pawel');
  await page.waitForTimeout(1500);
  await tab('Contracts');
  await page.getByRole('tabpanel').first().getByRole('listitem').filter({ hasText: `Offer from ${short(addr.Company)}` }).waitFor();
  await shot('3-offer');
  await accept(addr.Company);

  await tab('Claim');
  await sub('Split');
  // The split form reloads from the chain right after accept and would drop what we typed.
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: '+ Taxes' }).click();
  await field('Address 1').fill(addr.Taxes);
  await page.getByRole('button', { name: '+ Add address' }).click();
  await field('Label 2').fill('Mom');
  await field('Address 2').fill(addr.Mom);
  await field('Percent 2').fill('10');
  await field('Invest percent').fill('10');
  await page.getByTestId('asset-price').filter({ hasText: /\$\d/ }).waitFor();
  await page.getByTestId('wallet-pct').filter({ hasText: /^\s*55/ }).waitFor();
  await shot('5-split');
  await page.getByRole('button', { name: 'Save split' }).click();
  await page.getByRole('button', { name: 'Sign and save' }).click();
  await toast('Split saved');

  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '+1 day' }).click();
    await page.waitForTimeout(1200);
  }
  await tab('Claim');
  await sub('Claim');
  await page.waitForFunction(() => document.querySelector('[data-testid=claimable]')?.textContent.startsWith('120'));
  await shot('4-claim');
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await toast('Claimed');

  await tab('History');
  // Open the newest claim, its card shows where the money went.
  await page.getByRole('button', { name: /^. Claimed/ }).first().click();
  await page.getByText('Where it went').waitFor();
  await shot('6-history');

  await as('Company');
  await tab('Pool');
  await sub('Summary');
  await page.waitForTimeout(1500);
  await shot('2-pool');

  await as('Sebastian');
  await tab('Companies');
  await field('Company address').fill(addr.Company);
  await page.getByText('Acme Labs').first().waitFor();
  await shot('7-companies');
  console.log('SHOTS OK');
} catch (e) {
  console.error('SHOTS FAILED:', String(e).split('\n')[0]);
  await page.screenshot({ path: '/tmp/readme-shots-failed.png' });
  process.exitCode = 1;
} finally {
  await browser.close();
}
