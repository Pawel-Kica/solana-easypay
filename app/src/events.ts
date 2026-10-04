import { containsBytes, createSolanaRpc, getBase64Encoder, type Address, type Signature } from '@solana/kit';
import { RPC_URL } from './chain';
import {
  ACCEPTED_EVENT_DISCRIMINATOR,
  CLAIMED_EVENT_DISCRIMINATOR,
  ENDED_EVENT_DISCRIMINATOR,
  fetchAllMaybePool,
  getAcceptedEventDecoder,
  getClaimedEventDecoder,
  getEndedEventDecoder,
  Period,
  type AcceptedEvent,
  type ClaimedEvent,
  type EndedEvent,
} from './generated';
import { DAY, HOUR } from './pay';

// Reads the program's events from a worker's transactions. Anchor writes each event into the logs as
// "Program data: <base64>", 8 bytes of discriminator first. Only what the income certificate needs: Accepted,
// Claimed, Ended.

const rpc = createSolanaRpc(RPC_URL);

type Event =
  | { kind: 'Accepted'; data: AcceptedEvent }
  | { kind: 'Claimed'; data: ClaimedEvent }
  | { kind: 'Ended'; data: EndedEvent };
type Landed = { signature: Signature; time: number; events: Event[] };

// One "Program data:" payload as an event we read, or null for anything else.
function decodeEvent(bytes: Uint8Array): Event | null {
  if (containsBytes(bytes, ACCEPTED_EVENT_DISCRIMINATOR, 0))
    return { kind: 'Accepted', data: getAcceptedEventDecoder().decode(bytes) };
  if (containsBytes(bytes, CLAIMED_EVENT_DISCRIMINATOR, 0))
    return { kind: 'Claimed', data: getClaimedEventDecoder().decode(bytes) };
  if (containsBytes(bytes, ENDED_EVENT_DISCRIMINATOR, 0))
    return { kind: 'Ended', data: getEndedEventDecoder().decode(bytes) };
  return null;
}

// The owner's landed transactions with their events, oldest first. Failed ones are skipped: their logs can hold
// an event the rollback undid. time is the block time in unix seconds (from getTransaction, see getHistory).
async function getEvents(owner: Address): Promise<Landed[]> {
  const signatures: { signature: Signature; err: unknown }[] = [];
  let before: Signature | undefined;
  // RPC returns at most 1,000 signatures per page. Income exports need the whole history.
  for (;;) {
    const page = await rpc.getSignaturesForAddress(owner, { before, limit: 1000 }).send();
    signatures.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  const landed = await Promise.all(
    signatures
      .filter((s) => s.err === null)
      .reverse()
      .map(async ({ signature }) => {
        const tx = await rpc
          .getTransaction(signature, {
            commitment: 'confirmed',
            encoding: 'json',
            maxSupportedTransactionVersion: 0,
          })
          .send();
        if (!tx || tx.meta?.err != null || tx.blockTime === null) return null;
        const events = (tx.meta?.logMessages ?? [])
          .filter((line) => line.startsWith('Program data: '))
          .map((line) => decodeEvent(new Uint8Array(getBase64Encoder().encode(line.slice('Program data: '.length)))))
          .filter((e): e is Event => e !== null);
        return { signature, time: Number(tx.blockTime), events };
      }),
  );
  return landed.filter((l): l is Landed => l !== null);
}

// One claim as the certificate lists it: gross base units, before any split.
export type IncomeClaim = {
  signature: Signature;
  time: number;
  amount: bigint;
};

// One of the worker's contracts, terms from its Accepted event, claims matched to it by pool and slot in time
// order. An ended contract frees its slot for a later one, so terms never come from the pool. period is DAY or
// HOUR seconds, end null while open-ended. companyName is the pool's current name, set by the company.
export type IncomeContract = {
  pool: Address;
  employer: Address;
  companyName: string;
  slot: number;
  title: string;
  rate: bigint;
  period: number;
  start: number;
  end: number | null;
  claims: IncomeClaim[];
};

// Every contract the owner had as the worker, oldest first, with all its claims.
export async function getIncome(owner: Address): Promise<IncomeContract[]> {
  type Draft = Omit<IncomeContract, 'employer' | 'companyName'>;
  const contracts: Draft[] = [];
  const current = new Map<string, Draft>(); // `${pool}:${slot}` to the contract in it now
  for (const { signature, time, events } of await getEvents(owner)) {
    for (const { kind, data } of events) {
      if (data.employee !== owner) continue;
      const key = `${data.pool}:${data.slot}`;
      if (kind === 'Accepted') {
        const end = data.end.__option === 'Some' ? Number(data.end.value) : null;
        const contract: Draft = {
          pool: data.pool,
          slot: data.slot,
          title: data.title,
          rate: data.rate,
          period: data.period === Period.Hour ? HOUR : DAY,
          start: Number(data.start),
          end,
          claims: [],
        };
        contracts.push(contract);
        current.set(key, contract);
      } else if (kind === 'Claimed') {
        current.get(key)?.claims.push({ signature, time, amount: data.amount });
      } else {
        const contract = current.get(key);
        if (contract) contract.end = Number(data.end);
      }
    }
  }

  const pools = [...new Set(contracts.map((c) => c.pool))];
  const accounts = await fetchAllMaybePool(rpc, pools);
  const byAddress = new Map(accounts.flatMap((a) => (a.exists ? [[a.address, a.data] as const] : [])));
  // Pools are never closed. If one is missing anyway, its address stands in for the employer's.
  return contracts.map((c) => {
    const pool = byAddress.get(c.pool);
    return {
      ...c,
      employer: pool?.employer ?? c.pool,
      companyName: pool?.name ?? '',
    };
  });
}
