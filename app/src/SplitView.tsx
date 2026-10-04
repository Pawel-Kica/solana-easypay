import { isAddress, type Address } from '@solana/kit';
import { useEffect, useState } from 'react';
import { ASSET_NAMES, getPythPrice, signText, type SigningClient } from './chain';
import { shortAddress } from './format';
import { Asset, type Split } from './generated';
import { encryptLabels, labelsFit } from './labels';
import type { Notify } from './Toasts';
import { sendWithToast } from './tx';
import { BUTTON, FIELD, INPUT, Info, SMALL_BUTTON, Tabs } from './ui';

const MAX_RECIPIENTS = 3;
const TAXES = 'Taxes';
const ASSETS = [Asset.Sol, Asset.Btc, Asset.Eth];
const ADD_BUTTON =
  'flex-1 rounded-2xl border border-dashed border-white/15 py-3 text-sm text-white/50 hover:border-white/30 hover:text-white';

type Row = { label: string; address: string; pct: string };

// The worker's wallet share: whatever the recipients and investing leave.
export const walletPct = (split: Pick<Split, 'recipients' | 'investPct'> | null) =>
  100 - (split?.recipients.reduce((sum, r) => sum + r.pct, 0) ?? 0) - (split?.investPct ?? 0);

type Props = {
  client: SigningClient;
  owner: Address;
  split: Split | null;
  labels: string[]; // the split's decrypted labels, in recipient order
  notify: Notify;
  onSaved: () => void; // re-reads the split
};

