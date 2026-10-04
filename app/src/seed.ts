import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { DEMO_COMPANIES_KEY, resetTestAccounts, type Role } from './accounts';
import {
  addUsdc,
  airdropSol,
  createSigningClient,
  getChainTime,
  getContracts,
  getSplit,
  setupExchangeIfMissing,
  signText,
  timeTravel,
  USDC_MINT,
  waitForSol,
} from './chain';
import { claimInstructions } from './core';
import { Asset, Period } from './generated';
import { encryptLabels } from './labels';

// Local only: the dev footer's "seed demo". Swaps in fresh test accounts and builds a small world on the current
// chain, with real transactions and time travel, so every tab has something to show:
//   Acme Labs (Company, the one you click): 3 contracts, never ran dry, Score 100. Pawel and Sebastian work there,
//     Sebastian's QA contract has ended with pay left, an offer to Pawel and one from Sebastian wait.
//   Globex (no keys kept): ran out of money twice, Score 50, and is short right now. Pawel works there too.
//   Initech (no keys kept): one contract, New, an offer to Sebastian waits.
// Pawel's split sends 10% to Mom and 10% to Taxes. Takes about half a minute, the chain moves about a year ahead.

export type DemoCompany = { name: string; address: Address };
export const loadDemoCompanies = (): DemoCompany[] => JSON.parse(localStorage.getItem(DEMO_COMPANIES_KEY) ?? '[]');

const DAY = 86_400;
const usdc = (n: number) => BigInt(n * 1_000_000);

// Airdrops SOL and adds USDC, then waits for the airdrop to land.
async function fund(owner: Address, sol: number, usdcAmount = 0) {
  await airdropSol(owner, sol);
  if (usdcAmount) await addUsdc(owner, usdcAmount);
  await waitForSol(owner);
}

type Terms = { title: string; rate: number; notice: number; weekdaysOnly?: boolean; lastDay?: number };

// An offer from `from` (the employer or the worker) for a daily contract starting today at midnight UTC.
// lastDay is the end in days from that midnight. Returns the args accept needs, the same terms.
async function propose(from: KeyPairSigner, employer: Address, employee: Address, t: Terms) {
  const now = await getChainTime();
  const start = BigInt(now - (now % DAY));
  const args = {
    employer,
    employee,
    proposer: from.address,
    rate: usdc(t.rate),
    period: Period.Day,
    weekdaysOnly: t.weekdaysOnly ?? false,
    start,
    end: t.lastDay === undefined ? null : start + BigInt(t.lastDay * DAY),
    title: t.title,
    notice: t.notice,
  };
  await createSigningClient(from).easypay.instructions.propose({ ...args, proposer: from }).sendTransaction();
  return args;
}

// The employer proposes, the worker accepts.
async function hire(employer: KeyPairSigner, worker: KeyPairSigner, t: Terms) {
  const args = await propose(employer, employer.address, worker.address, t);
  await createSigningClient(worker)
    .easypay.instructions.accept({ signer: worker, mint: USDC_MINT, ...args })
    .sendTransaction();
}

async function createPool(employer: KeyPairSigner, name: string, deposit: number) {
  await createSigningClient(employer).easypay.instructions.createPool({ employer, mint: USDC_MINT, name }).sendTransaction();
  await depositInto(employer, deposit);
}

const depositInto = (employer: KeyPairSigner, amount: number) =>
  createSigningClient(employer)
    .easypay.instructions.deposit({ employer, mint: USDC_MINT, amount: usdc(amount) })
    .sendTransaction();

// Claims what `worker` can from the pools of `employers`, through the worker's split. A claim also settles the pool,
// which is how a short pool gets counted as ran dry.
async function claim(worker: KeyPairSigner, employers: Address[]) {
  const [{ contracts }, split] = await Promise.all([getContracts(worker.address), getSplit(worker.address)]);
  const mine = contracts.filter((c) => c.employee === worker.address && employers.includes(c.employer));
  await createSigningClient(worker).sendTransaction(await claimInstructions(worker, worker.address, split, mine));
}

