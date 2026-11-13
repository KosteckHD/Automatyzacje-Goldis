# Protokół odbioru UI, UX i user flow Goldis

Data: 22 października 2026. Status: **implementacja lokalna UX-00–UX-15 wykonana; odbiór integracyjny i pracowniczy częściowy; wdrożenia nie wykonano**.

Powiązane dokumenty: [audyt](./AUDYT_UI_UX_USER_FLOW_2026-10-22.md), [plan implementacji ze statusem każdego kroku](./PLAN_IMPLEMENTACJI_UI_UX_USER_FLOW_2026-10-22.md).

## Zakres i wersja

Pracowano w repozytorium na bazowym commicie `af512e9`, gałąź `codex/backend-feature-modules`. Drzewo robocze zawierało wiele niezapisanych zmian przed tą rundą; wyniki dotyczą stanu lokalnego z dnia odbioru i nie są przypisane do nowego commita. Nie resetowano, nie stage’owano ani nie czyszczono cudzych zmian. Nie uruchamiano portali live, produkcyjnych operacji ani wdrożenia.

Wykonane pakiety obejmują wspólny zakres listy i eksportu firm, stany odczytu i liczniki, filtry i powrót zapisane w URL, obsługę sesji, niezależne otwieranie powiadomień, kontekst wyniku, etapy i gotowość OC, wybór firm z rewizji, czytelne podsumowanie całego importu, odtwarzanie szkicu i bezpieczne ponawianie tej samej próby, słownik nawigacji, ekrany codziennego kontaktu oraz poprawki kontrastu, rozmiarów kontrolek i układu. Przy końcowym przeglądzie naprawiono także szerokość i wysokość wyszukiwarki wyników OC; test sprawdza computed styles zamiast nazw klas.

## Zakończone testy automatyczne

| Polecenie | Wynik |
|---|---|
| `npm run build` | PASS — core, API, worker i web. |
| `npm run build -w @goldis/web` | PASS — powtórzony po końcowej poprawce kontrolki wyników. |
| `npm run test:module:leads` | PASS — 5 testów zakresu, walidacji parametrów, kursora i ograniczeń SQL/ACL. |
| `npm run test:module:review` | PASS — 56 testów. |
| `npm run test:module:submission` | PASS — 9 testów, w tym selekcja, idempotencja i zakres wyników. |
| `npm run test:lead-ui-smoke -w @goldis/web` | PASS — pulę, podgląd bez mutacji, niepewną odpowiedź, nawigację ról i układ mobilny; dane API syntetyczne. |
| `npm run test:manager-ui-smoke -w @goldis/web` | PASS — strony menedżera, granty, przydział, raporty, drawer mobilny i odmowa dostępu pracownika. |
| `npm run test:history-ui-smoke -w @goldis/web` | PASS — katalog, filtrowanie, kursor, Back, wejście bezpośrednie i stan bez polis. |
| `npm run test:review-ui-smoke -w @goldis/web` | PASS — korekta, konflikt, CSRF, uprawnienia i widok mobilny. |
| `npm run test:run-submission-ui-smoke -w @goldis/web` | PASS — przygotowanie, eksport, preview, osobne potwierdzenie, idempotencja, pause/resume/cancel i ponowne wczytanie. |
| `npm run test:oc-workspace-ui-smoke -w @goldis/web` | PASS — osiem etapów, historia przeglądarki, wybór po stronach i wyszukiwaniu, preview przed startem, skojarzenie wyników, paginacja i szerokości 320–1920 px. Zawiera obliczenia kontrastu oraz geometrii wyszukiwarek wyboru i wyników. |
| `npm run test:w3-sms-ui-smoke -w @goldis/web` | PASS — modal kodu, pułapy i wygaśnięcie SMS, focus trap i odtworzenie fokusu; portal syntetyczny. |
| `npm run test:audit-ui-smoke -w @goldis/web` | PASS — filtry, paginacja, rola operatora, widok mobilny i brak żądań zewnętrznych. |
| `npm run test:admin-ui-smoke -w @goldis/web` | PASS — granty, operacje, raporty, CAS, CSRF i szerokości 320–1920 px. |
| `npm run test:tool-grants-ui-smoke -w @goldis/web` | PASS — brak dostępu, wspólny odczyt/pobranie, blokada uruchomienia w trybie read-only i układ mobilny. |

Testy przeglądarkowe korzystały z lokalnego buildu i atrap API z danymi syntetycznymi. Nie wysyłały ruchu do portali ubezpieczycieli ani rzeczywistych usług biznesowych. Osiem zrzutów przebiegu OC znajduje się w [`output/acceptance/oc-8-screens-2026-10-21/`](../output/acceptance/oc-8-screens-2026-10-21/).

Nie uruchomiono pełnego `npm test`. Nie uruchomiono `npm run test:db-integration`: zmienna `GOLDIS_TEST_DATABASE_ADMIN_URL` nie jest ustawiona w środowisku. Nie odczytywano `.env` ani danych produkcyjnych, żeby jej szukać. Testy modułowe nie zastępują testu PostgreSQL ani odczytu rzeczywistego pliku XLSX.

