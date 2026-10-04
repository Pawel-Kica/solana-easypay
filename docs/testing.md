# Testing

How a ticket gets checked. Commands run inside the devcontainer (VS Code terminal, or from the Mac `docker exec <container> sh -c 'cd /workspaces/repo && ...'`).

## Per ticket

1. Program changed: `anchor build` (regenerates `app/src/generated`), `cargo fmt`, `cargo clippy`.
2. `pnpm test` in the repo root. Program tests on LiteSVM plus the app's unit tests, a few seconds. No `pnpm dev`, no validator, no browser.
3. In `app/`: `npx tsc --noEmit`, plus `-p tests` and `-p server` if you touched those.

No browser check per ticket. The browser runs once at the end of a batch, see below.

## What runs where

- `app/tests/program.test.ts`: the built program (`target/deploy/easypay.so`) in LiteSVM, in-process. Transactions are built with the same Codama client and `core.ts` the app uses. Covers the main paths: pool and deposit, propose and accept, claim, withdraw, end of contract. `pnpm test:program` in `app/` runs only this file.
- `app/tests/*.test.mjs`: app logic and components without a chain (pay mirror, alerts, split, tax CSV).
- Browser: what LiteSVM can't see, the app against a real RPC (websocket confirmations, history from `getTransaction`, Explorer links, wallets).

## Writing a program test

Add a top-level `test()` to `program.test.ts`, one behavior each, on a fresh `chain()`. Helpers at the top of the file: `wallet(svm, usdc)` makes a funded wallet, `hire(svm, rate, deposit, notice)` a pool with one accepted contract, `send(svm, payer, instructions)` throws with the program logs on failure, `rejects(promise, 'ErrorName')` expects a program error, `setTime(svm, unix)` moves chain time (no waiting), `usdcOf` and `poolOf` read state. Run `anchor build` first, the test loads the `.so` from disk.

## Shared machine rules

- Tickets that change the program go one at a time. Tickets that touch only the app can run in parallel.
- `anchor build`, `pnpm add` and `pnpm install` take the lock: `mkdir /tmp/easypay-build.lock` before, `rmdir` after. Two at once break `node_modules` or the `.so`.
- A running `pnpm dev` (Surfpool `--watch`) redeploys every new `.so`, also yours. Don't restart someone else's `pnpm dev`.

## End of a batch: browser

One agent, once, on its own chain and ports, not the one someone is clicking on. Run `anchor build` first (under the lock) if the program changed, then:

```
bash scripts/chain.sh smoke --no-build
```

Works from the Mac or the container. It starts a fresh offline stack on port 38899 (app on 35173), runs `app/tests/smoke.mjs` in headless Chromium inside the container and stops the stack. About 20 s. The flow: Company creates a pool and deposits, proposes to Pawel with 14 days notice, Pawel accepts and sees the notice, +1 day, claims, Company sees the notice reserve and withdraws Max (vault minus earned minus reserve), ends the contract at the picker's default and Details show "Last paid day <date>", then after the notice Pawel claims the 14 days. A failure prints the toasts and the visible panel. A new flow worth guarding goes into `smoke.mjs`, not into a one-off script in `/tmp`.

Your own stack to click through or script against: `bash scripts/chain.sh start --port N` (also `stop`, `restart`, `status`; `--no-build`, `--chain-only`). Ports: RPC N, websocket N+1, app 5173+(N-8899). Only 8899 is published to the Mac, other ports are reachable inside the container only. Taken: 8899 (Paweł's `pnpm dev`), 28899 (Play), 38899 (smoke). On a port other than 8899 the program is deployed once at start, so after `anchor build` run `restart --chain-only`.

The full catalog: `pnpm scenarios --run all --headless` from the Mac, about 25 minutes, exit 1 on any failed check. One scenario: `--run <id>` (ids: `pnpm scenarios --list`). It plays `app/scenarios/catalog.mjs` on port 28899 through a proxy container (`easypay-play-proxy-28899`) that publishes 28899, 28900 and 25173 to the Mac. A UI change that breaks a scenario gets fixed in the catalog in the same ticket. Only one Play runs at a time, on 28899: if `pgrep -f play.mjs` finds one, kill it first, never start a second one on another `PLAY_PORT`.

Demo data to click through: `seed demo` in the dev footer swaps in fresh test accounts and builds three companies (Acme Labs as Company with Score 100, Globex with Score 50 and short, Initech New) with offers, active and ended contracts and Pawel's split, on the running chain, in about half a minute (`app/src/seed.ts`, scenario `demo`). `reset` gives fresh empty accounts. Neither restarts the chain.
