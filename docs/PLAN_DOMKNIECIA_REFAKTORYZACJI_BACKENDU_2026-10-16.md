# Plan domknięcia refaktoryzacji backendu

Data: 16 października 2026. Status: w realizacji. Checkboksy oznaczają wyłącznie zweryfikowane wyniki.

Plan kontynuuje [pierwotny plan P0–P15](PLAN_PRZEBUDOWY_BACKENDU_FEATURE_DRIVEN_2026-10-15.md) oraz [raport wykonania](backend-refactor/phase-status-2026-10-15.md). Nie powtarza wykonanej relokacji kodu. Rozstrzyga pozostałe braki architektury i warunki odbioru P15. „Feature-driven” oznacza tutaj organizację kodu według funkcji biznesowych, zgodnie z pierwotnym zakresem, bez wprowadzania procesu zarządzania projektem FDD.

Aktualne wyniki realizacji i braki środowiskowe zapisuje [checkpoint 2026-10-16](backend-refactor/execution-checkpoint-2026-10-16.md).

Szczegółową kolejność implementacji, nowe zakresy testów DB, przygotowanie środowiska, backup/restore, CI i wydanie opisuje [plan produkcyjny PROD-00–14](PLAN_WDROZENIA_PRODUKCYJNEGO_2026-10-16.md). Zgodnie z planem modułowym pełny proces biznesowy i portale live pozostają do odbioru przez użytkownika; nie są automatycznym zadaniem agenta ani CI.

## 1. Punkt wyjścia i cel

Punkt odniesienia kodu: `af512e9502218d336b4b73df0c5f612905c6ac7b` (`backend refractor`), gałąź `codex/backend-feature-modules`. Przed utworzeniem tego dokumentu drzewo robocze było czyste; lokalna gałąź wskazywała ten sam commit co lokalny ref `origin/codex/backend-feature-modules`. Nie jest to potwierdzenie bieżącego wyniku zdalnego CI.

Podczas sprawdzenia stanu bezpośrednio poprzedzającego ten plan:

| Kontrola | Wynik |
| --- | --- |
| Pełne `npm test` | PASS, exit 0; core 18/18, API 369/369, worker 115 PASS / 70 SKIP |
| Granice funkcji API | 272 pliki, zero naruszeń, cykli i wyjątków |
| Audyt transakcji | 317 plików, 98 granic, zero wykrytych naruszeń |
| Inwentaryzacja | 593 pliki TS, 130 tras, zero nieprzypisanych właścicieli, kolizji i nierozwiązanych importów względnych |
| Historyczny kontrakt HTTP | 84 wcześniejsze trasy zachowane w sprawdzanym zakresie; 46 tras dodatkowych |
| Manifest scenariuszy | 187 plików testowych, 616 deklaracji/patternów; nie oznacza 616 wykonanych testów |
| Efekty importowania | Skan 354 źródeł, zero wykrytych kandydatów; kontrola statyczna nie dowodzi wszystkich efektów pośrednich |
| `npm run check:backend:style` | Exit 0, 47 ostrzeżeń |

DB, Redis, browser fixture, realnego E2E i Compose nie uruchamiano ponownie w ramach tego sprawdzenia. Wcześniejsze wyniki są opisane w raporcie etapu. Domyślny `npm test` nie zastępuje tych prób, a 70 SKIP wymaga osobnego rozliczenia.

**Cel:** ukończyć podział transport → operacje biznesowe → persistence/adaptery, uszczelnić granice funkcji i zakończyć odbiór na odtwarzalnej wersji. Zachować zachowanie HTTP, payloady kolejek, reguły produktu, dane, blokady, idempotencję i bariery kasowania.

## 2. Potwierdzone braki

