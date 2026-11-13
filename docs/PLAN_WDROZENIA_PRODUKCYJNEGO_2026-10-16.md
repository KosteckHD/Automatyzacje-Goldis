# Plan implementacji i odbioru wersji produkcyjnej Goldis

Data: 16 października 2026. Status: plan do wykonania; dokument nie potwierdza gotowości produkcyjnej.

Punkt odniesienia: gałąź `codex/backend-feature-modules`, bazowy HEAD `af512e9502218d336b4b73df0c5f612905c6ac7b` i niezacommitowane zmiany opisane w [checkpointcie](backend-refactor/execution-checkpoint-2026-10-16.md). Przed realizacją trzeba odczytać aktualny stan Git; liczby poniżej są ostatnim zapisanym wynikiem, a nie nowym przebiegiem testów wykonanym przy pisaniu planu.

Dokument rozszerza [plan domknięcia refaktoryzacji D0–D7](PLAN_DOMKNIECIA_REFAKTORYZACJI_BACKENDU_2026-10-16.md) o zadania integracyjne, operacyjne i wydanie. Procedurę zmiany wersji określa [RELEASE_AND_ROLLBACK.md](RELEASE_AND_ROLLBACK.md), a technikę kopii [deploy/backup/README.md](../deploy/backup/README.md).

## 1. Zakres i definicje zakończenia

Obowiązuje podział z [planu modułowego, rewizja 2](PLAN_DOMKNIECIA_PLATFORMY_AUTOMATYZACJI_2026_10_07.md): agent implementuje oraz osobno testuje moduły na syntetycznych danych. Pełny proces biznesowy, portale live i odbiór ich rzeczywistego działania pozostają pod kontrolą użytkownika. Ten plan nie zleca wdrożenia na używaną instalację, aktywacji dostawców live ani wykonania operacji na danych klientów.

Nie dodawać automatycznego wspólnego przebiegu całej platformy ani nie uruchamiać `test:automation-e2e` / `test:platform-e2e` w ramach listy domyślnej lub CI tego planu. Zachować wcześniejsze harnessy i wyniki jako historię. Z modułów tych harnessów można wydzielić odrębne testy zachowania, z własnym seedem i końcem na kontrakcie modułu. W razie sprzeczności z automatycznym pełnym E2E w D6 starszego planu obowiązuje powyższa granica.

Trzy wyniki mają osobne warunki:

| Wynik | Warunek |
| --- | --- |
| `KOD_GOTOWY` | Zakończone PROD-00–07; brak przejściowych wyjątków architektury, zachowane kontrakty i zaliczone testy zmienionych operacji |
| `DO_ODBIORU_UZYTKOWNIKA` | Dodatkowo zakończone PROD-08–12: działający izolowany stos, testy modułów, bezpieczeństwo, odtwarzanie, pomiary i odtwarzalna paczka |
| `PRODUKCJA_ODEBRANA` | Użytkownik/operator wykonał PROD-13–14 dla wskazanego SHA, zestawu obrazów i konkretnej instalacji; otwarte blokery nie zostały zastąpione deklaracją |

Samo `npm test`, poprawny build, konfiguracja Compose albo health 200 nie spełniają wszystkich trzech warunków. Nie każda zmiana architektury jest błędem produkcyjnym, ale pełny uzgodniony zakres refaktoryzacji wymaga domknięcia PROD-00–07. Ewentualne ograniczenie zakresu wydania wymaga jawnej decyzji użytkownika i listy pozostałego ryzyka.

## 2. Stan wejściowy i kolejność

Ostatni zapisany `npm test`: core 18/18, API 376/376, worker 115 PASS / 70 SKIP. Reports ma nowe repozytoria, Review ma repozytorium odczytów, a PrivilegedActions jest rozdzielone na controller, DTO, service i repository. Nie implementować tego ponownie. Pozostają testy rzeczywistej bazy oraz prace wskazane niżej.

Kontrola architektury: 20 wyjątków warstwowych, 129 zgłoszeń, 90 wyjątków publicznych eksportów i 19 kierunków zależności. To różne miary; nie sumować ich jako liczby usterek. Ostatnia próba Reports DB była zablokowana przez brak połączenia z Docker Engine. Nie zakładać, że stan środowiska nadal jest taki sam bez sprawdzenia.

| Pakiet | Zakres | Zależność | Powiązanie z D0–D7 |
| --- | --- | --- | --- |
| PROD-00 | Rejestr braków i dowodów | start | D0 |
| PROD-01 | Izolowany harness PostgreSQL/Redis i nowe tryby testów | 00 | D0–D2, D6 |
| PROD-02 | Odbiór repozytoriów Reports i kontraktu transakcji | 00–01 | D1–D2 |
| PROD-03 | Persistence Grouping i zapisów Review | 01–02 | D3 |
| PROD-04 | Rozdzielenie Leads | 01–03 | D3 |
| PROD-05 | Admission, dispatch, outbox | 01–04 | D4 |
| PROD-06 | Finalizacja eksportu oraz testy PrivilegedActions | 01, 05 | D4 |
| PROD-07 | Usunięcie fasady DB i wyjątków architektury | 02–06 | D0, D5 |
| PROD-08 | Odbiór HTTP/DB/UI i fixture osobnych modułów | testy po każdym pakiecie; finał po 07 | D6 |
| PROD-09 | Izolowany stos produkcyjny i konfiguracja | 01, finał po 07 | D5–D6 |
| PROD-10 | Backup, restore i rollback aplikacji | 09 | D6 |
| PROD-11 | Pomiary, bezpieczeństwo, monitoring | przygotowanie od 00; finał po 07 i 09 | D6 |
| PROD-12 | CI i paczka wydania | 08–11 | D7 |
| PROD-13 | Odbiór portali przez użytkownika | 12 i dostęp użytkownika | osobny odbiór |
| PROD-14 | Wdrożenie i odbiór instalacji | 12–13 | osobna operacja operatora |

Niedostępny Docker nie zatrzymuje inwentaryzacji, implementacji i testów bez DB. Zmiana persistence bez odbioru DB pozostaje jednak nieodebrana; po uruchomieniu środowiska sprawdzić ją przed oznaczeniem pakietu jako zamkniętego. Nie uznawać czasu oczekiwania ani testu z atrapą za zastępstwo wyniku integracyjnego.

