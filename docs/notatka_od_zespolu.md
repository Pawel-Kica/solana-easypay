# Notatka od zespołu

## Kto może zmienić program po wdrożeniu

Dziś jedna osoba z zespołu. Program na devnecie (`BNUCb9cqqaxfVsNiRNofP2RVTjNn6XKnpcfRQWas8FYQ`) ma upgrade authority na zwykłym kluczu `DpvteuKXFrmxH54jxs3nYfgEzbh426mpgw8YzPDhtF6s`. Widać to w [Explorerze](https://explorer.solana.com/address/BNUCb9cqqaxfVsNiRNofP2RVTjNn6XKnpcfRQWas8FYQ?cluster=devnet), pole Upgrade Authority.

To problem. Kto ma ten klucz, może wgrać nowy kod, a na Solanie nowy kod działa od razu ([Neodyme](https://neodyme.io/en/blog/solana_upgrade_authority/)). Taki kod mógłby wypłacić pulę firmy albo zarobione dniówki na dowolny adres. Firma i pracownik nie muszą ufać sobie nawzajem, ale muszą ufać nam. Pośrednik nie zniknął, tylko zmienił się w nas.

Na hackathon zostawiamy jeden klucz, bo program wciąż poprawiamy, a z multisigiem każdy deploy wymagałby kilku podpisów.

## Możliwe tryby

- Zamrożony program (`solana program set-upgrade-authority --final`). Nikt nic nie zmieni, my też nie. Błędu nie da się poprawić, nowa wersja to nowy program i przeniesienie umów. Tak działają Sablier i LlamaPay na EVM.
- Multisig z timelockiem ([Squads v4](https://docs.squads.so/main/development/reference/time-locks)). Zmiana wymaga kilku podpisów, a potem przez ustalony czas czeka publicznie, zanim da się ją wykonać. Kto nie ufa zmianie, zdąży wyjść: firma wypłaca niezarobione, pracownik robi claim. Minus: poprawki idą wolniej.
- Jeden klucz, jak dziś. Najszybsze poprawki, ale wszystko stoi na jednej osobie. Zgubiony klucz to koniec aktualizacji, wykradziony to obcy, który może podmienić program.

## Co wybieramy po hackathonie

Multisig Squads v4, 4 z 7: czterech z nas i trzy zaufane osoby z Superteamu. Timelock 7 dni. Bez config authority, więc zmiana członków albo progu też wymaga 4 podpisów. Składu jeszcze nie ustaliliśmy. Kiedy program się ustabilizuje, rozważymy zamrożenie.

Dla porównania: program streamingu Zebec na mainnecie ma upgrade authority na zwykłym kluczu (`GYJaAKVuUkMpzBUWXt9NUqZ5rRPhZR5U4YwdzhmJmmpp`, sprawdzone 2026-10-03). Squads v4 jest popularny, ale 98,2% jego multisigów nie ma timelocka ([solana-upgrade-watch](https://github.com/simonvellin/solana-upgrade-watch)).

## Zaświadczenie o dochodach i historię firmy da się napompować

Dane w łańcuchu są prawdziwe, ale nie mówią, kto stoi za pulą. Wystarczy drugi portfel: zakładam pulę, zatrudniam sam siebie, wpłacam i robię claim. Wychodzi zaświadczenie z "dochodem" i firma z ładną historią wypłat (`contracts_total`, `paid_total` w `Pool`). Nazwa firmy to tekst wpisany przy `create_pool`, nikt jej nie sprawdza.

Zaświadczenie dowodzi więc, że z danej puli szły wypłaty na dany adres, a nie że to był prawdziwy pracodawca. Tak samo historia firmy: pokazuje, czy pula płaciła, ale nie odróżni prawdziwych pracowników od portfeli samej firmy.

Na hackathon zostawiamy tak. Pomysł na później: powiązanie puli z tożsamością firmy spoza łańcucha, np. domena albo podpis z rejestru firm.
