# Easy Pay: dniówki dla kontraktorów B2B na Solanie

## Problem

Kontraktor B2B, który pracuje dla firmy z innego kraju, zwykle pracuje miesiąc na zaufanie i potem czeka 30 dni lub dłużej na przelew. Nasz kolega przepracował trzy miesiące dla zagranicznego startupu, odszedł, a founder odmówił zapłaty za ostatni miesiąc, około 10 tys. USD. Sprawa w sądzie za granicą kosztowałaby więcej niż ta kwota. Dziś jedynym zabezpieczeniem jest pośrednik, któremu trzeba ufać.

## Rozwiązanie

Firma wpłaca USDC do jednej puli w programie on-chain na Solanie. Kontraktor co dzień zarabia swoją stawkę, a tego, co już zarobił, firma nie może zabrać. Zasady są zapisane w programie, nie na naszym serwerze, więc ani firma, ani my nie możemy przesunąć zarobionych pieniędzy.

- Kontraktor podpisuje dokładne warunki umowy. Akceptacja przechodzi tylko wtedy, gdy pula pokrywa okres wypowiedzenia.
- Firma może wypłacić z puli tylko to, czego pracownicy jeszcze nie zarobili, pomniejszone o rezerwę na wypowiedzenie.
- Jeśli firma zniknie, pieniądze zostają w puli i kontraktor nadal je odbiera.
- W programie nie ma kluczy admina ani uprzywilejowanych instrukcji.

## Co już działa

- Pula firmy: wpłata, wypłata niezarobionych środków i podgląd rezerwy.
- Umowy ze stawką dzienną lub godzinową, z okresem wypowiedzenia i opcjonalną datą końca. Pracę można liczyć tylko w dni robocze.
- Claim ręczny albo automatyczny. Auto-claim robi nasz serwer, ale wysyła pieniądze tylko tam, gdzie wskazał kontraktor.
- Podział każdej wypłaty, na przykład 25% na konto podatkowe i 10% dla mamy, plus wymiana części na SOL, BTC lub ETH po kursie z Pytha. Etykiety odbiorców są zaszyfrowane on-chain.
- Historia transakcji z linkami do Solana Explorer, zaświadczenie o dochodach w PDF oraz CSV do podatków z kursami NBP.
- Zakładka Companies: historia każdej firmy prosto z łańcucha, czyli liczba umów, ile wypłaciła i ile razy zabrakło jej środków w puli.
- Program w Rust (Anchor) wdrożony na devnecie, testy programu w LiteSVM i test end-to-end w przeglądarce.

## Jak uruchomić

1. Zainstaluj portfel Phantom i włącz tryb testnet, sieć Solana Devnet.
2. Pobierz testowe SOL z https://faucet.solana.com i testowe USDC z https://faucet.circle.com (sieć Solana Devnet).
3. Otwórz https://solana-easypay.vercel.app/app i połącz portfel.
4. Jako firma: w zakładce Pool utwórz pulę i wpłać USDC, potem w Contracts zaproponuj umowę na adres kontraktora.
5. Jako kontraktor (drugie konto w Phantomie): zaakceptuj ofertę w Contracts, a zarobione pieniądze odbierz w zakładce Claim.

Uruchomienie lokalne jest opisane w [README](../README.md) (devcontainer, `pnpm dev`, gotowe konta testowe i przycisk seed demo).

## Repozytorium

https://github.com/Pawel-Kica/solana-easypay