## Macierz T01–T32

Status `PASS` oznacza, że zachowanie pokrywa wskazany test automatyczny. `CZĘŚCIOWO` oznacza, że implementacja lub test syntetyczny istnieje, ale brakuje integracji z bazą, pełnego scenariusza albo ręcznego odbioru. Żaden wpis poniżej nie potwierdza akceptacji przez pracowników.

| ID | Status | Dowód i brakujący odbiór |
|---|---|---|
| T01 | CZĘŚCIOWO | Wspólny zakres, uprawnienia i filtry są pokryte modułem leads i smoke UI; porównanie wszystkich ID z rzeczywistym XLSX dla zakresu mine wymaga PostgreSQL. |
| T02 | CZĘŚCIOWO | Eksport wyników zestawu jest testowany modułowo; brak DB-owego porównania XLSX dla `resultSetId`. |
| T03 | CZĘŚCIOWO | Rozdzielenie widoczności, wykonania, odczytu i pobrania przechodzi testy UI grantów; osobny test API eksportu firm bez grantu do plików pozostaje do potwierdzenia integracyjnego. |
| T04 | CZĘŚCIOWO | Limit eksportu i komunikat są zaimplementowane; nie zweryfikowano wygenerowanego pliku dla 50 000 rekordów ani odmowy dla 50 001 w DB. |
| T05 | CZĘŚCIOWO | Stany błędu/retry są w UI; brak odrębnego końcowego scenariusza 503 pierwszego odczytu i odczytu pustego stanu w całej macierzy. |
| T06 | CZĘŚCIOWO | Obsługa błędu odświeżenia istnieje; zachowanie poprzednich danych z czasem odczytu wymaga osobnego kontrolowanego testu 503. |
| T07 | CZĘŚCIOWO | Odpowiedzi nieaktualnego zakresu są odrzucane w implementacji; brak osobnego powolnego A / szybkiego B w końcowym smoke. |
| T08 | CZĘŚCIOWO | Copy pustych stanów rozdziela brak puli i brak dopasowań; wszystkie warianty trzeba potwierdzić na API/DB. |
| T09 | PASS | Smoke OC używa 61 syntetycznych firm, strony po 50 i wyboru firm z kilku stron oraz po wyszukiwaniu. |
| T10 | CZĘŚCIOWO | URL, kursor i powrót są wdrożone; pełne mine/pool → detal → reload w integracji z żywymi rekordami wymaga dodatkowego odbioru. |
| T11 | CZĘŚCIOWO | Historia Back/Forward działa w smoke historii i OC; otwarcie detalu w nowej karcie z zachowaniem rzeczywistego kursora nie ma osobnego potwierdzenia. |
| T12 | CZĘŚCIOWO | Nawigacja poprzednia/następna i zachowanie filtrów są zaimplementowane; scenariusz statusu zmienionego współbieżnie trzeba wykonać na danych DB. |
| T13 | CZĘŚCIOWO | Błędy dostępu/odświeżenie są obsługiwane; usunięcie sąsiada między odczytem a kliknięciem pozostaje do integracji. |
| T14 | CZĘŚCIOWO | Bezpieczny `returnTo` i ekran wymaganej sesji są wdrożone; macierz 401 na każdym z ekranów detal/OC/powiadomienie wymaga testu przekrojowego. |
| T15 | CZĘŚCIOWO | UI rozróżnia błędy sieci od 401; końcowy smoke nie pokrywa osobno `auth/me` z 503 i ponowienia. |
| T16 | CZĘŚCIOWO | Otwieranie interwencji, modal i SMS nie blokują pracy; brak jawnego przypadku oznaczenia powiadomienia jako przeczytane z odpowiedzią 503/timeout. |
| T17 | PASS | Smoke OC sprawdza bezpośrednie wejście do result-set oraz blokuje obce/niepowiązane wyniki. |
| T18 | PASS | Smoke obejmuje osiem etapów, dostępność przy braku gotowości i przejście między etapami bez mutacji; zrzuty w podanej ścieżce. |
| T19 | PASS | Smoke zgłoszenia potwierdza preview, brak startu przed zgodą, osobny start oraz CSRF/idempotency key. |
| T20 | CZĘŚCIOWO | Backend sprawdza wersję/fingerprint; brak odrębnego testu browser zmiany rewizji dokładnie po wyświetleniu preview. |
| T21 | CZĘŚCIOWO | Paginacja i zachowanie zaznaczeń przechodzą na 61 rekordach; granica 500/501 i zmiana rewizji wymagają dodatkowych przypadków. |
| T22 | PASS | Smoke zgłoszenia odtwarza wybór po reloadzie bez zgody i bez automatycznego startu; przed startem wymaga nowego preview. |
| T23 | PASS | Smoke leads weryfikuje niepewną odpowiedź i ponowienie, a API modułu submission sprawdza idempotencję wyboru. |
| T24 | CZĘŚCIOWO | Szkic jest wiązany z tenantem/użytkownikiem; zmiana użytkownika i niedostępny `sessionStorage` nie mają osobnego końcowego scenariusza browser. |
| T25 | CZĘŚCIOWO | Historia testuje przegląd i krok podniesionego uwierzytelnienia przy usunięciu; zachowanie snapshotu po rzeczywistym usunięciu importu wymaga DB. |
| T26 | PASS | Testy admina, grantów, menedżera i audytu obejmują role, widoczność menu, blokadę wykonania i odmowę dostępu. |
| T27 | CZĘŚCIOWO | Automatyczne rozmiary 320–1920 px oraz zrzuty desktop/mobile przechodzą; nie wykonano pełnego pomiaru clippingu wszystkich kart przy 1366×768 i 1440×900. |
| T28 | CZĘŚCIOWO | Brak poziomego overflow testowany dla 320–1920 px; 200% zoom i fizyczne użycie dotykowe pozostają do ręcznego odbioru. |
| T29 | CZĘŚCIOWO | Modal SMS ma test focus trap/powrotu fokusu, drawer ma test klawiatury; brak pełnego audytu Tab/Shift+Tab dla wszystkich ekranów i czytnika NVDA. |
| T30 | CZĘŚCIOWO | Computed styles potwierdzają kontrast tekstu i granicy dwóch wyszukiwarek; pozostałe pola, focus, błędy i statusy wymagają pełnej macierzy. |
| T31 | CZĘŚCIOWO | Testy API sprawdzają wersjonowanie, selekcję i idempotencję; wszystkie ścieżki 409 statusu i podwójnego kliknięcia na żywym API wymagają odbioru. |
| T32 | CZĘŚCIOWO | Parser parametrów leads i filtry SQL są testowane; tenant DB, sfałszowany cursor w każdym zakresie oraz złośliwe `returnTo` pozostają do pełnej integracji. |

