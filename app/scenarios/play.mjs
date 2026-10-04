// Play mode: plays scenarios in the real app, in a visible Chromium window with a panel on the right.
// Every Play restarts the scenario chain (its own ports, see chain.mjs), so it starts from a fresh state. Paweł's
// `pnpm dev` and its chain on 8899 are never touched. After a scenario the app stays open for clicking around.
//
//   pnpm scenarios                      window with the panel: pick a scenario, Play / Pause / Stop
//   pnpm scenarios --run <id|all>       plays without the panel clicks, prints the checks, exits 1 on a failure
//   pnpm scenarios --run all --headless the same without a window
//   pnpm scenarios --list               scenario ids
//   pnpm scenarios --stop               stops the scenario chain and its proxy
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import * as chain from './chain.mjs';
import { SCENARIOS } from './catalog.mjs';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? '') : undefined);
const HEADLESS = args.includes('--headless');
const RUN = option('--run');
// How long the panel shows a step's text before the step runs. Shorter when nobody is watching.
const EXPLAIN_MS = HEADLESS ? 0 : 1800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usdcText = (base) => `${(Number(base) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDC`;

if (args.includes('--list')) {
  for (const s of SCENARIOS) console.log(`${s.id.padEnd(16)} ${s.side.padEnd(8)} ${s.title}`);
  process.exit(0);
}
if (args.includes('--stop')) {
  await chain.stopAll();
  process.exit(0);
}

// What the panel shows. play.mjs owns it and redraws the panel after every change.
const state = {
  scenarios: SCENARIOS.map(({ id, side, title, summary }) => ({ id, side, title, summary })),
  selected: SCENARIOS[0].id,
  status: 'idle', // idle, resetting, running, paused, stopping, stopped, passed, failed
  current: null, // { index, total, text }
  log: [], // { kind: 'step' | 'check' | 'info' | 'error', text, ok?, index? }
  error: null,
};
let page;
let control = { pause: false, stop: false, resume: null };

const render = () => page?.evaluate((s) => window.__playRender?.(s), state).catch(() => {});
function log(entry) {
  state.log.push(entry);
  const line =
    entry.kind === 'step'
      ? `\n${entry.index}. ${entry.text}`
      : entry.kind === 'check'
        ? `   ${entry.ok ? 'OK  ' : 'FAIL'} ${entry.text}`
        : `   ${entry.text}`;
  console.log(line);
  render();
}
const info = (text) => log({ kind: 'info', text });

class CheckFailed extends Error {}

