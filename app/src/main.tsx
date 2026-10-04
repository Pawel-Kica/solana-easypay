import { lazy, StrictMode, Suspense, useEffect, useState, useTransition, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Landing } from './Landing';
import './index.css';

const App = lazy(() => import('./App').then(({ App }) => ({ default: App })));
const StatsPage = lazy(() => import('./StatsPage').then(({ StatsPage }) => ({ default: StatsPage })));
type Page = 'landing' | 'app' | 'stats' | 'admin';
const pageOf = (): Page => (window.location.pathname.match(/^\/(app|stats|admin)\/?$/)?.[1] as Page) ?? 'landing';

// Keep the landing visible during the first import, and reuse loaded modules on later visits.
function Site() {
  const [page, setPage] = useState(pageOf);
  const [opening, startTransition] = useTransition();
  useEffect(() => {
    const onBack = () => startTransition(() => setPage(pageOf()));
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, []);

  const openApp = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (opening) return;
    history.pushState(null, '', '/app');
    startTransition(() => setPage('app'));
  };

  return (
    <Suspense fallback={
      <div aria-busy="true" aria-label="Loading application" className="min-h-screen text-white">
        <header className="flex min-h-[4.5rem] items-center px-6">
          <a href="/" aria-label="Easy Pay home">
            <img src="/brand/easy-pay-horizontal.svg" alt="Easy Pay" width="176" height="44" />
          </a>
        </header>
        <div aria-hidden="true" className="mx-auto mt-16 h-64 w-[calc(100%-2rem)] max-w-[37rem] animate-pulse rounded-3xl border border-white/10" />
      </div>
    }>
      {page === 'app' ? (
        <App />
      ) : page === 'landing' ? (
        <Landing onOpen={openApp} opening={opening} />
      ) : (
        <StatsPage admin={page === 'admin'} />
      )}
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Site />
  </StrictMode>,
);
