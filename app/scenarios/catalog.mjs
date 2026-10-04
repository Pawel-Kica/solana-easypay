// The scenario catalog. A scenario is a list of steps: a short text the panel shows first, then what the step does
// in the app and what it checks (balances on chain, numbers and statuses in the UI). Steps get the context from
// play.mjs. Every scenario starts on a fresh chain on Monday 09:00 UTC, with Company, Pawel and Sebastian at
// 5 SOL and 1000 USDC each, Mom and Taxes at 0.

const step = (text, run) => ({ text, run });
const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

// ---- Building blocks ----

const poolBalance = (c) => c.app.getByTestId('pool-balance');
const claimable = (c) => c.app.getByTestId('claimable');
// The tab's card. A low pool banner above it has its own Deposit button.
const card = (c) => c.app.getByRole('tabpanel');

// `by` creates its pool on the Pool tab and deposits `deposit` USDC.
const createPool = ({ by = 'Company', name = 'Acme Labs', deposit }) => [
  step(`${by} creates the pool "${name}" on the Pool tab`, async (c) => {
    await c.as(by);
    await c.tab('Pool');
    await c.type(c.field('Company name'), name);
    await c.tx(() => c.click(c.button('Create pool')), `Pool ${name} created`);
    await c.expectNumber('pool balance is 0 USDC', poolBalance(c), 0);
  }),
  ...(deposit ? [depositStep({ by, amount: deposit, pool: deposit })] : []),
];

// `by` deposits on the Pool tab. `pool` is the balance expected after it.
const depositStep = ({ by = 'Company', amount, pool }) =>
  step(`${by} deposits ${fmt(amount)} USDC into the pool`, async (c) => {
    await c.as(by);
    await c.tab('Pool');
    await c.sub('Deposit');
    const wallet = await c.usdcOf(by);
    await c.type(c.field('You deposit'), String(amount));
    await c.tx(() => c.click(c.button('Deposit', card(c))), `Deposited ${fmt(amount)} USDC`);
    await c.expectUsdc(`${by} wallet paid ${fmt(amount)} USDC`, by, wallet - c.usd(amount));
    if (pool !== undefined) await c.expectNumber(`pool balance is ${fmt(pool)} USDC`, poolBalance(c), pool);
  });

// One side proposes a contract on Contracts > New contract. `from` and `to` are roles: a company role proposing
// hires `to`, a worker proposing (`asWorker`) asks the company `to` for a contract. `lastDay` and `start` are days
// from today. Leaving `notice` out keeps the form's default (7 days, or 168 hours).
const propose = ({ from = 'Company', to = 'Pawel', rate, hourly = false, notice, title, lastDay, weekdaysOnly, asWorker = false }) =>
  step(
    `${from} offers ${asWorker ? `to work for ${to}` : `${to} a contract`}: ${fmt(rate)} USDC per ${hourly ? 'hour' : 'day'}` +
      `${weekdaysOnly ? ', weekdays only' : ''}${notice === undefined ? '' : `, ${notice} ${hourly ? 'hours' : 'days'} notice`}` +
      `${lastDay === undefined ? '' : ', with a last working day'}`,
    async (c) => {
      await c.as(from);
      await c.tab('Contracts');
      await c.sub('New contract');
      if (asWorker) await c.click(c.button("I'm working for"));
      await c.type(c.field(asWorker ? 'Company address' : 'Worker address'), c.addr(to));
      if (title) await c.type(c.field('Title'), title);
      if (hourly) await c.select(c.field('Pay period'), 'hour');
      await c.type(c.field(hourly ? 'Hourly rate' : 'Daily rate'), String(rate));
      if (weekdaysOnly) await c.click(c.field('Weekdays only'));
      if (notice !== undefined) await c.type(c.field(hourly ? 'Notice in hours' : 'Notice in days'), String(notice));
      if (lastDay !== undefined) await c.fill(c.field('Last working day'), await c.day(lastDay));
      await c.tx(() => c.click(c.button('Propose')), `Proposed contract to ${c.short(to)}`);
      await c.expectVisible('the offer waits on Contracts', c.row(`Offer to ${c.short(to)}`));
    },
  );

// `by` accepts the offer `from` sent, on Contracts.
const accept = ({ by = 'Pawel', from = 'Company' } = {}) =>
  step(`${by} opens Contracts and accepts the offer from ${from}`, async (c) => {
    await c.as(by);
    await c.tab('Contracts');
    const offer = c.row(`Offer from ${c.short(from)}`);
    await c.tx(() => c.click(c.button('Accept', offer)), `Accepted contract from ${c.short(from)}`);
    await c.expectGone('the offer is gone', c.row(`Offer from ${c.short(from)}`));
    await c.expectVisible('the contract is Active', c.row('Active'));
  });

// Opens Details on `row` on Contracts, checks each label of `terms` against its RegExp, then closes the dialog.
async function expectDetails(c, text, row, terms) {
  await c.click(c.button('Details', row));
  for (const [label, re] of Object.entries(terms)) await c.expectText(`${text}: ${label}`, c.line(label), re);
  await c.click(c.button('Close'));
}

