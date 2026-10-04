import {
  AccountRole,
  address,
  getBase58Decoder,
  getBase64Encoder,
  parseBase64RpcAccount,
  type Address,
  type Base58EncodedBytes,
  type Option,
  type ReadonlyUint8Array,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  unwrapOption,
} from '@solana/kit';
import {
  fetchAllMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { fetchSysvarClock } from '@solana/sysvars';
import {
  Asset,
  decodeOffer,
  decodePool,
  EASYPAY_PROGRAM_ADDRESS,
  fetchMaybeSplit,
  findBtcMintPda,
  findEthMintPda,
  findExchangePda,
  findSplitPda,
  getClaimInstructionAsync,
  OFFER_DISCRIMINATOR,
  Period,
  POOL_DISCRIMINATOR,
  type Pool,
  type Split,
} from './generated';
import { DAY, HOUR, type Funding } from './pay';

// What the app and the auto-claim server share: reading contracts and splits, and the claim transaction.
// No browser or Vite globals here: every function takes the RPC (and the RPC URL for Surfpool cheatcodes).
// The pay mirror is pay.ts.

export type ChainRpc = Rpc<SolanaRpcApi>;

// Circle's devnet USDC. The local chain forks devnet, so the same mint exists there.
export const USDC_MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
export const USDC_DECIMALS = 6;

// Pyth push feeds (PriceUpdateV2 accounts), the same on devnet and mainnet. The local chain clones them from devnet.
export const PRICE_FEEDS: Record<Asset, Address> = {
  [Asset.Sol]: address('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE'),
  [Asset.Btc]: address('4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo'),
  [Asset.Eth]: address('42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC'),
};

// Chain time in unix seconds, from the Clock sysvar the program reads too. Never the machine clock.
export async function getChainTime(rpc: ChainRpc): Promise<number> {
  const clock = await fetchSysvarClock(rpc);
  return Number(clock.unixTimestamp);
}

// The owner's associated token account for the mint: one fixed address per owner and mint.
export const ataOf = async (owner: Address, mint: Address) =>
  (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];

// The worker's split, or null if they never saved one. It lives at the PDA [b"split", employee].
export async function getSplit(rpc: ChainRpc, employee: Address): Promise<Split | null> {
  const [address] = await findSplitPda({ employee });
  const split = await fetchMaybeSplit(rpc, address);
  return split.exists ? split.data : null;
}

// What pay.ts settles a pool from: the vault balance, the stored funded_until and the used slots.
export const fundingOf = (pool: Pool, vaultBalance: bigint | undefined): Funding => ({
  balance: vaultBalance ?? 0n,
  fundedUntil: Number(pool.fundedUntil),
  contracts: pool.slots
    .filter((s) => s.used)
    .map(({ rate, period, weekdaysOnly, start, end, claimed, notice }) => ({
      rate,
      period: periodSecs(period),
      weekdaysOnly,
      start: Number(start),
      end: endOf(end),
      claimed,
      notice,
    })),
});

// Seconds in a contract's period, as pay.ts takes it.
const periodSecs = (period: Period) => (period === Period.Hour ? HOUR : DAY);

// The end in unix seconds, null while open-ended. The program stores Option<i64>.
const endOf = (end: Option<bigint>) => {
  const value = unwrapOption(end);
  return value === null ? null : Number(value);
};

// The pool's public history counters, what the Companies tab scores a company from.
export type CompanyRecord = { contractsTotal: number; paidTotal: bigint; ranDryCount: number };
export const recordOf = ({ contractsTotal, paidTotal, ranDryCount }: Pool): CompanyRecord => ({
  contractsTotal,
  paidTotal,
  ranDryCount,
});

// Every account of one type that our program owns, optionally narrowed by more memcmp filters. getProgramAccounts
// scans all of the program's accounts and the first filter keeps one type: Anchor starts each account with an
// 8-byte discriminator of its type. No size filter: the optional contract end makes the layout variable size.
// On Surfpool this also asks devnet, about 0.1 s.
export async function getAccountsOfType(
  rpc: ChainRpc,
  discriminator: ReadonlyUint8Array,
  more: { offset: number; bytes: ReadonlyUint8Array }[] = [],
) {
  const base58 = (b: ReadonlyUint8Array) => getBase58Decoder().decode(b) as Base58EncodedBytes;
  const filters = [{ offset: 0, bytes: discriminator }, ...more].map(({ offset, bytes }) => ({
    memcmp: { offset: BigInt(offset), bytes: base58(bytes), encoding: 'base58' as const },
  }));
  const accounts = await rpc.getProgramAccounts(EASYPAY_PROGRAM_ADDRESS, { encoding: 'base64', filters }).send();
  return accounts.map(({ pubkey, account }) => parseBase64RpcAccount(pubkey, account));
}

// Decodes what it can and skips the rest: an account made by an older program version has another layout and
// fails to decode, and one of those must not break the whole list.
export function decodeEach<T>(
  list: Awaited<ReturnType<typeof getAccountsOfType>>,
  decode: (a: (typeof list)[number]) => T,
) {
  return list.flatMap((a) => {
    try {
      return [decode(a)];
    } catch {
      return [];
    }
  });
}

// An offer waiting for the other side's signature. employer is the employer of the offer's pool, proposer is
// employer or employee, whoever sent it.
export type PendingOffer = {
  address: Address;
  pool: Address;
  employer: Address;
  employee: Address;
  proposer: Address;
  rate: bigint;
  period: number;
  weekdaysOnly: boolean;
  start: number;
  end: number | null;
  notice: number; // periods pay keeps running after the employer ends the contract
  // What the contract is for, can be empty. companyName is the pool's name, set by the company and not verified.
  title: string;
  companyName: string;
  record: CompanyRecord; // the employer's pool counters, for the score under the offer
};
// An accepted contract, in slot `slot` of `pool`. rate is base units per period, period its length in seconds
// (DAY or HOUR), weekdaysOnly true when only Monday to Friday UTC pay, start and end in unix seconds (end null
// while open-ended), claimed the base units the worker already took, notice the periods pay keeps running after the
// employer ends it. funding is its pool's, for settle.
// pay.ts turns these into what Claim pays now.
export type Contract = {
  pool: Address;
  employer: Address;
  slot: number;
  employee: Address;
  rate: bigint;
  period: number;
  weekdaysOnly: boolean;
  start: number;
  end: number | null;
  claimed: bigint;
  notice: number;
  funding: Funding;
  title: string;
  companyName: string;
};

// The owner's pending offers and contracts on both sides, as the employer and as the worker.
// Reads every pool and offer of our program and keeps the owner's. Fine for a handful of pools. With many we
// would filter on the RPC side (memcmp on the offer's employee) or use an indexer.
export async function getContracts(
  rpc: ChainRpc,
  owner: Address,
): Promise<{ offers: PendingOffer[]; contracts: Contract[] }> {
  const [pools, offers] = await Promise.all([
    getAccountsOfType(rpc, POOL_DISCRIMINATOR).then((list) => decodeEach(list, (a) => decodePool(a))),
    getAccountsOfType(rpc, OFFER_DISCRIMINATOR).then((list) => decodeEach(list, (a) => decodeOffer(a))),
  ]);

  // The pools the owner is in, with their vault balances: Claim pays only what the vault covers.
  const mine = pools.filter(
    ({ data }) => data.employer === owner || data.slots.some((s) => s.used && s.employee === owner),
  );
  const vaults = await Promise.all(mine.map(({ address, data }) => ataOf(address, data.mint)));
  const tokens = await fetchAllMaybeToken(rpc, vaults);

  const contracts = mine.flatMap(({ address: pool, data }, i) => {
    const funding = fundingOf(data, tokens[i].exists ? tokens[i].data.amount : undefined);
    return data.slots.flatMap(({ used, employee, rate, period, weekdaysOnly, start, end, claimed, title, notice }, slot) =>
      used && (data.employer === owner || employee === owner)
        ? [
            {
              pool,
              employer: data.employer,
              slot,
              employee,
              rate,
              period: periodSecs(period),
              weekdaysOnly,
              start: Number(start),
              end: endOf(end),
              claimed,
              notice,
              funding,
              title,
              companyName: data.name,
            },
          ]
        : [],
    );
  });

  const poolOf = new Map(pools.map(({ address, data }) => [address, data]));
  const pending = offers.flatMap(({ address, data }) => {
    const { pool, employee, proposer, rate, period, weekdaysOnly, start, end, title, notice } = data;
    const employer = poolOf.get(pool)?.employer;
    return employer && (employer === owner || employee === owner)
      ? [
          {
            address,
            pool,
            employer,
            employee,
            proposer,
            rate,
            period: periodSecs(period),
            weekdaysOnly,
            start: Number(start),
            end: endOf(end),
            notice,
            title,
            companyName: poolOf.get(pool)!.name,
            record: recordOf(poolOf.get(pool)!),
          },
        ]
      : [];
  });

  return { offers: pending, contracts };
}

// Where the price message starts in a PriceUpdateV2: discriminator (8), write authority (32), then the verification
// level, 1 byte for Full and 2 for Partial. In it: feed id (32), price i64, conf u64, exponent i32, publish_time i64.
export const priceMessageOffset = (data: Uint8Array) => 41 + (data[40] === 0 ? 1 : 0);

export async function getAccountBytes(rpc: ChainRpc, account: Address) {
  const { value } = await rpc.getAccountInfo(account, { encoding: 'base64' }).send();
  if (!value) throw new Error(`Account ${account} not found`);
  return { owner: value.owner, data: new Uint8Array(getBase64Encoder().encode(value.data[0])) };
}

// Calls a Surfpool cheatcode. These JSON-RPC methods exist only on Surfpool, so Kit has no wrapper.
export async function cheatcode(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

// Local only. Surfpool clones a price account once, so its publish_time goes stale within minutes, and always after
// time travel, and the program refuses a price older than 120 s. Rewrites publish_time in the three feeds to chain
// time, keeping the cloned price. Whoever sends a claim on Local calls this first.
export async function refreshPythPrices(rpc: ChainRpc, rpcUrl: string) {
  const now = BigInt(await getChainTime(rpc));
  await Promise.all(
    Object.values(PRICE_FEEDS).map(async (feed) => {
      const { data } = await getAccountBytes(rpc, feed);
      new DataView(data.buffer).setBigInt64(priceMessageOffset(data) + 32 + 20, now, true);
      const hex = [...data].map((b) => b.toString(16).padStart(2, '0')).join('');
      await cheatcode(rpcUrl, 'surfnet_setAccount', [feed, { data: hex }]);
    }),
  );
}

// The exchange accounts claim takes on every claim, for the split's asset (SOL without a split). SOL goes to the
// worker's wallet, BTC and ETH to the worker's associated token account for the exchange's test mint.
async function exchangeAccounts(owner: Address, asset: Asset) {
  const [exchange] = await findExchangePda();
  const assetMint =
    asset === Asset.Btc ? (await findBtcMintPda())[0] : asset === Asset.Eth ? (await findEthMintPda())[0] : undefined;
  return {
    exchangeUsdc: await ataOf(exchange, USDC_MINT),
    price: PRICE_FEEDS[asset],
    assetMint,
    employeeAsset: assetMint ? await ataOf(owner, assetMint) : owner,
  };
}

// The instructions of the one transaction that claims everything `owner` can claim from `contracts` (pool and slot
// of each, all with something to pay), paid out by `split`, signed and paid by `signer` (the worker or their
// split.claimer). In it: the worker's, the split addresses' and the worker's BTC or ETH accounts get created if
// missing (the idempotent create does nothing when one exists, so a recipient who closed theirs can't block the
// claim), then one claim per contract with the split addresses' USDC accounts as remaining accounts, in split
// order. All of it lands, or none of it. Before it, on Local, call refreshPythPrices so the swap sees a fresh price.
export async function claimInstructions(
  signer: TransactionSigner,
  owner: Address,
  split: Split | null,
  contracts: { pool: Address; slot: number }[],
) {
  const asset = split?.investAsset ?? Asset.Sol;
  const investing = (split?.investPct ?? 0) > 0;
  const recipients = split?.recipients.map((r) => r.owner) ?? [];
  const exchange = await exchangeAccounts(owner, asset);
  const atas = await Promise.all(recipients.map((r) => ataOf(r, USDC_MINT)));
  const remaining = atas.map((address) => ({ address, role: AccountRole.WRITABLE }));
  const creates: { owner: Address; mint: Address }[] = [owner, ...recipients].map((o) => ({ owner: o, mint: USDC_MINT }));
  if (investing && exchange.assetMint) creates.push({ owner, mint: exchange.assetMint });

  return Promise.all([
    ...creates.map(({ owner, mint }) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner, mint })),
    ...contracts.map(async ({ pool, slot }) => {
      const ix = await getClaimInstructionAsync({ signer, employee: owner, pool, mint: USDC_MINT, slot, ...exchange });
      return { ...ix, accounts: [...ix.accounts, ...remaining] };
    }),
  ]);
}
