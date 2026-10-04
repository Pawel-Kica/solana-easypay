// Auto-claim server. Every 60 s it finds the Splits whose claimer is its key (workers who turned auto-claim on)
// and sends the same claim transaction the app sends, for every worker with something to claim. It pays the fees
// and only triggers claims: the program still decides how much and where it goes. No queue, no database: a failed
// claim is logged and retried on the next poll.
//   Local:  pnpm --filter app autoclaim           (pnpm dev starts it). Committed local-only key, airdrops itself SOL.
//   Devnet: pnpm --filter app autoclaim:devnet    AUTOCLAIM_KEYPAIR=[...] in the repo's gitignored .env, funded once
//           from the faucet. Its public key is AUTOCLAIM_KEY in app/src/chain.ts.
import { readFileSync } from 'node:fs';
import { createClient, createKeyPairSignerFromBytes, devnet, getAddressEncoder, lamports } from '@solana/kit';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { signer } from '@solana/kit-plugin-signer';
import { claimInstructions, decodeEach, getAccountsOfType, getChainTime, getContracts, refreshPythPrices } from '../src/core';
import { decodeSplit, SPLIT_DISCRIMINATOR } from '../src/generated';
import { claimable, settle } from '../src/pay';

const IS_LOCAL = process.env.NETWORK !== 'Devnet';
const RPC_URL = devnet(process.env.RPC_URL ?? (IS_LOCAL ? 'http://localhost:8899' : 'https://api.devnet.solana.com'));
const RPC_WS_URL = RPC_URL.replace(/^http/, 'ws').replace(/:(\d+)$/, (_: string, port: string) => `:${Number(port) + 1}`);
const POLL_MS = 60_000;
// Split layout: discriminator (8), employee (32), then claimer as Option<Pubkey>: tag 1 for Some, then the key.
const CLAIMER_OFFSET = 40;

function loadKey(): Uint8Array {
  if (IS_LOCAL) return Uint8Array.from(JSON.parse(readFileSync(new URL('./autoclaim-local.json', import.meta.url), 'utf8')));
  const env = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  const key = env.match(/^AUTOCLAIM_KEYPAIR=(.+)$/m)?.[1];
  if (!key) throw new Error('AUTOCLAIM_KEYPAIR=[...] is missing in the repo .env');
  return Uint8Array.from(JSON.parse(key));
}

const server = await createKeyPairSignerFromBytes(loadKey());
const client = createClient().use(signer(server)).use(solanaRpc({ rpcUrl: RPC_URL, rpcSubscriptionsUrl: RPC_WS_URL }));
console.log(`Auto-claim server ${server.address} on ${IS_LOCAL ? 'Local' : 'Devnet'}, polling every ${POLL_MS / 1000} s`);

async function poll() {
  // A fresh local chain has no SOL for us yet.
  if (IS_LOCAL && (await client.rpc.getBalance(server.address).send()).value < 1_000_000_000n)
    await client.rpc.requestAirdrop(server.address, lamports(5_000_000_000n)).send();

  const claimer = new Uint8Array([1, ...getAddressEncoder().encode(server.address)]);
  const splits = decodeEach(
    await getAccountsOfType(client.rpc, SPLIT_DISCRIMINATOR, [{ offset: CLAIMER_OFFSET, bytes: claimer }]),
    (a) => decodeSplit(a),
  );
  if (!splits.length) return;
  const now = await getChainTime(client.rpc);
  let pricesFresh = false;
  for (const { data: split } of splits) {
    const worker = split.employee;
    try {
      const { contracts } = await getContracts(client.rpc, worker);
      const due = contracts.filter(
        (c) => c.employee === worker && claimable(c, settle(c.funding, now).fundedUntil) > 0n,
      );
      if (!due.length) continue;
      // Same as the app: on Local the swap needs a fresh Pyth publish_time.
      if (IS_LOCAL && split.investPct > 0 && !pricesFresh) {
        await refreshPythPrices(client.rpc, RPC_URL);
        pricesFresh = true;
      }
      const contractsDue = due.map(({ pool, slot }) => ({ pool, slot }));
      const sent = await client.sendTransaction(await claimInstructions(server, worker, split, contractsDue));
      console.log(`Claimed for ${worker}: ${sent.context.signature}`);
    } catch (error) {
      console.error(`Claim for ${worker} failed, retrying on the next poll: ${error instanceof Error ? error.message : error}`);
    }
  }
}

for (;;) {
  await poll().catch((error) => console.error(`Poll failed: ${error instanceof Error ? error.message : error}`));
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
