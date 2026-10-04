import type { Address } from '@solana/kit';
import { useEffect, useMemo, useState } from 'react';
import { AccountButton, TestAccountSwitch } from './AccountButton';
import { Alerts, Dot, solAlert, useRunwayAlerts } from './Alerts';
import { loadTestAccounts, ROLES, UNFUNDED, type TestAccount } from './accounts';
import {
  airdropSol,
  createSigningClient,
  DEVNET_ONLY,
  fundIfEmpty,
  getBalances,
  getChainTime,
  getPool,
  IS_LOCAL,
  NETWORK,
  NETWORKS,
  setupExchangeIfMissing,
  switchNetwork,
  walletClient,
  type Balances,
  type PoolState,
} from './chain';
import { ClaimTab } from './ClaimTab';
import { COMPANIES_VIEW_KEY, CompaniesTab } from './CompaniesTab';
import { ContractsTab } from './ContractsTab';
import { DevFooter } from './DevFooter';
import { HistoryTab } from './HistoryTab';
import { POOL_VIEW_KEY, PoolTab } from './PoolTab';
import { Toasts, useToasts, type Notify } from './Toasts';
import { Tabs, useStoredState } from './ui';
import { ConnectPrompt, ConnectWallet, DisconnectWallet, FaucetNote, useWallet } from './Wallet';

const TABS = ['Pool', 'Contracts', 'Claim', 'History', 'Companies'] as const;
type Tab = (typeof TABS)[number];

// Public devnet RPC limits requests per IP, so Devnet polls slower.
const REFRESH_MS = IS_LOCAL ? 1000 : 3000;

// Local only: loads the test accounts, funds the empty ones (except UNFUNDED), then hands them over, so fresh accounts
// never show the "0 SOL" banner while their airdrop lands. Then sets up the exchange, once per page load.
function useTestAccounts(notify: Notify) {
  const [accounts, setAccounts] = useState<TestAccount[]>();

  // `alive` drops the first of React StrictMode's two dev mounts, so funding below runs once.
  useEffect(() => {
    if (!IS_LOCAL) return;
    let alive = true;
    loadTestAccounts().then(async (list) => {
      if (!alive) return;
      const funded = await Promise.all(
        list.filter((a) => !UNFUNDED.includes(a.role)).map((a) => fundIfEmpty(a.signer.address)),
      ).catch(() => notify({ title: 'Could not fund the test accounts. Is pnpm dev running?', error: true }));
      setAccounts(list);
      if (funded?.some(Boolean)) notify({ title: 'Test accounts funded with SOL and USDC' });
      // The exchange for investing, once per chain. The company account pays, after funding gave it SOL.
      await setupExchangeIfMissing(createSigningClient(list[0].signer)).catch(() =>
        notify({ title: 'Could not set up the exchange. Is pnpm dev running?', error: true }),
      );
    });
    return () => {
      alive = false;
    };
  }, [notify]);

  return accounts;
}

// `owner` is the account the balances and pool were read for. pool is null when it has none.
type ChainView = { owner?: Address; time?: number; balances?: Balances; pool?: PoolState | null; offline: boolean };

// Reads chain time, the active account's balances and its pool on a timer. refresh() re-reads right away.
// version counts the refreshes, for reads that run only after a transaction.
function useChain(owner?: Address) {
  const [view, setView] = useState<ChainView>({ offline: false });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const [time, balances, pool] = await Promise.all([
          getChainTime(),
          owner ? getBalances(owner) : undefined,
          owner ? getPool(owner) : undefined,
        ]);
        if (alive) setView({ owner, time, balances, pool, offline: false });
      } catch {
        // Keep the last read, so one failed poll (a devnet rate limit) doesn't unmount the forms.
        if (alive) setView((last) => ({ ...last, offline: true }));
      }
    };
    read();
    const id = setInterval(read, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [owner, tick]);

  // Right after an account switch the view still holds the previous account. Show only its chain time.
  const current: ChainView = view.owner === owner ? view : { time: view.time, offline: view.offline };
  return [current, () => setTick((t) => t + 1), tick] as const;
}