| Obszar | Dowód w kodzie | Praca do wykonania |
| --- | --- | --- |
| Leads | `features/leads/business-leads.service.ts` łączy reguły, SQL, modele, alokację, zmianę statusu i eksport | Rozdzielić odczyty, zapisy i przygotowanie eksportu |
| Review i grouping | Bezpośrednie SQL/ORM w `review.service.ts` i `grouping.service.ts` | Wydzielić persistence, zachować transakcje i aktualność rewizji |
| Reports | SQL w `admin-reports`, `contact-report`, `dashboard`, `history` services | Wprowadzić jawne repozytoria projekcji odczytowych |
| Privileged actions | `privileged-actions.service.ts` zawiera również kontroler, dynamiczne importy bazy i SQL | Oddzielić transport, reguły potwierdzeń oraz persistence |
| Runs i results | Operacje modeli/SQL m.in. w `run-admission`, `run-dispatch`, `export-finalization` | Domknąć repozytoria, atomowość outboxu i protokół publikacji pliku |
| Wspólna baza | `infrastructure/database/db.ts` eksportuje proxy połączenia oraz modele wielu funkcji | Usunąć dostęp biznesu przez zbiorczą fasadę i doprowadzić DI/fabryki do jawnego cyklu życia |
| Kontrola architektury | Bada bezpośrednie krawędzie między funkcjami API; nie zabrania SQL w serwisach ani omijania granic przez wspólną bazę | Rozszerzyć kontrolę warstw, publicznych eksportów i zależności pośrednich |
| Runner modułów | `audit-reports` wskazuje nieistniejący `features/audit/audit-search.http.spec.js`; źródło jest w `features/reports` | Poprawić ścieżkę i kontrolować wszystkie wpisy manifestu |
| Dokumentacja | Raport podaje poprzedni HEAD i niecommitowane zmiany; część podsumowań ma wcześniejsze liczby | Zachować historię dowodów, dodać aktualne podsumowanie z SHA i datą |

Wyszukiwanie po nazwach metod ORM służy do znalezienia kandydatów. Nie każda metoda `.create()` oznacza dostęp do bazy; zadanie wymaga sprawdzenia źródła i zależności. Sam rozmiar pliku nie jest kryterium podziału.

## 3. Zasady wykonania

- Jedna zmiana obejmuje spójną operację lub funkcję wraz z jej testami. Nie łączyć ekstrakcji z niezależną zmianą reguł biznesowych, uprawnień czy schematu.
- Repozytoria i adaptery zawierają SQL/ORM. Serwisy ustalają reguły i granice transakcji przez jawny kontrakt transakcyjny; przekazują ten sam kontekst do repozytoriów, audytu i outboxu. Nie wprowadzać nowego ORM ani frameworka transakcyjnego.
- Modelami zarządza funkcja będąca ich właścicielem. Przekrojowe odczyty mają nazwany kontrakt projekcji, jawny zakres danych i test tenantów. Nie tworzyć cykli przez wymuszanie zależności między pełnymi modułami.
- API korzysta z providerów Nest. Worker, migrator, parser i enrichment mogą używać jawnych fabryk; nie muszą uruchamiać Nest tylko w celu uzyskania połączenia.
- Zachować obecny model rejestracji Sequelize i oczekiwane współdzielenie połączenia w procesie, dopóki osobna zmiana i test nie uzasadnią innego zachowania. Rejestracja modeli odbywa się raz przed obsługą pracy.
- Migracje 001–062, tabele, nazwy kolejek i entrypointy są kontraktami. Jeśli usunięcie fasady wymaga dostosowania importu migracji, udokumentować wyłącznie techniczną różnicę i sprawdzić historyczny kontrakt; nie zmieniać semantyki ani numeracji migracji.
- DB/Redis/E2E/awarie działają na zasobach tworzonych przez istniejący izolowany harness, z danymi syntetycznymi i wyłączonymi portalami live.
- Przy każdym etapie zapisać SHA kodu, polecenie, PASS/FAIL/SKIP, przyczynę pominięcia i lokalizację dowodu bez sekretów. Dokumentacja nie otrzymuje PASS na podstawie samego istnienia testu.

## 4. Etapy i kryteria odbioru

Kolejność podstawowa: **D0 → D1 → D2 → D3 → D4 → D5 → D6 → D7**. Zbieranie materiałów historycznych z D6 rozpocząć już w D0. Po każdej ekstrakcji wykonać testy dotkniętego przepływu, bez odkładania DB na D6.

### D0 — Ustalenie aktualnej listy pozostałych prac

