# Wdrożenie napraw po pentestach

Data: **17.10.2026**. Stan: **SEC-01 i SEC-02 naprawione w badanym drzewie; PT12-04 powtórzony wiarygodnym testem fixture; pełny odbiór aplikacji pozostaje otwarty**.

Punkt wyjścia to pentest commita `af512e9502218d336b4b73df0c5f612905c6ac7b` na zastanym, niezacommitowanym drzewie (83 zmienione ścieżki, historyczny hash diffu `1e0d2c761a13739b1e2d0c4a842354616f5e088e795a78be9aacfbba9a16befa`). Historyczny raport i jego macierz pozostają niezmienione. Wyniki retestu z tej implementacji są zapisane w [manifest.json](manifest.json) i [retest-scenarios.json](retest-scenarios.json).

## Zmiany

**SEC-01 — lista importów.** Operator widzi własny import narzędzia prywatnego tylko przy bieżącym `view_results`. Współdzielony odczyt wyników OC pozostaje zachowany. Warunek tenanta i capability jest wykonywany w predykacie SQL używanym przed filtrami, sortowaniem, limitem i kursorem. Szczegóły zapewnia [resource-scope.ts](../../../apps/api/src/features/authorization/resource-scope.ts). Wspólny predykat nadal chroni listy historii i kolejki review.

**SEC-02 — dashboard.** Projekcja `operations` ma jawny warunek `tool_id = 'oc-policy-verification'` w `WHERE`, przed grupowaniem i `LIMIT 8`. Dzięki temu prywatne operacje nie zasilają `operations` ani `actionRequired`; licznik operacji OC zachowuje ten sam zakres. Zachowane leady i osobisty licznik powiadomień mają własne reguły.

Dołożyłem [security-resource-scope-db-smoke.cjs](../../../apps/api/scripts/security-resource-scope-db-smoke.cjs) i wpiąłem go w testy raportów oraz runtime ról. Fixture jest wstawiany połączeniem migratora, a odczyt HTTP i dashboardu działa połączeniem `goldis_api`. Test sprawdza brak grantu, same prawa discover/execute, dodatni grant `view_results`, cofnięcie grantu przy tej samej sesji i starym kursorze, obcy tenant, szczegół importu, anonima, paginację i dodatni przypadek OC.

**PT12-04 — popup.** Test korzysta teraz z prawdziwego kliknięcia `page.click`, potwierdza wywołanie handlera i odbiera zdarzenie utworzenia popupu. Nie czeka arbitralnych 200 ms. W Chromium popup jest zamknięty, fixture obcej domeny nie dostaje żądania, kontrola kolejnej akcji odrzuca wykonanie przed zwiększeniem licznika, a drugi portal nadal działa. Test potwierdził, że istniejąca blokada w BrowserSession działa, gdy popup rzeczywiście powstaje; osobna zmiana tej logiki nie była potrzebna. Stary FAIL wynikał z niedowodzącego fixture i pozostaje w historycznym raporcie.

## Weryfikacja

- `npm run build -w @goldis/api` i `npm run build -w @goldis/worker` — PASS.
- `npm run test:unit -w @goldis/api` — 355/355 PASS.
- `npm run test:architecture` — 5/5 PASS; `npm run test:transaction-audit` — 4/4 PASS.
- `npm run test:module:reports` na jednorazowym PostgreSQL 18 — PASS; migracje 001–062, raporty, zachowane leady, HTTP listy importów, regresje SEC-01/02.
- `npm run test:module:runtime-roles` na jednorazowym PostgreSQL 18 — PASS; nowy test wypisał `RESOURCE_SCOPE_DB_PASS role=goldis_api`, a istniejący smoke potwierdził rozdział ról i brak publicznych grantów.
- Everest/PZU popup fixture — 4/4 PASS po poprawie; pełny moduł Everest wcześniej 27/27 PASS. Compensa browser — 39/39 PASS; UFG browser — 14/14 PASS.
- Skrypty smoke przeszły `node --check`.

Jednorazowy harness PostgreSQL utworzył własny katalog/bazę i posprzątał je po zakończeniu. Zmiany nie dodają migracji schematu.

## Decyzje z triage skanerów

**`uuid@8.3.2`.** Lockfile otrzymał to wydanie przez ExcelJS i Sequelize. Advisory [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) dotyczy wywołań v3/v5/v6 z przekazanym buforem. W sprawdzonych wywołaniach ExcelJS używa wyłącznie v4 bez bufora, Sequelize używa v1/v4, a kod aplikacji nie importuje tych metod. Nie wymuszałem major override, który mógłby złamać wymagania pakietów nadrzędnych. SCA nadal zgłosi wersję; wrócić do zmiany przy aktualizacji ExcelJS/Sequelize albo po zgodnościowo przetestowanej aktualizacji drzewa.

**Gitleaks.** Wartości nie były odczytywane ani umieszczane w raporcie. Osiem historycznych dopasowań dotyczy plików testów, smoke i dokumentacji; część jest opisana syntetycznymi markerami, a jedno dopasowanie wskazuje na ścieżkę usuniętą później. Nie potwierdziłem, że którekolwiek jest aktywnym sekretem. Dopasowania filesystemu obejmują ignorowane `.env*`, cache npm, build Next, profile przeglądarki i fixture. `.gitignore` i `.dockerignore` wykluczają lokalne `.env*`, cache i profile z Git/build contextu. Obrazy i backupy nie były dostępne bez Dockera, więc ich zawartość pozostaje do osobnego sprawdzenia. Nie wykonano rotacji bez potwierdzenia aktywnego ujawnienia.

**Redis, obrazy i CI.** Dockerfile Redis nie deklaruje `USER`, ale entrypoint kończy przez `su-exec redis redis-server`; ACL jest zapisywany z prawami 0600 i właścicielem `redis`. Compose definiuje healthchecki Redis, API, workera i web, więc statyczne ostrzeżenie o braku `HEALTHCHECK` w samym Dockerfile nie uzasadnia dodania drugiej, rozbieżnej sondy. Faktycznego UID, ACL i digestów uruchomionych obrazów nie sprawdziłem, bo Docker daemon nie działa. Workflow zachowuje `permissions: contents: read`; akcje są wskazane tagami `@v4`, nie commit SHA. Pinning SHA pozostaje osobną decyzją supply-chain.

## Pozostałe prace

Weryfikacja dynamiczna odbyła się na PostgreSQL 18. PostgreSQL 17, rzeczywisty Redis i testowy HTTPS/proxy nie były dostępne, bo Docker daemon jest niedostępny. To blokuje końcowy odbiór planu E, w tym sprawdzenie runtime obrazów, ACL Redis i wariantów CORS przez HTTPS. Poprawka SEC-01/02 przeszła też pod rolą `goldis_api` na PG18, ale nie stanowi to odbioru docelowej wersji PG17.

Pozostałe scenariusze pentestu nadal mają historyczne statusy BLOCKED/INCONCLUSIVE; nie zostały wszystkie powtórzone. Testy nie obejmowały produkcji, stagingu ani prawdziwych portali/usług zewnętrznych. Dlatego raport pentestu nadal opisuje zakres całej aplikacji jako częściowo zbadany. Do domknięcia przed wydaniem: powtórzyć testy i runtime role na PG17, uruchomić Redis i HTTPS/proxy w kontrolowanym harnessie, przejrzeć obrazy/backupy dla Gitleaks i indywidualnie rozstrzygnąć pozostałe scenariusze.