type SplitTo = { owner: Address; pct: number; label: string }[];

export async function seedDemo(): Promise<void> {
  const accounts = await resetTestAccounts();
  const role = (r: Role) => accounts.find((a) => a.role === r)!.signer;
  const [company, pawel, sebastian] = [role('Company'), role('Pawel'), role('Sebastian')];
  const [globex, initech, g1, g2, i1] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()));
  const split: SplitTo = [
    { owner: role('Mom').address, pct: 10, label: 'Mom' },
    { owner: role('Taxes').address, pct: 10, label: 'Taxes' },
  ];

  await Promise.all([
    fund(company.address, 5, 30_000),
    fund(pawel.address, 5, 1_000),
    fund(sebastian.address, 5, 1_000),
    fund(globex.address, 5, 20_000),
    fund(initech.address, 5, 5_000),
    ...[g1, g2, i1].map((w) => fund(w.address, 1)),
  ]);
  await setupExchangeIfMissing(createSigningClient(company));

  // Day 0: Globex starts with two workers and too little money.
  await createPool(globex, 'Globex', 300);
  await hire(globex, g1, { title: 'Support', rate: 10, notice: 0 });
  await hire(globex, g2, { title: 'Ops', rate: 10, notice: 0 });

  // Day 200: the pool covered 15 days. A claim settles it short (ran dry 1×), then Globex tops it up.
  await timeTravel(200 * DAY);
  await claim(g1, [globex.address]);
  await depositInto(globex, 5_000);

  // Day 230: enough again (the claim settles it in full), Pawel joins Globex. Acme Labs opens.
  await timeTravel(30 * DAY);
  await claim(g2, [globex.address]);
  await hire(globex, pawel, { title: 'Data Engineer', rate: 25, notice: 0 });
  await createPool(company, 'Acme Labs', 12_000);
  await hire(company, pawel, { title: 'Backend Dev', rate: 40, notice: 14 });
  await hire(company, sebastian, { title: 'Designer', rate: 30, notice: 7, weekdaysOnly: true });
  await hire(company, sebastian, { title: 'QA Tester', rate: 20, notice: 0, lastDay: 45 });
  await createSigningClient(pawel).sendTransaction([
    await createSigningClient(pawel).easypay.instructions.setSplit({
      employee: pawel,
      recipients: split.map(({ owner, pct }) => ({ owner, pct })),
      investPct: 0,
      investAsset: Asset.Sol,
      claimer: null,
      labels: await encryptLabels(pawel.address, split.map((r) => r.label), signText(pawel)),
    }),
  ]);

  // Day 260: Globex is short again (ran dry 2×) when Pawel claims from both. Sebastian claims too.
  await timeTravel(30 * DAY);
  await claim(pawel, [company.address, globex.address]);
  await claim(sebastian, [company.address]);

  // Day 290: Pawel claims Acme again, Acme adds money. Sebastian's QA contract ended on day 275 with pay left.
  await timeTravel(30 * DAY);
  await claim(pawel, [company.address]);
  await depositInto(company, 3_000);

  // Day 320: Initech opens with one worker and offers Sebastian a contract.
  await timeTravel(30 * DAY);
  await createPool(initech, 'Initech', 1_500);
  await hire(initech, i1, { title: 'Marketing', rate: 15, notice: 0 });
  await propose(initech, initech.address, sebastian.address, { title: 'Frontend Dev', rate: 35, notice: 7 });

  // Day 350, now: two offers wait at Acme, one to Pawel and one from Sebastian.
  await timeTravel(30 * DAY);
  await propose(company, company.address, pawel.address, { title: 'Mobile Dev', rate: 50, notice: 14 });
  await propose(sebastian, company.address, sebastian.address, { title: 'Design System', rate: 25, notice: 7 });

  const demo: DemoCompany[] = [
    { name: 'Acme Labs', address: company.address },
    { name: 'Globex', address: globex.address },
    { name: 'Initech', address: initech.address },
  ];
  localStorage.setItem(DEMO_COMPANIES_KEY, JSON.stringify(demo));
}