## 3. Zasady dla każdego pakietu

1. Odczytać aktualny kod, instrukcje repo i istniejące testy; ustalić konkretną lukę, bez opierania decyzji na starych checkboxach.
2. Zdefiniować wejście, wynik, błędy HTTP/domeny, tenant/aktora, mutowane dane, transakcję, blokady, CAS, retry i skutki zewnętrzne.
3. Dla utrwalania danych dodać lub rozszerzyć test zachowania, który wykryje utratę transakcji, uprawnień lub idempotencji. Nie powielać testów wyłącznie dla sprawdzania nazwy delegowanej metody.
4. Wprowadzić spójną ekstrakcję. Nie zmieniać przy okazji produktu, schematu ani protokołu kolejek. Nowa funkcjonalność lub konieczna migracja otrzymuje osobny opis i odbiór.
5. Zachować tę samą transakcję dla danych, audytu i outboxu. Rodzicielska transakcja lub jawny savepoint na tym samym połączeniu nie może stać się niezależną transakcją. Zachować kolejność blokad rozpoznaną dla danej operacji; nie narzucać nowej globalnej kolejności bez testów współbieżności.
6. Repozytorium zawiera SQL/ORM i mapowanie danych. Service zachowuje decyzje biznesowe. Samo przeniesienie całego use case do klasy nazwanej `Repository` nie kończy podziału. Publiczny kontrakt zwraca projekcję/typ wyniku lub port operacji; nie eksportuje całego dostępu do tabel.
7. Uruchomić testy dotkniętego modułu i potrzebne kontrole wspólne; naprawić regresje. Po dodaniu źródła/testu odświeżyć manifesty.
8. Zmniejszyć właściwe wyjątki architektury; nie zwiększać limitu, aby ukryć nową zależność. Ustalić właściciela ostrzeżeń w zmienianym kodzie.
9. Zapisać wynik wraz z SHA i identyfikatorem drzewa/snapshotu, środowiskiem, poleceniem i dowodem. Wynik brudnego drzewa nie może być przypisany wyłącznie bazowemu HEAD.

Wspólny zestaw po zmianie architektury/transakcji:

```powershell
npm run test:architecture
npm run test:transaction-audit
npm run test:http-contract
npm run check:backend:style
npm run test:module:runner
```

Po dodaniu/usunięciu/relokacji plików lub scenariuszy:

```powershell
npm run backend:refactor:inventory
npm run backend:refactor:scenarios
npm run backend:refactor:import-effects
npm run test:inventory
npm run test:scenarios
```

Zmiany w diagramach/Markdown nie wymagają ponownego pełnego testowania aplikacji. Po zmianie kontraktu publicznego, wspólnej bazy, lifecycle lub wykryciu regresji rozszerzyć zakres testów o konsumentów.

## PROD-00 — Ustalić kompletną listę pracy i dowodów

**Pliki wejściowe:** checkpoint, `docs/backend-refactor/inventory.json`, `route-contract-review.json`, trzy pliki `scripts/backend-*-exceptions.json`, `scripts/check-feature-boundaries.cjs`, `scripts/backend-refactor-transaction-audit.cjs`.

1. Zapisać HEAD, branch, `git status` oraz wersje Node/npm/Docker/Compose; wskazać pliki z poprzedniej serii zmian i zachować je. Zweryfikować bieżącą najwyższą migrację, zamiast zakładać 062 na zawsze.
2. Zinwentaryzować produkcyjny dostęp do DB w API, workerze, enrichment, parserze, migratorze, bootstrapie i helperach: statyczne/dynamiczne importy, SQL, ORM, globalne proxy oraz pośrednie re-eksporty.
3. Dla każdego miejsca zapisać: `file`, operację/zakres linii, właściciela feature, odczytywane/zapisywane tabele, zakres tenanta, granicę transakcji, blokady, docelowy adapter i test zachowania. Wywołania o tej samej nazwie niebędące ORM oznaczyć z uzasadnieniem.
4. Rozszerzyć istniejący generator albo dodać `scripts/backend-persistence-inventory.cjs` z testami rozpoznawania importów i call sites. To nazwa projektowanego pliku, nie istniejąca komenda. Wynik: `docs/production-readiness/persistence-inventory.json`.
5. Utworzyć `docs/production-readiness/verification-matrix.json` z wierszami dla pakietu/scenariusza oraz `PASS`, `FAIL`, `SKIP`, `BLOCKED`, `NOT_RUN`. Pola: command, commit/snapshot, środowisko, czas, expected, actual, evidence, owner, blocker. Brak wykonanego testu zaczyna się od `NOT_RUN`.
6. Utworzyć rejestr wszystkich domyślnych SKIP w `skip-register.json`: stabilny scenariusz, przyczyna, dedykowany moduł, ostatni wynik na wersji odbiorowej. Liczba 70 jest stanem wejściowym i może się zmienić.
7. Utworzyć `deployment-decisions.md` z brakującymi decyzjami: docelowy host/origin, operator, dopuszczalne obciążenie, RPO/RTO, cel kopii i retencja, kanał alertów, provider rejestru i zakres aktywacji portali. Ustalić je przed etapem, który ich wymaga; sekretów nie zbierać do dokumentu.
8. Sprawdzić dostępność poprzednich obrazów i ich digestów, pełnego źródła/config, historycznego schematu/danych i pomiarów. Brak pakietu pozostawia zgodność historyczną niepotwierdzoną. Commit `e3a507e` ani czysta nowa baza nie są pełnym dowodem poprzedniej instalacji.

**Odbiór:** każde miejsce persistence ma właściciela i decyzję, każdy wymagany test ma przypisanie, brakujące dane mają jawny wpływ. Rejestry nie zawierają sekretów ani danych klientów.

## PROD-01 — Przywrócić izolowane testy i uzupełnić brakujące tryby DB

**Pliki:** `scripts/test-module.cjs`, `scripts/test-module.test.cjs`, `scripts/Test-GoldisDatabase.ps1`, `scripts/Test-GoldisSecurityRedis.ps1`, `apps/api/scripts/run-db-integration.cjs`, `migration-smoke.cjs` i istniejące `*-db-smoke.cjs`.