const hire = (terms) => [propose(terms), accept({ by: terms.to ?? 'Pawel', from: terms.from ?? 'Company' })];

// `by` claims on the Claim tab. `wallet` is what lands in their own wallet, when a split sends part elsewhere.
const claim = ({ by = 'Pawel', amount, wallet = amount }) =>
  step(`${by} opens Claim and claims ${fmt(amount)} USDC`, async (c) => {
    await c.as(by);
    await c.tab('Claim');
    await c.sub('Claim');
    await c.expectNumber(`claimable is ${fmt(amount)} USDC`, claimable(c), amount);
    const before = await c.usdcOf(by);
    await c.tx(() => c.click(c.button('Claim')), 'Claimed');
    await c.expectUsdc(`${by} wallet got ${fmt(wallet)} USDC`, by, before + c.usd(wallet));
    // A fully paid ended contract leaves the list, then the tab says "Nothing to claim".
    await c.expectVisible(
      'nothing left to claim',
      claimable(c).filter({ hasText: /^0\.00/ }).or(c.app.getByText('Nothing to claim', { exact: true })),
    );
  });

const passDays = (days) =>
  step(`Dev footer: move the chain ${days} day${days === 1 ? '' : 's'} ahead`, (c) => c.plus('day', days));
const passHours = (hours) =>
  step(`Dev footer: move the chain ${hours} hour${hours === 1 ? '' : 's'} ahead`, (c) => c.plus('hour', hours));

// Company's Pool tab numbers.
const poolNumbers = (text, numbers) =>
  step(text, async (c) => {
    await c.as('Company');
    await c.tab('Pool');
    // The balance sits over the Deposit form, the rest on Summary.
    for (const [label, value] of Object.entries(numbers))
      if (label === 'Pool balance') {
        await c.sub('Deposit');
        await c.expectNumber(`pool balance is ${fmt(value)} USDC`, poolBalance(c), value);
      } else {
        await c.sub('Summary');
        await c.expectNumber(`${label} is ${fmt(value)} USDC`, c.line(label), value);
      }
  });

const historyShows = (by, ...lines) =>
  step(`${by} opens History`, async (c) => {
    await c.as(by);
    await c.tab('History');
    for (const line of lines) await c.expectVisible(`History shows "${line}"`, c.app.getByText(line).first());
  });

// Opens the newest claim's card on History and checks what it shows, like where the money went.
const claimCardShows = (by, ...lines) =>
  step(`${by} opens the newest claim on History`, async (c) => {
    await c.as(by);
    await c.tab('History');
    await c.click(c.app.getByRole('button', { name: /^. Claimed/ }).first());
    for (const line of lines) await c.expectVisible(`The claim card shows "${line}"`, c.app.getByText(line).first());
  });

// Opens the End form on `by`'s contract with `other`, and confirms the default (earliest) end.
const endContract = ({ by, text }) =>
  step(text, async (c) => {
    await c.as(by);
    await c.tab('Contracts');
    const row = c.row('Active');
    await c.click(c.button('End contract', row));
    await c.tx(() => c.click(c.button('Confirm end', row)), 'Ended contract with');
  });

// ---- Scenarios ----