- [x] Utrwalić aktualny SHA i wyniki powyższych kontroli w nowym checkpointcie; wcześniejsze wpisy pozostawić jako historię.
- [ ] Sporządzić listę wszystkich produkcyjnych miejsc dostępu do DB i globalnych modeli w API oraz powiązanych procesach. Dla każdego wskazać właściciela, docelowe repozytorium/adapter, kontrakt transakcyjny i test zachowania. Objąć również helpery i dynamiczne importy.
- [x] Zweryfikować wszystkie ścieżki `scripts/test-module.cjs`, poprawić `audit-reports` i dodać kontrolę, która wykryje brakujący test także w module nieuruchamianym przez domyślne `npm test`.
- [x] Ustalić dostępność historycznej paczki API/workera, konfiguracji, źródeł, dumpu schematu i danych oraz pomiarów wydajności. `e3a507e` nie jest automatycznie pełnym baseline aplikacji: przed refaktorem istniały liczne zmiany poza HEAD. Zweryfikować kompletność odzyskiwanego stanu przed użyciem go w porównaniu.

**Odbiór:** każde znalezione miejsce ma decyzję i właściciela; manifest modułów nie zawiera nieistniejących plików; braki materiałów historycznych są jawnie zapisane. Brak materiału nie zatrzymuje D1–D5.

### D1 — Kontrole architektury i wzorzec persistence

- [ ] Uzgodnić lekki kontrakt połączenia/transakcji oraz repozytorium na jednej projekcji Reports. Wstrzykiwać zależności, zamiast importować globalne modele w serwisie.
- [x] Rozszerzyć kontrolę o SQL/ORM w kontrolerach i serwisach, importy zbiorczego `db.ts`, dynamiczne importy oraz ponowne eksportowanie kontrolerów/modeli przez publiczne baryłki. Dozwolić deklaracje typów oraz uruchamianie transakcji przez uzgodniony kontrakt.
- [x] Sprawdzać kierunek zależności: composition może składać modele funkcji, infrastructure udostępnia mechanikę; infrastruktura bazy nie importuje composition ani reguł biznesowych. Dołączyć odpowiednie granice worker/core; testy i migracje mają osobne, jawne reguły.
- [x] Istniejące naruszenia wpisać na czasową listę z konkretnym plikiem, regułą i etapem usunięcia. CI blokuje nowe naruszenia; D5 usuwa listę przejściową. Nie wyłączać globalnie kontroli na czas refaktoru.
- [x] Dodać testy narzędzia kontroli architektury wykrywające SQL w serwisie, prywatny import przez re-eksport, kontroler eksportowany jako API funkcji, globalną fasadę, cykl przez infrastructure i niedozwolony import core/worker. Dodać poprawne przykłady, aby uniknąć fałszywych alarmów.

**Odbiór:** pilot działa przez prawdziwy DI; kontrola wykrywa znane obecne obejścia i blokuje ich powrót. Testy audytu transakcji rozpoznają nowy kontrakt i wykrywają utratę przekazania transakcji.

### D2 — Odczyty Reports i jawne projekcje

- [x] Wydzielić repozytoria dla history, dashboard, contact-report i admin-reports. Zachować filtry, paginację, daty, limity, granty i parametryzację SQL.
- [x] Opisać projekcje przekraczające własność tabel: potrzebne pola, zakres tenanta, reguły dostępu i właściciela zapytania. Zwracać typy wyniku, nie globalne modele ORM.
- [ ] Przenieść sukcesowe i odmowne scenariusze HTTP/DB do testów rzeczywistej ścieżki kontroler → serwis → repozytorium.

**Testy:** `test:module:reports`, `test:module:audit-reports` po naprawie manifestu; przypadki dwóch tenantów, przydziałów, cofniętego grantu, kursora, dat granicznych i pustych wyników.

**Odbiór:** Reports nie wykonuje SQL w serwisach; odpowiedzi zachowują kształt, kolejność i zakres danych. Użycie przekrojowego odczytu jest jawne w grafie kontraktów.

### D3 — Leads, review i grouping

- [ ] Rozdzielić Leads na odczyty, alokację/zwolnienie, zmianę statusu, zapis wyników i przygotowanie eksportu. Repozytoria przejmują zapytania i mapowanie; serwisy zachowują reguły produktu.
- [ ] W Review i Grouping wydzielić persistence oraz czyste decyzje domenowe. Nie rozcinać jednej transakcji na niezależne zapisy.
- [ ] Zachować kolejność blokad, CAS/rewizje, idempotencję, przydziały, zakres tenanta oraz współpracę z Results, Notifications i deletion barrier.

