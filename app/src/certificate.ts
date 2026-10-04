import type { Address } from '@solana/kit';
import { explorerTxUrl } from './chain';
import type { IncomeContract } from './events';
import { contractTitle, formatUsdc } from './format';
import { HOUR } from './pay';

// The income certificate: a PDF a worker shows a bank or landlord, built in the browser from chain data only.
// Covers the last 3 months before `now` (chain time). Every contract still running in that window goes on it.

const PURPLE = '#9945FF';
const GREY = '#6b6b6b';
const MARGIN = 20; // mm, A4 is 210 x 297
const WIDTH = 210 - 2 * MARGIN;

// "3 Oct 2026", UTC like the program.
const day = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
// ASCII only: the PDF's built-in fonts have no "…".
const short = (text: string) => `${text.slice(0, 8)}...${text.slice(-8)}`;
const sum = (amounts: bigint[]) => amounts.reduce((a, b) => a + b, 0n);

// Builds the certificate and downloads it as easypay-income-<date>.pdf.
export async function downloadCertificate(worker: Address, contracts: IncomeContract[], now: number) {
  const { jsPDF } = await import('jspdf');
  const logoResponse = await fetch('/brand/easy-pay-horizontal.png');
  if (!logoResponse.ok) throw new Error('Could not load the Easy Pay logo.');
  const logo = new Uint8Array(await logoResponse.arrayBuffer());
  const start = new Date(now * 1000);
  start.setUTCMonth(start.getUTCMonth() - 3);
  const from = Math.floor(start.getTime() / 1000);
  const shown = contracts
    .filter((c) => c.end === null || c.end >= from)
    .map((c) => ({
      ...c,
      claims: c.claims.filter((cl) => cl.time >= from && cl.time <= now),
    }));
  const total = sum(shown.flatMap((c) => c.claims.map((cl) => cl.amount)));

  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  let y = MARGIN;
  // A full page continues on a new one.
  const room = () => {
    if (y <= 297 - MARGIN) return;
    pdf.addPage();
    y = MARGIN;
  };
  // Writes one line at x and moves y down by gap.
  const line = (
    text: string,
    { x = MARGIN, size = 10, bold = false, mono = false, color = '#131313', gap = 5.5 } = {},
  ) => {
    room();
    pdf
      .setFont(mono ? 'courier' : 'helvetica', bold ? 'bold' : 'normal')
      .setFontSize(size)
      .setTextColor(color);
    pdf.text(text, x, y);
    y += gap;
  };

  // Header: the app's mark and name, then what this is.
  pdf.addImage(logo, 'PNG', MARGIN, y - 6, 42, 10);
  y += 12;
  line('Income certificate', { size: 20, bold: true, gap: 7 });
  line(`Payouts from ${day(from)} to ${day(now)}, read from the Solana blockchain.`, { color: GREY, gap: 10 });

  line('Worker', { size: 9, color: GREY, gap: 4.5 });
  line(worker, { size: 9, mono: true, gap: 9 });
  line('Total paid in these 3 months', { size: 9, color: GREY, gap: 7 });
  line(formatUsdc(total), { size: 18, bold: true, color: PURPLE, gap: 10 });

  for (const c of shown) {
    pdf.setDrawColor('#e5e5e5').line(MARGIN, y - 4, MARGIN + WIDTH, y - 4);
    line(contractTitle(c), { size: 13, bold: true, gap: 6 });
    line(`Company: ${c.companyName || 'Unnamed company'} (name set by the company, not verified)`, { gap: 5 });
    line(`Company address: ${c.employer}`, { size: 9, color: GREY, gap: 5 });
    const ended = c.end === null ? '' : `, ends ${day(c.end)}`;
    line(`Rate ${formatUsdc(c.rate)} per ${c.period === HOUR ? 'hour' : 'day'}, started ${day(c.start)}${ended}`, {
      gap: 5,
    });
    line(`Paid in these 3 months: ${formatUsdc(sum(c.claims.map((cl) => cl.amount)))}`, { bold: true, gap: 7 });
    if (!c.claims.length) line('No payouts in these 3 months.', { size: 9, color: GREY, gap: 6 });
    for (const cl of c.claims) {
      room();
      pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor('#131313');
      pdf.text(new Date(cl.time * 1000).toUTCString().replace('GMT', 'UTC'), MARGIN, y);
      pdf.text(formatUsdc(cl.amount), MARGIN + 75, y);
      pdf.setTextColor(PURPLE).textWithLink(`Explorer: ${short(cl.signature)}`, MARGIN + 110, y, {
        url: explorerTxUrl(cl.signature),
      });
      y += 5;
    }
    y += 6;
  }

  line('Every payout above is a Solana transaction and can be checked in Solana Explorer.', { size: 9, color: GREY });
  pdf.save(`easypay-income-${new Date(now * 1000).toISOString().slice(0, 10)}.pdf`);
}
