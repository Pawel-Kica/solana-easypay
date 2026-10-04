// The scenarios' own chain and what they read from it. Runs on the Mac, next to Playwright.
// The chain, Vite and the auto-claim server run in the devcontainer on their own ports (scripts/chain.sh --port),
// apart from `pnpm dev` on 8899. The container publishes only Paweł's ports, so a small proxy container publishes
// ours to 127.0.0.1 on the Mac.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
// Ports follow scripts/chain.sh: RPC N, websocket N+1, Vite 5173 + (N - 8899).
export const PORT = Number(process.env.PLAY_PORT ?? 28899);
const WEB_PORT = 5173 + (PORT - 8899);
export const RPC = `http://localhost:${PORT}`;
export const APP = `http://localhost:${WEB_PORT}/app`;

export const PROGRAM = 'BNUCb9cqqaxfVsNiRNofP2RVTjNn6XKnpcfRQWas8FYQ';
export const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const EXCHANGE = '8VA46TriR8DRd1SqA4waF3FAqVZwD4hMfjD654rWsKdw';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
export const DAY = 86_400;
export const HOUR = 3_600;

// ---- Keys ----

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

// Fixed keys, so every Play starts with the same accounts and the scenarios know their addresses up front.
// The app's test accounts get theirs through localStorage (see TEST_ACCOUNTS). Local chain only.
const seedOf = (name) => createHash('sha256').update(`easypay-play:${name}`).digest();
function addressOf(seed) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({
    format: 'der',
    type: 'spki',
  });
  return base58(spki.subarray(12));
}

export const ROLES = ['Company', 'Pawel', 'Sebastian', 'Mom', 'Taxes'];
// Split recipients, the app leaves them at 0 SOL and 0 USDC (UNFUNDED in app/src/accounts.ts).
const UNFUNDED = ['Mom', 'Taxes'];
// localStorage['easypay.testAccounts'] as app/src/accounts.ts reads it.
export const TEST_ACCOUNTS = Object.fromEntries(ROLES.map((r) => [r, [...seedOf(r)]]));
// Addresses by name: the test accounts, plus wallets that only receive (split recipients).
export const ADDRESS = Object.fromEntries(
  [...ROLES, 'Nobody'].map((name) => [name, addressOf(seedOf(name))]),
);

// ---- RPC ----

export async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export const lamports = async (owner) => BigInt((await rpc('getBalance', [owner, { commitment: 'confirmed' }])).value);

// USDC base units (6 decimals) across the owner's token accounts for the mint.
export async function usdc(owner) {
  const { value } = await rpc('getTokenAccountsByOwner', [
    owner,
    { mint: USDC_MINT },
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  return value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

export const accountExists = async (address) =>
  (await rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }])).value !== null;

// Chain time in unix seconds, from the Clock sysvar like the program. Never the machine clock.
export async function chainTime() {
  const { value } = await rpc('getAccountInfo', [CLOCK, { encoding: 'base64' }]);
  return Number(Buffer.from(value.data[0], 'base64').readBigInt64LE(32));
}

// Surfpool cheatcode: sets chain time, in milliseconds.
export const setChainTime = (unixSeconds) => rpc('surfnet_timeTravel', [{ absoluteTimestamp: unixSeconds * 1000 }]);

// Surfpool cheatcode: sets a wallet's SOL, to show the "no SOL" banner.
export const setLamports = (owner, amount) => rpc('surfnet_setAccount', [owner, { lamports: Number(amount) }]);

// ---- Environment ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOCKER_PATH = `${process.env.PATH}:/Applications/Docker.app/Contents/Resources/bin`;
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, PATH: DOCKER_PATH }, ...opts }).trim();
const docker = (...args) => sh('docker', args);
// scripts/chain.sh, without blocking the panel while it runs.
const chainSh = (...args) =>
  promisify(execFile)('bash', [`${REPO}/scripts/chain.sh`, ...args, '--port', String(PORT)], {
    env: { ...process.env, PATH: DOCKER_PATH },
  }).catch((e) => {
    throw new Error(`chain.sh ${args.join(' ')} failed: ${`${e.stdout}${e.stderr}`.trim().split('\n').slice(-3).join(' | ')}`);
  });