// Split view of the Claim tab: up to 3 other addresses with a whole percent of every claim, the worker's wallet
// gets the rest. "+ Taxes" adds a ready "Taxes" row at 25% for the worker's own tax address. Invest swaps a whole percent of every claim into
// SOL, BTC or ETH at the Pyth price shown. Save opens a confirm window with the new split, then signs set_split.
// The auto-claim key is kept as it is on-chain. Labels like "Mom" go on-chain encrypted (labels.ts), saving the
// first one asks the wallet for a signature.
export function SplitView({ client, owner, split, labels, notify, onSaved }: Props) {
  const [rows, setRows] = useState<Row[]>(
    () => split?.recipients.map((r, i) => ({ label: labels[i] ?? '', address: r.owner, pct: String(r.pct) })) ?? [],
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const [investText, setInvestText] = useState(String(split?.investPct ?? 0));
  const [asset, setAsset] = useState(split?.investAsset ?? Asset.Sol);
  const [price, setPrice] = useState<number | null>(null); // USD per unit of the asset, null while reading

  useEffect(() => {
    let alive = true;
    setPrice(null);
    getPythPrice(asset).then(
      (p) => alive && setPrice(p),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [asset]);

  const investPct = Number(investText);
  const pcts = rows.map((r) => Number(r.pct));
  const mine = 100 - investPct - pcts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const error = (() => {
    for (const [i, r] of rows.entries()) {
      const address = r.address.trim();
      if (!isAddress(address)) return `Row ${i + 1}: not a Solana address`;
      if (address === owner) return `Row ${i + 1}: that is your own wallet, it gets the rest anyway`;
      if (rows.slice(0, i).some((o) => o.address.trim() === address)) return `Row ${i + 1}: address already in the split`;
      if (!/^\d+$/.test(r.pct) || pcts[i] < 1) return `Row ${i + 1}: percent must be a whole number from 1`;
    }
    if (!labelsFit(rows.map((r) => r.label))) return 'Labels are too long together, shorten one';
    if (!/^\d+$/.test(investText) || investPct > 100) return 'Invest must be a whole percent from 0 to 100';
    return mine < 0 ? 'Shares add up to more than 100%' : null;
  })();

  const edit = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setBusy(true);
    const ok = await sendWithToast(client, notify, { success: 'Split saved', failure: 'Saving split failed' }, async () =>
      client.sendTransaction([
        await client.easypay.instructions.setSplit({
          employee: client.identity,
          recipients: rows.map((r) => ({ owner: r.address.trim() as Address, pct: Number(r.pct) })),
          investPct,
          investAsset: asset,
          claimer: split?.claimer ?? null,
          labels: await encryptLabels(owner, rows.map((r) => r.label), signText(client.identity)),
        }),
      ]),
    );
    setBusy(false);
    setConfirming(false);
    if (ok) onSaved();
  };

  return (
    <>
      <div className={`mt-2 ${FIELD} flex items-center gap-3`}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            My wallet
            <Info text="This wallet gets whatever the other addresses don't" />
          </p>
          <p className="font-mono text-sm text-white/55">{shortAddress(owner)}</p>
        </div>
        <span data-testid="wallet-pct" className="text-2xl tabular-nums">
          {Math.max(mine, 0)}
        </span>
        <span className="text-white/50">%</span>
        <span className="w-4" />
      </div>
      {rows.map((r, i) => (
        <div key={i} className={`mt-2 ${FIELD} flex items-center gap-3`}>
          <div className="min-w-0 flex-1">
            <input
              value={r.label}
              onChange={(e) => edit(i, { label: e.target.value })}
              placeholder="Label, encrypted, only you can read it"
              maxLength={24}
              aria-label={`Label ${i + 1}`}
              className={`w-full text-sm font-medium ${INPUT}`}
            />
            <input
              value={r.address}
              onChange={(e) => edit(i, { address: e.target.value })}
              placeholder="Solana address"
              aria-label={`Address ${i + 1}`}
              className={`mt-1 w-full font-mono text-xs ${INPUT}`}
            />
          </div>
          <input
            value={r.pct}
            onChange={(e) => edit(i, { pct: e.target.value })}
            inputMode="numeric"
            aria-label={`Percent ${i + 1}`}
            className={`w-16 text-right text-2xl tabular-nums ${INPUT}`}
          />
          <span className="text-white/50">%</span>
          <button
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            aria-label={`Remove row ${i + 1}`}
            className="w-4 text-white/40 hover:text-red-300"
          >
            ×
          </button>
        </div>
      ))}
      {rows.length < MAX_RECIPIENTS && (
        <div className="mt-2 flex gap-2">
          <button onClick={() => setRows([...rows, { label: '', address: '', pct: '' }])} className={ADD_BUTTON}>
            + Add address
          </button>
          {/* Tax pot: a ready-made row, the worker pastes their own second address. */}
          {!rows.some((r) => r.label.trim() === TAXES) && (
            <button onClick={() => setRows([...rows, { label: TAXES, address: '', pct: '25' }])} className={ADD_BUTTON}>
              + Taxes
            </button>
          )}
        </div>
      )}
      <div className={`mt-2 ${FIELD} flex items-center gap-3`}>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Invest
            <Info text="Swapped at every claim by our exchange at the real Pyth price. On devnet the swap is simulated. If it can't swap, you get USDC" />
          </p>
          <div className="mt-1 flex items-center gap-2">
            <Tabs
              tabs={ASSETS.map((a) => ASSET_NAMES[a])}
              value={ASSET_NAMES[asset]}
              onChange={(name) => setAsset(ASSETS.find((a) => ASSET_NAMES[a] === name)!)}
              label="Asset to invest in"
            />
            <span data-testid="asset-price" className="text-sm text-white/55 tabular-nums">
              {price === null ? '' : `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
            </span>
          </div>
        </div>
        <input
          value={investText}
          onChange={(e) => setInvestText(e.target.value)}
          inputMode="numeric"
          aria-label="Invest percent"
          className={`w-16 text-right text-2xl tabular-nums ${INPUT}`}
        />
        <span className="text-white/50">%</span>
        <span className="w-4" />
      </div>
      {error && <p className="mt-3 px-1 text-sm text-amber-300">{error}</p>}
      <button onClick={() => setConfirming(true)} disabled={!!error} className={`${BUTTON} mt-3`}>
        Save split
      </button>

      {confirming && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label="Confirm split">
          <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#131313] p-5">
            <p className="text-lg font-semibold">Are you sure?</p>
            <p className="mt-1 text-sm text-white/50">Every claim from now on pays out like this.</p>
            <ul className="mt-4 space-y-2 text-sm">
              <li className="flex justify-between">
                <span>My wallet</span>
                <span className="tabular-nums">{mine}%</span>
              </li>
              {rows.map((r, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="min-w-0">
                    {r.label.trim() || 'Address'}{' '}
                    <span className="font-mono text-sm break-all text-white/50">{r.address.trim()}</span>
                  </span>
                  <span className="tabular-nums">{r.pct}%</span>
                </li>
              ))}
              {investPct > 0 && (
                <li className="flex justify-between">
                  <span>Invest in {ASSET_NAMES[asset]}</span>
                  <span className="tabular-nums">{investPct}%</span>
                </li>
              )}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirming(false)} disabled={busy} className={`${SMALL_BUTTON} text-white/60 hover:text-white`}>
                Cancel
              </button>
              <button onClick={save} disabled={busy} className={`${SMALL_BUTTON} bg-[#9945FF] text-white hover:bg-[#8a3ef0]`}>
                {busy ? 'Signing…' : 'Sign and save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