1. Sprawdzić `docker info` i `docker compose version`; ustalić dostępny silnik. Nie naprawiać niedostępności przez skierowanie testów na używaną bazę lub Redis.
2. Zweryfikować własność zasobów harnessu: losowy projekt/kontener, etykieta właściciela, dynamiczny port loopback, syntetyczne hasła, osobna baza i katalogi, flagi live/full-flow wyłączone.
3. Przejrzeć dispatch runnera przed wykonaniem. `review`, `leads`, `runs` i `results` to obecnie głównie zestawy bez DB; sama nazwa modułu nie dowodzi odbioru zapisu.
4. Wykorzystać istniejący `business-leads-db-smoke.cjs`, `worker-result-smoke.cjs`, `run-control-db-smoke.cjs`, `team-db-smoke.cjs` i `admin-users-db-smoke.cjs`. Wyodrębnić brakujące scenariusze bez uruchamiania następnego modułu procesu.
5. Dodać jawne tryby `review-write`, `leads-write`, `privileged-actions-db`, `run-dispatch-db`, `export-finalization-db`, jeżeli istniejący tryb nie daje właściwej izolacji. **Są to nazwy projektowane.** Przed użyciem dodać je do manifestu, PowerShell `ValidateSet`, dispatchu DB, izolacji środowiska, testów runnera i ewentualnych npm scripts.
6. Testować cleanup po sukcesie, błędzie i przerwaniu. Sprzątać wyłącznie zasoby własnego uruchomienia; potwierdzić pozostawienie obcego zasobu bez zmian.
7. Rozwiązać przenośność harnessów przed dodaniem ich do CI. Obecny `security-redis` ma ograniczenie Windows; nie wpisywać go bez zmian do joba Ubuntu. Przystosować wrapper do używanego środowiska i sprawdzić testy izolacji.
8. Uruchomić najpierw `test:module:runner`, następnie `test:module:migrations`, `test:module:runtime-roles`, `test:module:app-module` i `test:module:security-redis` w obsługiwanym środowisku.

**Odbiór:** testy używają własnych PostgreSQL/Redis, nie łączą się z portalami, zwracają poprawny exit code i sprzątają własne zasoby. Niedostępny silnik daje `BLOCKED`, a nie PASS/SKIP bez przyczyny.

## PROD-02 — Odebrać Reports i ustalić wzorzec repozytoriów

**Pliki:** `features/reports/*repository.ts`, `reports.module.ts`, `history.spec.ts`, `audit-search.http.spec.ts`, `apps/api/scripts/admin-reports-db-smoke.cjs`, `infrastructure/database/database.factory.ts`, `docs/backend-refactor/report-projection-contracts.md`. Ścieżki `features/...` w tej części odnoszą się do `apps/api/src/`.

1. Zweryfikować, że rzeczywisty `ReportsModule` otrzymuje `API_DATABASE`; test nie może podmieniać całego service w scenariuszu, który ma potwierdzać repozytorium.
2. Zachować istniejące repozytoria history/dashboard/contact/admin-reports. Ustalić kontrakt: połączenie z DI, typowane wyniki, parametry SQL, jawny tenant i opcjonalny kontekst transakcji tam, gdzie odczyt jest częścią operacji.
3. Rozszerzyć DB smoke o dwa tenanty, własne/cudze przydziały, cofnięty grant, tombstone/import w kasowaniu, pusty wynik, granice dat oraz kursor przy jednakowym czasie rekordów.
4. Przejść rzeczywistą ścieżkę controller → service → repository → PostgreSQL przynajmniej dla sukcesu i odmowy każdego zmienionego rodzaju raportu. Sprawdzić kształt, kolejność, liczniki i redakcję danych.
5. Dodać test kontraktu transakcyjnego wykrywający zapytanie/audyt wykonane poza przekazaną transakcją. Udokumentować wzorzec do następnych ekstrakcji.
6. Uruchomić `test:module:reports`, `test:module:audit-reports` i wspólne kontrole.

**Odbiór:** nie ma SQL w serwisach Reports, a rzeczywista baza potwierdza zakres danych i działanie DI. Wyniki z atrapami pozostają osobnymi dowodami.

## PROD-03 — Wydzielić persistence Grouping i zapisów Review

**Pliki:** `features/grouping/grouping.service.ts`, `entity-grouping.ts`, `grouping.module.ts`, `features/review/review.service.ts`, `review.repository.ts`, `review.module.ts`, `review.dto.ts` oraz `contracts/deletion-barrier.ts`.

1. Opisać aktualny porządek blokad batch/row/conflict/entity/link, ponowienie po unique conflict oraz zachowanie przy transakcji rodzica. Utrwalić ten kontrakt w testach przed ekstrakcją.
2. Dodać prywatny `grouping.repository.ts`: wyszukanie powiązanych wierszy, blokowane odczyty encji i linków, tworzenie konfliktu/encji/linku, zapis wersji oraz odczyt pochodzenia registry. Zachować warunki tenanta i deterministyczną kolejność kandydatów.
3. Pozostawić `assessEntityGrouping` jako czystą decyzję; service koordynuje wynik i transakcję przez repozytorium. Nie ujawniać modeli grouping w publicznym API funkcji.
4. Rozszerzyć istniejący `ReviewRepository` o persistence decyzji korekty i konfliktu albo dodać prywatne repozytorium zapisów. Odczyty list są już wydzielone.
5. Przenieść SQL i ORM z `decideCorrection`, `resolveConflict`, `assertGrant`, `assertNoRuns`, `updateSoleLinkedEntity`. Zachować brak możliwości decyzji po utworzeniu runu, expectedRowVersion, reguły REGON/NIP, grupowanie oraz audyt w tej samej transakcji.
6. Zdefiniować port współpracy Review → Grouping z projekcjami wejścia/wyniku zamiast publicznego modelu `SourceRow`. Zmienić wszystkich konsumentów razem z testami.
7. W DB sprawdzić: dwie decyzje z tą samą wersją, równoległe grupowanie tej samej firmy, zgodny identyfikator w różnych tenantach, cofnięty grant, istniejący run, konflikt unikalności, awarię audytu i wycofanie wszystkich zapisów.
8. Zweryfikować barierę kasowania w aktualnej operacji. Jeżeli ujawni się brak zachowania, opisać go jako osobną poprawkę z testem regresji, a nie ukrytą część relokacji.
9. Uruchomić `test:module:grouping`, `test:module:review`, `test:module:tenant-scope` i nowy dedykowany tryb zapisów Review po jego rejestracji. Usunąć wyjątki dla obu service tylko po usunięciu rzeczywistych zależności.

