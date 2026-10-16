# Realizacja planu adaptacji — 12 października 2026

## Status

Kroki implementacyjne 0–8 są wykonane. Kodowe zabezpieczenia P0 z kroku 9 są dodane. Build i regresja lokalna są zielone. System nie jest jeszcze gotowy do publicznego uruchomienia: nie ma wdrożonego VPS/domeny/TLS, produkcyjnego cold restore, protokołu staging ani odbioru lokalnego przez użytkownika.

Nie logowałem się do portali i nie wykonywałem automatyzacji live. Tryb portali pozostaje wyłączony.

## Zmiany domknięte w tej iteracji

- Ograniczyłem zakresy scalonych komórek arkusza przed parsowaniem przez ExcelJS; limit zlicza sumę całego skoroszytu.
- Eksporty XLSX są szyfrowane AES-256-GCM w katalogu artefaktów. Pobieranie produkcyjne może wymagać szyfrowania i odrzuca legacy plaintext, gdy `ARTIFACT_REQUIRE_ENCRYPTION=1`. Dodałem kontrolowany, wznawialny skrypt szyfrujący historyczne pliki po weryfikacji SHA-256.
- Compose tworzy rozłączne role PostgreSQL migrator/API/worker. Migracje uruchamiają się z konta migratora, a API i worker nie mają DDL. Idempotentna usługa `db-roles` obsługuje też istniejące wolumeny.
- Dodałem `npm run upgrade:local:db-roles` dla starszego `.env.local`; uzupełnia poświadczenia ról i zachowuje hasło bootstrapu oraz adres istniejącego loopback PostgreSQL.
- Chromium działa z `chromiumSandbox: true`, `no-new-privileges` i profilowanym seccomp na bazie Moby; weryfikacja nie wymaga `SYS_ADMIN` ani `seccomp=unconfined`.
- Dodałem przykład Nginx, który zastępuje nagłówki przekazane przez klienta oraz instrukcję VPS, konwersji eksportów i odbioru staging.
- Naprawiłem fixture workera, które pomijało osobę decyzyjną wymaganą przez wejściowy snapshot.

## Dowody

- `npm run build` — PASS dla core, API, workera i web.
- `npm test` — PASS dla core, API, workera i walidacji preflight.
- `npm run test:module:results` — PASS, 27/27.
- Izolowany PostgreSQL 17: świeża baza — migrator tworzy tabelę, API zapisuje/odczytuje, worker odczytuje, konta runtime nie mogą tworzyć tabel; wszystkie trzy role mają `rolsuper=false` — PASS.
- Izolowany PostgreSQL 17 ze schematem sprzed aktualizacji — przekazanie istniejących tabel/sequence, DML API, DDL migratora i odmowa DDL API — PASS.
- Zbudowany obraz workera Playwright: test syntetycznej strony z Chromium sandbox, custom seccomp oraz `no-new-privileges` — `CHROMIUM_SANDBOX_SMOKE_PASS`. Obraz testowy został usunięty po weryfikacji.
- `docker compose config --quiet`, `node --check` skryptów migracji artefaktów i sandbox smoke — PASS.
- Pozostałe moduły integracyjne wykonane w poprzedniej weryfikacji tej samej serii zmian: migracje 001–058; registry 56/56; submission 1/1; leads 1/1; deletion, deletion step-up, SMS 33/33; Everest 8/8, Compensa 29/29, UFG 13/13; reports i PostgreSQL backup/restore — PASS.

## Bramki przed publiczną produkcją

1. Wykonać lokalny scenariusz odbiorczy z 3–5 syntetycznymi wierszami i zatwierdzić go przez użytkownika, zgodnie z krokiem 10 planu.
2. Ustawić VPS, domenę i certyfikat TLS; wdrożyć Nginx, ustawić dokładne `TRUST_PROXY_IPS`, origin HTTPS, cookie i zapory. Przetestować z zewnątrz, że API, PostgreSQL, Redis i worker nie są publiczne, a spoofing XFF nie omija limitera.
3. Zrobić backup przed zmianą istniejącego magazynu. Zatrzymać API/workery i uruchomić `scripts/migrate-artifacts-to-encrypted.cjs` na docelowym storage. Dopiero po kontroli wyniku włączyć `APP_ENV=production` oraz `ARTIFACT_REQUIRE_ENCRYPTION=1`.
4. Uruchomić codzienny zaszyfrowany backup z alertami, zachować journal kasowań i wykonać cold restore na innym hoście. Zmierzyć RPO ≤ 24 h i RTO ≤ 8 h.
5. Zbudować i zapisać release commit/digest, sprawdzić rollback aplikacji wobec migracji jednokierunkowych i testy staging ról/sieci/autoryzacji.
6. Po odbiorze lokalnym wykonać nadzorowany staging z uprawnionymi kontami portalowymi, w tym SMS, ręczne użycie tych samych kont, zmiany sesji i kontrolę braku podwójnej oferty. Otworzyć `WORKER_LIVE_PORTALS=1` dopiero na zaakceptowanym środowisku.

Szczegóły i przykładowa topologia są w [instrukcji wdrożenia produkcyjnego](WDROZENIE_PRODUKCYJNE_I_ROLE_BAZY_2026-10-12.md). Kryteria lokalnego i stagingowego odbioru pozostają w [planie adaptacji](PLAN_ADAPTACJI_PLATFORMY_DO_USTALEN_2026-10-12.md).
