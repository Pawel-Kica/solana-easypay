import {
  address,
  containsBytes,
  createClient,
  createSignableMessage,
  decodeTransactionFromRpcResponse,
  devnet,
  getBase64Encoder,
  getInstructionsFromCompiledTransactionMessage,
  isInstructionWithData,
  isMessagePartialSigner,
  lamports,
  type Address,
  type ReadonlyUint8Array,
  type Signature,
  type TransactionSigner,
} from '@solana/kit';
import {
  fetchMaybeToken,
} from '@solana-program/token';
import { solanaRpc, solanaRpcConnection } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { walletSigner } from '@solana/kit-plugin-wallet';
import {
  ACCEPTED_EVENT_DISCRIMINATOR,
  CLAIMED_EVENT_DISCRIMINATOR,
  decodePool,
  Asset,
  EASYPAY_PROGRAM_ADDRESS,
  EasypayInstruction,
  easypayProgram,
  fetchMaybePool,
  findBtcMintPda,
  findEthMintPda,
  findExchangePda,
  findPoolPda,
  getAcceptedEventDecoder,
  getClaimedEventDecoder,
  parseEasypayInstruction,
  POOL_DISCRIMINATOR,
  type AcceptedEvent,
  type ClaimedEvent,
  type ParsedEasypayInstruction,
} from './generated';
import * as core from './core';
import { ataOf, fundingOf, PRICE_FEEDS, priceMessageOffset, recordOf, USDC_DECIMALS, USDC_MINT, type CompanyRecord } from './core';
export {
  ataOf,
  PRICE_FEEDS,
  USDC_DECIMALS,
  USDC_MINT,
  type CompanyRecord,
  type Contract,
  type PendingOffer,
} from './core';
import type { Funding } from './pay';

// Local: Surfpool started by `pnpm dev`, with the test accounts and the dev footer. Devnet: Phantom, for the demo.
// The switch reloads the page, so every constant below is fixed for one page load.
// The hosted build (app/.env.production) sets VITE_DEVNET_ONLY: Local means the visitor's own machine there.
export const NETWORKS = ['Local', 'Devnet'] as const;
export type Network = (typeof NETWORKS)[number];
export const DEVNET_ONLY = import.meta.env.VITE_DEVNET_ONLY === 'true';
const NETWORK_KEY = 'easypay.network';
export const NETWORK: Network = DEVNET_ONLY || localStorage.getItem(NETWORK_KEY) === 'Devnet' ? 'Devnet' : 'Local';
export const IS_LOCAL = NETWORK === 'Local';

export function switchNetwork(network: Network) {
  localStorage.setItem(NETWORK_KEY, network);
  location.reload();
}

// Local Surfpool is published from the devcontainer to the Mac. VITE_RPC_URL in app/.env.local overrides it when
// 8899 is taken on the Mac. devnet() tells Kit it's a test cluster, which keeps requestAirdrop on the RPC type.
export const RPC_URL = IS_LOCAL
  ? devnet(import.meta.env.VITE_RPC_URL ?? 'http://localhost:8899')
  : devnet('https://api.devnet.solana.com');
// The websocket is on the RPC port + 1 on Surfpool, and on the same host for devnet. Kit only knows the port for
// 8899, so we pass it ourselves.
const RPC_WS_URL = RPC_URL.replace(/^http/, 'ws').replace(/:(\d+)$/, (_: string, port: string) => `:${Number(port) + 1}`);

// What a failed read tells the user to check.
export const UNREACHABLE_HINT = IS_LOCAL ? 'Is pnpm dev running?' : 'Devnet RPC did not answer. Try again in a moment.';

// The auto-claim server's public key per network. Local: the committed local-only key in app/server/. Devnet:
// the public half of AUTOCLAIM_KEYPAIR in the repo's .env.
export const AUTOCLAIM_KEY: Address = IS_LOCAL
  ? address('2WWvMgnRsyix8pJbDmogqAS6qXax7piQKuPR82NGZZRA')
  : address('ExSNkc1vUfp3sEm1jnonCzXHYcuSX7ZhFsxJgv1MeJdv');