**Odbiór:** service nie wykonuje SQL/ORM; stara rewizja nie nadpisuje decyzji, równoległe wykonanie nie tworzy sprzecznych linków, a błąd audytu wycofuje całą operację.

## PROD-04 — Rozdzielić Leads według operacji

**Pliki:** `features/leads/business-leads.service.ts`, `leads.module.ts`, `lead-import-deletion.ts`, `features/results/lead-result-snapshots.ts`, `apps/api/scripts/business-leads-db-smoke.cjs`.

1. Zapisać kontrakty metod `list/get/recipients/allocationSummary`, `allocate/releaseAssignment`, `updateContactStatus`, `attachSubmissionGroups/completeResultSet`, `exportWorkbook/downloadSnapshot`.
2. Wprowadzić prywatne repozytoria odczytów, alokacji oraz zapisów wyników/kontaktu. Nazwy mogą odpowiadać operacjom, np. `business-leads-read.repository.ts`, `lead-allocation.repository.ts`, `lead-results.repository.ts`; nie tworzyć osobnej klasy dla każdego pojedynczego zapytania.
3. Najpierw przenieść odczyty z niezmienionymi filtrami, scope, kursorami i mapowaniem. Oddzielić przygotowanie danych eksportu od budowania XLSX.
4. Następnie przenieść alokację: advisory lock, weryfikację odbiorcy, idempotency key/hash, selekcję kandydatów, atomowy zapis właściciela/wersji oraz audit. Zachować istniejące sortowanie i sposób blokowania kandydatów.
5. Wydzielić zwolnienie przydziału i kontakt status; zachować niezależne wersje przydziału/statusu i odmowę przy cudzym właścicielu lub starej wersji.
6. Wydzielić attach/completion wyników z linkami do wszystkich source rows/chunków, snapshotami i Notifications. Zachować pojedynczy efekt powiadomienia przy retry terminalnego wyniku.
7. Sprawdzić wykluczenie tombstone przed liczeniem dostępności, przydziałem, późnym zapisem i eksportem. Projekcje przekrojowe muszą mieć nazwany zakres tabel i uprawnień.
8. Rozszerzyć DB smoke o dwóch alokujących managerów, ten sam i inny klucz idempotencji, niewystarczającą pulę, cofnięte członkostwo, cudzy tenant, stary CAS, równoczesne release/status, rollback audytu i kasowanie importu.
9. W osobnym teście eksportu sprawdzić daty, polisy, zero wyników, formuły w komórkach, uprawnienie do snapshotu i brak ujawniania pól chronionych. Bez uruchamiania portali.
10. Uruchomić `test:module:leads`, `test:module:results`, `test:module:reports`, `test:module:tenant-scope` i dedykowany tryb DB leadów. Obecne dwa pliki w zestawie `leads` nie wystarczają do odbioru zapisów.

**Odbiór:** jeden lead ma co najwyżej jednego aktywnego właściciela; retry nie mnoży alokacji, linków i powiadomień; CAS i rollback działają na PostgreSQL; service jest wolny od persistence.

## PROD-05 — Domknąć admission i dispatch runów

**Pliki:** `features/runs/run-admission.service.ts`, `run-dispatch.service.ts`, istniejące repozytoria cancellation/control/recovery/resume, `features/submissions/*repository.ts` i `apps/worker/src/application/`.

1. Dodać repozytorium admission i przenieść odczyty sesji/membership/grantów, blokady źródła/encji, kontrolę limitu, tworzenie runu i outboxu. Service zachowuje reguły kwalifikacji i mapowanie odmów.
2. Zapewnić jeden kontekst transakcji dla runu, snapshotu wejścia, audytu i outboxu. Retry tego samego żądania nie tworzy nowego runu.
3. Dodać repozytorium outboxu do `ensureDispatch`, `publishOutbox`, `recoverPublishedOutbox`; transport BullMQ pozostawić w adapterze kolejki, z jawnie zarządzanym lifecycle.
4. Zachować payload `runId`, dotychczasowe intent/revision/fence i stabilny sposób identyfikowania jobów. Publikacja odbywa się po trwałym zapisie DB.
5. Obsłużyć jawnie okno awarii między publikacją do Redis a potwierdzeniem DB. Dopuszczalna powtórna dostawa nie może powtórzyć skutku biznesowego; nie deklarować atomowości PostgreSQL–Redis ani gwarancji exactly-once.
6. Dodać testy z restartem: rollback przed commitem, brak Redis po commicie, sukces kolejki bez ACK DB, restart publishera, dwa publisher procesy, stara rewizja, cancel/pause w trakcie oraz ponowne przejęcie po lease.
7. Użyć kontrolowanego odbiornika kolejki, który odczyta i potwierdzi kontrakt bez uruchamiania procesora portalowego. Sprawdzić stan DB/outbox, liczbę skutków i poprawne zakończenie zasobów.
8. Uruchomić `test:module:runs`, `test:module:run-control`, `test:module:submission`, `test:module:worker-lifecycle`, `test:module:security-redis` i nowy dedykowany tryb outbox DB/Redis.

**Odbiór:** nie ma runu bez wymaganego outboxu; rollback nie publikuje zadania, a powtórna dostawa nie omija revision/fence ani nie tworzy drugiej operacji.

## PROD-06 — Finalizacja pliku oraz integracyjny odbiór PrivilegedActions

**Pliki:** `features/results/export-finalization.service.ts`, `artifact-store.ts`, `artifact-download.repository.ts`, `run-export.ts`, `features/privileged-actions/*`, `features/admin/admin-users.service.ts`, `features/teams/team.service.ts`, `features/account-recovery/account-recovery.service.ts`.