## Linki do kodu i dowodów

- Zakres i walidacja leads: [lead-query.spec.ts](../apps/api/src/features/leads/lead-query.spec.ts), [business-leads.http.spec.ts](../apps/api/src/features/leads/business-leads.http.spec.ts), [lead-ui-smoke.cjs](../apps/web/scripts/lead-ui-smoke.cjs). DB smoke do uruchomienia: [business-leads-db-smoke.cjs](../apps/api/scripts/business-leads-db-smoke.cjs).
- Przepływ OC i wyniki: [oc-workspace-ui-smoke.cjs](../apps/web/scripts/oc-workspace-ui-smoke.cjs), [run-submission-ui-smoke.cjs](../apps/web/scripts/run-submission-ui-smoke.cjs), [run-submissions.http.spec.ts](../apps/api/src/features/submissions/run-submissions.http.spec.ts), [run-submission-preview.repository.ts](../apps/api/src/features/submissions/run-submission-preview.repository.ts).
- Role i operacje pracowników: [manager-ui-smoke.cjs](../apps/web/scripts/manager-ui-smoke.cjs), [tool-grants-ui-smoke.cjs](../apps/web/scripts/tool-grants-ui-smoke.cjs), [review-ui-smoke.cjs](../apps/web/scripts/review-ui-smoke.cjs), [history-ui-smoke.cjs](../apps/web/scripts/history-ui-smoke.cjs).
- Pozostałe widoki i dostępność: [admin-ui-smoke.cjs](../apps/web/scripts/admin-ui-smoke.cjs), [audit-ui-smoke.cjs](../apps/web/scripts/audit-ui-smoke.cjs), [w3-sms-ui-smoke.cjs](../apps/web/scripts/w3-sms-ui-smoke.cjs).
- Zrzuty ośmiu etapów: [output/acceptance/oc-8-screens-2026-10-21](../output/acceptance/oc-8-screens-2026-10-21/).

## Otwarte działania odbiorowe

1. Uruchomić testy PostgreSQL w izolowanej bazie testowej, w tym rzeczywiste XLSX, mine/pool, tenant, zachowane snapshoty oraz limity 50 000/50 001. Nie kierować testów do produkcji.
2. Uzupełnić smoke o brakujące awarie 503/401, opóźnione odpowiedzi A/B, zmianę rewizji po preview, granice 500/501, obcy tenant i bezpieczny parser `returnTo`.
3. Przeprowadzić ręczny przegląd geometrii na 1366×768, 1440×900, 390×844 oraz 200% zoomie: clipping w panelach, sticky focus, pełne etykiety, dolna nawigacja i wielkość obszarów dotykowych. Sprawdzić NVDA i rzeczywisty telefon.
4. Z nowym i doświadczonym pracownikiem oraz menedżerem wykonać zadania: znaleźć firmę, odczytać wynik OC, skontaktować się, zapisać decyzję, przejść dalej i wznowić przerwany import. Zanotować ukończenie, pomyłki i pytania; nie deklarować efektu przed pomiarem.
5. Dopiero po odbiorze wyznaczyć wersję i plan wdrożenia etapowego/rollbacku. Nie wdrażano produkcyjnie.