export const AIRDROP_SOL = 5;
// The exchange's SOL reserve on Local, from the faucet once. Swaps pay SOL out of it.
export const EXCHANGE_RESERVE_SOL = 100;
export const USDC_TOP_UP = 1000;

// Read-only client for polling. Transactions go through the signing clients below.
const client = createClient().use(solanaRpcConnection({ rpcUrl: RPC_URL }));

// Client that signs as one test account and pays its fees. client.easypay comes from the Codama plugin.
// skipPreflight: a failing transaction still lands on chain, so its toast links to Explorer with the logs.
// Confirmations come over the websocket.
export const createSigningClient = (account: TransactionSigner) =>
  createClient()
    .use(signer(account))
    .use(solanaRpc({ rpcUrl: RPC_URL, rpcSubscriptionsUrl: RPC_WS_URL, skipPreflight: true }))
    .use(easypayProgram());
export type SigningClient = ReturnType<typeof createSigningClient>;

// Devnet client that signs with the account selected in Phantom, through Wallet Standard. One per page load:
// a wallet client is bound to one chain. It remembers the wallet and reconnects silently after a reload.
// Null on Local, so Local never asks the browser for wallets.
export const walletClient = IS_LOCAL
  ? null
  : createClient()
      .use(walletSigner({ chain: 'solana:devnet', storageKey: 'easypay.wallet' }))
      .use(solanaRpc({ rpcUrl: RPC_URL, rpcSubscriptionsUrl: RPC_WS_URL, skipPreflight: true }))
      .use(easypayProgram());

// Signs raw bytes as `signer`, for the split labels key (labels.ts). Test keypairs sign silently, a wallet like
// Phantom asks through Wallet Standard's signMessage.
export const signText =
  (signer: TransactionSigner) =>
  async (message: Uint8Array): Promise<Uint8Array> => {
    if (isMessagePartialSigner(signer)) {
      const [signatures] = await signer.signMessages([createSignableMessage(message)]);
      return signatures[signer.address];
    }
    return walletClient!.wallet.signMessage(message);
  };

const explorerCluster = IS_LOCAL ? `cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}` : 'cluster=devnet';
export const explorerTxUrl = (signature: string) => `https://explorer.solana.com/tx/${signature}?${explorerCluster}`;
export const explorerAddressUrl = (address: string) =>
  `https://explorer.solana.com/address/${address}?${explorerCluster}`;

// The shared readers from core.ts, bound to this page's RPC.
export const getChainTime = () => core.getChainTime(client.rpc);
export const getSplit = (employee: Address) => core.getSplit(client.rpc, employee);
export const getContracts = (owner: Address) => core.getContracts(client.rpc, owner);
export const refreshPythPrices = () => core.refreshPythPrices(client.rpc, RPC_URL);
const cheatcode = (method: string, params: unknown[]) => core.cheatcode(RPC_URL, method, params);
const getAccountBytes = (account: Address) => core.getAccountBytes(client.rpc, account);

export type Balances = { lamports: bigint; usdc: bigint };

// SOL in lamports and USDC in base units (6 decimals) of one wallet.
// USDC sits in the wallet's associated token account (ATA) for the mint. Reading that one account
// stays on the local chain, while getTokenAccountsByOwner asks devnet on every call.
export async function getBalances(owner: Address): Promise<Balances> {
  const ata = await ataOf(owner, USDC_MINT);
  const [sol, token] = await Promise.all([client.rpc.getBalance(owner).send(), fetchMaybeToken(client.rpc, ata)]);
  return { lamports: sol.value, usdc: token.exists ? token.data.amount : 0n };
}

// A pool with its vault and history counters, plus what pay.ts needs to tell what is owed and what the employer can
// withdraw.
export type PoolState = Funding & CompanyRecord & { address: Address; vault: Address; name: string };