1. W ExportFinalization wydzielić prywatne repozytorium run/artifact/event i wykorzystać istniejący adapter `artifact-store`; zachować publiczny kontrakt finalizatora i kody błędów.
2. Utrwalić protokół: weryfikacja stanu i fence → przygotowanie XLSX → trwała publikacja pliku → zapis metadanych/terminalnego runu. Nie zmieniać czasu trzymania blokady ani granic transakcji w tej samej ekstrakcji bez osobnego testu.
3. Rozdzielić rollback DB od skutku publikacji pliku. Zdefiniować rozpoznawanie osieroconego pliku, retry i bezpieczne sprzątanie; nie zakładać, że rollback PostgreSQL usuwa opublikowane bajty.
4. Wstrzyknąć awarie: zapis/rename, `afterFilePublished`, insert metadanych, commit i restart. Sprawdzić brak `completed` bez gotowego artefaktu, spójność SHA/liczby polis i niezmienny wynik retry. Sprawdzić stale worker i deletion barrier.
5. PrivilegedActions jest już rozdzielone; uzupełnić odbiór na prawdziwym PostgreSQL: dwie równoczesne próby użycia, replay zgodnego klucza, zmieniony payload/aktor/tenant/sesja, wygaśnięcie, revocation i zmiana credential revision podczas potwierdzania.
6. W scenariuszu awarii mutacji/audytu potwierdzić rollback zarówno zmiany biznesowej, jak i zużycia potwierdzenia. Sam zapis odpowiedzi replay musi należeć do tej samej transakcji.
7. Sprawdzić ścieżkę controller → service → repository dla 429/Retry-After oraz Origin/CSRF; repozytorium nie może wymuszać nagłówków HTTP.
8. Uruchomić `test:module:results`, `test:module:security`, `test:module:admin`, `test:module:teams-db`, `test:module:admin-users-db`, właściwe testy deletion i nowe dedykowane tryby DB z PROD-01.

**Odbiór:** finalizator zachowuje spójność DB–plik także po przerwaniu, a potwierdzenie uprzywilejowane nie daje drugiego skutku ani możliwości użycia po zmianie kontekstu.

## PROD-07 — Usunąć globalną fasadę i zakończyć granice architektury

**Pliki:** `infrastructure/database/db.ts`, `database.factory.ts`, `database.module.ts`, `model-registry.ts`, `composition/persistence-models.ts`, `composition/module.ts`, publiczne `index.ts/public.ts` funkcji, entrypointy API/workera/enrichment/parsera/migratora i trzy listy wyjątków.

1. Rozliczyć wszystkie pozycje PROD-00, również Health, Imports, Preparations, Submissions, enrichment i helpery. Oddzielić prawdziwe SQL/ORM od delegacji i importów typów.
2. Przejść na połączenia z jawnych providerów Nest albo fabryk procesów pomocniczych. Zachować role DB i oczekiwane współdzielenie połączenia; nie tworzyć puli na każdą operację/repozytorium.
3. Composition składa lokalne modele i przekazuje rejestrację/fabrykę do infrastruktury. Infrastructure nie importuje composition ani biznesowych modeli przez zbiorczą baryłkę.
4. Usunąć proxy `sequelize` i zbiorcze eksporty modeli z użycia biznesowego. `db.ts` usunąć albo pozostawić jako wąski adapter techniczny bez globalnych proxy, modeli biznesowych i zależności wstecznych.
5. Zmienić konsumentów, testy i narzędzia; zachować kontrakt historycznych migracji. Nie zmieniać numerów ani semantyki migracji przy technicznej zmianie importu.
6. Usunąć eksporty kontrolerów, modeli i prywatnych repozytoriów z publicznych interfejsów. Współdzielony port nie może stać się nową fasadą wszystkich tabel.
7. Rozszerzyć skaner o rzeczywiste aliasy/re-eksporty i cykle obejmujące infrastructure/composition; zakazać obejść API–worker–core. Ustalić jawne reguły dla migracji i testów.
8. Doprowadzić wszystkie trzy listy przejściowych wyjątków do zera. Poprawić ostrzeżenia w zmienianym kodzie; pozostałe sklasyfikować z właścicielem, bez globalnego wyciszania.
9. Uruchomić `test:module:database`, `runtime`, `runtime-roles`, `app-module`, `worker-lifecycle`, migracje/upgrade oraz pełne `npm test` i `npm run build`.
10. Na izolowanym stosie sprawdzić start/stop wszystkich procesów, jednokrotną rejestrację modeli i brak otwartych socketów/puli po zamknięciu. Porównać katalog schematu z punktem wejściowym 48 modeli/48 relacji i aktualnymi migracjami.

**Odbiór:** zero produkcyjnych zależności biznesu od starej fasady, zero przejściowych wyjątków i cykli, zgodny lifecycle oraz jawne role rzeczywistych połączeń.

## PROD-08 — Uzupełnić macierz zachowania osobnych modułów

1. Odświeżyć listę tras z kodu; punkt wejściowy to 130 tras. Dla każdej przypisać test sukcesu, walidacji, roli, tenanta, grantu/owner oraz status/body/cookies/nagłówków. `N/A` wymaga przyczyny; przegląd źródła nie jest testem zachowania.
2. Uzupełnić realne HTTP/DB tam, gdzie sukces jest obecnie pokryty wyłącznie atrapą service. Priorytet: mutacje Admin/Teams/Review/Leads, admission/outbox, raporty i kasowanie.
3. Wykorzystać macierz 21 akcji/5 ról; sprawdzić realne egzekwowanie w produkcyjnych guardach i zapytaniach, a nie wyłącznie czystą funkcję polityki.
4. Osobno odebrać UI importów, review, leadów, SMS/interwencji, raportów, admina, zespołu i historii. Korzystać z istniejących `apps/web/scripts/*-ui-smoke.cjs`; przed zmianą UI przeczytać `apps/web/AGENTS.md` i wskazaną dokumentację Next.
5. Dla UI sprawdzić role, pusty wynik, 409/503, brak uprawnień, F5, opóźnioną odpowiedź i szerokości 320/768/1920. Test jednego modułu nie uruchamia całej ścieżki platformy.
6. Uruchomić `npm run test:e2e:fixture`: security-browser, Everest, Compensa i UFG jako odrębne moduły z tymczasowymi profilami i lokalnymi fixture. Sprawdzić, że flagi nie mogą otworzyć portali live.
7. Rozliczyć każdy SKIP w rejestrze. Wymagany scenariusz musi mieć PASS dedykowanego przebiegu na wersji odbiorowej albo pozostać blokadą; historyczny fixture PASS nie zamyka nowej zmiany.
8. Odświeżyć manifest scenariuszy runtime po bieżącym buildzie przez `backend:refactor:runtime-scenarios`, następnie `test:scenario-runtime`. Nie utożsamiać liczby deklaracji z liczbą wykonanych przypadków.

