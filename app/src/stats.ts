import {
  containsBytes,
  createSolanaRpc,
  getBase64Encoder,
  type Address,
  type ReadonlyUint8Array,
  type Signature,
} from '@solana/kit';
import { fetchAllMaybeToken } from '@solana-program/token';
import { getChainTime, RPC_URL } from './chain';
import { ataOf, decodeEach, fundingOf, getAccountsOfType } from './core';
import {
  ACCEPTED_EVENT_DISCRIMINATOR,
  CLAIMED_EVENT_DISCRIMINATOR,
  decodePool,
  DEPOSITED_EVENT_DISCRIMINATOR,
  EASYPAY_PROGRAM_ADDRESS,
  ENDED_EVENT_DISCRIMINATOR,
  getAcceptedEventDecoder,
  getClaimedEventDecoder,
  getDepositedEventDecoder,
  getEndedEventDecoder,
  getWithdrewEventDecoder,
  POOL_DISCRIMINATOR,
  WITHDREW_EVENT_DISCRIMINATOR,
  type Pool,
} from './generated';
import { covers, DAY, ended, lastFull, locked } from './pay';

// App-wide numbers for the Stats page and the admin panel, read only from the chain. Display only, the program
// knows nothing about them. The summing below is pure, so it runs without a chain.

const rpc = createSolanaRpc(RPC_URL);

// Newest program transactions read for activity and the chart. Without an indexer every one is a getTransaction,
// and the public devnet RPC limits requests per IP.
export const MAX_TRANSACTIONS = 300;
const BATCH = 10;

// One pool as the chain holds it, with its vault balance in base units.
export type PoolInput = { address: Address; pool: Pool; balance: bigint };

// One company's row. active counts contracts that have not ended, locked is what withdraw must leave in the vault,
// daysLeft the runway from covers (null without active contracts).
export type CompanyStats = {
  pool: Address;
  employer: Address;
  name: string;
  contractsTotal: number;
  active: number;
  paidTotal: bigint;
  ranDryCount: number;
  balance: bigint;
  locked: bigint;
  daysLeft: number | null;
};

export type Totals = {
  companies: number;
  activeContracts: number;
  contractors: number; // distinct workers with an active contract
  paidTotal: bigint;
  lockedTotal: bigint;
  inPools: bigint;
};

export function summarize(pools: PoolInput[], now: number): { totals: Totals; companies: CompanyStats[] } {
  const contractors = new Set<Address>();
  const companies = pools.map(({ address, pool, balance }) => {
    const funding = fundingOf(pool, balance);
    const used = pool.slots.filter((s) => s.used);
    // fundingOf keeps the used slots in order, so index i is the same contract in both lists.
    const running = funding.contracts.flatMap((c, i) => (ended(c, now) ? [] : [used[i].employee]));
    running.forEach((employee) => contractors.add(employee));
    return {
      pool: address,
      employer: pool.employer,
      name: pool.name,
      contractsTotal: pool.contractsTotal,
      active: running.length,
      paidTotal: pool.paidTotal,
      ranDryCount: pool.ranDryCount,
      balance,
      locked: locked(funding.contracts, now),
      daysLeft: covers(funding, now)?.days ?? null,
    };
  });
  const sum = (pick: (c: CompanyStats) => bigint) => companies.reduce((s, c) => s + pick(c), 0n);
  return {
    totals: {
      companies: companies.length,
      activeContracts: companies.reduce((s, c) => s + c.active, 0),
      contractors: contractors.size,
      paidTotal: sum((c) => c.paidTotal),
      lockedTotal: sum((c) => c.locked),
      inPools: sum((c) => c.balance),
    },
    companies,
  };
}

// One event of a landed transaction. amount is null for events without one.
export type ActivityKind = 'Deposit' | 'Withdraw' | 'New contract' | 'Claim' | 'Contract ended';
export type Activity = { signature: Signature; time: number; kind: ActivityKind; pool: Address; amount: bigint | null };