**Testy:** `test:module:leads`, `test:module:review`, `test:module:grouping`, `test:module:reports`, `test:module:tenant-scope`; uzupełnić rzeczywiste testy zapisu leadów, jeżeli obecny zestaw nie pokrywa danej operacji.

**Odbiór:** brak SQL/modeli w serwisach tych funkcji; testy równoczesnej alokacji i starej rewizji nie pozwalają na podwójny przydział; awaria audytu wycofuje całą operację; kasowanie blokuje spóźniony zapis.

### D4 — Potwierdzenia uprzywilejowane, runs i finalizacja wyników

- [x] W PrivilegedActions wydzielić controller, wejściowe DTO, service i repository; usunąć dynamiczne pobieranie globalnej bazy. Zachować czas ważności, fingerprint operacji, związanie z aktorem/sesją, jednorazowość i ochronę przed replay.
- [ ] Domknąć RunAdmission i RunDispatch: odczyty membership/sesji/grantów, blokady, limity i zapis runu/outboxu przechodzą przez repozytoria z tym samym kontekstem transakcji.
- [ ] W ExportFinalization wydzielić persistence i adapter pliku, zachowując obecny protokół DB–plik. Nie zakładać wspólnej atomowej transakcji PostgreSQL i systemu plików.
- [ ] Rozliczyć pozostałe miejsca z D0, także w preparations, submissions, imports, enrichment, admin i helperach. Sam import typu albo delegacja `.create()` nie wymaga sztucznego repozytorium.

**Testy:** security, admin, teams-db, admin-users-db, runs, run-control, submission, interventions, results, deletion oraz odpowiednie integracje na PostgreSQL/Redis. Dla privileged actions: replay, wygaśnięcie, zmiana payloadu, cofnięcie sesji i równoczesne użycie. Dla outboxu: rollback oraz restart przed/po publikacji. Dla eksportu: awaria zapisu/rename, plik opublikowany bez potwierdzenia DB i retry bez duplikacji.

**Odbiór:** zachowane atomowe operacje i zachowanie awaryjne; wszystkie produkcyjne miejsca z listy D0 mają implementację docelową lub konkretne uzasadnienie właściwego adaptera.

### D5 — Usunięcie fasady globalnej i domknięcie zasobów

- [ ] Zastąpić użycia proxy `sequelize` i zbiorczych eksportów modeli jawnymi providerami/fabrykami i lokalnymi modelami repozytoriów. Docelowo usunąć `db.ts` albo pozostawić wyłącznie wąski adapter techniczny bez modeli biznesowych, globalnych proxy i importu composition.
- [ ] Rejestr modeli składać jawnie w composition. Przekazywać gotowy kontrakt bazy do API i procesów pomocniczych. Zachować wymagane launchery i faktyczne role połączeń.
- [ ] Usunąć eksporty kontrolerów z publicznych interfejsów funkcji oraz zbędne eksporty modeli. Współdzielone kontrakty nie mogą służyć jako nowy zbiorczy dostęp do tabel.
- [ ] Usunąć przejściowe wyjątki D1; sprawdzić cykle w całym objętym grafie. Uporządkować ostrzeżenia w zmienianym kodzie i sklasyfikować pozostałe z właścicielem. Nie ukrywać ich przez globalne wyciszenie.

**Testy:** pełne `npm test`, `test:module:database`, `test:module:runtime`, `test:module:app-module`, `test:module:runtime-roles`, worker-lifecycle; start/stop API, parsera, enrichment, migratora i workera z czystego builda. Odczyt schematu porównać z kontraktem 48 modeli/48 relacji i aktualnym katalogiem.

**Odbiór:** zero produkcyjnych zależności biznesu od starej fasady; jednokrotna rejestracja modeli, poprawne role, readiness i zamknięcie zasobów; zero przejściowych wyjątków. Liczby plików mogą się zmieniać, pokrycie manifestu nie może się zmniejszać bez uzasadnienia.

### D6 — Odbiór zachowania, środowiska i zgodności