**Odbiór:** wszystkie wymagane scenariusze modułów mają dowody, brak krytycznego FAIL i niewyjaśnionego wymaganego SKIP. Pełny proces pozostaje `DO_ODBIORU_UZYTKOWNIKA` do PROD-13.

## PROD-09 — Przygotować i odebrać izolowany stos produkcyjny

**Pliki:** `compose.yaml`, `compose.production.yaml`, `.env.production.example`, `deploy/secrets/README.md`, `deploy/nginx/goldis.conf.example`, `deploy/docker/`, runtime config i role DB.

1. Ustalić host docelowy, domenę HTTPS, operatora i profil wdrożenia w `deployment-decisions.md`. Przygotowanie izolowanego stagingu może odbyć się wcześniej; docelowe adresy nie mogą być zgadywane.
2. Zbudować z kompletnego snapshotu/commita zgodny zestaw API, worker i web oraz użyć zweryfikowanych obrazów PostgreSQL/Redis. Zanotować rzeczywiste digesty; nie wpisywać demonstracyjnych wartości `sha256` jako wyniku.
3. Utworzyć oddzielny projekt Compose z syntetycznymi sekretami i wolumenami. Start produkcyjnego stacku w tym pakiecie oznacza staging; używana instalacja jest obsługiwana dopiero w PROD-14.
4. Zweryfikować sekrety plikowe, prawa katalogów/profili/backupów, szyfrowanie PESEL/artefaktów/poczty i rotation/readability. Brak klucza ma blokować operację zamiast przełączać na tekst jawny.
5. Sprawdzić TLS/redirecty/cookies, zaufane proxy, prywatne porty DB/Redis/parsera/receivera, Redis ACL oraz rzeczywiste `current_user` API, workera, enrichment i migratora. Sprawdzić również odmowy zapisu poza grantem.
6. Uruchomić `npm run validate:production-compose -- --env <prywatny-plik-env>` i `npm run test:production-compose`. Ten drugi test bada konfigurację Compose; osobno wykonać rzeczywisty start wszystkich usług.
7. Po startach migracji/grantów sprawdzić liveness/readiness i `scripts/runtime-check.cjs` z jawnym `GOLDIS_RUNTIME_BASE_URL` stagingu. Domyślny adres skryptu jest przykładowy; nie używać go jako celu testu. Provider i oczekiwany tryb live muszą wynikać z konfiguracji.
8. Sprawdzić shutdown/restart parsera, enrichment, API i workera, brak niepotrzebnych połączeń przed pracą oraz odporność health na awarię DB/Redis/journala. Portal mode pozostaje `off`.
9. Poprawić lukę `runtime-check`: obecnie akceptuje oczekiwanego providera `mf-vat` lub `disabled`. Jeżeli wydanie wybiera GUS BIR, dodać obsługę i test kontraktu przed użyciem; nie maskować BIR przez wybór MF w checkerze.

**Odbiór:** rzeczywisty staging jest zdrowy, role i ACL są potwierdzone, awaria zależności odbiera readiness, a start/stop nie pozostawia zasobów. Poprawny YAML sam nie zalicza pakietu.

## PROD-10 — Zapewnić odtwarzanie i rollback całej aplikacji

1. Ustalić liczbowo RPO/RTO, częstotliwość/retencję, oddzielny cel kopii i sposób odzyskania klucza. Bez tych decyzji nie ma kryterium akceptacji backupu.
2. Wykorzystać `deploy/backup/backup.sh`, `verify.sh`, `restore.sh`; sprawdzić skład pakietu: dump, artefakty, staging/checkpointy, manifest, konfiguracja/sekrety odtworzenia i journal. Pracować na syntetycznym stosie PROD-09.
3. Zaimplementować brakujące wysyłanie obu wymaganych zaszyfrowanych archiwów do wybranego odseparowanego storage, harmonogram, kontrolę wieku/rozmiaru kopii, retry i alert błędu. README potwierdza, że zewnętrzna synchronizacja nie jest obecnie aktywna.
4. Przetestować brak miejsca, przerwanie backupu, zły klucz, zmienione bajty, niepełną wysyłkę i niedostępny storage. Błąd nie może usunąć ostatniej poprawnej kopii ani otworzyć ruchu na niespójnej aplikacji.
5. Wykonać pełny cold restore na drugim izolowanym hoście/projekcie: nowa nazwa `goldis-restore-*`, puste wolumeny, portal-worker off, brak wysyłki maili/ponownego aktywowania linków odzyskiwania.
6. Fixture obejmuje gotowy wynik i XLSX, cudzy przydział leada, oczekującą dostawę oraz kasowanie dokonane po backupie. Odtworzyć z najnowszym journalem i potwierdzić, że skasowany zasób nie wrócił do widoczności/pracy.
7. Zmierzyć wiek odzyskanych danych i pełny czas do readiness/odbioru; porównać z RPO/RTO. `pg_restore --list`, test kryptografii i rollback 061→062 nie zastępują tej próby.
8. Odtworzyć poprzedni zweryfikowany zestaw API/worker/web/core na kompatybilnym schemacie i wykonać modułowe smoke. Brak poprzedniej paczki/digestów pozostawia rollback aplikacji niepotwierdzony.
9. Zaktualizować runbook przywracania, zachowując zakaz nadpisania używanej bazy i automatycznego usuwania kwarantanny. Zakończyć `test:module:backup-restore` i rzeczywistą próbą skryptów Linux w izolacji.

**Odbiór:** kopia poza hostem daje się odtworzyć z journalem w ustalonym czasie, a poprzednia paczka ma potwierdzoną ścieżkę powrotu albo jawny blocker zgodności.

## PROD-11 — Zmierzyć obciążenie, zakończyć bezpieczeństwo i monitoring

