import { useCallback, useState } from 'react';
import { explorerTxUrl } from './chain';
import { shortAddress } from './format';

export type Toast = { id: number; title: string; signature?: string; error?: boolean };
export type Notify = (toast: Omit<Toast, 'id'>) => void;

const TOAST_MS = 10_000;
let nextId = 0;

// Toast list state. notify() shows a toast and removes it after TOAST_MS.
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify: Notify = useCallback((toast) => {
    const id = nextId++;
    setToasts((list) => [...list, { ...toast, id }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS);
  }, []);
  return [toasts, notify] as const;
}

// Stack of toasts above the dev footer. A transaction toast shows its signature and links to Explorer.
export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div aria-live="polite" className="fixed right-4 bottom-20 z-20 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`animate-toast-in rounded-2xl border bg-[#131313] p-4 shadow-2xl ${
            toast.error ? 'border-red-500/40' : 'border-white/10'
          }`}
        >
          <p className={`text-sm font-medium ${toast.error ? 'text-red-300' : 'text-white'}`}>{toast.title}</p>
          {toast.signature && (
            <div className="mt-2 flex items-center justify-between text-xs">
              <span className="font-mono text-white/50">{shortAddress(toast.signature)}</span>
              <a
                href={explorerTxUrl(toast.signature)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[#B98BFF] hover:text-white"
              >
                View on Explorer ↗
              </a>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
