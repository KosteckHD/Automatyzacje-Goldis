# Decyzje dla zgłoszeń zależności

Stan po `npm ci` i świeżym `npm audit --json` z 8 października 2026: **0 high, 7 moderate**. Początkowy skan z tego samego dnia wykazywał 2 high i 7 moderate. Ten dokument zachowuje otwarte zgłoszenia; wynik skanu nie oznacza braku ryzyka.

| Pakiet / ścieżka | Decyzja | Dowód i ograniczenie |
| --- | --- | --- |
| `next` 16.3.7 → 16.4.0 | Zaktualizowano w granicach major; zgłoszenia high zniknęły z aktualnego `npm audit`. | Produkcyjny build i test przeglądarkowy CSP zaliczone na 16.4.0. Nie opieramy autoryzacji API wyłącznie na Next Proxy. |
| `source-map-js` 1.2.1 → 1.2.2 | Zaktualizowano wersję rozwiązaną w lockfile; zgłoszenie high nie występuje w skanie po zmianie. | `npm ci` odtworzył 1.2.2 przez PostCSS/Next. |
| `uuid` 8.3.2 przez ExcelJS 4.4.0 i Sequelize 6.37.8 | Pozostaje zgłoszenie moderate; brak wymuszonego override major. | Advisory dotyczy `v3()`, `v5()` i `v6()` przy buforze wyjściowym z nieprawidłowym offsetem/rozmiarem; wyraźnie wyłącza `v1()` i `v4()`. Audyt użycia w zainstalowanych pakietach znalazł w ExcelJS wyłącznie `v4`, a w Sequelize `v1`/`v4`; nie znaleziono przekazania kontrolowanego przez HTTP bufora do podatnych metod. `npm audit fix --force` proponuje niezgodny downgrade ExcelJS do 3.4.0 lub Sequelize do 3.30.0. Ponowić analizę po aktualizacji rodzica i przed wydaniem produkcyjnym. |
| `sprintf-js` 1.0.3 przez Umzug 3.8.3 → `@rushstack/ts-command-line` → `argparse` | Pozostaje zgłoszenie moderate bez wersji naprawczej w advisory. | Biblioteka jest osiągalna przez parser CLI używany z runnerem migracji, ale format nie pochodzi z HTTP ani z pliku importowanego przez użytkownika. `npm audit fix --force` proponuje niezgodny downgrade Umzug do 2.3.0. Nie zastosowano go. Właściciel wyjątku: utrzymujący repozytorium; ponowny przegląd przy każdej aktualizacji Umzug/argparse i przed wydaniem. |

Pozostałe wpisy `exceljs`, `sequelize`, `umzug`, `argparse` i `@rushstack/ts-command-line` są ścieżkami zależnymi od powyższych dwóch zgłoszeń, a nie odrębnymi potwierdzonymi exploitami. Ich status pozostaje widoczny w skanie npm. Nie użyto `npm audit fix --force`.

Źródła advisory: [Next.js](https://github.com/advisories/GHSA-3w37-wq28-93x7), [source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), [uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).