- [ ] Odświeżyć przegląd 130 tras według faktycznego stanu końcowego. Dla każdej zapisać odpowiedni sukces, odmowę roli/tenanta/grantu, walidację, kształt odpowiedzi i dowód. Oznaczenie N/A wymaga przyczyny; review źródła nie zastępuje testu zachowania.
- [ ] Pokryć wszystkie 21 akcji polityki dla pięciu ról testami HTTP/DB tam, gdzie występują w produkcie. W osobnych modułach UI potwierdzić dostępność działań, odmowy oraz kontrakty importów, przygotowania, runów, SMS/interwencji, wyników i pobrań; sprawdzić też uprawnienia zespołu, leadów, raportów i kasowania. Pełny proces biznesowy pozostaje do odbioru użytkownika w PROD-13.
- [ ] Rozliczyć T01–T24 pierwotnego planu, przypisując każdemu osobny test modułowy, fixture/awarię albo odbiór użytkownika. Uruchomić izolowane moduły PostgreSQL/Redis i lokalne fixture bez tworzenia wspólnego przebiegu całej platformy. Każdy domyślny SKIP powiązać z osobnym wykonanym scenariuszem albo pozostawić jawnie niezaliczony.
- [ ] Na aktualnym izolowanym stosie potwierdzić `current_user`, flagi, członkostwa i ACL czterech ról. Osobno sprawdzić aktywny profil używanej instalacji, jeżeli istnieje i jest dostępny. Nie zmieniać poświadczeń, aby wymusić PASS; brak uruchomionego profilu zapisać jako niepotwierdzony odbiór instalacji.
- [ ] Porównać migracje oraz schemat i zachowanie danych z wiarygodnym historycznym materiałem. Jeśli go brak, zachować status niepotwierdzonej zgodności historycznej; czysta baza ani syntetyczny upgrade nie zastępują dowodu.
- [ ] Zmierzyć start, RSS, połączenia, p50/p95 login/list/detail, import/eksport i przepustowość kolejki: stałe fixture, sprzęt i konfiguracja, rozgrzewka, co najmniej trzy przebiegi. Porównać z `af512e9` jako baseline domknięcia. Osobno wykorzystać zweryfikowany baseline sprzed całego refaktoru, jeżeli jest odtwarzalny. Wzrost mediany p95/RSS ponad proponowane 10% wymaga powtórzenia pomiaru i analizy; brak historycznych danych nie uprawnia do stwierdzenia braku regresji całej przebudowy.
- [ ] Wykonać backup/restore z replay deletion journal oraz rollback kompletnego zgodnego zestawu API/workera/web/core na syntetycznych danych. Zachować wynik, cudzy przydzielony lead, oczekującą dostawę i kasowanie po backupie. Rollback 061→062 nie zastępuje powrotu obrazów aplikacji; nie odtwarzać starej bazy jako zwykłego rollbacku kodu.
- [ ] Z czystego commita uruchomić zdalne `.github/workflows/backend-checks.yml` oraz brakujące zadania osobnych modułów fixture/UI/Compose wymagane do odbioru. Nie dodawać full-flow/live do CI. Zapisać URL przebiegu i SHA. Wykonać triage skanów zależności/kodu/obrazów i sekretów z pierwotnego planu; wynik historyczny nie zastępuje bieżącego.

**Odbiór:** macierz T01–T24 posiada rzeczywiste wyniki i dowody; krytyczne FAIL i wymagane SKIP są zamknięte. Otwarte bramki historyczne lub środowiskowe zachowują jawny status; nie zmieniać ich na PASS z braku materiałów.

### D7 — Dokumentacja i paczka odbioru

- [ ] Zaktualizować plan P0–P15, raport etapu, instrukcję uruchomienia, opis architektury i procedurę [wydania/rollbacku](RELEASE_AND_ROLLBACK.md). Definicję ukończenia oznaczać według dowodów, nie zbiorczo.
- [ ] Odświeżyć inventory, scenariusze statyczne i runtime, przegląd tras oraz skan efektów importowania; zweryfikować odwołania do źródeł/testów.
- [ ] Dla wersji odbiorowej zapisać pełny SHA, wersje i digesty faktycznie zbudowanych obrazów, manifest migracji/grantów, niesekretną konfigurację, raport testów i znane ograniczenia. Zastosować istniejący generator release manifestu, gdy dostępne są wymagane digesty; nie wpisywać fikcyjnych identyfikatorów.

**Odbiór:** niezależny wykonawca może odtworzyć build, testy i start z dokumentacji oraz wskazanej wersji. Dokumentacja rozróżnia ukończenie kodu, odbiór przebudowy oraz gotowość konkretnej instalacji do wdrożenia.

## 5. Macierz uruchomień

