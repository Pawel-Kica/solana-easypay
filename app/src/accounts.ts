import { createKeyPairSignerFromPrivateKeyBytes, type KeyPairSigner } from '@solana/kit';

// Built-in test accounts for the local chain. Never used on devnet.
export const ROLES = ['Company', 'Pawel', 'Sebastian', 'Mom', 'Taxes'] as const;
export type Role = (typeof ROLES)[number];
export type TestAccount = { role: Role; signer: KeyPairSigner };
// Split recipients. They start at 0 SOL and 0 USDC, so whatever they hold came from a split.
export const UNFUNDED: readonly Role[] = ['Mom', 'Taxes'];

const STORAGE_KEY = 'easypay.testAccounts';

// Loads the test keypairs from localStorage, generating them on the first visit.
// Raw private keys in localStorage are fine for throwaway local keys, never for real money.
export async function loadTestAccounts(): Promise<TestAccount[]> {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  // Before 2026-10-04 the workers were called Worker A and Worker B. Keeps their keys.
  saved.Pawel ??= saved['Worker A'];
  saved.Sebastian ??= saved['Worker B'];
  delete saved['Worker A'];
  delete saved['Worker B'];
  for (const role of ROLES) {
    saved[role] ??= Array.from(crypto.getRandomValues(new Uint8Array(32)));
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));

  return Promise.all(
    ROLES.map(async (role) => ({
      role,
      signer: await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(saved[role]!)),
    })),
  );
}

// The demo companies seed.ts made, by name, for the quick picks on Companies > Search. Tied to the test accounts.
export const DEMO_COMPANIES_KEY = 'easypay.demoCompanies';

// Drops the test keypairs (and the demo companies) and makes fresh ones: empty accounts on the same chain, no
// restart needed. The dev footer's "reset" and "seed demo" reload the page after it.
export function resetTestAccounts(): Promise<TestAccount[]> {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(DEMO_COMPANIES_KEY);
  return loadTestAccounts();
}
