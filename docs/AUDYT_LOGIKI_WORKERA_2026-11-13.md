# Audyt logiki workera — 13 listopada 2026

Aktualizacja 17 listopada: wykonano odbiór na jednorazowym PostgreSQL/Redis, w tym rzeczywistą blokadę wykonania, 9 scenariuszy automatyzacji i kontrole ról. Poprawki wdrożono do lokalnych kontenerów; naprawiono również zależności blokujące import pliku. Aktualny stan i pozostały zakres testu rzeczywistych portali: [gotowość do testowania lokalnego](GOTOWOSC_WORKERA_LOKALNIE_2026-11-17.md).

Zakres: produkcyjny procesor zadań, sesje portali i SMS, wybór tożsamości, formularz i zapis Compensy, UFG, checkpointy, dostarczenie wyniku oraz powiązana reguła wznowienia w API. Audyt obejmuje również poprawki wykonane podczas wcześniejszej próby na rekordzie 18001. Nie uruchamiano rzeczywistych portali ani nowych SMS.

Wniosek: przepływ ma spójną konstrukcję i po opisanych poprawkach odpowiada sprawdzonym założeniom. Nie stanowi to pełnego odbioru aktualnej wersji na rzeczywistych portalach. Pozostają osobno test integracji z PostgreSQL/Redis oraz dokończenie rzeczywistego przebiegu po SMS.

## Obowiązujące założenia wyboru tożsamości

Na podstawie doprecyzowania użytkownika w tej rozmowie:

1. Everest wyszukuje `effectiveRegon` zapisany dla zadania.
2. Pierwszeństwo mają wiersze **Osoba fizyczna**. Brak PESEL-u lub konflikt w obecnym wierszu osoby nie powoduje cichego przełączenia na działalność.
3. Gdy takich wierszy nie ma, dopuszczony jest PESEL z wiersza **Osoba fizyczna prowadząca działalność gospodarczą**. Obowiązują te same kontrole poprawności PESEL-u, zgodności danych i niejednoznaczności.
4. Podmiot typu **Firma** ma osobną ścieżkę: zgodny REGON i nazwa; do Compensy trafia REGON, bez tworzenia fikcyjnego PESEL-u. Sam PESEL w wierszu typu Firma nie jest podstawą wyboru osoby.
5. Tożsamość jest wiązana z tym samym `runId` i `sourceRowId`. Compensa ponownie potwierdza identyfikator oraz wymagane dane osoby przed zapisem.

Wcześniejszy dokument uruchomienia zakazywał wykorzystania wiersza działalności. To ograniczenie zostało zastąpione aktualną decyzją użytkownika. Samo użycie działalności jako ścieżki zastępczej nie jest ustaleniem błędu tego audytu.

## Usterki wykryte i poprawione

| Problem | Skutek przed poprawką | Poprawka |
| --- | --- | --- |
| Brak kontroli właściciela wykonania wewnątrz części transakcji | Sprawdzenie przed transakcją nie zamykało okna utraty lease. Spóźniony proces mógł zmienić stan SMS albo zapisać intencję rozpoczęcia/UFG mimo przejęcia zadania przez innego właściciela. Nie wykazano takiego zdarzenia w poprzednim teście live. | Transakcyjna kontrola `execution_id`, `worker_session_id`, terminu lease według zegara DB, stanu końcowego i pauzy pod blokadą rekordu. Produkcyjny procesor przekazuje lease do tworzenia/wygaszania/unieważniania/rozliczania wyzwania oraz bramek Compensy. Utrata uprawnienia przerywa zapis. |
| Brak drogi wznowienia po rozpoznanym błędzie strony PZU przed ofertą | `PORTAL_FAILURE`, `PORTAL_SESSION_EXPIRED` albo `PORTAL_SCHEMA_CHANGED` tworzyły interwencję, której istniejąca reguła API nie pozwalała ponownie sprawdzić. Nawet naprawiony problem strony pozostawiał zadanie zablokowane. Test kontraktu odtworzył tę odmowę. | Jawne ponowne sprawdzenie przez uprawnionego uruchamiającego. Wymaga braku sprawy zewnętrznej, checkpointu akcji, aktywnego przekazania kodu i poprzedniego wykonania. Wznawia świeże wejście do PZU w tym samym zadaniu. |
| Niedziałające wyszukiwanie testów w `test:playwright` | Skrypt szukał wyłącznie głównych plików `.test.js`, podczas gdy testy są obecnie w podkatalogach jako `.spec.js`. | Wspólne rekurencyjne wyszukiwanie testów z repozytorium, z zachowaniem kolejności pojedynczego wykonywania i trybu Playwright. |

