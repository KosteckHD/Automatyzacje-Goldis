# Decyzja zależności — 2026-11-06

## DEP-001: `uuid` w ExcelJS i Sequelize

- Czyste `npm ci` na `package-lock.json` zakończyło się powodzeniem (Node 24.11.1, npm 11.6.2; 332 pakiety).
- Lockfile wymusza `uuid@11.1.1` wyłącznie w gałęziach `exceljs` i `sequelize`. Nie użyto `audit fix --force` ani globalnego override.
- Wybrano v11, ponieważ naprawiona wersja advisory to 11.1.1, a badani rodzice używają CommonJS. `uuid` v12+ zmienił tę ścieżkę ładowania na ESM.
- Obecne wersje rodziców (`exceljs@4.4.0`, `sequelize@6.37.8`) deklarują `uuid` z zakresu 8.x, dlatego `npm ls` zgłasza `invalid` dla świadomie wymuszonego 11.1.1. To widoczny koszt override'u, a nie brak zgodności w lockfile. Nie należy usuwać komentarza/tej decyzji ani rozszerzać override na inne rodziny.
- Przegląd wywołań rodziców znalazł `uuid.v4` w ExcelJS oraz `uuid.v1` i `uuid.v4` w Sequelize. Nowy test zgodności uruchamia rzeczywisty `CfRuleExtXform.prepare`, domyślne UUID Sequelize oraz konstruktor transakcji Sequelize bez połączenia z DB.
- Testy zgodności i pełny build wszystkich workspace przechodzą po czystej instalacji.
- `npm audit --omit=dev --audit-level=moderate` (2026-11-06) zwraca `found 0 vulnerabilities`.
- `pip-audit==2.9.0 --disable-pip --no-deps -r services/commission-engine/requirements.lock` nie znalazł znanych podatności w przypiętym lockfile. Wynik nie obejmuje bazowego obrazu kontenera ani pakietów systemowych.

Źródła:

- Advisory: https://github.com/advisories/GHSA-w5hq-g745-h8pq
- Zależność ExcelJS: https://github.com/exceljs/exceljs/blob/master/package.json
- UUID i CommonJS w Sequelize: https://github.com/sequelize/sequelize/issues/18238
- UUID: https://github.com/uuidjs/uuid

## Ograniczenia i ponowny przegląd

To obejście jest wąskie, sprawdzone testem integracji API biblioteki i widoczne jako naruszenie deklarowanego semver przez `npm ls`. Zastąpić je aktualizacją rodziców dopiero, gdy ich wydane wersje zadeklarują bezpieczny zakres UUID albo utrzymywana gałąź przejdzie te same testy. Przegląd powtórzyć przed kolejnym wydaniem i wcześniej, jeśli ExcelJS/Sequelize zaczną używać `uuid.v3`, `v5` lub `v6` z wejściowym buforem.

Zmiana `fastapi` w `pyproject.toml` do `0.162.0` ujednolica deklarację z `requirements.lock`. Skan obrazu produkcyjnego i pakietów systemowych nadal pozostaje bramką wydania.