1. Przygotować syntetyczne fixture 100, 1000 i 30 000 wierszy, wielu użytkowników/tenantów oraz liczne wyniki/interwencje. Dane i sprzęt są identyczne dla porównywanych wersji.
2. Zmierzyć start, RSS, liczbę połączeń, login/list/detail p50/p95, import/eksport, przepustowość i opóźnienie kolejki oraz istotne zapytania `EXPLAIN ANALYZE`. Użyć rozgrzewki i co najmniej trzech przebiegów, zapisać surowe wyniki i konfigurację.
3. Porównać z odtwarzalnym baseline `af512e9` dla etapu domknięcia. Historyczne źródło całego refaktoru porównywać osobno, tylko jeżeli pełny runtime da się odtworzyć. Proponowany próg wzrostu mediany p95/RSS 10% jest sygnałem do analizy, nie już zaakceptowanym SLA; ustalić też bezwzględne cele produktu.
4. Po pomiarze poprawiać udowodnione wąskie gardła; indeksy, batching i zmianę blokad odbierać osobno. Nie optymalizować przez zmianę filtrów/uprawnień.
5. Dla wersji odbiorowej wykonać aktualne skany zależności produkcyjnych, kodu, sekretów i rzeczywistych obrazów. Skorzystać z narzędzi przyjętych w dotychczasowych audytach, zapisując wersję narzędzia, SHA/digest i datę. Nie przypisywać nowych wyników raportom z 9–15 października.
6. Każde istotne znalezisko: osiągalność, wpływ, poprawka/mitigacja, właściciel i retest. Nierozwiązany krytyczny problem blokuje wydanie; samo exit 0 narzędzia nie dowodzi braku wszystkich zagrożeń.
7. Sprawdzić redakcję logów, nagłówki/cookies, uprawnienia plików env/sekretów, izolację Chromium i prywatne interfejsy usług. Ustalić wymagany zakres MFA/retencji jako decyzję produktu, bez wywodzenia brakującej implementacji ze starych raportów.
8. Podłączyć wykrywanie: offline worker, stary outbox, kolejka bez postępu, interwencje po terminie, awaria journala, brak miejsca, stary/nieudany backup i niedostępność usług. Zdefiniować progi, odbiorcę, deduplikację i wygaszanie alarmu.
9. Alerty testować kontrolowanym odbiornikiem. Włączenie wysyłki do rzeczywistych osób/kanałów wymaga ustalonego przez użytkownika adresata i zlecenia; sam plan nie wysyła wiadomości.

**Odbiór:** cele wydajności są zmierzone, krytyczne znaleziska zamknięte, operator widzi i potrafi obsłużyć testowe awarie oraz nieudaną kopię.

## PROD-12 — Przygotować odtwarzalny release i aktualne CI

**Pliki:** `.github/workflows/backend-checks.yml`, `scripts/create-release-manifest.cjs`, `docs/RELEASE_AND_ROLLBACK.md`, dokumentacja uruchomienia i rejestry dowodów.

1. Dokończyć dokumentację architektury/startu/odtwarzania, zaktualizować statusy D0–D7 i listę znanych ograniczeń. Nie przepisywać historycznych PASS na nowy SHA.
2. Odświeżyć inventory/scenarios/import-effects/runtime scenarios i zweryfikować linki do plików/testów. Zapisać migration head i hash grantów.
3. Przygotować czysty commit zawierający wszystkie potrzebne pliki, również nowe repozytoria, testy i manifesty. Wcześniej przejrzeć diff i upewnić się, że nie zawiera sekretów/danych. Nie resetować cudzych zmian dla uzyskania czystego drzewa.
4. Rozszerzyć obecny workflow o brakujące izolowane moduły DB/Redis, osobne fixture portali, security browser, konfigurację/staging Compose i artefakty wyników. Obecne zadania `backend` i `database-integration` nie dowodzą całej tej macierzy. Uwzględnić przenośność z PROD-01.
5. Uruchomić `npm ci`, `npm run build`, `npm test` i wymagane moduły z czystego checkoutu. Przebieg zdalny musi dotyczyć końcowego SHA; zapisać URL, SHA i wyniki. Full-flow/live nie jest dodawany do CI.
6. Zbudować zgodne obrazy aplikacji z tego samego commita; potwierdzić ich pochodzenie i digesty. Wyznaczyć poprzednią kompatybilną paczkę do rollbacku.
7. Wygenerować manifest poza repo po ustawieniu prawdziwych digestów i niesekretnej konfiguracji:

```sh
npm run release:manifest -- --env /etc/goldis/env.production --output /var/lib/goldis/releases/<wersja>/release-manifest.json
```

8. Pozostawić `pending` dla nieodebranego etapu; do każdej zmiany statusu dołączyć dowód. Manifest ma zawierać wersje/digesty, config checksums, migration/grants, wyniki testów, journal head, backup i operatora.
9. Oznaczyć paczkę `DO_ODBIORU_UZYTKOWNIKA` wraz z listą niepotwierdzonych kwestii historycznych/środowiskowych. Zmiana kodu po końcowym CI wymaga nowego SHA i ponowienia dotkniętych kontroli; zmiana manifestu nie może podmieniać pochodzenia obrazów.

**Odbiór:** niezależny operator potrafi pobrać dokładną paczkę, odtworzyć build/testy i uruchomić staging. Generator nie otrzymuje fikcyjnych digestów ani brudnego drzewa.

## PROD-13 — Przygotować odbiór rzeczywistych portali przez użytkownika

**Wykonawca:** użytkownik/operator. Agent może przygotować instrukcję i bezpieczny formularz wyników; wykonanie live wymaga odrębnego zlecenia i uprawnionej sesji. Ten pakiet jest zależnością produkcji, nie automatycznym testem agenta.

1. Użytkownik wskazuje odebraną paczkę, środowisko, uprawnione konto i jeden zaakceptowany przypadek. Potwierdza komplet zweryfikowanych selektorów; przykładowy JSON nie jest konfiguracją produkcyjną.
2. Sprawdzić rzeczywiste powiązanie firmy/tożsamości w Everest, przejścia formularza Compensy, potwierdzenie jednego zapisu i kompletny odczyt UFG. Dane i SMS nie trafiają do repo ani protokołu technicznego.
3. Użytkownik wykonuje przebieg z panelu do pobranego XLSX i porównuje liczbę/daty polis z portalem; wynik zerowy wymaga potwierdzenia, a nie przyjęcia błędu jako zera.
4. W uzgodnionych warunkach odbiera ponowne użycie sesji, SMS/interwencję i wznowienie po przerwaniu pod tym samym `runId`, bez drugiego zapisu oferty. Prób awaryjnych nie improwizować na klientach.
5. Zapisać wyłącznie bezpieczny protokół: wersja, digesty, operator, zakres, expected/actual i rezultat, bez tożsamości klienta i treści portalu. Niezgodność wraca do właściwego pakietu kodu i jego testu syntetycznego.

