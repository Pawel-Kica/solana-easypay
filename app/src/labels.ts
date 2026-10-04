import type { ReadonlyUint8Array } from '@solana/kit';

// Split labels like "Mom", stored on-chain in Split.labels, encrypted so only the worker reads them.
// The key is SHA-256 of the wallet's signature over LABELS_MESSAGE. Ed25519 signatures are deterministic, so the
// same wallet gets the same key in any browser. The key is cached in localStorage per address, one prompt per browser.
// Blob: 12-byte IV, then AES-GCM of the labels joined by "\n" and zero-padded to LABELS_TEXT bytes. All zeros = none.

export const LABELS_LEN = 128; // Split.labels in the program
const IV_LEN = 12;
const TAG_LEN = 16;
export const LABELS_TEXT = LABELS_LEN - IV_LEN - TAG_LEN;
export const LABELS_MESSAGE = 'EasyPay labels v1. Signing unlocks your split labels, it costs nothing.';
const KEYS_KEY = 'easypay.labelKeys';

export type SignText = (message: Uint8Array) => Promise<Uint8Array>;

const encoder = new TextEncoder();
const empty = (labels: string[]) => labels.every((l) => !l.trim());

// Whether the labels fit the blob, in UTF-8 bytes.
export const labelsFit = (labels: string[]) => encoder.encode(labels.map((l) => l.trim()).join('\n')).length <= LABELS_TEXT;

const importKey = (raw: Uint8Array) => crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function sealLabels(key: CryptoKey, labels: string[]): Promise<Uint8Array> {
  const text = new Uint8Array(LABELS_TEXT);
  text.set(encoder.encode(labels.map((l) => l.trim()).join('\n')));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, text));
  return new Uint8Array([...iv, ...sealed]);
}

// Throws on a wrong key or a tampered blob.
export async function openLabels(key: CryptoKey, blob: ReadonlyUint8Array): Promise<string[]> {
  const text = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, IV_LEN) }, key, blob.slice(IV_LEN));
  return new TextDecoder().decode(text).replace(/\0+$/, '').split('\n');
}

const cachedKeys = (): Record<string, string> => JSON.parse(localStorage.getItem(KEYS_KEY) ?? '{}');
const pending = new Map<string, Promise<CryptoKey>>(); // one prompt even when two views ask at once

// The owner's key: from the cache, else from a signature when `sign` is given, else null.
async function labelKey(owner: string, sign?: SignText): Promise<CryptoKey | null> {
  const cached = cachedKeys()[owner];
  if (cached) return importKey(Uint8Array.from(atob(cached), (c) => c.charCodeAt(0)));
  if (!sign) return null;
  if (!pending.has(owner)) {
    const derive = (async () => {
      const signature = new Uint8Array(await sign(encoder.encode(LABELS_MESSAGE)));
      const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', signature));
      localStorage.setItem(KEYS_KEY, JSON.stringify({ ...cachedKeys(), [owner]: btoa(String.fromCharCode(...raw)) }));
      return importKey(raw);
    })();
    pending.set(owner, derive);
    derive.finally(() => pending.delete(owner)).catch(() => {});
  }
  return pending.get(owner)!;
}

// The blob for set_split. No labels: all zeros, no prompt. Throws when the worker rejects the signature.
export async function encryptLabels(owner: string, labels: string[], sign: SignText): Promise<Uint8Array> {
  if (empty(labels)) return new Uint8Array(LABELS_LEN);
  return sealLabels((await labelKey(owner, sign))!, labels);
}

// Labels in recipient order, [] when there are none or they can't be read (no key and no `sign`, a rejected
// signature, another wallet's blob).
export async function decryptLabels(owner: string, blob: ReadonlyUint8Array, sign?: SignText): Promise<string[]> {
  if (blob.every((b) => b === 0)) return [];
  try {
    const key = await labelKey(owner, sign);
    return key ? await openLabels(key, blob) : [];
  } catch {
    return [];
  }
}
