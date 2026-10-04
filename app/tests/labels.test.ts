import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createSignableMessage, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { decryptLabels, encryptLabels, LABELS_LEN, labelsFit, LABELS_TEXT, openLabels, sealLabels } from '../src/labels';

// Split labels crypto (labels.ts) without a chain: the blob round-trips, only the right wallet opens it, and a fresh
// browser (empty localStorage) gets the same key back from the wallet's signature.

const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
} as Storage;
beforeEach(() => storage.clear());

const aesKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

// The test keypair's signer as the app uses it (chain.ts signText), counting signatures.
function signerOf(wallet: KeyPairSigner) {
  const sign = async (message: Uint8Array) => {
    sign.calls++;
    const [signatures] = await wallet.signMessages([createSignableMessage(message)]);
    return signatures[wallet.address];
  };
  sign.calls = 0;
  return sign;
}

test('sealed labels open with the same key and fail with another', async () => {
  const key = await aesKey();
  const blob = await sealLabels(key, ['Mom', ' Taxes ', 'Żona']);
  assert.equal(blob.length, LABELS_LEN);
  assert.deepEqual(await openLabels(key, blob), ['Mom', 'Taxes', 'Żona']);
  await assert.rejects(openLabels(await aesKey(), blob));
});

test('no labels: zero blob, no signature asked', async () => {
  const wallet = await generateKeyPairSigner();
  const sign = signerOf(wallet);
  const blob = await encryptLabels(wallet.address, ['', ' '], sign);
  assert.ok(blob.every((b) => b === 0));
  assert.deepEqual(await decryptLabels(wallet.address, blob, sign), []);
  assert.equal(sign.calls, 0);
});

test('another browser gets the labels back from one signature, another wallet does not', async () => {
  const wallet = await generateKeyPairSigner();
  const sign = signerOf(wallet);
  const blob = await encryptLabels(wallet.address, ['Mom', '', 'Taxes'], sign);
  assert.equal(sign.calls, 1);
  assert.deepEqual(await decryptLabels(wallet.address, blob), ['Mom', '', 'Taxes']); // cached key, no prompt

  storage.clear(); // a fresh browser
  assert.deepEqual(await decryptLabels(wallet.address, blob), []); // no key and no way to sign
  assert.deepEqual(await decryptLabels(wallet.address, blob, sign), ['Mom', '', 'Taxes']);
  assert.equal(sign.calls, 2);

  const stranger = await generateKeyPairSigner();
  assert.deepEqual(await decryptLabels(stranger.address, blob, signerOf(stranger)), []);
});

test('labelsFit counts UTF-8 bytes of all labels together', () => {
  assert.ok(labelsFit(['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(LABELS_TEXT - 66)]));
  assert.ok(!labelsFit(['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(LABELS_TEXT - 65)]));
  assert.ok(!labelsFit(['ż'.repeat(LABELS_TEXT / 2 + 1)]));
});
