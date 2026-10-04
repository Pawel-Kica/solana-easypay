// Sets up the exchange for investing, once per chain: init_exchange, then the SOL reserve from the payer's wallet.
// Safe to run again: skips what exists and only tops the reserve up to RESERVE_SOL (0.5 SOL by default).
// deploy-devnet.sh runs it after every deploy. ANCHOR_WALLET is the payer's keypair file, RPC_URL the chain
// (devnet by default). The local app does the same on first load.
import * as anchor from '@anchor-lang/core';
import { readFileSync } from 'node:fs';

const { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, Keypair, Connection } = anchor.web3;
const RESERVE_SOL = Number(process.env.RESERVE_SOL ?? 0.5);
// Circle's devnet USDC, the only mint the exchange swaps from.
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const idl = JSON.parse(readFileSync(new URL('../target/idl/easypay.json', import.meta.url), 'utf8'));
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET, 'utf8'))));
const connection = new Connection(process.env.RPC_URL ?? 'https://api.devnet.solana.com', 'confirmed');
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);
const [exchange] = PublicKey.findProgramAddressSync([Buffer.from('exchange')], program.programId);

if (await connection.getAccountInfo(exchange)) {
  console.log(`Exchange ${exchange} exists.`);
} else {
  await program.methods.initExchange().accounts({ payer: payer.publicKey, usdcMint: USDC_MINT }).rpc();
  console.log(`Exchange ${exchange} created.`);
}

const missing = RESERVE_SOL * LAMPORTS_PER_SOL - (await connection.getBalance(exchange));
if (missing > 0) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: exchange, lamports: Math.ceil(missing) }),
  );
  await provider.sendAndConfirm(tx);
}
console.log(`SOL reserve: ${(await connection.getBalance(exchange)) / LAMPORTS_PER_SOL} SOL.`);