export const SCENARIOS = [
  {
    id: 'tour',
    side: 'Demo',
    title: 'Full tour: hire, a day passes, get paid',
    summary: 'The whole product in two minutes: pool, offer, daily pay, claim, and the company record a worker can check.',
    steps: [
      ...createPool({ deposit: 600 }),
      ...hire({ rate: 20, title: 'Frontend dev' }),
      poolNumbers('Company sees what the pool keeps for Pawel: 7 days of notice', {
        'Notice reserve': 140,
        Withdrawable: 460,
      }),
      passDays(1),
      claim({ amount: 20 }),
      historyShows('Pawel', '+20 USDC'),
      step('Sebastian looks Acme Labs up on Companies before taking a job there', async (c) => {
        await c.as('Sebastian');
        await c.tab('Companies');
        await c.type(c.field('Company address'), c.addr('Company'));
        await c.expectNumber('Contracts: 1', c.line('Contracts'), 1);
        await c.expectNumber('Paid to workers: 20 USDC', c.line('paid to workers'), 20);
        await c.expectText('Ran out of money: 0×', c.line('ran out of money'), /^0×$/);
      }),
    ],
  },

  // ---- Company ----
  {
    id: 'pool',
    side: 'Company',
    title: 'Create a pool, deposit, withdraw',
    summary: 'With no contracts every USDC in the pool is the company’s to take back.',
    steps: [
      ...createPool({ deposit: 600 }),
      poolNumbers('Nothing is locked yet', { 'Waiting to be claimed': 0, 'Notice reserve': 0, Withdrawable: 600 }),
      step('Company withdraws 250 USDC', async (c) => {
        await c.sub('Withdraw');
        const wallet = await c.usdcOf('Company');
        await c.type(c.field('You withdraw'), '250');
        await c.tx(() => c.click(c.button('Withdraw')), 'Withdrew 250 USDC');
        await c.expectUsdc('Company wallet got 250 USDC back', 'Company', wallet + c.usd(250));
        await c.expectNumber('pool balance is 350 USDC', poolBalance(c), 350);
      }),
      historyShows('Company', 'Created pool Acme Labs', 'Deposited 600 USDC', 'Withdrew 250 USDC'),
    ],
  },
  {
    id: 'hire',
    side: 'Company',
    title: 'Hire a worker by the day',
    summary: 'A daily contract with the default 7 days notice. The pool locks the notice right away.',
    steps: [
      ...createPool({ deposit: 600 }),
      ...hire({ rate: 20, title: 'Designer' }),
      step('Both sides see the same terms', async (c) => {
        await expectDetails(c, 'Pawel sees the terms', c.row('Active'), {
          Rate: /^20 USDC per day$/,
          'Pay days': /^Every day$/,
          Notice: /^7 days notice$/,
          End: /^No end date$/,
        });
        await c.as('Company');
        await c.tab('Contracts');
        await c.expectText('Company sees Pawel on the contract', c.row('Active'), new RegExp(`Worker ${c.short('Pawel')}`));
      }),
      poolNumbers('Day 0: nothing earned, 140 USDC notice reserve', {
        'Waiting to be claimed': 0,
        'Notice reserve': 140,
        Withdrawable: 460,
      }),
      passDays(1),
      poolNumbers('Day 1: 20 USDC earned, still 140 USDC notice', {
        'Waiting to be claimed': 20,
        'Notice reserve': 140,
        Withdrawable: 440,
      }),
      step('Covers counts days the pool still pays', async (c) => {
        await c.expectText('Covers: 29 days', c.line('Covers'), /^29 days\b/);
      }),
    ],
  },
  {
    id: 'withdraw',
    side: 'Company',
    title: 'Withdraw only what nobody earned',
    summary: 'The program refuses to give the company money its worker already earned.',
    steps: [
      ...createPool({ deposit: 300 }),
      ...hire({ rate: 50, notice: 0 }),
      passDays(2),
      poolNumbers('Two days earned: 100 USDC locked for Pawel', { 'Waiting to be claimed': 100, Withdrawable: 200 }),
      step('Company tries to withdraw 250 USDC. The program says no', async (c) => {
        await c.sub('Withdraw');
        await c.type(c.field('You withdraw'), '250');
        await c.txFails(() => c.click(c.button('Withdraw')), /Withdraw failed/);
        await c.expectNumber('pool balance still 300 USDC', poolBalance(c), 300);
      }),
      step('Company presses Max and withdraws the 200 USDC it may take', async (c) => {
        await c.click(c.button('Max'));
        const wallet = await c.usdcOf('Company');
        await c.tx(() => c.click(c.button('Withdraw')), 'Withdrew 200 USDC');
        await c.expectUsdc('Company wallet got 200 USDC', 'Company', wallet + c.usd(200));
        await c.expectNumber('pool balance is 100 USDC', poolBalance(c), 100);
      }),
      claim({ amount: 100 }),
      poolNumbers('The pool is empty and nobody lost anything', { 'Pool balance': 0 }),
    ],
  },
  {
    id: 'notice-reserve',
    side: 'Company',
    title: 'The notice reserve stays in the pool',
    summary: 'Withdraw Max drops by the notice, and a new contract needs its notice covered before it can start.',
    steps: [
      ...createPool({ deposit: 400 }),
      ...hire({ rate: 20, notice: 14 }),
      poolNumbers('280 USDC is reserved for 14 days of notice', { 'Notice reserve': 280, Withdrawable: 120 }),
      step('Company tries to withdraw 200 USDC. Refused', async (c) => {
        await c.sub('Withdraw');
        await c.type(c.field('You withdraw'), '200');
        await c.txFails(() => c.click(c.button('Withdraw')), /Withdraw failed/);
      }),
      step('Company withdraws Max: 120 USDC', async (c) => {
        await c.click(c.button('Max'));
        await c.tx(() => c.click(c.button('Withdraw')), 'Withdrew 120 USDC');
        await c.expectNumber('pool balance is 280 USDC', poolBalance(c), 280);
      }),
      propose({ to: 'Sebastian', rate: 20, notice: 14 }),
      step('Sebastian accepts, but the pool can’t cover a second notice. Refused', async (c) => {
        await c.as('Sebastian');
        await c.tab('Contracts');
        const offer = c.row(`Offer from ${c.short('Company')}`);
        await c.txFails(() => c.click(c.button('Accept', offer)), /Could not accept the contract.*(notice|Deposit)/i);
        await c.expectVisible('the offer is still there', c.row(`Offer from ${c.short('Company')}`));
      }),
      depositStep({ amount: 280, pool: 560 }),
      accept({ by: 'Sebastian' }),
      poolNumbers('Two notices reserved, nothing to withdraw', { 'Notice reserve': 560, Withdrawable: 0 }),
    ],
  },
  {
    id: 'end-notice',
    side: 'Company',
    title: 'Company ends a contract, notice keeps paying',
    summary: 'The company can end a contract, but no earlier than the notice. Pawel is paid to the last day.',
    steps: [
      ...createPool({ deposit: 400 }),
      ...hire({ rate: 20, notice: 14 }),
      passDays(1),
      step('Company opens End contract and tries to stop pay tomorrow. The form says no', async (c) => {
        await c.as('Company');
        await c.tab('Contracts');
        const row = c.row('Active');
        await c.click(c.button('End contract', row));
        await c.fill(c.field('Last paid day'), await c.day(1));
        await c.expectVisible('the button says Earliest … and is off', row.getByRole('button', { name: /^Earliest/ }));
        await c.click(c.button('Cancel', row));
      }),
      endContract({ by: 'Company', text: 'Company ends the contract at the earliest date, 14 days ahead' }),
      step('The contract still runs and shows its end date', async (c) => {
        await expectDetails(c, 'Company sees the end', c.row('Active'), { End: /^Last paid day / });
        await c.as('Pawel');
        await c.tab('Contracts');
        await expectDetails(c, 'Pawel sees the end too', c.row('Active'), { End: /^Last paid day / });
      }),
      passDays(14),
      step('The notice ran out: the contract is Ended', async (c) => {
        await c.as('Pawel');
        await c.tab('Contracts');
        await c.expectVisible('badge Ended', c.row('Ended'));
      }),
      claim({ amount: 300 }),
      historyShows('Pawel', 'ended your contract'),
      poolNumbers('Pool keeps the 100 USDC nobody earned', { 'Pool balance': 100, Withdrawable: 100 }),
    ],
  },
  {
    id: 'runway',
    side: 'Company',
    title: 'Low pool alerts on both sides',
    summary: 'Under 7 days of pay the company and its worker get an amber banner, an empty pool turns it red.',
    steps: [
      ...createPool({ deposit: 120 }),
      ...hire({ rate: 20, notice: 0 }),
      step('Company sees an amber banner: 6 days left', async (c) => {
        await c.as('Company');
        await c.expectVisible('banner "Pool covers 6 more days"', c.app.getByRole('alert').filter({ hasText: 'Pool covers 6 more days' }));
      }),
      step('Pawel sees the same warning', async (c) => {
        await c.as('Pawel');
        await c.expectVisible('banner "Pool covers 6 more days"', c.app.getByRole('alert').filter({ hasText: 'Pool covers 6 more days' }));
      }),
      passDays(6),
      step('The pool is spent: red banners', async (c) => {
        await c.expectVisible("Pawel: Acme Labs' pool is empty", c.app.getByRole('alert').filter({ hasText: "Acme Labs' pool is empty" }));
        await c.as('Company');
        await c.expectVisible('Company: Your pool is empty', c.app.getByRole('alert').filter({ hasText: 'Your pool is empty' }));
      }),
      step('Company presses Deposit on the banner and adds 200 USDC', async (c) => {
        await c.click(c.button('Deposit', c.app.getByRole('alert')));
        await c.type(c.field('You deposit'), '200');
        await c.tx(() => c.click(c.button('Deposit', card(c))), 'Deposited 200 USDC');
        await c.expectGone('the banner is gone', c.app.getByRole('alert'));
      }),
    ],
  },
  {
    id: 'dry',
    side: 'Company',
    title: 'Short pool pays everyone fairly',
    summary: 'The pool can’t cover a full day. Both workers are paid up to the same hour, so the fastest claimer can’t take it all.',
    steps: [
      ...createPool({ deposit: 130 }),
      ...hire({ rate: 50, notice: 0 }),
      ...hire({ to: 'Sebastian', rate: 100, notice: 0 }),
      passDays(1),
      step('Pawel sees the pool ran short: paid up to 20:00', async (c) => {
        await c.as('Pawel');
        await c.tab('Claim');
        await c.expectText('note "Pool ran short … 20:00"', c.app.getByTestId('short-note'), /20:00/);
      }),
      claim({ amount: 41.666666 }),
      claim({ by: 'Sebastian', amount: 83.333333 }),
      step('Pawel checks the company record: it ran dry once', async (c) => {
        await c.as('Pawel');
        await c.tab('Companies');
        await c.type(c.field('Company address'), c.addr('Company'));
        await c.expectText('Ran out of money: 1×', c.line('ran out of money'), /^1×$/);
      }),
      depositStep({ amount: 300 }),
      passDays(1),
      claim({ amount: 58.333334 }),
    ],
  },
  {
    id: 'end-date',
    side: 'Company',
    title: 'Contract with a last working day',
    summary: 'Pay stops by itself after the last working day, the rest of the pool stays the company’s.',
    steps: [
      ...createPool({ deposit: 300 }),
      ...hire({ rate: 30, notice: 0, lastDay: 2 }),
      passDays(5),
      step('Three days paid, then the contract ended', async (c) => {
        await c.as('Pawel');
        await c.tab('Contracts');
        await c.expectVisible('badge Ended', c.row('Ended'));
        await expectDetails(c, 'Details show the last day', c.row('Ended'), { End: /^Last paid day / });
      }),
      claim({ amount: 90 }),
      poolNumbers('The other 210 USDC is free again', { Withdrawable: 210 }),
    ],
  },
  {
    id: 'weekdays',
    side: 'Company',
    title: 'Weekdays only',
    summary: 'A Mon-Fri contract earns nothing on Saturday and Sunday.',
    steps: [
      passDays(4),
      ...createPool({ deposit: 400 }),
      ...hire({ rate: 40, notice: 0, weekdaysOnly: true }),
      passDays(3),
      step('Friday paid, the weekend not: 40 USDC', async (c) => {
        await c.as('Pawel');
        await c.tab('Claim');
        await c.expectNumber('claimable is 40 USDC', claimable(c), 40);
      }),
      passDays(1),
      claim({ amount: 80 }),
    ],
  },
  {
    id: 'hourly',
    side: 'Company',
    title: 'Pay by the hour',
    summary: 'An hourly contract started at midnight pays every full hour. Handy for a live demo.',
    steps: [
      ...createPool({ deposit: 200 }),
      ...hire({ rate: 5, hourly: true, notice: 2 }),
      step('It is 09:00, so nine hours are already earned', async (c) => {
        await c.as('Pawel');
        await c.tab('Claim');
        await c.expectNumber('claimable is 45 USDC', claimable(c), 45);
      }),
      poolNumbers('2 hours of notice reserved', { 'Notice reserve': 10, 'Waiting to be claimed': 45 }),
      passHours(2),
      claim({ amount: 55 }),
    ],
  },
  {
    id: 'cancel',
    side: 'Company',
    title: 'Change of mind: cancel an offer',
    summary: 'An offer nobody accepted can be taken back, its rent returns.',
    steps: [
      ...createPool({ deposit: 300 }),
      step('Company notes its SOL before the offer', async (c) => {
        c.solBefore = await c.solOf('Company');
        c.note(`Company has ${Number(c.solBefore) / 1e9} SOL`);
      }),
      propose({ rate: 30, notice: 0 }),
      step('Pawel sees the offer', async (c) => {
        await c.as('Pawel');
        await c.tab('Contracts');
        await c.expectVisible('Offer from Company', c.row(`Offer from ${c.short('Company')}`));
      }),
      step('Company cancels it', async (c) => {
        await c.as('Company');
        await c.tab('Contracts');
        await c.tx(() => c.click(c.button('Cancel', c.row(`Offer to ${c.short('Pawel')}`))), 'Cancelled offer');
        await c.until('rent came back (only fees spent)', () => c.solOf('Company'), (sol) => c.solBefore - sol < 100_000n, (sol) => `${Number(c.solBefore - sol)} lamports spent`);
      }),
      step('Pawel has nothing to accept anymore', async (c) => {
        await c.as('Pawel');
        await c.tab('Contracts');
        await c.expectVisible('No contracts yet', c.app.getByText('No contracts yet'));
      }),
    ],
  },
  {
    id: 'record',
    side: 'Company',
    title: 'The company record builds up',
    summary: 'From three contracts on, the company has a score anyone can check on Companies.',
    steps: [
      ...createPool({ deposit: 500 }),
      ...hire({ rate: 10, notice: 0 }),
      ...hire({ to: 'Sebastian', rate: 10, notice: 0 }),
      ...hire({ rate: 15, notice: 0, title: 'Second gig' }),
      passDays(1),
      claim({ amount: 25 }),
      step('Sebastian looks the company up: 3 contracts, score 100', async (c) => {
        await c.as('Sebastian');
        await c.tab('Companies');
        await c.type(c.field('Company address'), c.addr('Company'));
        await c.expectNumber('Contracts: 3', c.line('Contracts'), 3);
        await c.expectNumber('Paid to workers: 25 USDC', c.line('paid to workers'), 25);
        await c.expectVisible('Score 100/100', c.app.getByText('Score 100/100'));
      }),
      step('A fresh address has no history at all', async (c) => {
        await c.type(c.field('Company address'), c.addr('Nobody'));
        await c.expectVisible('No history', c.app.getByText('No history', { exact: true }));
      }),
      step('Company opens My company: the same card workers see, a day on Easy Pay', async (c) => {
        await c.as('Company');
        await c.tab('Companies');
        await c.click(c.app.getByRole('tab', { name: 'My company', exact: true }));
        await c.expectNumber('Contracts: 3', c.line('Contracts'), 3);
        await c.expectText('On Easy Pay: 1 day', c.line('on Easy Pay'), /^1 day$/);
      }),
    ],
  },

  // ---- Worker ----
  {
    id: 'first-pay',
    side: 'Worker',
    title: 'First day’s pay',
    summary: 'The worker’s view: accept, wait a day, claim.',
    steps: [
      ...createPool({ deposit: 600 }),
      propose({ rate: 50, notice: 0 }),
      step('Pawel sees the offer and the company is New', async (c) => {
        await c.as('Pawel');
        await c.tab('Contracts');
        await c.expectText('badge New', c.row(`Offer from ${c.short('Company')}`), /New/);
      }),
      accept(),
      step('Claim tab: nothing yet, next pay at midnight', async (c) => {
        await c.tab('Claim');
        await c.expectNumber('claimable is 0', claimable(c), 0);
        await c.expectText('next pay in about 15 hours', c.app.getByTestId('next-pay'), /Next pay in 1[45]h/);
      }),
      passDays(1),
      claim({ amount: 50 }),
      historyShows('Pawel', '+50 USDC'),
    ],
  },
  {
    id: 'worker-proposes',
    side: 'Worker',
    title: 'Worker asks a company for a contract',
    summary: 'Either side can propose. Here the worker sends the terms, the company accepts.',
    steps: [
      ...createPool({ deposit: 600 }),
      propose({ from: 'Pawel', to: 'Company', asWorker: true, rate: 60, notice: 0, title: 'Frontend dev' }),
      accept({ by: 'Company', from: 'Pawel' }),
      step('Both sides see the contract Active', async (c) => {
        await c.expectText('Company: Frontend dev, Active', c.row('Active'), /Frontend dev/);
        await c.as('Pawel');
        await c.tab('Contracts');
        await c.expectText('Pawel: Frontend dev, Active', c.row('Active'), /Frontend dev/);
      }),
      historyShows('Company', 'proposed Frontend dev'),
    ],
  },
  {
    id: 'check-company',
    side: 'Worker',
    title: 'Check a company before accepting',
    summary: 'See record opens the company’s history from the chain. A fresh address shows a warning.',
    steps: [
      ...createPool({ deposit: 300 }),
      propose({ rate: 30, notice: 0 }),
      step('Pawel opens See record on the offer', async (c) => {
        await c.as('Pawel');
        await c.tab('Contracts');
        await c.click(c.button('See record →', c.row(`Offer from ${c.short('Company')}`)));
        await c.expectText('Companies opens Acme Labs', c.app.getByRole('tabpanel'), /Acme Labs/);
        await c.expectNumber('Contracts: 0', c.line('Contracts'), 0);
        await c.expectNumber('Paid to workers: 0 USDC', c.line('paid to workers'), 0);
        await c.expectText('Ran out of money: 0×', c.line('ran out of money'), /^0×$/);
      }),
      step('Pawel pastes an address that never paid anyone', async (c) => {
        await c.type(c.field('Company address'), c.addr('Nobody'));
        await c.expectVisible('warning No history', c.app.getByText('No history', { exact: true }));
      }),
    ],
  },
  {
    id: 'split',
    side: 'Worker',
    title: 'Split pay: taxes and family',
    summary: 'Every claim pays 25% to a tax wallet and 10% to Mom, the rest to the worker. The labels go on-chain encrypted.',
    steps: [
      ...createPool({ deposit: 600 }),
      ...hire({ rate: 100, notice: 0 }),
      step('Pawel adds + Taxes (25%) and Mom (10%) on Claim > Split', async (c) => {
        await c.tab('Claim');
        await c.sub('Split');
        await c.click(c.button('+ Taxes'));
        await c.type(c.field('Address 1'), c.addr('Taxes'));
        await c.click(c.button('+ Add address'));
        await c.type(c.field('Label 2'), 'Mom');
        await c.type(c.field('Address 2'), c.addr('Mom'));
        await c.type(c.field('Percent 2'), '10');
        await c.expectNumber('My wallet keeps 65%', c.app.getByTestId('wallet-pct'), 65);
      }),
      step('Pawel saves and signs the split', async (c) => {
        await c.click(c.button('Save split'));
        await c.tx(() => c.click(c.button('Sign and save')), 'Split saved');
        await c.expectText('Where it goes: My wallet 65%', c.app.getByTestId('where-it-goes'), /My wallet\s*65%/);
        await c.expectText('Where it goes names Taxes and Mom', c.app.getByTestId('where-it-goes'), /Taxes[\s\S]*Mom/);
      }),
      passDays(1),
      claim({ amount: 100, wallet: 65 }),
      step('Taxes and Mom got 25 and 10 USDC, on chain', async (c) => {
        await c.expectUsdc('Taxes wallet has 25 USDC', 'Taxes', c.usd(25));
        await c.expectUsdc('Mom wallet has 10 USDC', 'Mom', c.usd(10));
      }),
      claimCardShows('Pawel', 'Where it went', '25 USDC', '10 USDC'),
      step('Pawel opens the app in a fresh browser: one wallet signature brings the labels back', async (c) => {
        await c.page.evaluate(() => localStorage.removeItem('easypay.labelKeys'));
        await c.page.reload();
        await c.as('Pawel');
        await c.tab('Claim');
        await c.expectText('Where it goes names Taxes and Mom again', c.app.getByTestId('where-it-goes'), /Taxes[\s\S]*Mom/);
      }),
    ],
  },
  {
    id: 'invest',
    side: 'Worker',
    title: 'Invest part of every claim in SOL',
    summary: '20% of each claim is swapped to SOL at the Pyth price, the rest stays USDC.',
    steps: [
      ...createPool({ deposit: 600 }),
      ...hire({ rate: 100, notice: 0 }),
      step('Pawel sets Invest to 20% in SOL and saves', async (c) => {
        await c.tab('Claim');
        await c.sub('Split');
        await c.type(c.field('Invest percent'), '20');
        await c.expectText('the SOL price shows', c.app.getByTestId('asset-price'), /\$\d/);
        c.price = parseFloat((await c.app.getByTestId('asset-price').innerText()).replace(/[$,]/g, ''));
        c.note(`SOL price: $${c.price}`);
        await c.click(c.button('Save split'));
        await c.tx(() => c.click(c.button('Sign and save')), 'Split saved');
      }),
      passDays(1),
      step('Pawel notes their SOL', async (c) => {
        c.solBefore = await c.solOf('Pawel');
      }),
      claim({ amount: 100, wallet: 80 }),
      step('About 20 USDC worth of SOL arrived', async (c) => {
        const expected = (20 / c.price) * 1e9;
        await c.until(
          `SOL grew by about ${(expected / 1e9).toFixed(4)} SOL`,
          () => c.solOf('Pawel'),
          (sol) => Math.abs(Number(sol - c.solBefore) - expected) < expected * 0.03,
          (sol) => `${(Number(sol - c.solBefore) / 1e9).toFixed(5)} SOL`,
        );
      }),
      claimCardShows('Pawel', 'SOL bought'),
      step('Pawel sees the SOL and its dollar value in History > Balances', async (c) => {
        await c.sub('Balances');
        await c.expectText('Balances lists SOL, USDC, BTC and ETH', c.app.getByTestId('all-balances'), /SOL[\s\S]*USDC[\s\S]*BTC[\s\S]*ETH/);
        await c.expectText('the total is in dollars', c.app.getByTestId('balances-total'), /^\$[\d,]+\.\d\d$/);
      }),
    ],
  },
  {
    id: 'auto-claim',
    side: 'Worker',
    title: 'Auto-claim: paid without a click',
    summary: 'Our server claims for the worker after each completed day. It can only claim, the money goes to the worker’s split.',
    steps: [
      ...createPool({ deposit: 600 }),
      ...hire({ rate: 50, notice: 0 }),
      step('Pawel turns on Auto-claim', async (c) => {
        await c.tab('Claim');
        await c.tx(() => c.click(c.app.getByTestId('auto-claim')), 'Auto-claim on');
        c.before = await c.usdcOf('Pawel');
      }),
      passDays(1),
      step('Wait for the server (it checks every minute)', async (c) => {
        await c.until(
          'Pawel got 50 USDC without clicking Claim',
          () => c.usdcOf('Pawel'),
          (v) => v === c.before + c.usd(50),
          (v) => `${Number(v - c.before) / 1e6} USDC`,
          150_000,
        );
      }),
      claimCardShows('Pawel', 'Auto-claim server'),
    ],
  },
  {
    id: 'worker-quits',
    side: 'Worker',
    title: 'Worker ends the contract at once',
    summary: 'Notice protects the worker, not the company: the worker can stop today and keeps what they earned.',
    steps: [
      ...createPool({ deposit: 400 }),
      ...hire({ rate: 20, notice: 14 }),
      passDays(2),
      endContract({ by: 'Pawel', text: 'Pawel ends the contract today' }),
      step('Ended right away, two days still claimable', async (c) => {
        await c.expectVisible('badge Ended', c.row('Ended'));
        await c.tab('Claim');
        await c.expectNumber('claimable is 40 USDC', claimable(c), 40);
      }),
      poolNumbers('The notice reserve is free again', { 'Notice reserve': 0, Withdrawable: 360 }),
      historyShows('Company', 'ended your contract'),
      claim({ amount: 40 }),
    ],
  },
  {
    id: 'worker-dry',
    side: 'Worker',
    title: 'Employer’s pool runs dry',
    summary: 'The worker sees a red banner, still claims every hour that was funded, and earns again after a deposit.',
    steps: [
      ...createPool({ deposit: 120 }),
      ...hire({ rate: 50, notice: 0 }),
      passDays(3),
      step('Pawel sees a red banner', async (c) => {
        await c.as('Pawel');
        await c.expectVisible("Acme Labs' pool is empty", c.app.getByRole('alert').filter({ hasText: "Acme Labs' pool is empty" }));
      }),
      claim({ amount: 118.75 }),
      depositStep({ amount: 300 }),
      step('The red banner is gone for Pawel', async (c) => {
        await c.as('Pawel');
        await c.expectGone('no red banner', c.app.getByRole('alert').filter({ hasText: 'pool is empty' }));
      }),
    ],
  },
  {
    id: 'two-employers',
    side: 'Worker',
    title: 'Two employers, one claim',
    summary: 'Sebastian runs a company too. Pawel claims from both pools in one transaction.',
    steps: [
      ...createPool({ by: 'Sebastian', name: 'Initech', deposit: 300 }),
      ...hire({ from: 'Sebastian', rate: 30, notice: 0 }),
      ...createPool({ deposit: 600 }),
      ...hire({ rate: 50, notice: 0 }),
      passDays(1),
      claim({ amount: 80 }),
      historyShows('Pawel', '+50 USDC', '+30 USDC'),
    ],
  },
  {
    id: 'documents',
    side: 'Worker',
    title: 'Tax CSV and income certificate',
    summary: 'From the claims on chain: a CSV with the NBP rate for the accountant and a PDF for a bank or landlord.',
    steps: [
      ...createPool({ deposit: 600 }),
      ...hire({ rate: 50, notice: 0 }),
      passDays(1),
      claim({ amount: 50 }),
      step('Pawel exports the CSV on History', async (c) => {
        await c.tab('History');
        const csv = String(await c.download(c.button('Export CSV')));
        c.check('CSV has the header', csv.startsWith('Date (UTC),Amount (USDC),NBP rate (USD/PLN)'));
        c.check('CSV has the 50 USDC claim', csv.split('\n').some((l) => l.split(',')[1] === '50'), csv.split('\n')[1] ?? '');
      }),
      step('Pawel downloads the income certificate', async (c) => {
        const pdf = await c.download(c.button('Income certificate'));
        c.check('it is a PDF', pdf.subarray(0, 4).toString() === '%PDF', `${pdf.length} bytes`);
      }),
    ],
  },
  {
    id: 'no-sol',
    side: 'Worker',
    title: 'Out of SOL for fees',
    summary: 'A worker with no SOL gets a banner and one button to fix it.',
    steps: [
      ...createPool({ deposit: 300 }),
      ...hire({ rate: 30, notice: 0 }),
      step('Simulate: Pawel spent all their SOL (dev cheatcode)', async (c) => {
        await c.setLamports('Pawel', 0);
        await c.as('Pawel');
        await c.expectVisible('banner "You have 0 SOL for fees"', c.app.getByRole('alert').filter({ hasText: 'SOL for fees' }));
      }),
      step('Pawel presses Get SOL', async (c) => {
        await c.tx(() => c.click(c.button('Get SOL')), 'Airdropped 1 SOL to Pawel');
        await c.expectGone('the banner is gone', c.app.getByRole('alert').filter({ hasText: 'SOL for fees' }));
      }),
    ],
  },
  {
    id: 'demo',
    side: 'Company',
    title: 'Seed demo data',
    summary: 'One click in the dev footer: fresh accounts, three companies with different records, contracts in every state.',
    steps: [
      step('Dev footer: seed demo (about half a minute, then the page reloads)', async (c) => {
        await c.click(c.button('seed demo'));
        await c.until(
          'the demo companies are saved',
          () => c.page.evaluate(() => localStorage.getItem('easypay.demoCompanies')),
          Boolean,
          () => 'saved',
          180_000,
        );
      }),
      step('Company looks up the three demo companies', async (c) => {
        await c.as('Company');
        await c.tab('Companies');
        await c.sub('Search');
        const pick = async (name, badge) => {
          await c.click(c.button(name));
          await c.expectVisible(`${name}: ${badge}`, c.app.getByText(badge, { exact: true }));
        };
        await pick('Acme Labs', 'Score 100/100');
        await c.expectNumber('Acme Labs: 3 contracts', c.line('contracts'), 3);
        await pick('Globex', 'Score 50/100');
        await c.expectText('Globex ran out of money 2×', c.line('ran out of money'), /^2×$/);
        await pick('Initech', 'New');
      }),
      step('Company sees contracts in every state', async (c) => {
        await c.tab('Contracts');
        await c.expectVisible('an offer to a worker', c.row('Offer to'));
        await c.expectVisible('an offer from a worker', c.row('Offer from'));
        await c.expectVisible('an active contract', c.row('Active'));
        await c.expectVisible('an ended contract with pay left', c.row('Ended'));
      }),
      step('Pawel works for two companies, one of them short', async (c) => {
        await c.as('Pawel');
        await c.tab('Claim');
        await c.expectVisible('note "Pool ran short"', c.app.getByTestId('short-note'));
        await c.tab('History');
        await c.expectVisible('History shows a claim', c.app.getByText(/Claimed/).first());
      }),
      step('Sebastian has an offer from a New company', async (c) => {
        await c.as('Sebastian');
        await c.tab('Contracts');
        await c.expectText('offer from Initech is New', c.row('Initech'), /New/);
      }),
    ],
  },
];