// What a scenario step gets. Actions go through the visible UI, checks read the UI and the chain.
function makeContext() {
  const app = page.locator('#root');
  const mark = async (loc) => {
    if (HEADLESS) return;
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.evaluate((el) => window.__playMark?.(el)).catch(() => {});
    await sleep(400);
  };
  const visible = (loc) => loc.waitFor({ state: 'visible', timeout: 30_000 });

  const check = (text, ok, detail = '') => {
    log({ kind: 'check', ok, text: detail ? `${text} (${detail})` : text });
    if (!ok) throw new CheckFailed(`Check failed: ${text}${detail ? ` (${detail})` : ''}`);
  };

  // Polls read() until test(value) holds or the timeout passes, then logs one check.
  async function until(text, read, test, show = String, timeout = 30_000) {
    const end = Date.now() + timeout;
    let value;
    for (;;) {
      value = await read().catch((e) => e);
      if (!(value instanceof Error) && test(value)) return check(text, true, show(value));
      if (Date.now() > end) return check(text, false, value instanceof Error ? value.message : `got ${show(value)}`);
      await sleep(500);
    }
  }

  const number = (text) => parseFloat(text.replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0] ?? 'NaN');
  const toasts = () => page.evaluate(() => window.__playToasts.length);

  // Waits for the first toast after `from` that matches `re` (a RegExp, or text the title contains). Any other red toast first means the action failed.
  async function toastAfter(from, re, expectError) {
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      const list = await page.evaluate((n) => window.__playToasts.slice(n), from);
      const hit = list.find((t) => (typeof re === 'string' ? t.title.includes(re) : re.test(t.title)));
      if (hit) return check(`toast: ${hit.title}`, hit.error === expectError);
      const bad = list.find((t) => t.error);
      if (bad) return check(`toast: ${bad.title}`, false, `expected ${re}`);
      await sleep(250);
    }
    check(`toast ${re}`, false, 'none in 2 minutes');
  }

  const c = {
    page,
    app,
    addr: (name) => chain.ADDRESS[name],
    short: (name) => short(chain.ADDRESS[name]),
    usd: (n) => BigInt(Math.round(n * 1e6)),
    note: info,
    check,
    until,

    // ---- Finding things ----
    button: (name, scope = app) => scope.getByRole('button', { name, exact: true }),
    field: (label) => app.getByLabel(label),
    row: (text) => app.getByRole('listitem').filter({ hasText: text }),
    // A labelled number in a card: "Withdrawable" on Pool Summary, "paid to workers" on Companies.
    line: (label) => app.locator('dl > div').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd'),

    // ---- Doing things, with the element outlined first ----
    async click(loc) {
      await visible(loc);
      await mark(loc);
      await loc.click();
    },
    async type(loc, text) {
      await visible(loc);
      await mark(loc);
      await loc.fill('');
      if (HEADLESS) await loc.fill(text);
      else await loc.pressSequentially(text, { delay: text.length > 20 ? 6 : 35 });
    },
    async fill(loc, value) {
      await visible(loc);
      await mark(loc);
      await loc.fill(value);
    },
    async select(loc, value) {
      await visible(loc);
      await mark(loc);
      await loc.selectOption(value);
    },
    // Switches the test account in the top right.
    async as(role) {
      const button = app.getByRole('group', { name: 'Test account' }).getByRole('button', { name: role, exact: true });
      await visible(button);
      if ((await button.getAttribute('aria-pressed')) === 'true') return;
      await c.click(button);
      // The tabs remount for the new account and read the chain again.
      await sleep(1500);
    },
    tab: (name) => c.click(app.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name, exact: true })),
    sub: (name) => c.click(app.getByRole('tabpanel').getByRole('tab', { name, exact: true })),

    // Runs `action` and expects a green toast matching `re`.
    async tx(action, re) {
      const from = await toasts();
      await action();
      await toastAfter(from, re, false);
    },
    // Runs `action` and expects a red toast matching `re`: the program refused.
    async txFails(action, re) {
      const from = await toasts();
      await action();
      await toastAfter(from, re, true);
    },

    // ---- Checks ----
    expectText: (text, loc, re) =>
      until(text, () => loc.first().innerText({ timeout: 2_000 }), (t) => re.test(t), (t) => JSON.stringify(t.slice(0, 120))),
    // A number shown in the UI, two decimals like the app.
    expectNumber: (text, loc, n) =>
      until(text, () => loc.first().innerText({ timeout: 2_000 }), (t) => Math.abs(number(t) - n) < 0.006, (t) => t.trim()),
    expectVisible: (text, loc) => until(text, () => loc.first().isVisible(), Boolean, () => 'visible'),
    expectGone: (text, loc) => until(text, async () => !(await loc.first().isVisible()), Boolean, () => 'gone'),
    // An exact USDC amount on chain, in base units.
    expectUsdc: (text, name, base) => until(text, () => chain.usdc(chain.ADDRESS[name]), (v) => v === base, usdcText),

    // ---- Chain ----
    usdcOf: (name) => chain.usdc(chain.ADDRESS[name]),
    solOf: (name) => chain.lamports(chain.ADDRESS[name]),
    time: chain.chainTime,
    // "2026-10-05": the chain's UTC day plus `days`, as a date input wants it.
    async day(days = 0) {
      const now = await chain.chainTime();
      return new Date((now - (now % chain.DAY) + days * chain.DAY) * 1000).toISOString().slice(0, 10);
    },
    // The dev footer's time buttons, clicked so the viewer sees them. Waits until the chain moved.
    async plus(unit, times = 1) {
      const seconds = unit === 'day' ? chain.DAY : chain.HOUR;
      const start = await chain.chainTime();
      for (let i = 1; i <= times; i++) {
        await c.click(c.button(`+1 ${unit}`));
        const end = Date.now() + 30_000;
        while ((await chain.chainTime()) < start + i * seconds - 5 && Date.now() < end) await sleep(250);
      }
      const label = new Date(start * 1000 + times * seconds * 1000).toUTCString().slice(0, 22);
      await until(`chain time is ${label}`, chain.chainTime, (t) => t >= start + times * seconds - 5, (t) => new Date(t * 1000).toUTCString().slice(0, 22));
      // The app polls every second.
      await sleep(1500);
    },
    setLamports: (name, amount) => chain.setLamports(chain.ADDRESS[name], amount),

    // Clicks `loc`, waits for the file it downloads and returns its bytes.
    async download(loc) {
      await visible(loc);
      await mark(loc);
      const [file] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), loc.click()]);
      return readFileSync(await file.path());
    },
  };
  return c;
}

// Pause waits here, before the next step. Stop ends the scenario here: a sent transaction stays sent.
async function gate(index, total, next) {
  if (control.pause && !control.stop) {
    state.status = 'paused';
    state.current = { index, total, text: `Paused. Next: ${next}` };
    render();
    await new Promise((resolve) => (control.resume = resolve));
    state.status = 'running';
  }
  return !control.stop;
}

// Morning of the next Monday, so day counts and weekdays come out the same on every Play.
async function startOfWeek() {
  const now = await chain.chainTime();
  const midnight = now - (now % chain.DAY);
  const weekday = (Math.floor(midnight / chain.DAY) + 3) % 7; // 0 = Monday, unix day 0 was a Thursday
  const monday = midnight + (7 - weekday) * chain.DAY;
  await chain.setChainTime(monday + 9 * chain.HOUR);
}