Najważniejsze miejsca zmian:

- `apps/worker/src/features/execution/execution-lease.ts`: `assertLockedRunExecution`.
- `apps/worker/src/features/authentication/auth-challenges.ts`: kontrole przed mutacjami wyzwań.
- `apps/worker/src/portals/shared/portal-action-gate.ts`: kontrola przed intencją rozpoczęcia i UFG.
- `apps/worker/src/features/execution/live-run.ts`: przekazanie aktualnego lease do powyższych operacji.
- `apps/api/src/features/review/portal-review-contract.ts`: reguła ponownego sprawdzenia PZU; istniejące blokady usługi `run-resume.service.ts` obowiązują również dla tej ścieżki.
- `apps/worker/scripts/test-playwright.cjs`: poprawione wyszukiwanie testów.
- `apps/worker/src/portals/pzu/everest-identity-provider.ts`: doprecyzowanie typów kont zgodnie z decyzją użytkownika.

## Ocena głównego przepływu

| Założenie | Ocena kodu i testów syntetycznych |
| --- | --- |
| Jeden właściciel przeglądarki i kolejności zadań | Jeden trwały kontekst, blokada profilu, globalna blokada advisory w bazie i kolejka o `concurrency: 1`. Lease chroni konkretne wykonanie zadania. Nie należy uruchamiać niezależnych instalacji na tych samych kontach portalowych bez dodatkowej koordynacji. |
| Kolejność Everest → Compensa Komunikacja → zapis → UFG → wynik | Procesor prowadzi jawne przejścia stanów. Nowe zadanie wchodzi do Compensy przez stronę aplikacji i kafelek Komunikacja, z rolą Ubezpieczający oraz skonfigurowaną rejestracją. Nie korzysta z dawnego obejścia Klient 360. |
| Świeże wyniki Everest | Oczekiwanie na nowy render wyniku wyszukiwania, zamiast zaakceptowania starej tabeli. Osobny wynik pusty i obsługa rozpoznanych nakładek. |
| SMS jest jednokrotnym przekazaniem | API blokuje powtórne przekazanie przez stany `claimed/submitted`. Worker oczekuje na zapis `submitted` przed użyciem kodu. Kod trafia do pamięci procesu, bufor jest zerowany, a wejście w przeglądarce czyszczone. Limit prób nie jest resetowany przy świeżym wejściu. |
| Wygaśnięcie i niepewny wynik SMS | Brak automatycznego ponownego wysyłania tego samego kodu. Przy niepewności zadanie wymaga kontroli; timeout pozwala jawnie zlecić nową próbę. Poprzednie poprawki odświeżają cały dokument PZU zamiast samego starego iframe i rozpoznają stronę 403. |
| Brak ślepego ponowienia utworzenia/zapisu oferty | Intencje zapisywane przed akcjami; wznowienie wymaga zgodności numeru tej samej sprawy. Niepewny zapis jest uzgadniany na podstawie potwierdzenia, a brak wiedzy nie oznacza zezwolenia na kolejny zapis. |
| Brak ślepego ponowienia UFG | Oddzielna intencja UFG; ponowne uruchomienie nie autoryzuje kolejnej akcji, gdy intencja już istnieje. Wynik istniejącej sprawy może być odczytany, jeśli portal go udostępnia. |
| Pełna tabela OC | Porównanie liczby polis z podsumowania i wierszy, kontrola numerów pozycji, konfliktów, nagłówków i dat; przewijanie tabel wirtualizowanych. Niekompletna tabela nie tworzy poprawnego wyniku. |
| Powtarzalny wynik po awarii dostarczenia | Szyfrowany staging i checkpoint `reading_oc`; ponowienie dostarcza zapisany snapshot zamiast ponawiać akcje w portalu. API sprawdza identyfikator wykonania, tożsamość i zgodność zachowanego snapshotu. |
| Filtr eksportu | `policyMatchesDate` wybiera `coverageTo >= referenceDate`, włącznie z dniem granicznym. To jest filtr daty końca z dokumentacji; nie wymaga rozpoczęcia ochrony przed datą odniesienia. Data odniesienia pochodzi z zadania. |
| Wynik zerowy i błędy wiersza | Brak pasujących polis daje jawne `no_matching_policies`; nie powstaje udawany pusty eksport. Rozpoznane braki/komunikaty portalu zatrzymują bieżący wiersz zgodnie z jego klasyfikacją. |

