// Writes scripts/chain-snapshot.json: the devnet accounts the offline local chain needs, the USDC mint and the
// three Pyth price feeds (app/src/core.ts). Run once when one of them changes: node scripts/make-snapshot.mjs
// Surfpool loads the file with --snapshot, the format of its surfnet_exportSnapshot.
import { writeFileSync } from 'node:fs';

const ACCOUNTS = [
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // USDC mint
  '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE', // Pyth SOL/USD
  '4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo', // Pyth BTC/USD
  '42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC', // Pyth ETH/USD
];

const res = await fetch('https://api.devnet.solana.com', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getMultipleAccounts',
    params: [ACCOUNTS, { encoding: 'base64' }],
  }),
});
const { result } = await res.json();
const snapshot = Object.fromEntries(
  result.value.map(({ lamports, owner, executable, data }, i) => [
    ACCOUNTS[i],
    { lamports, owner, executable, rentEpoch: 0, data: data[0], parsedData: null },
  ]),
);
writeFileSync(new URL('./chain-snapshot.json', import.meta.url), JSON.stringify(snapshot, null, 2) + '\n');
console.log(`Saved ${ACCOUNTS.length} accounts to scripts/chain-snapshot.json`);
