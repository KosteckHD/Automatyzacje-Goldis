# Pakiet pełnego odbioru Goldis

Zacznij od [planu głównego](../../PLAN_PELNEGO_ODBIORU_PLATFORMY_2026-11-05.md), następnie użyj [checklisty](CHECKLISTA.md), [rejestru wyników](wyniki.csv) i [protokołu](PROTOKOL_ODBIORU.md). Ten pakiet jest planem przygotowanym w pracy rozpoczętej 5 listopada; nie zawiera wykonanych testów aplikacji.

- `przypadki.json` — kompletna specyfikacja grup przypadków z expected i wymaganymi dowodami; `phaseGates` wskazuje bramkę każdego wykonania.
- `wyniki.csv` — UTF-8 z BOM, separator przecinek, osobny wiersz dla każdej początkowej pary case/faza. Warianty i retesty dopisuj jako nowe wiersze, zachowując poprzednie obserwacje.
- `usterki.csv` — pusty wzór rejestru znalezisk, poprawek, retestów i zaakceptowanych niższych ryzyk.
- `manifest.example.json` — szablon do skopiowania poza repo i uzupełnienia bez sekretów; null oznacza brak wartości/dowodu.
- `PROTOKOL_ODBIORU.md` — zakres, wyniki, odzyskiwanie, przekazanie i decyzja końcowa.

Wybierz jedno bieżące źródło wyników (CSV albo strukturalny rejestr executions) i zapisz je w manifeście. Checklista i NOT_RUN w definicjach nie są automatycznie aktualizowanym raportem.

## Aktualizacja definicji przed wykonaniem

Źródłowe grupy definicji są w `release-cases.json`, `functional-cases.json`, `security-cases.json` i `infrastructure-cases.json`. Przed rozpoczęciem odbioru można po zmianie tych plików wykonać:

```sh
node docs/acceptance/2026-11-05/przygotuj-rejestry.cjs
```

Skrypt sprawdza identyfikatory i zależności oraz generuje wyłącznie dokumentację/JSON/CSV. **Nie uruchamia aplikacji, testów, skanów, połączeń sieciowych ani migracji.** Odmawia nadpisania rejestru, gdy canonical executions/statusy albo CSV zawierają już zapisane wykonania lub inne zmiany. Wtedy definicje i nowe wiersze należy scalić ręcznie, zachowując historię.

Za pełne pokrycie nie uznaje się samej liczby grup: SEC trzeba rozwinąć na aktualne endpointy, role, zasoby i stany. Wyłączenie modułu nie wyłącza wspólnych testów jego izolacji i wpływu na runtime. Historyczne PASS z innych snapshotów nie zaliczają nowego release.