**Odbiór:** użytkownik potwierdza konkretny zakres live. Bez niego status pozostaje `DO_ODBIORU_UZYTKOWNIKA`; nie można go wywieść z fixture.

## PROD-14 — Wdrożyć wskazaną paczkę i odebrać instalację

**Wykonawca:** operator na odrębne zlecenie użytkownika, zgodnie z runbookiem wydania. Planowanie nie uruchamia tych działań na używanej instalacji.

1. Potwierdzić zamknięcie wymaganych bramek, zgodną poprzednią paczkę, okno wdrożenia, aktualny backup poza hostem i journal oraz gotowy sposób rollbacku.
2. Wstrzymać nowe przyjęcia, doprowadzić workerów do bezpiecznej granicy i zachować staging/checkpointy. Nie przerywać niepewnego zapisu w portalu jako standardowej metody wdrożenia.
3. Wdrożyć obrazy po digestach; wykonać migracje/granty w przewidzianych rolach. Bootstrap administratora tylko zgodnie z rzeczywistym stanem inicjalizacji, bez odtwarzania kont przy każdym release.
4. Potwierdzić faktyczne SHA/digesty, `current_user` procesów, TLS, readiness, login/logout, odmowy ról i prywatny download. Smoke wykonuje syntetyczny uzgodniony zakres; nie uruchamia samoczynnie nowych zadań klientów.
5. Otworzyć ruch dopiero po spełnieniu kryteriów. Aktywację automatyzacji live wykonać zgodnie z odbiorem PROD-13 i decyzją operatora.
6. Obserwować metryki i alerty przez wcześniej uzgodnione okno; przy kryterium wycofania zastosować procedurę kompatybilnego rollbacku lub restore w nowym projekcie, bez czyszczenia stanu runów.
7. Zapisać protokół i manifest końcowy. Jeżeli instalacja ma działać z portalami off, odnotować dokładnie taki ograniczony zakres; nie oznaczać automatyzacji OC jako odebranej live.

**Odbiór:** `PRODUKCJA_ODEBRANA` odnosi się do konkretnej instalacji i paczki, z aktualnym backupem, dowodami runtime i wskazanym operatorem.

## 4. Zestawy testów i granice ich dowodu

| Obszar | Istniejące wejście | Czego nadal dopilnować |
| --- | --- | --- |
| Ogólne | `npm test`, `npm run build` | Domyślne SKIP mają osobny rejestr; brak automatycznego dowodu DB/live |
| Architektura | `test:architecture`, `test:transaction-audit`, `test:http-contract` | Zero przejściowych wyjątków i realne testy rollbacku poza statyką |
| Raporty | `test:module:reports`, `test:module:audit-reports` | Realny DI/DB, dwaj tenantowie i grant/tombstone |
| Review/Grouping/Leads | `test:module:review`, `test:module:grouping`, `test:module:leads` | Nowe dedykowane tryby zapisów i współbieżności z PROD-01 |
| Runs/Results | `test:module:runs`, `run-control`, `submission`, `results` | Nowe izolowane DB/Redis outbox i DB–plik |
| Bezpieczeństwo | `test:module:security`, `security-db`, `security-redis`, `security-browser`, `teams-db`, `admin-users-db` | Brak dziedziczenia produkcyjnych usług; integracyjny replay/revocation |
| Migracje/lifecycle | `test:module:migrations`, `migrations-upgrade`, `runtime-roles`, `database`, `runtime`, `app-module`, `worker-lifecycle` | Upgrade konkretnej migracji nie zastępuje rollbacku obrazów i historycznych danych |
| Kasowanie/odtwarzanie | `test:module:deletion`, `deletion-step-up`, `deletion-jobs`, `backup-restore` | Cold restore poza hostem oraz journal nowszy od kopii |
| Portale syntetyczne | `test:e2e:fixture` lub osobne `*-browser` | Tymczasowe profile, lokalne fixture, live off; nie pełny proces |
| Compose | `validate:production-compose`, `test:production-compose` | Osobny faktyczny start/shutdown stagingu |

W komórkach z krótszymi nazwami modułów obowiązuje prefiks `npm run test:module:`. Każde wejście sprawdzić w bieżącym `package.json` przed wykonaniem; nowe tryby opisane w planie nie istnieją automatycznie.

## 5. Pierwszy pakiet wykonawczy i warunki stopu

Kolejność rozpoczęcia realizacji:

1. PROD-00: aktualny rejestr persistence, coverage i SKIP, bez ponownego przepisywania już wydzielonych modułów.
2. PROD-01: izolowany Docker/harness i jawne tryby zapisów, bez używania istniejącej bazy jako obejścia.
3. PROD-02: rzeczywisty odbiór repozytoriów Reports i wzorca transakcyjnego.
4. PROD-03: Grouping, następnie zapisy Review, każdy wraz z DB rollback/concurrency.
5. Dalej PROD-04–07 w kolejności tabeli; próby i brakujące decyzje operacyjne przygotowywać równolegle do pracy kodowej, bez uzależniania ich od kosmetycznego porządkowania dokumentacji.

Wydanie zatrzymują: niespójne dane/artefakt, powtórny skutek biznesowy, naruszenie tenanta/uprawnień, niesprawny restore/journal, niezgodny SHA/digest, wymagany test bez dowodu, krytyczny problem bezpieczeństwa lub brak odbioru live przy deklarowaniu aktywnej automatyzacji. Brak historycznego baseline pozostawia osobną niepotwierdzoną bramkę zgodności; nie wolno zamienić jej na PASS na podstawie czystej nowej bazy.

Terminu i procentu gotowości nie wyznacza liczba katalogów ani liczba PASS. Oszacowanie kolejnych pakietów oprzeć na kompletnej inwentaryzacji PROD-00 oraz rzeczywistym koszcie pierwszej ekstrakcji wraz z testami DB i poprawkami.