type Decoder = [ReadonlyUint8Array, ActivityKind, (bytes: Uint8Array) => { pool: Address; amount?: bigint }];
const DECODERS: Decoder[] = [
  [DEPOSITED_EVENT_DISCRIMINATOR, 'Deposit', (b) => getDepositedEventDecoder().decode(b)],
  [WITHDREW_EVENT_DISCRIMINATOR, 'Withdraw', (b) => getWithdrewEventDecoder().decode(b)],
  [ACCEPTED_EVENT_DISCRIMINATOR, 'New contract', (b) => ({ pool: getAcceptedEventDecoder().decode(b).pool })],
  [CLAIMED_EVENT_DISCRIMINATOR, 'Claim', (b) => getClaimedEventDecoder().decode(b)],
  [ENDED_EVENT_DISCRIMINATOR, 'Contract ended', (b) => ({ pool: getEndedEventDecoder().decode(b).pool })],
];

// The events in a transaction's logs, where Anchor writes each as "Program data: <base64>".
export function activityOf(signature: Signature, time: number, logs: readonly string[]): Activity[] {
  return logs.flatMap((line) => {
    if (!line.startsWith('Program data: ')) return [];
    const bytes = new Uint8Array(getBase64Encoder().encode(line.slice('Program data: '.length)));
    const match = DECODERS.find(([discriminator]) => containsBytes(bytes, discriminator, 0));
    if (!match) return [];
    const { pool, amount } = match[2](bytes);
    return [{ signature, time, kind: match[1], pool, amount: amount ?? null }];
  });
}

// Claimed base units per UTC day for the last `days` days up to chain time `now`, oldest first.
export function paidByDay(activity: Activity[], now: number, days = 30): { day: number; amount: bigint }[] {
  const today = lastFull(DAY, now);
  const buckets = Array.from({ length: days }, (_, i) => ({ day: today - (days - 1 - i) * DAY, amount: 0n }));
  for (const a of activity) {
    if (a.kind !== 'Claim' || a.amount === null) continue;
    const bucket = buckets[(lastFull(DAY, a.time) - buckets[0].day) / DAY];
    if (bucket) bucket.amount += a.amount;
  }
  return buckets;
}

// Every pool with its vault balance.
async function getPools(): Promise<PoolInput[]> {
  const list = await getAccountsOfType(rpc, POOL_DISCRIMINATOR);
  const pools = decodeEach(list, (a) => decodePool(a));
  const vaults = await Promise.all(pools.map(({ address, data }) => ataOf(address, data.mint)));
  const tokens = await fetchAllMaybeToken(rpc, vaults);
  return pools.map(({ address, data }, i) => ({
    address,
    pool: data,
    balance: tokens[i].exists ? tokens[i].data.amount : 0n,
  }));
}

// Events of the newest MAX_TRANSACTIONS landed program transactions, newest first. time is the block time from
// getTransaction: after time travel Surfpool's getSignaturesForAddress reports a wrong one.
async function getActivity(): Promise<Activity[]> {
  const page = await rpc.getSignaturesForAddress(EASYPAY_PROGRAM_ADDRESS, { limit: MAX_TRANSACTIONS }).send();
  const landed = page.filter((s) => s.err === null).map((s) => s.signature);
  const activity: Activity[] = [];
  for (let i = 0; i < landed.length; i += BATCH) {
    const txs = await Promise.all(
      landed.slice(i, i + BATCH).map((signature) =>
        rpc.getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }).send(),
      ),
    );
    txs.forEach((tx, j) => {
      if (!tx || tx.meta?.err != null || tx.blockTime === null) return;
      activity.push(...activityOf(landed[i + j], Number(tx.blockTime), tx.meta?.logMessages ?? []));
    });
  }
  return activity.sort((a, b) => b.time - a.time);
}

export type Stats = { now: number; totals: Totals; companies: CompanyStats[]; activity: Activity[] };

export async function getStats(): Promise<Stats> {
  const [now, pools, activity] = await Promise.all([getChainTime(), getPools(), getActivity()]);
  return { now, ...summarize(pools, now), activity };
}