Poniższe polecenia są istniejącymi wejściami; uruchamiać je według zakresu zmiany. Naprawiony manifest modułów i nowe scenariusze muszą wejść do odpowiednich zestawów, aby tabela nie pomijała nowych testów.

| Moment | Polecenia / próby |
| --- | --- |
| Każda ekstrakcja | `npm run test:architecture`, `npm run test:transaction-audit`, `npm run test:http-contract`, `npm run check:backend:style` oraz testy funkcji |
| Relokacja/dodanie pliku lub testu | Generatory inventory/scenarios/import-effects z `package.json`, następnie `test:inventory`, `test:scenarios`; runtime manifest po aktualnym buildzie API/workera |
| Zmiana persistence | Właściwy `test:module:*` na DB oraz sukces, rollback, tenant i istotna współbieżność dla zmienionej operacji |
| D5 i kandydat odbioru | `npm test`, `npm run build`, `npm run test:scenario-runtime`, AppModule oraz runtime-roles |
| Odbiór DB | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Test-GoldisDatabase.ps1` oraz `npm run test:module:migrations-upgrade`; dodatkowe nowe przypadki z D2–D4 |
| Odbiór modułów portali i UI | `npm run test:e2e:fixture` i osobne modułowe UI smoke; uzupełniona macierz HTTP/UI. Pełny przebieg oraz live: osobny odbiór użytkownika PROD-13 |
| Odbiór uruchomienia | `npm run validate:production-compose`, `npm run test:production-compose`, rzeczywisty start izolowanego Compose i shutdown; walidacja YAML nie zastępuje startu |
| Odbiór odtwarzania | `npm run test:module:backup-restore`, test poprzedniego zestawu obrazów według procedury rollbacku, porównanie syntetycznych danych |

Przed komendami integracyjnymi zweryfikować izolację istniejącego harnessu. Testy nie mogą odziedziczyć połączeń do używanej bazy lub flag portali live. Nie ponawiać pełnej macierzy po każdej zmianie dokumentacji; powtarzać ją po zmianie wspólnej infrastruktury, kontraktów albo wykrytej regresji.

## 6. Warunki zakończenia i zależności zewnętrzne

**Kod można oznaczyć jako ukończony**, gdy D0–D5 są odebrane: wszystkie miejsca persistence rozliczone, warstwy i jawne kontrakty egzekwowane, brak globalnej fasady modeli w biznesie, testy wykrywane i wykonywane, zachowany cykl życia procesów.

**Cały pierwotny plan można oznaczyć jako odebrany**, gdy dodatkowo D6–D7 oraz definicja ukończenia P15 mają dowody. Nie zamykać P15 tylko dlatego, że nowa struktura kompiluje się i przechodzi unit testy.

| Brakujący materiał / dostęp | Wpływ i działanie |
| --- | --- |
| Wiarygodny historyczny dump i dane | Blokuje pełne potwierdzenie zgodności wcześniejszej instalacji; zebrać materiał albo pozostawić niepotwierdzoną bramkę |
| Poprzednia odtwarzalna paczka | Blokuje dowód rollbacku całej aplikacji; najpierw zweryfikować źródła/obrazy i konfigurację |
| Historyczny pomiar lub odtwarzalny stary runtime | Blokuje porównanie wydajności sprzed całej przebudowy; baseline `af512e9` rozlicza wyłącznie etap domknięcia |
| Aktywny profil pierwotnej instalacji | Blokuje przypisanie rzeczywistego konta DB tej instalacji; izolowane role nadal można i należy sprawdzić |
| Dostęp do zdalnego CI | Blokuje dowód GitHub Actions dla końcowego SHA; lokalne PASS jest osobnym wynikiem |

Portale live oraz wdrożenie do używanej instalacji pozostają osobnymi operacjami, zgodnie z pierwotnym planem. Plan nie zleca ich wykonania.

## 7. Pierwszy pakiet do realizacji

Rozpocząć od D0 i D1: naprawić manifest `audit-reports`, przygotować listę pozostałego persistence, wdrożyć kontrolę warstw i jeden wzorcowy odczyt Reports. Następnie przeprowadzić D2 i zmierzyć rzeczywisty koszt ekstrakcji wraz z integracjami. Dopiero na tej podstawie szacować czas D3–D7; obecnie liczba katalogów ani odhaczonych punktów nie uzasadnia procentu ukończenia lub terminu.
