# Checkpoint realizacji refaktoryzacji backendu

Utworzono: 2026-10-16. Ostatnia aktualizacja: 2026-10-17. Gałąź: `codex/backend-feature-modules`. Bazowy `HEAD`: `af512e9502218d336b4b73df0c5f612905c6ac7b`; opisane niżej zmiany są niezatwierdzone w tym checkpointcie. Pełne `npm test`, `npm run build` i dedykowane testy fixture zakończyły się PASS; 70 testów workera w domyślnym przebiegu ma SKIP i zostało uruchomionych osobno w fixture.

## Wykonane zmiany

- Naprawiono ścieżkę testu audytu w module `audit-reports`; manifest jawnie uruchamia też specyfikacje repozytoriów Reports. Test modułu wykrywa teraz test wskazujący nieistniejące źródło w dowolnym zestawie.
- `history`, `dashboard`, `contact-report` i `admin-reports` otrzymały repozytoria z wstrzykniętym `API_DATABASE`. Serwisy Reports zachowują walidację, autoryzację i mapowanie wyniku. `ReportsModule` eksportuje `HistoryService`, bo ImportController używa go do historii importów; kontrolery Reports nie są publicznie eksportowane.
- Dashboard i history sprawdzają tenant również na krawędziach joinów oraz barier tombstone. Kontrakty projekcji i ich zakres opisuje [report-projection-contracts.md](report-projection-contracts.md).
- Odczyty oraz decyzje korekt i konfliktów w Review obsługuje teraz typowany `ReviewRepository`. Serwis zachowuje reguły decyzji, a repository przejmuje blokady, tenant/grant scope, sprawdzanie istniejących runów, zapisy i odczyt kandydata; mutacja, resolver Grouping i audyt pozostają w tej samej transakcji. Tenant-scope smoke potwierdził approve/reject, rozstrzygnięcia konfliktów i rollback audytu.
- W PrivilegedActions rozdzielono controller, parser DTO, service i repository. Wstrzyknięte repozytorium obsługuje weryfikację sesji, kolejność blokad użytkownik → członkostwo → sesja, pruning/inserty, jednorazowe zużycie i replay w transakcji wywołującego. Z serwisu usunięto dynamiczny import globalnego `db.ts`; testy obejmują payload, fingerprint, klucz idempotencji, credential revision, wygaśnięcie, unieważnioną sesję i kolejność blokad.
- Kontrola architektury skanuje SQL/ORM oraz statyczne i dynamiczne importy globalnej bazy w serwisach/kontrolerach funkcji API, eksporty kontrolerów/modeli/repozytoriów przez publiczne baryłki oraz zależności infrastructure/composition i API/worker/core. Tymczasowe listy zawierają plik, regułę, powód i etap D5. Po ekstrakcji Review obniżono limit jego wywołań persistence z 24 do 21.
- Odświeżono inventory, scenariusze i skan efektów importowania. Sprawdzono listę suite runnera oraz dostępne historyczne artefakty.
- Dodano inwentarz persistence obejmujący 430 plików produkcyjnego TypeScript z API, workera i core. Wszystkie 207 kandydatów ma przypisanego właściciela, ale wymaga ręcznej oceny tenanta, transakcji, blokad i testu; wynik nie jest jeszcze pełnym odbiorem D0.
- Dodano natywny harness PostgreSQL dla Windows: osobny klaster tymczasowy, losowy port loopback i syntetyczne bazy. Reports, tenant-scope, teams, admin-users, deletion oraz grouping-perf przeszły na PostgreSQL 18; w teście historii naprawiono join do `automation_runs`, który odwoływał się do nieistniejącej kolumny `tenant_id`.
- Zaktualizowano smoke fixtures Reports, Teams, AdminUsers, Review i deletion do jawnego DI repozytoriów. Wyniki PostgreSQL dotyczą testowej instancji lokalnej i nie potwierdzają zgodności z docelowym obrazem PostgreSQL 17.
- Uruchomiono `npm run test:e2e:fixture`: security smoke PASS, Everest 27/27 (w tym pełny `pzu-session.spec`), Compensa 39/39 i UFG 14/14 na syntetycznych fixture; `WORKER_LIVE_PORTALS=0`. W trakcie odbioru naprawiono błędną ścieżkę do syntetycznych selectorów PZU i dodano brakujący plik testowy do dedykowanego zestawu Everest.
- Test konfiguracji Compose przeszedł z syntetycznymi sekretami i digestami, ale kontenerów nie uruchomiono, bo Docker Engine jest niedostępny. Nie przeprowadzono wdrożenia.