// The employer's pool, its vault balance and contracts, or null if this account has no pool yet.
// The pool lives at the PDA [b"pool", employer]. The vault is the pool's associated token account.
export async function getPool(employer: Address): Promise<PoolState | null> {
  const [address] = await findPoolPda({ employer });
  const pool = await fetchMaybePool(client.rpc, address);
  if (!pool.exists) return null;
  const vault = await ataOf(address, pool.data.mint);
  const token = await fetchMaybeToken(client.rpc, vault);
  return {
    address,
    vault,
    name: pool.data.name,
    ...recordOf(pool.data),
    ...fundingOf(pool.data, token.exists ? token.data.amount : undefined),
  };
}

// Block time of the account's oldest transaction in unix seconds, null without one. For a pool that is create_pool,
// so the Companies card shows how long the company has been on EasyPay. The pool stores no creation date.
export async function getFirstSeen(account: Address): Promise<number | null> {
  let oldest: Signature | undefined;
  // RPC returns at most 1,000 signatures per page, newest first. The last page ends with the oldest.
  for (let before: Signature | undefined; ; ) {
    const page = await client.rpc.getSignaturesForAddress(account, { before, limit: 1000 }).send();
    if (page.length) oldest = before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  if (!oldest) return null;
  // blockTime from getTransaction, see getHistory.
  const tx = await fetchTransaction(oldest);
  return tx?.blockTime == null ? null : Number(tx.blockTime);
}

// A landed transaction as the RPC returns it, or null if it never landed.
const fetchTransaction = (signature: Signature) =>
  client.rpc
    .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 })
    .send();

// Outcome and program logs of a landed transaction, null if it never landed. Failed transactions keep their logs too.
export async function getLandedTransaction(signature: Signature) {
  const tx = await fetchTransaction(signature);
  return tx && { failed: tx.meta?.err != null, logs: tx.meta?.logMessages ?? [] };
}

// One EasyPay instruction, decoded by the Codama client. claimed is the Claimed event of a claim: claim takes no
// amount, so History reads the gross amount and the split breakdown there. Undefined for other instructions and
// for a claim that failed.
export type HistoryInstruction = ParsedEasypayInstruction<string> & { claimed: ClaimedEvent | undefined };

// One transaction with our program. `instructions` are its EasyPay instructions.
// time is the block time in unix seconds. A failed transaction is listed too, its logs are in Explorer.
// company is the name and employer of the pool it touched, undefined when it touched none or the pool is gone.
// fee is in lamports. accepted are its Accepted events: a claim carries only pool and slot, History takes the
// contract title from these.
export type HistoryEntry = {
  signature: Signature;
  time: number | null;
  failed: boolean;
  fee: bigint | null;
  accepted: AcceptedEvent[];
  instructions: HistoryInstruction[];
  company: { name: string; address: Address } | undefined;
};