const PROXY = `easypay-play-proxy-${PORT}`;
// Forwards each published port to the same port on the devcontainer. Runs in the devcontainer's image, which has node.
const PROXY_JS = `const net = require('net');
for (const p of process.env.PORTS.split(',').map(Number))
  net.createServer((c) => { const s = net.connect(p, process.env.TARGET); c.pipe(s); s.pipe(c);
    c.on('error', () => s.destroy()); s.on('error', () => c.destroy()); }).listen(p, '0.0.0.0');`;

function devcontainer() {
  const id = docker('ps', '-q', '--filter', `label=devcontainer.local_folder=${REPO}`).split('\n')[0];
  if (!id) throw new Error('The devcontainer is not running. Start it first (pnpm dev or VS Code).');
  const [image, ip] = docker(
    'inspect',
    '-f',
    '{{.Config.Image}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    id,
  ).split(' ');
  return { image, ip };
}

// Starts the proxy container, or keeps it if it already points at the devcontainer's current address.
export function ensureProxy() {
  const { image, ip } = devcontainer();
  const running = docker('ps', '-q', '--filter', `name=^${PROXY}$`);
  if (running) {
    const target = docker('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', PROXY)
      .split('\n')
      .find((e) => e.startsWith('TARGET='));
    if (target === `TARGET=${ip}`) return;
    docker('stop', PROXY);
  }
  const ports = [PORT, PORT + 1, WEB_PORT];
  docker(
    'run', '-d', '--rm', '--name', PROXY, '--platform', 'linux/amd64',
    '-e', `TARGET=${ip}`, '-e', `PORTS=${ports.join(',')}`,
    ...ports.flatMap((p) => ['-p', `127.0.0.1:${p}:${p}`]),
    '--entrypoint', 'node', image, '-e', PROXY_JS,
  );
}

// Restarts the scenario chain with the snapshot (fresh state), then waits until the app can use it. `all` restarts
// Vite and the auto-claim server too, for the first start. Deploys the last built .so (--no-build): another session
// may be halfway through a program change. log gets one line per phase, for the panel.
export async function resetChain(log, all = false) {
  log('Starting the proxy for the scenario ports');
  ensureProxy();
  log(`Restarting the scenario ${all ? 'chain, app and auto-claim server' : 'chain'} on ${PORT}`);
  const restart = () => chainSh('restart', '--no-build', ...(all ? [] : ['--chain-only']));
  // Right after a start, stop can find the chain still busy. One retry covers it.
  await restart().catch(() => sleep(2000).then(restart));
  await waitReady(log);
}

// The chain answers, the program is deployed and Vite serves the app.
export async function waitReady(log) {
  log('Waiting for the chain, the program and the app');
  for (let i = 0; i < 360; i++) {
    const ready = await Promise.all([
      accountExists(PROGRAM),
      fetch(APP).then((r) => r.ok),
    ]).then((all) => all.every(Boolean), () => false);
    if (ready) return;
    await sleep(500);
  }
  throw new Error(`The scenario chain (${RPC}) or app (${APP}) did not come up in 3 minutes. See /tmp/easypay-${PORT}/*.log in the devcontainer.`);
}

// The app funds its test accounts and sets up the exchange on its first load. Waits for both.
export async function waitFunded() {
  for (let i = 0; i < 240; i++) {
    const done = await Promise.all([
      ...ROLES.filter((r) => !UNFUNDED.includes(r)).map(async (r) => (await lamports(ADDRESS[r])) > 0n && (await usdc(ADDRESS[r])) > 0n),
      accountExists(EXCHANGE),
    ]).then((all) => all.every(Boolean), () => false);
    if (done) return;
    await sleep(500);
  }
  throw new Error('The app did not fund the test accounts in 2 minutes.');
}

export async function stopAll() {
  console.log((await chainSh('stop')).stdout);
  if (docker('ps', '-q', '--filter', `name=^${PROXY}$`)) docker('stop', PROXY);
}
