# Easy Pay: codzienna wypłata dla kontraktorów B2B

## Problem

Kontraktor B2B, czyli osoba na własnej działalności, która pracuje dla firmy z innego kraju, zwykle pracuje cały miesiąc na zaufanie, a potem czeka 30 dni lub dłużej na przelew. Nasz kolega przepracował trzy miesiące dla zagranicznego startupu i odszedł, a founder odmówił mu zapłaty za ostatni miesiąc, około 10 tys. USD. Sprawa w sądzie za granicą kosztowałaby więcej niż ta kwota. Dziś jedynym zabezpieczeniem jest firma pośrednicząca, której też trzeba zaufać.

## Rozwiązanie

Firma wpłaca pieniądze do wspólnej puli, czyli skarbonki na wypłaty. Pula działa na Solanie, publicznym rejestrze (blockchainie), którego nie kontroluje żadna pojedyncza firma. Zasady puli zapisaliśmy w programie działającym w tym rejestrze. Pieniądze w puli to USDC, cyfrowy dolar (1 USDC = 1 USD).

Kontraktor zarabia swoją stawkę każdego dnia i może ją od razu odebrać. Tego, co już zarobił, firma nie może cofnąć. My, autorzy aplikacji, też nie, bo program nie daje nikomu takiego uprawnienia.

- Przed startem kontraktor akceptuje dokładne warunki umowy. Umowa rusza tylko wtedy, gdy w puli są pieniądze co najmniej na okres wypowiedzenia.
- Firma może wyjąć z puli tylko pieniądze, których kontraktorzy jeszcze nie zarobili, poza rezerwą na wypowiedzenie.
- Jeśli firma zniknie, pieniądze zostają w puli i kontraktor nadal może odebrać to, co zarobił.

## Co już działa

- Pula firmy: wpłata, wypłata niezarobionych pieniędzy i podgląd rezerwy.
- Umowy ze stawką dzienną lub godzinową, z okresem wypowiedzenia i opcjonalną datą końca. Można liczyć tylko dni robocze.
- Odbiór zarobionych pieniędzy jednym kliknięciem albo automatycznie. Automat działa na naszym serwerze, ale może wysłać pieniądze tylko na konta wskazane przez kontraktora.
- Podział każdej wypłaty, np. 25% na odłożenie na podatek i 10% dla mamy. Część można od razu wymienić na SOL, BTC lub ETH po aktualnym kursie rynkowym. Nazwy odbiorców są zaszyfrowane.
- Historia operacji, gdzie każdą można sprawdzić w publicznym rejestrze. Zaświadczenie o dochodach w PDF i plik CSV do rozliczenia podatku z kursami NBP.
- Zakładka Companies, czyli publiczna historia płatnicza każdej firmy: ile umów zawarła, ile wypłaciła i ile razy zabrakło jej pieniędzy w puli.
- Program działa w sieci testowej Solany (Devnet) i ma testy automatyczne.

## Plany

- Odsetki dla firm: pieniądze czekające w puli mogłyby na siebie zarabiać, co zachęci firmy do wpłacania z góry.

## Jak wypróbować

Aplikacja działa w sieci testowej, więc wszystkie pieniądze są testowe i darmowe.

1. Zainstaluj Phantom (https://phantom.com), rozszerzenie do przeglądarki, które służy jako portfel na cyfrowe pieniądze. W ustawieniach włącz tryb testowy (Testnet Mode) i wybierz sieć Solana Devnet.
2. Skopiuj adres swojego portfela z Phantoma. Pobierz na niego darmowe testowe SOL, potrzebne do drobnych opłat za operacje, z https://faucet.solana.com, oraz testowe USDC z https://faucet.circle.com (wybierz Solana Devnet).
3. Otwórz https://solana-easypay.vercel.app/app i kliknij połączenie portfela.
4. Jako firma: w zakładce Pool utwórz pulę i wpłać USDC, potem w zakładce Contracts zaproponuj umowę na adres portfela kontraktora.
5. Jako kontraktor: dodaj w Phantomie drugie konto, zaakceptuj ofertę w zakładce Contracts, a zarobione pieniądze odbierz w zakładce Claim.

Uruchomienie na własnym komputerze jest opisane w [README](../README.md).

## Repozytorium

https://github.com/Pawel-Kica/solana-easypay
