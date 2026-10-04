import type { ReactNode } from 'react';

// What a tab shows when there is nothing in it yet: what is missing and the next step.
// `children` is an optional action under the text, like the Create pool button.
export const EmptyState = ({ title, text, children }: { title: string; text: string; children?: ReactNode }) => (
  <div className="flex min-h-44 flex-col items-center justify-center px-2 py-6 text-center">
    <h2 className="text-lg font-semibold">{title}</h2>
    <p className="mt-1 text-sm text-balance text-white/50">{text}</p>
    {children && <div className="mt-6 w-full">{children}</div>}
  </div>
);
