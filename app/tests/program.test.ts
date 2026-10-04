import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ReadonlyUint8Array,
  unwrapOption,
} from '@solana/kit';
import { AccountState, getMintEncoder, getTokenEncoder, decodeToken, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { Clock, FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { ataOf, claimInstructions, USDC_MINT } from '../src/core';
import {
  Asset,
  decodePool,
  decodeSplit,
  EASYPAY_PROGRAM_ADDRESS,
  findPoolPda,
  findSplitPda,
  getAcceptInstructionAsync,
  getCreatePoolInstructionAsync,
  getDepositInstructionAsync,
  getEndContractInstructionAsync,
  getProposeInstructionAsync,
  getSetSplitInstructionAsync,
  getWithdrawInstructionAsync,
  Period,
} from '../src/generated';

// Program tests on LiteSVM: the built program (target/deploy/easypay.so) runs in-process, no validator, no lock.
// Transactions are built with the same Codama client the app uses. Run `anchor build` first after a program change.

const USDC = 1_000_000n;
const DAY = 86_400n;
// Monday 2026-10-05 00:00 UTC, a fixed chain time so the tests don't depend on the machine clock.
const MONDAY = BigInt(Date.UTC(2026, 9, 5) / 1000);

// A fresh chain with our program, the USDC mint at the address the app hard-codes, and the clock at MONDAY.
function chain() {
  const svm = new LiteSVM();
  svm.addProgramFromFile(EASYPAY_PROGRAM_ADDRESS, new URL('../../target/deploy/easypay.so', import.meta.url).pathname);
  const mint = getMintEncoder().encode({
    mintAuthority: null,
    supply: 1_000_000n * USDC,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: null,
  });
  setRaw(svm, USDC_MINT, TOKEN_PROGRAM_ADDRESS, mint);
  setTime(svm, MONDAY);
  return svm;
}

function setRaw(svm: LiteSVM, address: Address, owner: Address, data: ReadonlyUint8Array) {
  const space = BigInt(data.length);
  // litesvm ships its own @solana/kit 8, whose branded types don't match ours. The shapes are the same.
  svm.setAccount({
    address,
    data,
    executable: false,
    lamports: lamports(svm.minimumBalanceForRentExemption(space)),
    programAddress: owner,
    space,
  } as never);
}

// Moves chain time to `unix` seconds, what the program reads from the Clock sysvar.
function setTime(svm: LiteSVM, unix: bigint) {
  const c = svm.getClock();
  svm.setClock(new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unix));
}

const now = (svm: LiteSVM) => svm.getClock().unixTimestamp;

// A funded wallet holding `usdc` base units in its USDC account.
async function wallet(svm: LiteSVM, usdc = 0n) {
  const signer = await generateKeyPairSigner();
  svm.airdrop(signer.address as never, lamports(10_000_000_000n) as never);
  if (usdc > 0n) {
    const data = getTokenEncoder().encode({
      mint: USDC_MINT,
      owner: signer.address,
      amount: usdc,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    });
    setRaw(svm, await ataOf(signer.address, USDC_MINT), TOKEN_PROGRAM_ADDRESS, data);
  }
  return signer;
}

// Sends one transaction paid by `payer`. Throws with the program logs when it fails.
async function send(svm: LiteSVM, payer: KeyPairSigner, instructions: Instruction[]) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash({ blockhash: svm.latestBlockhash() as never, lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  const result = svm.sendTransaction(tx as never);
  // A new blockhash, so sending the same instructions again is a new transaction.
  svm.expireBlockhash();
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(`${result.toString()}\n${result.meta().logs().join('\n')}`);
  }
  return result;
}

const usdcOf = async (svm: LiteSVM, owner: Address) => {
  const account = svm.getAccount((await ataOf(owner, USDC_MINT)) as never);
  return account.exists ? decodeToken(account as never).data.amount : 0n;
};

const poolOf = async (svm: LiteSVM, employer: Address) => {
  const [address] = await findPoolPda({ employer });
  return { address, data: decodePool(svm.getAccount(address as never) as never).data };
};

// Expects the transaction to fail with the program error `name`.
async function rejects(promise: Promise<unknown>, name: string) {
  await assert.rejects(promise, (e: Error) => e.message.includes(`Error Code: ${name}`));
}

// A company with a pool holding `deposit`, and a worker hired at `rate` per `period` (a day by default) from now
// with `notice` periods of notice: the company proposes, the worker accepts. `accepted` overrides terms the worker
// signs, to test a changed offer.
async function hire(svm: LiteSVM, rate: bigint, deposit: bigint, notice = 0, period = Period.Day, accepted = {}) {
  const employer = await wallet(svm, 1_000n * USDC);
  const worker = await wallet(svm);
  await send(svm, employer, [await getCreatePoolInstructionAsync({ employer, mint: USDC_MINT, name: 'Acme' })]);
  await send(svm, employer, [await getDepositInstructionAsync({ employer, mint: USDC_MINT, amount: deposit })]);
  const terms = { rate, period, weekdaysOnly: false, start: now(svm), end: null, title: 'Dev', notice };
  await send(svm, employer, [
    await getProposeInstructionAsync({
      proposer: employer,
      employer: employer.address,
      employee: worker.address,
      ...terms,
    }),
  ]);
  await send(svm, worker, [
    await getAcceptInstructionAsync({
      signer: worker,
      employer: employer.address,
      employee: worker.address,
      proposer: employer.address,
      mint: USDC_MINT,
      ...terms,
      ...accepted,
    }),
  ]);
  return { employer, worker };
}

// The worker claims slot 0 of the employer's pool, the same transaction the app sends.
async function claim(svm: LiteSVM, worker: KeyPairSigner, employer: Address) {
  const { address: pool } = await poolOf(svm, employer);
  await send(svm, worker, await claimInstructions(worker, worker.address, null, [{ pool, slot: 0 }]));
}

test('company creates a pool and deposits USDC', async () => {
  const svm = chain();
  const employer = await wallet(svm, 1_000n * USDC);
  await send(svm, employer, [await getCreatePoolInstructionAsync({ employer, mint: USDC_MINT, name: 'Acme' })]);
  await send(svm, employer, [await getDepositInstructionAsync({ employer, mint: USDC_MINT, amount: 300n * USDC })]);

  const pool = await poolOf(svm, employer.address);
  assert.equal(pool.data.name, 'Acme');
  assert.equal(await usdcOf(svm, pool.address), 300n * USDC);
  assert.equal(await usdcOf(svm, employer.address), 700n * USDC);
});

test('worker accepts the offer and the contract takes a slot', async () => {
  const svm = chain();
  const { employer, worker } = await hire(svm, 100n * USDC, 300n * USDC);

  const { data } = await poolOf(svm, employer.address);
  assert.equal(data.slots[0].used, true);
  assert.equal(data.slots[0].employee, worker.address);
  assert.equal(data.slots[0].rate, 100n * USDC);
  assert.equal(data.contractsTotal, 1);
});

test('worker claims what they earned, day by day', async () => {
  const svm = chain();
  const { employer, worker } = await hire(svm, 100n * USDC, 300n * USDC);

  // Half a day in nothing is earned yet: pay accrues per full day.
  setTime(svm, MONDAY + DAY / 2n);
  await rejects(claim(svm, worker, employer.address), 'NothingToClaim');

  setTime(svm, MONDAY + 2n * DAY);
  await claim(svm, worker, employer.address);
  assert.equal(await usdcOf(svm, worker.address), 200n * USDC);
  assert.equal((await poolOf(svm, employer.address)).data.slots[0].claimed, 200n * USDC);
});

test('company withdraws only what is not earned yet', async () => {
  const svm = chain();
  const { employer } = await hire(svm, 100n * USDC, 300n * USDC);
  setTime(svm, MONDAY + DAY);

  // 300 in the vault, 100 earned by the worker: 200 can go back.
  await rejects(
    send(svm, employer, [await getWithdrawInstructionAsync({ employer, mint: USDC_MINT, amount: 200n * USDC + 1n })]),
    'MoreThanWithdrawable',
  );
  await send(svm, employer, [await getWithdrawInstructionAsync({ employer, mint: USDC_MINT, amount: 200n * USDC })]);
  assert.equal(await usdcOf(svm, employer.address), 900n * USDC);
});

test('an ended contract stops paying, earned pay stays claimable', async () => {
  const svm = chain();
  const { employer, worker } = await hire(svm, 100n * USDC, 500n * USDC);
  setTime(svm, MONDAY + DAY);
  await send(svm, employer, [
    await getEndContractInstructionAsync({
      signer: employer,
      employer: employer.address,
      employee: worker.address,
      slot: 0,
      end: null,
    }),
  ]);

  // Three days later the worker still gets only the one day before the end.
  setTime(svm, MONDAY + 4n * DAY);
  await claim(svm, worker, employer.address);
  assert.equal(await usdcOf(svm, worker.address), 100n * USDC);
});

// Notice period: the pool keeps every contract's next N days locked, the employer's end waits for them.

// end_contract on slot 0, signed by `signer`, at `end` (null: the earliest end the program allows).
async function end(svm: LiteSVM, signer: KeyPairSigner, employer: Address, worker: Address, end: bigint | null) {
  await send(svm, signer, [
    await getEndContractInstructionAsync({ signer, employer, employee: worker, slot: 0, end }),
  ]);
}

const endOf = async (svm: LiteSVM, employer: Address) =>
  unwrapOption((await poolOf(svm, employer)).data.slots[0].end);

test('accept needs the pool to cover the notice', async () => {
  // 14 days of notice at 50 a day locks 700 from the start.
  await assert.rejects(hire(chain(), 50n * USDC, 699n * USDC, 14), (e: Error) =>
    e.message.includes('Error Code: PoolShort'),
  );
  await hire(chain(), 50n * USDC, 700n * USDC, 14);
});

test('withdraw keeps the notice reserve, the current day included', async () => {
  const svm = chain();
  const { employer } = await hire(svm, 50n * USDC, 1_000n * USDC, 14);
  // Tuesday noon: Monday earned, Tuesday and 13 more days of notice locked, 15 days at 50.
  setTime(svm, MONDAY + DAY + DAY / 2n);
  await rejects(
    send(svm, employer, [await getWithdrawInstructionAsync({ employer, mint: USDC_MINT, amount: 250n * USDC + 1n })]),
    'MoreThanWithdrawable',
  );
  await send(svm, employer, [await getWithdrawInstructionAsync({ employer, mint: USDC_MINT, amount: 250n * USDC })]);
  assert.equal(await usdcOf(svm, employer.address), 250n * USDC);
});

test("employer's end waits for the notice and the worker is paid through it", async () => {
  const svm = chain();
  const { employer, worker } = await hire(svm, 50n * USDC, 1_000n * USDC, 14);
  setTime(svm, MONDAY + DAY + DAY / 2n);

  await rejects(end(svm, employer, employer.address, worker.address, MONDAY + 10n * DAY), 'EndTooEarly');
  await end(svm, employer, employer.address, worker.address, null);
  // The last midnight (Tuesday) plus 14 days.
  assert.equal(await endOf(svm, employer.address), MONDAY + 15n * DAY);

  setTime(svm, MONDAY + 30n * DAY);
  await claim(svm, worker, employer.address);
  assert.equal(await usdcOf(svm, worker.address), 750n * USDC);
  // Pay stopped at the end, the rest is the employer's again.
  await send(svm, employer, [await getWithdrawInstructionAsync({ employer, mint: USDC_MINT, amount: 250n * USDC })]);
});

test('employer can pick a later end, the worker can end at once', async () => {
  const svm = chain();
  const { employer, worker } = await hire(svm, 50n * USDC, 1_000n * USDC, 14);

  await rejects(end(svm, employer, employer.address, worker.address, MONDAY + 400n * DAY), 'EndTooFar');
  await rejects(end(svm, employer, employer.address, worker.address, MONDAY + 20n * DAY + 1n), 'BadEnd');
  await end(svm, employer, employer.address, worker.address, MONDAY + 20n * DAY);
  assert.equal(await endOf(svm, employer.address), MONDAY + 20n * DAY);

  // Wednesday 01:00: the worker leaves at the last midnight, no notice on their side.
  setTime(svm, MONDAY + 2n * DAY + 3_600n);
  await end(svm, worker, employer.address, worker.address, null);
  assert.equal(await endOf(svm, employer.address), MONDAY + 2n * DAY);
});

test('accept fails when the notice differs from the offer', async () => {
  await rejects(hire(chain(), 50n * USDC, 1_000n * USDC, 14, Period.Day, { notice: 0 }), 'OfferChanged');
});

test('hourly contract: notice in hours locks and delays the end (demo case)', async () => {
  const svm = chain();
  const { employer, worker } = await hire(svm, 10n * USDC, 100n * USDC, 3, Period.Hour);
  // 01:30: one hour earned, 01:00 plus 3 hours of notice locked, 40 in all.
  setTime(svm, MONDAY + 5_400n);
  await rejects(
    send(svm, employer, [await getWithdrawInstructionAsync({ employer, mint: USDC_MINT, amount: 60n * USDC + 1n })]),
    'MoreThanWithdrawable',
  );
  await end(svm, employer, employer.address, worker.address, null);
  assert.equal(await endOf(svm, employer.address), MONDAY + 4n * 3_600n);

  setTime(svm, MONDAY + DAY);
  await claim(svm, worker, employer.address);
  assert.equal(await usdcOf(svm, worker.address), 40n * USDC);
});

test('set_split stores the encrypted labels blob as is and overwrites it', async () => {
  const svm = chain();
  const worker = await wallet(svm);
  const mom = await generateKeyPairSigner();
  const [split] = await findSplitPda({ employee: worker.address });
  const save = async (labels: Uint8Array) =>
    send(svm, worker, [
      await getSetSplitInstructionAsync({
        employee: worker,
        recipients: [{ owner: mom.address, pct: 10 }],
        investPct: 0,
        investAsset: Asset.Sol,
        claimer: null,
        labels,
      }),
    ]);
  const labelsOf = () => decodeSplit(svm.getAccount(split as never) as never).data.labels;

  const blob = crypto.getRandomValues(new Uint8Array(128));
  await save(blob);
  assert.deepEqual([...labelsOf()], [...blob]);
  await save(new Uint8Array(128));
  assert.ok(labelsOf().every((b) => b === 0));
});