async function play(id) {
  const scenario = SCENARIOS.find((s) => s.id === id);
  control = { pause: false, stop: false, resume: null };
  Object.assign(state, { selected: id, status: 'resetting', error: null, log: [] });
  state.current = { index: 0, total: scenario.steps.length, text: 'Fresh chain, fresh accounts' };
  console.log(`\n=== ${scenario.title} ===`);
  render();
  let index = 0;
  try {
    await chain.resetChain(info);
    await startOfWeek();
    info('Chain time set to Monday 09:00 UTC');
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await page.goto(chain.APP);
    info('The app funds the test accounts');
    await chain.waitFunded();
    await sleep(1500);
    state.status = 'running';
    const ctx = makeContext();
    for (const step of scenario.steps) {
      index++;
      if (!(await gate(index - 1, scenario.steps.length, step.text))) {
        state.status = 'stopped';
        info(`Stopped before step ${index}. Transactions already sent stay on the chain.`);
        state.current = null;
        return false;
      }
      state.current = { index, total: scenario.steps.length, text: step.text };
      log({ kind: 'step', index, text: step.text });
      await sleep(EXPLAIN_MS);
      await step.run(ctx);
    }
    state.status = 'passed';
    state.current = { index, total: scenario.steps.length, text: 'Done. The app stays as it is, click around freely.' };
    return true;
  } catch (e) {
    state.status = 'failed';
    const where = index ? `Step ${index}: ${scenario.steps[index - 1].text}` : 'Reset';
    const message = e instanceof CheckFailed ? e.message : String(e.message ?? e).split('\n')[0];
    state.error = `${where}\n${message}\nThe app is left as it is, so you can look around.`;
    log({ kind: 'error', text: message });
    return false;
  } finally {
    render();
  }
}

async function command(name, arg) {
  const busy = ['resetting', 'running', 'stopping'].includes(state.status);
  if (name === 'ready') return render();
  if (name === 'select' && !busy && state.status !== 'paused') state.selected = arg;
  if (name === 'play' && !busy && state.status !== 'paused') return void play(state.selected);
  if (name === 'pause' && state.status === 'running') {
    control.pause = true;
    info('Pausing after this step');
  }
  if (name === 'resume' && state.status === 'paused') {
    control.pause = false;
    control.resume?.();
  }
  if (name === 'stop' && (busy || state.status === 'paused')) {
    control.stop = true;
    if (state.status !== 'resetting') state.status = 'stopping';
    control.resume?.();
  }
  render();
}

async function launch() {
  const args = HEADLESS ? [] : ['--window-size=1500,960'];
  // PLAY_DEBUG_PORT lets a test script attach over CDP and press the panel buttons.
  if (process.env.PLAY_DEBUG_PORT) args.push(`--remote-debugging-port=${process.env.PLAY_DEBUG_PORT}`);
  const options = { headless: HEADLESS, args };
  // Playwright's own Chromium, or the system Chrome when that build is not downloaded.
  return chromium.launch(options).catch(() => chromium.launch({ ...options, channel: 'chrome' }));
}

async function main() {
  const ids = RUN === undefined ? [] : RUN === 'all' ? SCENARIOS.map((s) => s.id) : RUN.split(',');
  const unknown = ids.filter((id) => !SCENARIOS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`Unknown scenario ${unknown.join(', ')}. See pnpm scenarios --list`);

  // The app has to be up before the window opens it. The first Play restarts it anyway.
  chain.ensureProxy();
  const up = await fetch(chain.APP).then((r) => r.ok, () => false);
  if (!up) await chain.resetChain((text) => console.log(text), true);
  else await chain.waitReady(() => {});

  const browser = await launch();
  const context = await browser.newContext({ viewport: HEADLESS ? { width: 1500, height: 960 } : null, acceptDownloads: true });
  const panel = readFileSync(new URL('./panel.js', import.meta.url), 'utf8');
  const webPort = new URL(chain.APP).port;
  await context.addInitScript({
    content: `window.__PLAY = ${JSON.stringify({ webPort, accounts: chain.TEST_ACCOUNTS })};\n${panel}`,
  });
  await context.exposeBinding('__play', (_source, name, arg) => command(name, arg));
  page = await context.newPage();
  await page.goto(chain.APP);

  if (!ids.length) {
    console.log(`Play is open at ${chain.APP}. Close the window to quit.`);
    await new Promise((resolve) => browser.on('disconnected', resolve));
    return;
  }

  const failed = [];
  for (const id of ids) if (!(await play(id))) failed.push(id);
  console.log(`\n${ids.length - failed.length}/${ids.length} passed${failed.length ? `, failed: ${failed.join(', ')}` : ''}`);
  if (HEADLESS || failed.length === 0) await browser.close();
  else console.log('The window stays open on the failed state. Close it to quit.');
  await new Promise((resolve) => (browser.isConnected() ? browser.on('disconnected', resolve) : resolve()));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
