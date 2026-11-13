# Raport odbioru formularza OC — 8 kroków

Data: 21.10.2026  
Stan: częściowy odbiór; bez wdrożenia produkcyjnego.  
Punkt bazowy repozytorium: `af512e9`; zmiany robocze pozostają niezacommitowane.

## Zakres sprawdzenia

Odbiór dotyczy formularza `/tools/oc-policy-verification`, nowych wejść do kroku 8, zgodności kontekstów importu/run/submission/resultSet, zachowania starych tras oraz awaryjnego powrotu do poprzedniego widoku. Pełną kolejność pakietów i pozostałe bramki opisuje [plan implementacji](PLAN_IMPLEMENTACJI_FORMULARZA_OC_8_KROKOW_2026-10-21.md).

## Wyniki

| Sprawdzenie | Wynik | Uwagi |
| --- | --- | --- |
| `npm run build -w @goldis/web` | PASS | Produkcyjny build Next.js i TypeScript. |
| `npm run test:oc-workspace-ui-smoke -w @goldis/web` | PASS | Osiem ekranów, nawigacja, reload, preview/start, CSRF/idempotencja, pause/resume, wyniki, responsywność 320–1920 px oraz blokada sprzecznych identyfikatorów. API jest syntetyczne. |
| `OC_AUTOMATION_WORKSPACE_ENABLED=0` + smoke rollbacku | PASS | Serwer wybiera poprzedni formularz. Osobny smoke potwierdza też `?view=legacy`. |
| `npm run test:history-ui-smoke -w @goldis/web` | PASS | Dashboard → krok 8, import z historii → krok 2, historia wyników, wejście do runu i paginacja historii. |
| `npm run test:lead-ui-smoke -w @goldis/web` | PASS | Stara pula wyników zachowuje zakres leadów i dostęp. |
| `npm run test:run-submission-ui-smoke -w @goldis/web` | PASS | Wybór, podgląd, start, sterowanie, ponowne otwarcie oraz `/submissions/:id`. |
| `npm run test:w3-sms-ui-smoke -w @goldis/web` | PASS | Modal SMS, CSRF, limity i wygaśnięcie; portal syntetyczny. |
| `npm run test:w4-enrichment-ui-smoke -w @goldis/web` | PASS | Lookup REGON, pochodzenie danych, korekty, joby, anulowanie i stany błędów; API syntetyczne. |
| `npm run test:module:submission` | PASS | 9 testów: wybór, kontrolery, CSRF, wersje, eksport XLSX, agregaty, scope i osobne prawo pobierania. |
| `npm run test:module:security` | PASS | 79 testów; w tym wspólny podgląd OC bez domyślnego prawa pobierania i jawny grant eksportu. |
| `npm run test:module:notifications` | PASS | 4 testy, w tym nowy adres „wynik gotowy” do kroku 8. |
| `npm run test:module:results` | PASS | 31 testów. |
| `npm run test:module:review` | PASS | 56 testów, wykonane wcześniej po zmianach wyszukiwania. |
| `node --check` skryptów smoke i migracyjnego; `git diff --check` | PASS | Bez błędów składni skryptów i whitespace w sprawdzonych plikach. |
| `tenant-scope` i `run-control` na tymczasowym PostgreSQL 17 | PASS | Bazy testowe tworzone i usuwane przez runner. Obejmują import/preparation, prepared set, korektę w trakcie lookupu, izolację tenantów, cofnięty grant przed dispatch, jawny grant pobrania, pauzę/wznowienie zgłoszenia i wykonania, anulowanie, idempotencję, outbox oraz migracje 001–065. Końcowy wynik: `DB_INTEGRATION_PASS modes=tenant-scope,run-control`. |
| Produkcyjny przebieg portali i wdrożenie | NOT RUN | Ten odbiór używa syntetycznych API. Nie uruchamiano portali ani nie zmieniano środowiska produkcyjnego. |

## Zrzuty ekranów

Smoke zapisał wszystkie osiem ekranów w `output/acceptance/oc-8-screens-2026-10-21/`: `01-upload.png`, `02-validation.png`, `03-regon.png`, `04-deduplication.png`, `05-selection.png`, `06-launch.png`, `07-progress.png`, `08-results.png`.

## Pozostałe bramki

- Domknąć pozostałe przypadki graniczne ról, cofniętych grantów i dużych list poza scenariuszami pokrytymi w DB smoke.
- Nie wykonywano przełączenia produkcyjnego; wymaga ono osobnego uzgodnionego wdrożenia po zakończeniu odbioru.