// The account's transactions with our program, newest first, read from the chain on every call.
// Covers the transactions that touch the account (what it signed) and the ones on its pool, so a company also
// sees what its workers do there. Transactions without an EasyPay instruction, like airdrops, are left out.
export async function getHistory(owner: Address): Promise<HistoryEntry[]> {
  const [pool] = await findPoolPda({ employer: owner });
  const [lists, pools] = await Promise.all([
    Promise.all([owner, pool].map((a) => client.rpc.getSignaturesForAddress(a).send())),
    core.getAccountsOfType(client.rpc, POOL_DISCRIMINATOR).then((list) => core.decodeEach(list, (a) => decodePool(a))),
  ]);
  // Company names by pool address, so a row can say whose pool it was.
  const companies = new Map(pools.map(({ address, data }) => [address, { name: data.name, address: data.employer }]));

  // The owner's own pool transactions are on both lists.
  const unique = [...new Map(lists.flat().map((s) => [s.signature, s])).values()];
  unique.sort((a, b) => Number(b.slot - a.slot));

  const entries = await Promise.all(
    unique.map(async ({ signature, err }) => {
      const tx = await fetchTransaction(signature);
      if (!tx) return null;
      const { compiledMessage, loadedAddresses } = decodeTransactionFromRpcResponse(tx);
      // Claimed events from the logs, where Anchor writes each as "Program data: <base64>". A failed transaction
      // rolled back whatever its logs say. Several claims in one transaction are told apart by pool and slot.
      const logs = err !== null ? [] : (tx.meta?.logMessages ?? []);
      const claimedEvents = claimedIn(logs);
      const instructions = getInstructionsFromCompiledTransactionMessage(compiledMessage, loadedAddresses).flatMap(
        (ix) => {
          if (ix.programAddress !== EASYPAY_PROGRAM_ADDRESS || !isInstructionWithData(ix)) return [];
          const parsed = parseEasypayInstruction(ix);
          const claimed =
            parsed.instructionType === EasypayInstruction.Claim
              ? claimedEvents.find((e) => e.pool === parsed.accounts.pool.address && e.slot === parsed.data.slot)
              : undefined;
          return [{ ...parsed, claimed }];
        },
      );
      const pool = instructions.map(({ accounts }) => ('pool' in accounts ? accounts.pool.address : null)).find(Boolean);
      const company = pool ? companies.get(pool) : undefined;
      // blockTime from getTransaction: after time travel Surfpool's getSignaturesForAddress reports a wrong one.
      const time = tx.blockTime === null ? null : Number(tx.blockTime);
      const fee = tx.meta ? BigInt(tx.meta.fee) : null;
      return { signature, time, failed: err !== null, fee, accepted: acceptedIn(logs), instructions, company };
    }),
  );
  return entries.filter((e): e is HistoryEntry => e !== null && e.instructions.length > 0);
}

// The events of one kind in a transaction's logs.
const eventsIn =
  <T,>(discriminator: ReadonlyUint8Array, decoder: { decode: (bytes: Uint8Array) => T }) =>
  (logs: readonly string[]): T[] =>
    logs
      .filter((line) => line.startsWith('Program data: '))
      .map((line) => new Uint8Array(getBase64Encoder().encode(line.slice('Program data: '.length))))
      .filter((bytes) => containsBytes(bytes, discriminator, 0))
      .map((bytes) => decoder.decode(bytes));
export const claimedIn = eventsIn(CLAIMED_EVENT_DISCRIMINATOR, getClaimedEventDecoder());
const acceptedIn = eventsIn(ACCEPTED_EVENT_DISCRIMINATOR, getAcceptedEventDecoder());

export const ASSET_NAMES: Record<Asset, string> = { [Asset.Sol]: 'SOL', [Asset.Btc]: 'BTC', [Asset.Eth]: 'ETH' };
// Base units of each asset: lamports for SOL, the program's test mints for BTC and ETH.
export const ASSET_DECIMALS: Record<Asset, number> = { [Asset.Sol]: 9, [Asset.Btc]: 8, [Asset.Eth]: 8 };

// The asset's USD price from its Pyth feed, as the program reads it.
export async function getPythPrice(asset: Asset): Promise<number> {
  const { data } = await getAccountBytes(PRICE_FEEDS[asset]);
  const view = new DataView(data.buffer);
  const at = priceMessageOffset(data) + 32;
  return Number(view.getBigInt64(at, true)) * 10 ** view.getInt32(at + 16, true);
}

export type WalletBalance = { name: string; amount: bigint; decimals: number; usd: number | null; account: Address };

