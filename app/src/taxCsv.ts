import type { Address } from '@solana/kit';
import { explorerTxUrl } from './chain';
import { getIncome, type IncomeClaim } from './events';
import { usdcText } from './format';

// The worker's tax export: one CSV row per claim with the NBP rate and the PLN amount, built in the browser.
// Polish PIT (art. 11a ust. 1) converts income at the NBP table A mid rate from the last business day before
// the day of the claim. USDC counts as USD.

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10); // "2026-10-03", UTC

type NbpRate = { effectiveDate: string; mid: number };

// Keep requests within NBP's documented 93-day limit without dropping older claims.
// Ten extra days before the first claim cover weekends and holidays.
async function fetchUsdRates(firstMs: number, lastMs: number): Promise<NbpRate[]> {
  const to = Date.parse(isoDay(Math.min(lastMs, Date.now())));
  const from = Date.parse(isoDay(Math.min(firstMs, to))) - 10 * DAY_MS;
  const rates: NbpRate[] = [];
  for (let start = from; start <= to; start += 90 * DAY_MS) {
    const end = Math.min(start + 89 * DAY_MS, to);
    const url = `https://api.nbp.pl/api/exchangerates/rates/a/usd/${isoDay(start)}/${isoDay(end)}/?format=json`;
    const response = await fetch(url);
    if (response.status === 404) continue; // A short final range may contain only a weekend.
    if (!response.ok) throw new Error(`NBP answered ${response.status}`);
    rates.push(...(await response.json()).rates);
  }
  return rates.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

// Future Local claims use the latest available rate. Never give an old claim a rate from a later date.
function rateBefore(rates: NbpRate[], day: string) {
  const rate = rates.filter((r) => r.effectiveDate < day).at(-1);
  if (!rate) throw new Error(`No NBP rate before ${day}`);
  return rate;
}

// One row per claim, including separate claims sent in the same transaction.
export async function buildTaxCsv(income: IncomeClaim[]) {
  const claims = [...income].sort((a, b) => a.time - b.time);
  const rates = claims.length ? await fetchUsdRates(claims[0].time * 1000, claims.at(-1)!.time * 1000) : [];
  const rows = claims.map(({ time, amount, signature }) => {
    const usdc = usdcText(amount);
    const { mid } = rateBefore(rates, isoDay(time * 1000));
    const date = new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ');
    return [date, usdc, mid, (Number(usdc) * mid).toFixed(2), explorerTxUrl(signature)].join(',');
  });
  return ['Date (UTC),Amount (USDC),NBP rate (USD/PLN),Amount (PLN),Transaction', ...rows].join('\n') + '\n';
}

// Builds the CSV from the worker's Claimed events and downloads it as easypay-claims-<date>.csv.
export async function downloadTaxCsv(worker: Address) {
  const csv = await buildTaxCsv((await getIncome(worker)).flatMap((c) => c.claims));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `easypay-claims-${isoDay(Date.now())}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
