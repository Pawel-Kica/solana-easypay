import type { MouseEventHandler } from 'react';

const HEADLINES = ['Pay should follow.', 'Make payday every day.', 'Keep what you earn.'];

// This page has no wallet or chain imports. The app loads only after following its link.
export function Landing({ onOpen, opening }: { onOpen: MouseEventHandler<HTMLAnchorElement>; opening: boolean }) {
  return (
    <main className="landing">
      <svg className="landing-network" viewBox="0 0 1440 960" fill="none" aria-hidden="true">
        <g className="network-drift">
          <path d="M-40 270 160 180 290 310 160 480-40 410M160 180 250-30M160 480 80 720 290 840 400 1020M80 720-40 820M290 310 350 80" />
          {[[-40, 270], [160, 180], [290, 310], [160, 480], [80, 720], [290, 840], [350, 80]].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3" />
          ))}
        </g>
        <g className="network-drift network-drift-late">
          <path d="m1050-40 120 210 220 90 100-80M1170 170l-90 170 190 130 120-210M1270 470l-110 220 180 110 160-170M1160 690l-90 270M1340 800l-20 190" />
          {[[1170, 170], [1390, 260], [1080, 340], [1270, 470], [1160, 690], [1340, 800]].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3" />
          ))}
        </g>
      </svg>

      <div className="landing-content">
        <img className="landing-logo" src="/brand/easy-pay.svg" width="782" height="537" alt="Easy Pay" />
        <h1>
          Work gets done.
          <span className="sr-only"> Pay should follow.</span>
          <span className="landing-headlines" aria-hidden="true">
            {HEADLINES.map((text, i) => <span key={text} style={{ animationDelay: `${i * 3}s` }}>{text}</span>)}
          </span>
        </h1>
        <p className="landing-description">
          Fund your team’s pay in USDC. Earnings build up each workday,
          and contractors can withdraw them without waiting for the end of the month.
        </p>
        <a className="landing-cta" href="/app" onClick={onOpen} aria-busy={opening}>
          {opening && <span className="entry-spinner" aria-hidden="true" />}
          Go to the app
        </a>
        <p className="landing-footnote">What your team earns stays theirs. Built on Solana.</p>
      </div>
    </main>
  );
}