// Every balance a worker can hold here: SOL, USDC, and the BTC and ETH the exchange swaps into, each with its USD
// value at the Pyth price (USDC at $1, null when the price can't be read). `account` is what Explorer opens: the
// wallet for SOL, the associated token account for the rest.
export async function getWalletBalances(owner: Address): Promise<WalletBalance[]> {
  const [[btcMint], [ethMint]] = await Promise.all([findBtcMintPda(), findEthMintPda()]);
  const [usdcAta, btcAta, ethAta] = await Promise.all([ataOf(owner, USDC_MINT), ataOf(owner, btcMint), ataOf(owner, ethMint)]);
  const tokens = async (ata: Address) => {
    const token = await fetchMaybeToken(client.rpc, ata);
    return token.exists ? token.data.amount : 0n;
  };
  const price = (asset: Asset) => getPythPrice(asset).catch(() => null);
  const [sol, usdc, btc, eth, solUsd, btcUsd, ethUsd] = await Promise.all([
    client.rpc.getBalance(owner).send().then((r) => r.value),
    tokens(usdcAta),
    tokens(btcAta),
    tokens(ethAta),
    price(Asset.Sol),
    price(Asset.Btc),
    price(Asset.Eth),
  ]);
  const row = (name: string, amount: bigint, decimals: number, usdPrice: number | null, account: Address) => ({
    name,
    amount,
    decimals,
    usd: usdPrice === null ? null : (Number(amount) / 10 ** decimals) * usdPrice,
    account,
  });
  return [
    row('SOL', sol, ASSET_DECIMALS[Asset.Sol], solUsd, owner),
    row('USDC', usdc, USDC_DECIMALS, 1, usdcAta),
    row('BTC', btc, ASSET_DECIMALS[Asset.Btc], btcUsd, btcAta),
    row('ETH', eth, ASSET_DECIMALS[Asset.Eth], ethUsd, ethAta),
  ];
}

// Moves chain time forward. surfnet_timeTravel only takes an absolute timestamp, in milliseconds.
export async function timeTravel(seconds: number) {
  const now = await getChainTime();
  await cheatcode('surfnet_timeTravel', [{ absoluteTimestamp: (now + seconds) * 1000 }]);
}

// Adds USDC to a wallet. surfnet_setTokenAccount sets an absolute amount, so we send balance + top up.
export async function addUsdc(owner: Address, usdc: number) {
  const { usdc: current } = await getBalances(owner);
  const amount = current + BigInt(usdc) * 10n ** BigInt(USDC_DECIMALS);
  await cheatcode('surfnet_setTokenAccount', [owner, USDC_MINT, { amount: Number(amount) }]);
}

// SOL from Surfpool's faucet. It is a real transaction, so its signature opens in Explorer.
export function airdropSol(owner: Address, sol: number): Promise<Signature> {
  return client.rpc.requestAirdrop(owner, lamports(BigInt(sol) * 1_000_000_000n)).send();
}

// Waits until a fresh airdrop to `owner` has landed, up to 10 s. A payer without SOL gets its transaction lost.
export async function waitForSol(owner: Address) {
  for (let i = 0; i < 40 && (await getBalances(owner)).lamports === 0n; i++) await new Promise((r) => setTimeout(r, 250));
}

// Gives a wallet SOL and USDC if it has none: on the first visit, or after `pnpm dev` restarted the chain.
// Resolves once the SOL landed. Returns true if it funded anything.
export async function fundIfEmpty(owner: Address): Promise<boolean> {
  const balances = await getBalances(owner);
  const noSol = balances.lamports === 0n;
  const noUsdc = balances.usdc === 0n;
  if (noSol) await airdropSol(owner, AIRDROP_SOL);
  if (noUsdc) await addUsdc(owner, USDC_TOP_UP);
  if (noSol) await waitForSol(owner);
  return noSol || noUsdc;
}

// Local only: on a fresh chain creates the exchange (signed and paid by `payer`) and tops up its SOL reserve once
// from the faucet. The devnet deploy script does the same on devnet. Returns true if it set anything up.
export async function setupExchangeIfMissing(payer: SigningClient): Promise<boolean> {
  const [exchange] = await findExchangePda();
  const { value } = await client.rpc.getAccountInfo(exchange, { encoding: 'base64' }).send();
  if (value) return false;
  // On a fresh chain the payer's airdrop may not have landed yet, and a payer without SOL gets its transaction lost.
  for (let i = 0; i < 20 && (await client.rpc.getBalance(payer.identity.address).send()).value === 0n; i++)
    await new Promise((r) => setTimeout(r, 500));
  const ix = await payer.easypay.instructions.initExchange({ payer: payer.identity, usdcMint: USDC_MINT });
  await payer.sendTransaction([ix]);
  await airdropSol(exchange, EXCHANGE_RESERVE_SOL);
  return true;
}