## Weryfikacja

Testy korzystają z fikcyjnych stron oraz danych. Testy przeglądarkowe i wybrane testy API uruchomiono z ograniczonym zestawem zmiennych środowiskowych, bez konfiguracji i poświadczeń rzeczywistych portali.

- Kompilacja workera wraz z core: PASS.
- Kompilacja TypeScript API: PASS.
- Pełny zestaw workera w trybie `PLAYWRIGHT_INTEGRATION=1`, po doprecyzowaniu działalności: **232/232 PASS**, bez pominięć, około 126 s.
- Kontrakt ponownego sprawdzenia i usługa wznowienia API: **18/18 PASS**, bez pominięć.
- Core, w tym daty, PESEL, tożsamość firmy i kontrakty wyników: **22/22 PASS**.
- Kontrola granic modułów oraz jej testy: PASS, **5/5**; kontrola respektuje istniejące wyjątki architektoniczne repozytorium.

Nowe regresje obejmują zapis SMS przez aktualnego i nieaktualnego właściciela, utratę lease między sprawdzeniem wstępnym a transakcją intencji Compensy, wznowienie błędów PZU, dopuszczenie działalności bez osoby fizycznej oraz odrzucenie nieprawidłowego/brakującego PESEL-u, niespójnych danych i wielu różnych osób.

Lokalne logi syntetyczne: `exports/worker-code-audit-20261113/all.log` i `api.log`. Katalog jest ignorowany przez Git. Historyczny `identity-before-fix.log` sprawdzał wcześniejsze, odrzucone przez użytkownika założenie zakazu działalności i nie jest podstawą końcowej oceny tej reguły.

## Granice odbioru

1. W tym audycie nie wykonano testu z rzeczywistym PostgreSQL/Redis. Nowe kontrole transakcyjne mają testy z symulowaną odpowiedzią DB; potrzebują osobnego testu integracyjnego przejęcia lease. Docker był niedostępny podczas próby uruchomienia testów kontenerowych.
2. Ostatnie zmiany tego audytu są w kodzie roboczym i lokalnie skompilowanym `dist`; nie przebudowano ani nie wdrożono dla nich obrazów kontenerów.
3. Syntetyczne strony potwierdzają zachowanie adapterów, ale nie gwarantują zgodności z każdą aktualną odmianą DOM portali, konfiguracją MFA ani komunikatem serwera.
4. Porównanie nazw Everest jest heurystyką normalizowanych słów, a nie formalnym dowodem relacji osoby do firmy. Wymaga reprezentatywnych przypadków odbiorowych. Konflikt danych nadal ma zatrzymywać zadanie.
5. Utrata niezapisanego formularza lub brak potwierdzenia wyniku nieodwracalnej akcji może wymagać operatora. Usunięcie tych barier bez wiarygodnego odczytu stanu portalu groziłoby utworzeniem drugiej sprawy lub ponowną akcją UFG.
6. Poprzedni rzeczywisty test doszedł po poprawkach do nowego SMS, którego użytkownik nie mógł dostarczyć. Nie potwierdzono w nim dalszej ścieżki Everest → Compensa → UFG → eksport. Szczegóły: [diagnoza PZU](DIAGNOZA_PZU_SMS_2026-11-13.md).

Nie znaleziono w sprawdzonym kodzie podstaw do ogólnego wyłączenia zabezpieczeń. Zbyt wąska reguła wznowienia PZU została rozszerzona w konkretnym, odwracalnym etapie przed sprawą zewnętrzną; bariery chroniące zapis/UFG zachowano.
