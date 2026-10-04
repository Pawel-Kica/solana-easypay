import { useSyncExternalStore } from 'react';
import { walletClient, type Balances } from './chain';
import { EmptyState } from './EmptyState';
import type { Notify } from './Toasts';
import { SMALL_BUTTON } from './ui';

// Devnet only: Phantom (or any Wallet Standard wallet on devnet) through walletClient from chain.ts.

const noSubscribe = () => () => {};

// The wallet state: discovered wallets, status and the connected account. Null on Local.
// Switching accounts in Phantom fires a change event, so `connected` follows it.
export const useWallet = () =>
  useSyncExternalStore(walletClient?.wallet.subscribe ?? noSubscribe, () => walletClient?.wallet.getState() ?? null);

// Header control while no wallet is connected: one Connect button per wallet on devnet, or a link to Phantom.
// Renders nothing during the silent reconnect after a reload, so it doesn't flash.
export function ConnectWallet({ notify }: { notify: Notify }) {
  const wallet = useWallet();
  if (!wallet || wallet.status === 'pending' || wallet.status === 'reconnecting') return null;

  if (!wallet.wallets.length)
    return (
      <a
        href="https://phantom.com/download"
        target="_blank"
        rel="noreferrer"
        className={`${SMALL_BUTTON} bg-[#9945FF] text-white hover:bg-[#8a3ef0]`}
      >
        Install Phantom ↗
      </a>
    );

  const connect = async (index: number) => {
    try {
      await walletClient!.wallet.connect(wallet.wallets[index]);
    } catch (e) {
      if ((e as Error).name !== 'AbortError')
        notify({ title: `Could not connect: ${e instanceof Error ? e.message : String(e)}`, error: true });
    }
  };

  return (
    <div className="flex gap-1">
      {wallet.wallets.map((w, i) => (
        <button
          key={w.name}
          onClick={() => connect(i)}
          disabled={wallet.status === 'connecting'}
          className={`${SMALL_BUTTON} bg-[#9945FF] text-white hover:bg-[#8a3ef0]`}
        >
          Connect {w.name}
        </button>
      ))}
    </div>
  );
}

// Placeholder for a view that needs a wallet (tabs on Devnet, My company): which network to pick plus the same
// Connect button as the header, so nobody has to look for it.
export const ConnectPrompt = ({ notify }: { notify: Notify }) => (
  <EmptyState
    title="Connect a wallet"
    text="Easy Pay runs on Solana Devnet. Any Solana wallet works (Phantom, Solflare, Backpack), switched to Devnet."
  >
    <div className="flex justify-center">
      <ConnectWallet notify={notify} />
    </div>
  </EmptyState>
);

export const DisconnectWallet = () => (
  <button
    onClick={() => walletClient?.wallet.disconnect()}
    className={`${SMALL_BUTTON} w-28 bg-[#9945FF] text-white hover:bg-[#8a3ef0]`}
  >
    Disconnect
  </button>
);

// Shown on Devnet when the connected account has no USDC, with where to get it. Missing SOL is the SOL banner's job.
export function FaucetNote({ balances }: { balances: Balances }) {
  if (balances.usdc !== 0n) return null;
  return (
    <p data-testid="faucet-note" className="mb-2 rounded-2xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
      No USDC. Get devnet USDC at <FaucetLink href="https://faucet.circle.com" />, network Solana Devnet.
    </p>
  );
}

const FaucetLink = ({ href }: { href: string }) => (
  <a href={href} target="_blank" rel="noreferrer" className="font-medium underline hover:text-white">
    {href.replace('https://', '')}
  </a>
);