## Bieżące wyniki

| Kontrola | Wynik |
| --- | --- |
| Pełne `npm test` | PASS; core 18/18, API 376/376, worker 115 PASS / 70 SKIP |
| `npm run build` (core, API, worker, web) | PASS |
| `test:module:audit-reports` | PASS, 9/9 |
| `test:module:review` | PASS, 56/56 |
| `test:module:security` | PASS, 79/79; w tym parser/repo PrivilegedActions, replay i granice sesji |
| `test:module:admin` | PASS, 6/6; `test:module:auth` PASS, 73/73; `test:module:teams` PASS, 4/4 |
| `test:architecture` | PASS, 281 plików funkcji, 0 naruszeń/cykli, 17 wyjątków warstwowych (105 findings), 90 public-export i 19 source-direction wyjątków |
| `test:transaction-audit` | PASS, 326 plików, 96 granic, 0 brakujących transakcji/audytów |
| `test:http-contract` | PASS, 84 wcześniejsze trasy zachowane, 46 dodatków |
| `test:module:runner` | PASS, 22/22 |
| `test:inventory` | PASS, 9/9; generator: 607 plików, 130 tras, 0 nieprzypisanych właścicieli i kolizji |
| `test:scenarios` | PASS, 2/2; manifest: 193 pliki testowe i 630 scenariuszy/patternów |
| import-effects | 363 źródła przeskanowane statycznie, 0 kandydatów |
| `check:backend:style` | PASS, 0 błędów i 47 ostrzeżeń |
| DB smoke: reports, tenant-scope, teams, admin-users, deletion, grouping-perf | PASS na izolowanym natywnym PostgreSQL 18; dane syntetyczne |
| `npm run test:e2e:fixture` | PASS: security smoke, Everest 27/27, Compensa 39/39, UFG 14/14 |
| `npm run test:production-compose` | PASS dla walidacji konfiguracji na fixture; kontenerów nie uruchomiono |
| `npm run build` | PASS, pełny build wszystkich workspace’ów |

## Otwarte bramki

- D0 ma kandydatów z przypisanym właścicielem, lecz 207 wymaga ręcznej oceny semantyki; nie ma historycznego dumpu/kopii danych ani odtwarzalnej paczki aplikacji. Pełnego baseline sprzed przebudowy nie potwierdzono.
- D1 ma działający ratchet i testy, ale nie jest domknięty. Pozostaje 17 wyjątków warstwowych, 90 publicznych eksportów i 19 zależności wstecznych. Test Compose na fixture przeszedł, lecz nie uruchomiono izolowanego stosu z Docker Engine.
- D2: Reports przeszły odbiór smoke na lokalnym PostgreSQL 18. Nie potwierdzono docelowego obrazu PostgreSQL 17 ani pełnej macierzy wszystkich repozytoriów i ról.
- D3 jest w toku: decyzje Review wydzielono i sprawdzono na PostgreSQL; `GroupingService` nadal ma bezpośrednie persistence, a Leads wymaga rozdzielenia odczytów, alokacji i wyników.
- W D4 domknięto PrivilegedActions. RunAdmission, RunDispatch, ExportFinalization i pozostałe miejsca D0 nadal wymagają repozytoriów. Browser fixture przeszły, ale nie zastępują pełnej macierzy UI/HTTP ani odbioru portali live. Redis, uruchomienie Compose, backup/restore, pełne pomiary, aktualne remote CI i zgodność historyczna pozostają niezweryfikowane.

Aktualna macierz dowodów i jawne blokery: [verification-matrix.json](../production-readiness/verification-matrix.json), [rejestr SKIP](../production-readiness/skip-register.json), [decyzje wdrożeniowe](../production-readiness/deployment-decisions.md). Pełny plan PROD-00–14 pozostaje otwarty; ten checkpoint nie oznacza gotowości do produkcji.

Szczegółowy zakres i kryteria końcowe: [plan domknięcia](../PLAN_DOMKNIECIA_REFAKTORYZACJI_BACKENDU_2026-10-16.md).

Plan kolejnych implementacji, izolowanych odbiorów i wydania: [PROD-00–14](../PLAN_WDROZENIA_PRODUKCYJNEGO_2026-10-16.md). Dodanie tego planu nie zmienia zapisanych powyżej wyników ani statusu otwartych bramek.