export function App() {
  const [toasts, notify] = useToasts();
  const accounts = useTestAccounts(notify);
  const wallet = useWallet();
  // The last account and tab survive a refresh. Each tab keeps its own sub-tab the same way.
  const [role, setRole] = useStoredState('easypay.role', 'Company', ROLES);
  const [tab, setTab] = useStoredState<Tab>('easypay.tab', 'Pool', TABS);
  // Local only: the dev footer hides the test account switcher, e.g. for screenshots. Balances and address stay.
  const [accountsView, setAccountsView] = useStoredState('easypay.accounts', 'shown', ['shown', 'hidden'] as const);
  // The Companies address field. "See record" on an offer fills it and opens the tab.
  const [company, setCompany] = useState('');
  const openCompany = (employer: Address) => {
    setCompany(employer);
    localStorage.setItem(COMPANIES_VIEW_KEY, 'Search');
    setTab('Companies');
  };
  // The active account: a test account on Local, the account selected in Phantom on Devnet.
  const account = accounts?.find((a) => a.role === role);
  const owner = IS_LOCAL ? account?.signer.address : wallet?.connected?.signer?.address;
  const [chain, refresh, version] = useChain(owner);
  // The banner's Deposit opens Pool. The count remounts the card, so it shows Deposit even from the Withdraw view.
  const [deposits, setDeposits] = useState(0);
  const openDeposit = () => {
    localStorage.setItem(POOL_VIEW_KEY, 'Deposit');
    setTab('Pool');
    setDeposits((n) => n + 1);
  };
  const runway = useRunwayAlerts({ owner, pool: chain.pool, chainTime: chain.time, version, onDeposit: openDeposit });
  // Get SOL: 1 SOL from Surfpool's faucet on Local, the public faucet in a new tab on Devnet.
  const getSol = () => {
    if (!IS_LOCAL) window.open('https://faucet.solana.com', '_blank', 'noreferrer');
    else if (owner)
      airdropSol(owner, 1).then(
        (signature) => {
          notify({ title: `Airdropped 1 SOL to ${role}`, signature });
          refresh();
        },
        () => notify({ title: 'Could not airdrop SOL. Is pnpm dev running?', error: true }),
      );
  };
  const sol = solAlert(chain.balances?.lamports, getSol);
  // Every banner above the card. Another kind of alert is one more entry here.
  const alerts = sol ? [sol, ...runway.alerts] : runway.alerts;
  // Transactions sign as the active account. One client per test account, kept across renders. The devnet client
  // follows Phantom by itself.
  const client = useMemo(() => (IS_LOCAL ? account && createSigningClient(account.signer) : walletClient), [account]);

  return (
    <div className="min-h-screen bg-[#131313] pb-28 text-white">
      <header className="app-header flex min-h-[4.5rem] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-4">
          <a href="/" aria-label="Easy Pay home" className="shrink-0 rounded-sm">
            <img src="/brand/easy-pay-horizontal.svg" alt="Easy Pay" width="176" height="44" />
          </a>
          {!DEVNET_ONLY && <Tabs tabs={NETWORKS} value={NETWORK} onChange={switchNetwork} label="Network" />}
        </div>
        {IS_LOCAL && accounts && account && (
          <AccountButton label={role} address={account.signer.address} balances={chain.balances} notify={notify}>
            {accountsView === 'shown' && <TestAccountSwitch accounts={accounts} active={role} onSwitch={setRole} />}
          </AccountButton>
        )}
        {!IS_LOCAL && owner && (
          <AccountButton label={wallet?.connected?.wallet.name ?? 'wallet'} address={owner} balances={chain.balances} notify={notify}>
            <DisconnectWallet />
          </AccountButton>
        )}
        {!IS_LOCAL && !owner && <ConnectWallet notify={notify} />}
      </header>

      <main className="mx-auto mt-16 w-full max-w-[39rem] px-4">
        {!IS_LOCAL && chain.balances && <FaucetNote balances={chain.balances} />}
        <nav className="mb-2">
          <Tabs
            tabs={TABS}
            value={tab}
            onChange={setTab}
            label="Sections"
            size="md"
            names={{
              Pool: <>Pool<Dot tone={runway.poolTone} /></>,
              Claim: <>Claim<Dot tone={runway.claimTone} /></>,
            }}
          />
        </nav>
        <Alerts alerts={alerts} />

        <section
          role="tabpanel"
          aria-label={tab}
          className="rounded-3xl border border-white/10 p-4"
        >
          <div key={`${tab}-${owner}-${deposits}`} className="animate-fade-in">
          {!owner && !IS_LOCAL && tab !== 'Companies' && (
            <ConnectPrompt notify={notify} />
          )}
          {tab === 'Pool' && owner && client && (
            <PoolTab
              key={owner}
              client={client}
              pool={chain.pool}
              walletUsdc={chain.balances?.usdc}
              chainTime={chain.time}
              notify={notify}
              onDone={refresh}
            />
          )}
          {tab === 'Contracts' && owner && client && (
            <ContractsTab
              key={owner}
              client={client}
              owner={owner}
              pool={chain.pool}
              chainTime={chain.time}
              notify={notify}
              onDone={refresh}
              onOpenCompany={openCompany}
            />
          )}
          {tab === 'Claim' && owner && client && (
            <ClaimTab
              key={owner}
              client={client}
              owner={owner}
              chainTime={chain.time}
              notify={notify}
              onDone={refresh}
            />
          )}
          {tab === 'History' && owner && <HistoryTab key={owner} owner={owner} />}
          {tab === 'Companies' && <CompaniesTab query={company} onQuery={setCompany} owner={owner} chainTime={chain.time} notify={notify} />}
          </div>
        </section>
      </main>

      <Toasts toasts={toasts} />
      {IS_LOCAL && (
        <DevFooter
          chainTime={chain.time}
          offline={chain.offline}
          accountsShown={accountsView === 'shown'}
          onToggleAccounts={() => setAccountsView(accountsView === 'shown' ? 'hidden' : 'shown')}
          notify={notify}
          onDone={refresh}
        />
      )}
    </div>
  );
}
