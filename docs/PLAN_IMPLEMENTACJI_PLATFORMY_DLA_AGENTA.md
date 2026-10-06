# Szczegółowy plan implementacji platformy Goldis dla agenta kodującego

Data: 5 października 2026. Status: specyfikacja prac do wykonania. Podstawa: obecny kod, audyt z 05.10.2026 i `PLAN_DOMKNIECIA_PLATFORMY.md`. Identyfikatory PL-01–PL-11 zachowują zgodność z planem nadrzędnym. Wszystkie nowe endpointy, pliki i tabele wymienione jako **projektowane** należy dopiero utworzyć.

## 0. Instrukcja wykonania i zakres

1. Przeczytaj `README.md`, plan nadrzędny, audyt i najnowsze wpisy `STAN_IMPLEMENTACJI.md`/`POSTEP_IMPLEMENTACJI.md`. Starsze opisy braków są historią; sprawdzaj fakty w kodzie.
2. Sprawdź aktualne `AGENTS.md`, Git, katalog migracji i stan usług. Numery linii z audytu są wskazówką, nie gwarancją po kolejnych zmianach.
3. Uzupełniaj istniejące serwisy i mechanizmy. Nie zastępuj sesji, guardów, outboxa, lease, kanonicznych runów ani eksportera uproszczonymi odpowiednikami.
4. Zakres: jedna organizacja Goldis, cztery role, pierwsze narzędzie OC i kompletne funkcje wspólne platformy. Nowe narzędzia, zespoły, urządzenia fizyczne i wieloorganizacyjna administracja są rozszerzeniami poza tą implementacją.
5. Używaj `WORKER_LIVE_PORTALS=0` do pracy nad platformą. Fixture portali ma być uruchamiane przez izolowany harness. Nie korzystaj z kont klienta ani nie twórz rzeczywistych ofert dla sprawdzenia UI.
6. Pracuj pakietami: model/kontrakt → autoryzacja → transakcje → API → UI → test wymaganych zachowań → odbiór i dokumentacja. Wprowadź kod warstwy przed zależnym ekranem.
7. Nowe migracje są addytywne. Obecne źródła kończą się na 023; sprawdź numer przed każdą nową migracją. Nie poprawiaj zastosowanej migracji wstecz. `down` nie jest automatycznym rollbackiem produkcyjnych danych.
8. Test zakończony brakiem konfiguracji albo pominięciem nie zalicza bramki. Zapisz blokadę i wykonuj niezależną pracę; nie oznaczaj całego pakietu jako odebranego.
9. Po każdym pakiecie dostarcz: kod i migracje, aktualną instrukcję, wynik testów, pozostałe ograniczenia i wpis dowodowy. Nie kończ na pustym ekranie, typie lub API bez dostępnej ścieżki użytkownika.
10. Zachowaj osobne statusy: implementacja, test modułu, odbiór HTTP/DB/Redis/UI, odbiór portali live i eksploatacja. Ukończenie platformy na fixture nie zalicza A9.

### 0.1. Zasady wspólne

- Tożsamość aktora, tenant, właściciel i narzędzie pochodzą z sesji/relacji w bazie. Body nie może wskazać uprzywilejowanego użytkownika ani zmienić własności.
- Listy filtruj w SQL po tenant/grant/ownership **przed** paginacją, liczeniem i agregacją. Dla bezpośredniego URL użyj istniejących reguł 401/403/404; błędy usług 503, nieaktualna wersja 409, błędne dane 400, limit nowych runów 429.
- Mutation: Origin/CSRF, allowlista pól, role/grant, transakcja, CAS tam, gdzie zmieniasz współdzielony stan, i wymagany audit w tej samej transakcji. Błąd audytu cofa mutację.
- Nie zapisuj kodu SMS w DB, BullMQ, audit, logach ani raportach. Nie umieszczaj danych osobowych w nowych payloadach kolejek; job przenosi identyfikator zasobu.
- Oryginalne dane Excela pozostają zachowane. Dane operacyjne i pochodzenie mają wersję. Zmiana źródła nie może przestawić trwającego runu na inną osobę/sprawę.
- Czas DB: UTC. Czas użytkownika i okien pracy: jawnie `Europe/Warsaw` lub zatwierdzona strefa ustawienia. Nie interpretuj czasu operacyjnego według przypadkowej strefy przeglądarki.
- Dwie identyczne próby startu/rozstrzygnięcia nie mają tworzyć dwóch skutków. Warunki transakcyjne/unikalne indeksy są zabezpieczeniem; disabled button jest tylko pomocą UI.
- W pierwszym wydaniu nie włączaj usuwania danych bez zatwierdzonej polityki retencji. Można przygotować kod, dry-run i testy.

### 0.2. Proponowany układ docelowych ekranów

| Ścieżka | Cel | Uprawnienia |
| --- | --- | --- |
| `/` | Logowanie albo katalog narzędzi/odnośniki do właściwych ekranów | Aktywna sesja po zalogowaniu |
| `/tools/oc-policy-verification` | Workspace OC | Dostęp zgodny z grantami; każda akcja osobno |
| `/imports` i `/imports/[id]` | Historia i szczegóły importu | Admin/recenzent w zakresie narzędzia, operator własne |
| `/runs` i `/runs/[id]` | Historia i szczegóły zadania | Jak istniejący model odczytu; ograniczony widok przypisanego SMS |
| `/submissions/[id]` | Postęp partii uruchomień | Właściwy właściciel/narzędzie/rola |
| `/results` | Gotowe wyniki i jawne wyniki zerowe | `view_results`; download dodatkowo według roli/grantu |
| `/review` | Korekty i konflikty | Admin/recenzent, grant do narzędzia |
| `/audit` | Dziennik | Admin/audytor; recenzent tylko dozwolony podzbiór |
| `/admin`, `/account` | Istniejąca administracja i własne konto | Dotychczasowe role |

Można zachować istniejący workspace i przenieść go do modułu. Nie kopiuj jego całego kodu do nowych stron. Dodawaj małe komponenty funkcjonalne i wspólne helpery; gruntowny redesign nie jest warunkiem tego planu.

### 0.3. Kontrakt nowych list

Projektowany wspólny format: `{ items, nextCursor }`, `limit` domyślnie 50, maksymalnie 100; nie pobieraj całych tabel. Walidowany kursor niesie wersję, ostatni klucz porządku i fingerprint filtrów/sortu. Zmiana filtrów resetuje kursor. Nie używaj danych wrażliwych jako jego treści. Kursor nie zastępuje autoryzacji.

Nowe historie sortuj po `(created_at DESC, id DESC)`. Dla kolejki interwencji można zachować `(priority_rank ASC, created_at ASC, intervention_id ASC)`, ale uwzględnij wszystkie te klucze w kursorze. Zmiana priorytetu odświeża listę od początku; przy równoczesnych zmianach UI nie ma obiecywać zamrożonego snapshotu. Odbiór stabilności paginacji obejmuje identyczny zestaw danych i jednoznaczne klucze przy jednakowych timestampach.

Nie zmieniaj nagle istniejącego `GET /runs?batchId=...`, który zwraca tablicę. Nową historię wystaw osobno i przełącz konsumentów świadomie. Istniejące `page` w administracji mogą pozostać kompatybilne przejściowo, z nowym `hasMore`/kursorem; końcowy UI musi docierać do dalszych rekordów.

## 1. PL-01 — wersja bazowa, migracje i środowisko

**Pliki istniejące:** `package.json`, `.gitignore`, `.dockerignore`, `compose.yaml`, `compose.local-browser.yaml`, `.env*.example`, `scripts/Start-GoldisLocal.ps1`, `scripts/Test-GoldisDatabase.ps1`, `apps/api/scripts/run-db-integration.cjs`, `migration-smoke.cjs`, `apps/api/src/migrate.ts`.

### Kroki

1. PL-01.01: odczytaj `git status`, `git ls-files` i historię. Bieżący audyt wykazał tylko README w śledzonych plikach; nie zakładaj, że to nadal aktualne.
2. PL-01.02: przejrzyj wykluczenia prywatnych katalogów, źródłowych XLSX, stagingu, trace i środowisk. Dołącz źródła, przykłady bez sekretów, lockfile, testy i dokumentację do sprawdzonej wersji; nie używaj bez przeglądu `git add .`.
3. PL-01.03: sprawdź Node/npm, Docker i wolne porty. Wybierz jeden sposób lokalnego uruchomienia: Windows z usługami DB/Redis albo pełny Compose. Nie uruchamiaj dwóch workerów na tym samym koncie/profilu.
4. PL-01.04: testy DB/Redis uruchamiaj na zasobach z losowym ID i etykietą własności. Nie używaj wykrytego PostgreSQL na 5432 jako testowego bez potwierdzenia izolacji.
5. PL-01.05: zachowaj ochronę runnera: loopback, baza administracyjna `postgres`/`template1`, tylko nowo utworzone testowe bazy, sprzątanie własnych zasobów w `finally` i jawny niezerowy exit.
6. PL-01.06: przygotuj testową matrycę: admin, admin rezerwowy, operator A/B, recenzent A/B, audytor, nieaktywne konto, konto bez grantu i drugi syntetyczny tenant do prób negatywnych.
7. PL-01.07: dodaj fixtures 101 użytkowników, 51+ interwencji/runów, kilka importów, gotowy/zerowy/uszkodzony wynik, pending correction i conflict. Dane mają być syntetyczne; nie kopiuj rekordów klienta.
8. PL-01.08: rozszerz `migration-smoke.cjs`, który obecnie zna konkretne numery do 023. Weryfikuj pełną bieżącą listę migracji zamiast pozostawić hardcoded „001–023”. Zachowaj testy historycznych ścieżek.
9. PL-01.09: wykonaj fresh, legacy upgrade i powtórne `up`. Na kopii aktualnej bazy odczytaj `SequelizeMeta`, FK, CHECK i indeksy; nie twórz raportu zawierającego dane/sekrety.
10. PL-01.10: zanotuj wersję bazową, wyniki, komendę startu i blokady. Uaktualnij `.env.example` tylko nazwami/bezpiecznymi przykładami potrzebnych nowych parametrów.

**Testy:** `ENV-01` świeży start; `ENV-02` legacy upgrade; `ENV-03` rerun migracji; `ENV-04` przerwanie testu usuwa tylko własne zasoby; `ENV-05` brak konfiguracji kończy się BLOCKED bez mutacji; `ENV-06` brak sekretów w zbudowanym obrazie.

**Bramka:** odtwarzalny backend testowy i potwierdzona ścieżka migracji. Gdy Docker jest niedostępny, PL-02 i niezależne API/UI mogą powstawać, ale testów DB nie oznaczaj PASS.

## 2. PL-02 — błędy i niepełna obsługa administracji

**Pliki:** `apps/web/app/admin/page.tsx`, `apps/api/src/admin.ts`, `apps/web/scripts/admin-ui-smoke.cjs`; projektowane `apps/web/lib/warsaw-date-time.ts`, komponent potwierdzenia i testy odpowiednich kontraktów.

### 2.1. Termin interwencji

1. PL-02.01: odtwórz `dueAt.slice(0,16)` → `new Date(draft.dueAt).toISOString()` dla zapisanego `2026-10-05T12:00:00Z`; zapis bez edycji obecnie może oddać `10:00:00Z`.
2. PL-02.02: helper formatuje UTC do części formularza w jawnej strefie, np. przez `Intl.DateTimeFormat(...).formatToParts`. Nie obcinaj tekstu UTC i nie polegaj na domyślnej strefie `Date`.
3. PL-02.03: przechowuj w draft oryginalne ISO i flagę edycji. Jeśli termin nie był zmieniany, wyślij dokładne oryginalne ISO, zachowując sekundy/milisekundy; null pozostaje null.
4. PL-02.04: edytowaną wartość przelicz z Warsaw na UTC. Weryfikuj istnienie lokalnej daty przez ponowne formatowanie. Dla nieistniejącej godziny przy zmianie czasu pokaż błąd; dla dwóch możliwych momentów wymagaj jawnego wyboru offsetu. Nie wybieraj losowo.
5. PL-02.05: pokaż „Czas: Europe/Warsaw” przy polu, stosuj ten sam helper w `assign()` i renderowaniu. Wyczyszczenie pola usuwa termin, nie przydział.
6. PL-02.06: po konflikcie rewizji zachowaj edycję w UI, ale wymagaj odświeżenia i świadomego ponownego zapisu; nie aktualizuj automatycznie expectedRevision i nie nadpisuj innej osoby.

**Testy DAT-01–06:** niezmieniony termin; edytowany termin; null/clear; Warszawa lato/zima; przeglądarka w UTC/Nowym Jorku; nieistniejąca i dwuznaczna godzina. Sprawdź także zgodność wysłanego JSON, nie tylko tekstu w input.

### 2.2. Paginacja i stany błędów

7. PL-02.07: użytkownicy — konsumuj istniejący `nextCursor`, dodaj kontrolkę dalszych stron i wybór użytkownika spoza pierwszej setki. Lista odbiorców przydziału też nie może ograniczać się do pierwszych kont; użyj stronicowanego wyszukiwania uprawnionych odbiorców.
8. PL-02.08: zadania/interwencje — rozszerz API o wiarygodne `hasMore` poprzez `limit+1` lub kontrakt kursora, dodaj właściwe indeksy po pomiarze i kontrolki UI. Zmiana filtra resetuje stronę.
9. PL-02.09: rozdziel stan filtrów poszczególnych sekcji: narzędzie interwencji nie powinno przypadkowo przełączać ustawień/raportu w trakcie edycji.
10. PL-02.10: każde `loadOperations`, `loadInterventions`, szczegóły i mutacje obsługują try/catch, loading, pustą listę i 401/403/409/503. Abort lub token żądania chroni przed późną odpowiedzią starego filtra. Polling działa przy widocznej stronie i nie nakłada żądań.

**Testy PAG-01–05:** 101. użytkownik; 51. run/incident; równe timestampy; zmiana filtra/kursora; spóźniona odpowiedź i 503 nie zostawiają nieobsłużonego Promise ani danych starego użytkownika.

### 2.3. Potwierdzenia

11. PL-02.11: wspólne potwierdzenie dla revoke grantu, disable konta, zmiany roli oraz revoke wszystkich sesji. Wskaż login i skutek; dla własnego konta ostrzeż o utracie sesji. Samo włączenie konta nie wymaga dodatkowej ceremonii.
12. PL-02.12: przy zmianie roli nie zapisuj w `onChange` selecta; najpierw lokalny wybór, następnie akcja „Zapisz rolę” i potwierdzenie skutków. Disabled podczas requestu, obsłużony błąd, fokus wraca do akcji.
13. PL-02.13: anulowanie dialogu nie wysyła requestu. Serwer nadal egzekwuje wszystkie zabezpieczenia; potwierdzenie ich nie zastępuje.

**Testy ADM-01–03:** cancel bez mutacji; confirm dokładnie jedna mutacja; ostatni admin/self-revocation ma właściwy komunikat i odmowę lub nowy ekran logowania.

**Bramka PL-02:** usunięta reprodukcja czasu, dostępne dalsze rekordy i spójne błędy/potwierdzenia z przechodzącym smoke UI.

## 3. PL-03 — katalog, importy i historie

**Istniejące pliki:** `imports.ts`, `runs.ts`, `tool-access.ts`, `authorization-guard.ts`, `module.ts`, `workspace.tsx`, `page.tsx`. **Projektowane:** `history.ts`, `list-query.ts`, `resource-scope.ts`, nowe strony historii/szczegółów i komponenty list.

### 3.1. Kontrakt API i bezpieczeństwo

1. PL-03.01: wyodrębnij funkcję budującą SQL scope dla kolekcji. Nie podawaj listy cudzych ID do Reacta w celu filtrowania. Admin: tenant; operator: tenant+owner+grant; reviewer: tenant+grant; auditor: brak operacyjnych kolekcji.

   Zbiór narzędzi do odczytu wynika z `view_results`, a do startu z `execute`. Nie używaj do tego bezpośrednio `listToolAccess()`, które obecnie filtruje katalog po `canDiscover`: widoczność kafla nie jest tożsama z prawem odczytu wcześniej przydzielonego wyniku.
2. PL-03.02: dodaj projektowane `GET /api/imports?toolId&from&to&cursor&limit` — DTO: id, toolId, fileName, totalRows, liczba wymagających przeglądu, createdAt i ownerLabel tylko dla uprawnionych. Import nie ma statusu runu; filtruj go osobnym `dataState=all|ready|needs_review` liczonym z aktualnych danych operacyjnych.
3. PL-03.03: dodaj projektowane `GET /api/history/runs?toolId&batchId&status&from&to&cursor&limit` i `GET /api/history/results?...`. Nowy endpoint nie zmienia formatu starego `GET /runs`.
4. PL-03.04: wyniki obejmują completed i no_matching_policies, counts, runId, batchId, referenceDate oraz artifactAvailable. Nie zwracaj pełnego PESEL ani zawartości pliku w listach.
5. PL-03.05: waliduj filtry, limit, ISO/zakres czasu, enum statusów i kursor. Nie interpoluj wartości do SQL. Daty raportuj jako ISO UTC; UI renderuje jawnie Warsaw.
6. PL-03.06: zaktualizuj guard/resolver kolekcji. Kolekcja nie ma jednego właściciela — kontrola roli zezwala na zapytanie, scope serwisu ogranicza wynik. Dla szczegółu nadal wyznaczaj zasób przez bazę.
7. PL-03.07: dodaj indeksy zgodne z relacjami tenant/owner/tool + createdAt/id; potwierdź `EXPLAIN ANALYZE` na fixture. Nie dodawaj wszystkich możliwych indeksów na zapas.

### 3.2. Katalog i powrót do pracy

8. PL-03.08: katalog pobiera `/tools`; rejestr modułów UI jawnie mapuje OC na workspace. Nie renderuj wpisu bez implementacji jako działającego narzędzia.
9. PL-03.09: maintenance oznacza dostęp do historii przy niedostępności nowych startów według polityki; disabled ma respektować obecne reguły API. Nie zmieniaj grantów przez samą zmianę etykiety.
10. PL-03.10: przenieś/reużyj workspace dla `/tools/oc-policy-verification`; stare `/` zachowuje wejście/logowanie. Stan importId/runId/filtrów zapisuj w URL, nie tylko useState.
11. PL-03.11: po bezpośrednim otwarciu szczegółów pobierz sesję i zasób. Zasób nieautoryzowany nie może mignąć przed guardem; po 401 przekieruj do logowania z bezpiecznym wewnętrznym returnTo.
12. PL-03.12: dodaj historie i odnośniki import↔run↔result. Po F5 i nowym logowaniu otwiera się ten sam zasób. Zmiana filtra zeruje kursor; przyciski back/forward zachowują nawigację.
13. PL-03.13: UI uwzględnia brak grantów, brak importów, brak wyników, zerowy wynik, niedostępny plik, usunięty zasób i 503.

**Testy HIS-01–08:** użytkownik A/B i obcy tenant; wszystkie strony; bezpośredni URL; cofnięcie grantu między stronami; logout/login/F5; invalid cursor; maintenance; brak niezarejestrowanego modułu. Sprawdź listy i liczniki przez prawdziwy HTTP/DB.

**Bramka:** wcześniejsza praca jest dostępna bez ponownego importowania, a listy nie ujawniają cudzych zasobów.

## 4. PL-04 — konta, granty i cztery role

**Pliki:** `session.ts`, `admin.ts`, `authorization-policy.ts`, `authorization-guard.ts`, `tool-access.ts`, `admin-reports.ts`, `audit.ts`, `/account`, `/admin`, projektowane `/audit`, `/review`.

### Kroki

1. PL-04.01: zapisz macierz ról jako testowalny kontrakt. Admin zarządza tenantem; operator wykonuje swoje zadania; reviewer przegląda/rozstrzyga dane przydzielonego narzędzia; auditor czyta dziennik bez operacyjnych danych.
2. PL-04.02: przejdź istniejące endpointy kont/sesji i zachowaj format cookie v2, aktualny resolver oraz wymuszenie zmiany hasła. Nie otwieraj kompatybilności ze starymi bezterminowymi cookies.
3. PL-04.03: przetestuj dwie sesje; logout/revoke jednej pozostawia drugą według zasad, revoke all/password/role/disable wycofują obie. Brak DB nie przywraca sesji, kończy kontrolowanym 503.
4. PL-04.04: odbierz konkurencyjne zmiany ostatnich adminów z istniejącą blokadą tenantową. Konto bootstrap nie jest publicznym mechanizmem awaryjnego logowania.
5. PL-04.05: zaktualizuj deklaracje capabilities dla projektowanych funkcji: collection read, enrichment execute, correction review, conflict review, submission create/cancel/read. Używaj jawnych mappingów w `capabilityForPermission`, nie jednej flagi „admin everything”.
6. PL-04.06: rozszerz resolver o correction→source→import, conflict→source→import, submission/job→import. Sprawdź tenant i zgodność toolId run/batch. Klient nie wybiera zakresu swoim `toolId`.
7. PL-04.07: granty nadal nie otwierają cudzych importów operatorowi. Przy przypisanym SMS zwróć tylko ograniczony kontekst interwencji/challenge, bez wyników właściciela.
8. PL-04.08: utwórz `/audit` dla admina/audytora oraz ograniczonego reviewer. Auditor nie korzysta z `/admin`; dodaj właściwy link nawigacji niezależnie od widoczności narzędzia.
9. PL-04.09: reviewer audit filtruje wyłącznie jawnie dozwolone akcje operacyjne oraz relacje do narzędzi z aktualnym grantem. Odrzuca filtry proszące o konta/sesje/ustawienia. Nie dopuszczaj go do całego dziennika tenantowego.
10. PL-04.10: wszystkie UI operacje mają 401/403/404 i aktualne granty. Cofnięcie prawa usuwa przyciski po odświeżeniu i zawsze blokuje request po stronie API.
11. PL-04.11: odebranie dostępu/wyłączenie konta zdejmuje wymagające go otwarte przydziały w transakcji. Nowe oczekujące elementy partii tego operatora blokuj do świadomego przejęcia przez admina; nie wykonuj ich automatycznie pod cudzą tożsamością. Przyjęte runy pozostają zgodne z dotychczasową zasadą.
12. PL-04.12: udokumentuj tworzenie pierwszego admina i odzyskiwanie dostępu z konsoli przez kontrolowaną procedurę, bez otwierania aplikacji dla wszystkich i bez wysyłania haseł z aplikacji.

**Testy ACL-01–10:** role×grant×owner×tenant; znany URL; sesja revoked; wymuszona zmiana hasła; dwa ostatnie adminy; wyłączony assignee; auditor route; reviewer tylko operacyjny audit; brak download reviewera nawet przy fladze; błąd audytu rollback.

**Bramka:** każda rola ma użyteczny końcowy przepływ i serwerowo potwierdzone granice danych.

## 5. PL-05 — zatwierdzanie korekt i rozstrzyganie konfliktów

**Pliki:** `imports.ts`, `entity-grouping.ts`, `entity-grouping-service.ts`, `canonical-run-service.ts`, `db.ts`, `audit.ts`, `authorization-*`, `enrichment-review.tsx`. **Projektowane:** `data-review.ts`, testy HTTP/DB, komponent decyzji w `/review`.

### 5.1. Korekty REGON

1. PL-05.01: zachowaj tworzenie propozycji `pending`. Dodaj projektowane `GET /api/review/corrections?...` oraz `POST /api/review/corrections/:id/decision` z `{ decision: approved|rejected, expectedRowVersion, reasonCode }`.
2. PL-05.02: decyzja należy do admin/reviewer z grantem; operator może proponować, nie zatwierdzać. Powód w audit to bezpieczny kod; nie przenoś swobodnego powodu ani numeru REGON do metadanych audytu.
3. PL-05.03: transakcja blokuje source row, pending correction i niezbędne relacje zgodnie ze wspólnym porządkiem blokad. Po uzyskaniu blokad ponownie sprawdź stan/wersję/tenant/uprawnienia.
4. PL-05.04: jeżeli source row należy do aktywnego runu/niezakończonej przyjętej partii, odmów mutacji operacyjnej 409 z instrukcją rozstrzygnięcia/anulowania. Nie aktualizuj danych, na które pracują adaptery.

   Ochrona oczekującej partii dotyczy rekordów przypiętych do nadal aktywnej eligible group; rekord wykluczony w preview jako wymagający korekty nie może być zablokowany samą obecnością w historycznej liście items. Po korekcie jego uruchomienie wymaga nowego świadomego preview/submission.
5. PL-05.05: approved: ponownie waliduj REGON; zapisz reviewerRef/date, status, effectiveRegon i zwiększ rowVersion. RegonRaw/original regon pozostają historycznym źródłem; wylicz issues ponownie wspólną regułą walidacji, nie usuwaj całej tablicy issues.
6. PL-05.06: odrzucona propozycja zmienia tylko decyzję i wersję zgodnie z kontraktem; nie przepisuje effectiveRegon. Replay tej samej zakończonej decyzji może zwrócić istniejący rezultat; inna decyzja dla zakończonej propozycji to 409.
7. PL-05.07: zaktualizuj/usuń nieaktualny source entity link i ponownie oceń grupowanie w tej samej kontrolowanej operacji. Refaktoryzuj grouping do helpera przyjmującego transaction, unikając niezależnej zagnieżdżonej transakcji po częściowym zapisie.
8. PL-05.08: audyt zatwierdzenia/odrzucenia rozszerza union w `audit.ts` i DB CHECK nową migracją. Wszystkie dane, relacje, decyzja i wymagany audit commitują atomowo.

### 5.2. Konflikty podmiotów

9. PL-05.09: dodaj projektowane `GET /api/review/conflicts?...` i `POST /api/review/conflicts/:id/resolution` z `{ expectedRowVersion, resolution: link_existing|recheck|reject_link, canonicalEntityId?, reasonCode }`. Docelowe nazwy/statusy mają pasować do istniejących CHECK po przeglądzie schematu.
10. PL-05.10: ekran pokazuje rodzaj rozbieżności i dane potrzebne reviewerowi do decyzji w jego zakresie. Nie proponuj podobnej nazwy jako dowodu tożsamości.

   Kandydat canonical musi mieć sprawdzony zakres przez powiązanie source→import→tenant; samo ID z body nie uprawnia do odczytu jego nazwy ani powiązania. Obecne canonical_entities nie ma tenant_id, więc sprawdź izolację tej relacji przed udostępnieniem nowego API. Globalna unikalność identyfikatorów nie może służyć jako obejście granicy danych. Ewentualną zmianę schematu opisz i odbierz addytywnie; nie wdrażaj wieloorganizacyjnej administracji dla potrzeb tego ekranu.
11. PL-05.11: `link_existing` dopuszcza wyłącznie identyfikatory zgodne z wybranym podmiotem i potwierdzonymi danymi. Sprzeczny REGON/NIP wymaga najpierw zatwierdzonej korekty danych; nie omijaj unikalności canonical_entities.
12. PL-05.12: nie twórz dwóch canonical entities z tym samym unikalnym NIP lub REGON. „Rozdzielenie” oznacza skorygowanie błędnych identyfikatorów albo odrębny leadIdentityKey dla innej osoby w tym samym podmiocie. Nie dodawaj fikcyjnego ID, aby obejść konflikt.
13. PL-05.13: resolve blokuje konflikt/source/link/entity; potwierdza open/version i brak skutków aktywnego runu. Zapisuje właściwy matchMethod, decyzję, wersję oraz audit. Przy nierozstrzygniętym stanie rekord pozostaje review i nie startuje.
14. PL-05.14: UI ma zatwierdź/odrzuć/przelicz, czytelne skutki, loading/409 i aktualizację listy. Rola operatora widzi status swojej propozycji; nie renderuje aktywnych kontrolek decyzji.

**Testy REV-01–10:** approved zmienia effectiveRegon; rejected go zachowuje; raw zachowany; błędny REGON; wyścig dwóch decyzji; stale version; aktywny run; sprzeczne canonical ID; rollback audytu; poprawne przeliczenie issues i grupy. Użyj aktualnie prawidłowych wartości syntetycznych z istniejących fixtures.

**Bramka:** pending/conflict ma końcową obsługiwaną decyzję, a jej skutki są atomowe i nie podmieniają trwającej automatyzacji.

## 6. PL-06 — produkcyjne wzbogacanie NIP → REGON

**Istniejące:** `registry-provider.ts`, `registry-lookup.ts`, `registry-result.ts`, `registry-enrichment.ts`, `entity-grouping-service.ts`, `module.ts`, `db.ts`. **Projektowane:** `registry-provider-factory.ts`, adapter wybranego rejestru, `enrichment-jobs.ts`, runner zadań rejestrowych, komponent postępu i migracje.

### 6.1. Provider i trwałość zadania

1. PL-06.01: sprawdź decyzję właściciela o źródle rejestru i wymaganym dostępie. Przed implementacją konkretnego adaptera przeczytaj aktualną oficjalną dokumentację wybranego rejestru; nie wymyślaj URL, formatu odpowiedzi ani sposobu uwierzytelnienia.
2. PL-06.02: factory przez DI wybiera `off` albo wybrany provider; brak konfiguracji jest jawną niedostępnością, nie syntetycznym sukcesem. Provider fixture jest dostępny wyłącznie w harnessie testowym.
3. PL-06.03: adapter realizuje istniejący `RegistryProvider.lookupByNip(nip, signal)`, respektuje AbortSignal, mapuje odpowiedź na RegistryProviderResult i błędy na stałe kody. Nie loguje URL z identyfikatorem, poświadczeń ani raw body.
4. PL-06.04: zachowaj istniejący coordinator retry/cache/timeout. Jego cache i deduplikacja są procesowe — dla wielu procesów zastosuj jeden właścicielski runner rejestru lub trwałe lease i ograniczenie globalne. Nie twierdź, że in-memory semaphore ogranicza wszystkie instancje.
5. PL-06.05: projektowane tabele `enrichment_jobs` i `enrichment_job_items`: job ID, tenant/import/actor, idempotencyKey+requestHash, status, timestamps; item sourceRowId+expectedRowVersion, state, errorCode, retry/nextAttemptAt/lease. Unikalność item `(job_id,source_row_id)` i job `(tenant_id,actor_user_id,idempotency_key)`.
6. PL-06.06: w trwałym zadaniu/kolejce zapisuj ID i kody, nie pełną odpowiedź rejestru. Dobór danych odbywa się przez source row w DB. Grupuj kwalifikujące wiersze po poprawnym NIP; jeden lookup może obsłużyć kilka wierszy, ale walidacja nazwy/wersji odbywa się osobno dla każdego.
7. PL-06.07: granice job/item mają CHECK, FK i indeks `(state,next_attempt_at)`. Runner wybiera tylko własne należne zadania; restart odtwarza pracę. Wzbogacenie jest oddzielną kolejką od portali, więc awaria rejestru nie blokuje OC z poprawnym REGON.

### 6.2. API, zapis i UI

8. PL-06.08: projektowane `POST /api/imports/:id/enrichment-jobs` z wyborem rows/range i `idempotencyKey`, `GET /api/enrichment-jobs/:id`, `POST /api/enrichment-jobs/:id/cancel`. Aktor musi mieć prawo operacji na własnym imporcie lub być adminem; reviewer nie wykonuje lookupu przez sam grant odczytu.
9. PL-06.09: start waliduje właściwe rekordy z pustym REGON i poprawnym NIP; nie nadpisuje istniejącego effectiveRegon i nie dotyka raw. Replay tego samego payloadu zwraca ten sam job; ten sam klucz z inną treścią to 409.
10. PL-06.10: wykonaj transport poza transakcją DB. Następnie blokuj item/source i ponownie sprawdź lease, wersję, kwalifikację, brak pending correction i aktywnego runu. Użyj/refaktoryzuj `recordResult`, aby wspierał ten sam transaction kontekst z finalizacją itemu.
11. PL-06.11: wynik matched zapisuje effectiveRegon, provenance, rowVersion i aktualną walidację issues; później grupowanie. Samo dodanie REGON nie wystarcza, gdy issues nadal zawiera brak tego numeru. Pozostałe błędy walidacji zostają zachowane.
12. PL-06.12: dla not_found/ambiguous/manual_review zapisz stan przeglądu. Dla timeout/rate limit/unavailable zapisz kontrolowane nextAttemptAt z limitem; nie wkładaj błędu transportu w CHECK przewidziany tylko dla decyzji rejestru. Po wyczerpaniu retry pokaż dalszą akcję.
13. PL-06.13: jeśli odpowiedź już zastosowano, a worker stracił potwierdzenie, replay rozpoznaje zakończony item i nie zwiększa wersji ponownie. Stale row version kończy item kodem konfliktu i wymaga świadomego ponowienia po przeglądzie.
14. PL-06.14: UI pokazuje liczniki kwalifikujących, ukończonych, review, błędów i anulowanych; źródło/datę/proweniencję z istniejących danych. Anulowanie nie cofa wcześniej zastosowanych poprawnych rezultatów.
15. PL-06.15: odbierz provider na dozwolonym środowisku/danych, gdy dostęp zostanie zapewniony. Do tego momentu oznacz „mechanizm odebrany syntetycznie, provider nieodebrany”, nie „REGON działa produkcyjnie”.

**Testy REG-01–11:** poprawny NIP i wynik; brak/wiele/obcy podmiot; niepoprawna odpowiedź; timeout abortuje transport; 429/retry-limit; jeden lookup dla powtarzanego NIP; korekta w trakcie requestu; replay po utraconej odpowiedzi; restart; cancel; brak konfiguracji nie generuje sukcesu.

**Bramka:** kompletna ścieżka platformy na fixture, osobno aktualny dowód połączenia z zatwierdzonym rejestrem.

## 7. PL-07 — wybór zakresu, trwała partia i dispatch

**Istniejące:** `runs.ts`, `canonical-run-service.ts`, `entity-grouping-service.ts`, `run-queue.ts`, `db.ts`, `apps/worker/src/run-worker.ts`, `execution-lease.ts`. **Projektowane:** `submissions.ts`, `submission-planner.ts`, `submission-dispatcher.ts`, migracje/model i UI partii.

### 7.1. Jednoznaczny model i semantyka

`ImportBatch` nadal oznacza import Excela. Nową partię uruchomień nazwij `RunSubmission`/`run_submissions`; nie przeciążaj słowa batch drugim schematem i nie zmieniaj `automation_runs.batch_id` na ID partii uruchomień.

Projektowane dane:

| Tabela | Minimalne pola i ograniczenia |
| --- | --- |
| `run_submissions` | submission_id, import_batch_id, tenant_id, tool_id, actor_user_id, idempotency_key, request_hash, reference_date, status, version, created_at, updated_at; unique tenant/actor/idempotency_key; FK do importu/użytkownika/narzędzia |
| `run_submission_items` | item_id, submission_id, source_row_id, expected_row_version, group_id nullable, preparation_state, reason_code; unique submission/source; zachowuje także niegotowe/wykluczone rekordy |
| `run_submission_groups` | group_id, submission_id, canonical_entity_id, lead_identity_key, run_id nullable, admission_state, next_attempt_at, lease_owner/expiry, version; unique submission/canonical/lead; run przypięty raz |

Item odnosi się do wiersza, group do unikalnego planowanego runu. Przebieg runu czytaj przez istniejące automation_runs. Nie kopiuj wszystkich statusów runu do drugiej tabeli ani nie utrzymuj niespójnych liczników w pamięci.

Rozdziel **zarejestrowaną partię** od **przyjętego runu**. Przy limicie lub poza oknem grupa bez run_id oczekuje na przyjęcie i nie ma jeszcze outboxa. Po przyjęciu runu pauza nowych startów nie anuluje go ani retry jego outboxa. Pauza blokuje tylko nowe przyjęcia, również z wcześniej zarejestrowanej partii. UI ma wyraźnie opisywać tę różnicę.

### 7.2. Wybór, preview i start

1. PL-07.01: wprowadź kontrakt wyboru: lista rowNumbers albo zakres fromRow–toRow, zawsze w jednym imporcie. Waliduj liczby, brak duplikatów, limity żądania, źródłowe numery wierszy i zgodność uprawnień. Nie interpretuj ich jako pozycji aktualnie filtrowanej strony.
2. PL-07.02: projektowane `POST /api/imports/:id/run-submissions/preview` zwraca kwalifikację, counts i `selectionFingerprint` powiązany z wyborami/rowVersion/grupami; dla dużego wyboru szczegóły są stronicowane, a preview nie tworzy ofert/runów.
3. PL-07.03: rozróżnij selected rows, ready rows, unique groups, already-active, needs-review i excluded. Brak opcjonalnej osoby nie jest błędem importu; jeżeli adapter nie umie ustalić jej jednoznacznie, zaplanuj późniejszą identity intervention, nie podstawiaj osoby.
4. PL-07.04: projektowane `POST /api/imports/:id/run-submissions` przyjmuje wybór, fingerprint i idempotencyKey. Payload hash powstaje z kanonicznie posortowanego wyboru i parametrów, bez danych klienta.
5. PL-07.05: transakcyjnie ponownie sprawdź wersje i grupowanie z preview. Zmieniony wybór/dane to 409 „Odśwież podsumowanie”, nie częściowy start na innych rekordach. Utrwal wszystkie wybrane items i eligible groups w jednej kontrolowanej operacji; walidacja trwa poza długą blokadą, a warunki końcowe w transakcji.
6. PL-07.06: referenceDate przypnij z daty Warsaw przy rejestracji partii. Wszystkie jej nowe runy używają tej daty, także po północy. Single-row zachowuje dotychczasową datę startu. Zmiana daty nie może nastąpić przy retry.
7. PL-07.07: replay identycznego klucza zwraca tę samą submission, nawet jeśli limit/pauza od tamtej pory się zmieniły. Ten sam klucz z innym payloadem to 409. Kontrolę sesji/ownership zawsze wykonuj aktualnie.

### 7.3. Przyjęcie i wykonywanie grup

8. PL-07.08: dispatcher pobiera ograniczoną liczbę należnych groups z lease/CAS; claim nie powinien trzymać długiej transakcji ani obejmować działań w przeglądarce. Worker portalowy nadal otrzymuje tylko runId przez obecny outbox.
9. PL-07.09: przed przyjęciem sprawdź aktywność konta, grant, tool status, wersję source, brak korekt/konfliktów, enabledForNewRuns, okno i limit. Cofnięte konto/grant daje jawne blocked; admin może przejąć oczekującą pracę osobną audytowaną decyzją. Nie podpisuj startu jako nieaktywnego operatora.
10. PL-07.10: refaktoryzuj `CanonicalRunService.createOrGet`, by przyjmował transakcję/admission context i zweryfikowaną wewnętrznie referenceDate. Metoda publiczna single-row i dispatcher używają wspólnej logiki; nie zduplikuj limitera.
11. PL-07.11: ustal wspólny porządek blokad dla wszystkich startów: settings tenant/tool → import → source rows w kolejności ID → canonical entity → group/run. Zmień istniejący start, który obecnie uzyskuje settings dopiero po innych blokadach; odbierz dwa starty i konflikty deadlock. Przejrzyj inne operacje dotykające tych relacji.
12. PL-07.12: transakcja jednocześnie rezerwuje miejsce w limicie, tworzy albo dołącza właściwy run, zapisuje group.run_id, RunSourceRow i outbox oraz audit. Nie commituj runu bez powiązania z grupą ani powiązania bez outboxa dla nowego runu.
13. PL-07.13: limit jest limitem **nowych przyjętych kanonicznych runów w ruchomych 60 minutach**, nie liczbą kliknięć ani wierszy/dispatch retries. Dołączenie tego samego aktywnego runu nie zużywa dodatkowego miejsca.
14. PL-07.14: istniejący aktywny run z inną referenceDate nie może udawać wyniku z daty partii. Zablokuj grupę do przeglądu/świadomego odłożenia, nie twórz równoległego runu dla obejścia unikalności.
15. PL-07.15: przy limicie/oknie ustaw reasonCode i nextAttemptAt; unikaj pętli szybkich 429. Brak settings jest błędem konfiguracji, nie nieograniczonym trybem. Reconcile po restarcie korzysta z DB i lease.
16. PL-07.16: gdy group.run_id istnieje, retry nie może utworzyć nowego runu nawet po completed/failed/cancelled. Świadome ponowne przetworzenie jest nową submission z nowym kluczem i audytem; nigdy automatycznym skutkiem utraty odpowiedzi.

### 7.4. Kontrola, anulowanie i postęp

17. PL-07.17: projektowane `GET /api/run-submissions/:id`, `GET /api/run-submissions/:id/items?cursor...`, `POST /api/run-submissions/:id/cancel` z expectedVersion. DTO rozdziela liczniki wierszy i unikalnych runów; suma kategorii w każdym wymiarze musi się zgadzać.
18. PL-07.18: anulowanie zatrzymuje grupy nieprzyjęte i cancelleable oczekujące runy zgodnie z istniejącą polityką. Aktywnego runu nie oznaczaj cancelled bez skutecznego zatrzymania; nie cofaj wykonanego zapisu w portalu. Przy współdzielonym runie nie anuluj go, jeśli istnieje inne aktywne żądanie, które nadal go wymaga.
19. PL-07.19: submission kończy się, gdy wszystkie wybrane elementy mają wynik/zero/błąd/wykluczenie/anulowanie; open intervention jest jawnie waiting_attention. Błąd jednego elementu nie blokuje niezależnych groups i nie oznacza sukcesu całej partii.

   Wykluczone niegotowe items są rozliczone kodem powodu i nie czekają bez końca na zmianę danych. Poprawione dane można wybrać w nowej submission. Groups blocked przez brak grantu lub konflikt przyjęcia wymagają jawnej decyzji; nie przestawiaj ich automatycznie na completed.
20. PL-07.20: UI przed startem pokazuje zakres i podsumowanie, a potem trwały ekran postępu z powrotem do historii. Dwa kliknięcia i odświeżenie używają tej samej submission. Polling nie pokrywa całej tabeli i nie nakłada requestów.

**Testy SUB-01–15:** lista/zakres; mixed valid/review; powtarzane źródła; dwie osoby w firmie; ten sam klucz; konflikt klucza; dwa starty przy limicie 1; single-row przeciw partii przy limicie 1; północ/referenceDate; pauza i retry przyjętego runu; restart po commit przed odpowiedzią; anulowanie vs dispatch; współdzielony run; cofnięty grant; terminal replay nie tworzy nowego runu.

**Bramka:** trwały, kontrolowany start zakresu bez niejawnych duplikatów, z jednoznacznym końcowym rozliczeniem każdego rekordu.

## 8. PL-08 — interwencje, SMS i wynik

**Pliki:** `interventions.ts`, `manual-data.ts`, `manual-data-contract.ts`, `auth-challenges.ts`, `sms-retry-policy.ts`, `runs.ts`, `worker-results.ts`, `artifact-download.ts`, worker `live-run.ts`, `code-inbox.ts`, `result-forwarder.ts`, `result-staging*`; UI workspace i nowe szczegóły.

### Kroki

1. PL-08.01: zachowaj jedno otwarte zgłoszenie na run, rozdzielenie markRead/assignment/resolution i rewizję. Listy globalne wykorzystują paginację PL-02/03 oraz aktualne role.
2. PL-08.02: z nowego linku runu/interwencji otwieraj właściwy stan i portal; nie podstawiaj ostatnio wybranego zadania z Reacta. Sprawdź aktualny challengeId/status/deadline.
3. PL-08.03: przypisany operator bez view_results widzi minimalny kontekst SMS i może podać kod; nie dostaje danych polis, importu właściciela ani linku download.
4. PL-08.04: pole kodu czyści się po próbie/zmianie challenge; kod nie trafia do storage/URL. Termin odliczaj lokalnie z expiresAt, bez requestu co sekundę. Expiry/attempt limit wyłącza submit i przedstawia dozwoloną dalszą akcję.
5. PL-08.05: submit/resend działa tylko dla aktualnego challenge i dopuszczonego cyklu. Resend jest jawną akcją z dotychczasowym limitem; nie resetuj czasu pierwotnego cyklu po błędnym wpisaniu kodu.
6. PL-08.06: niepewna dostawa nie może automatycznie wysłać ponownie tego samego kodu. Zachowaj kontrolowane zatrzymanie i bezpieczne reasonCode; restart MFA odbierz przez prawdziwe API/DB/worker fixture.
7. PL-08.07: ręczne poprawki danych: allowlista istniejącego kontraktu, expectedVersion, autor i audit, brak ręcznego PESEL. Read/review/resume są odrębnymi czynnościami. Reviewer może rozstrzygać tylko przypisane mu w polityce rodzaje decyzji, nie wykonywać loginu SMS.
8. PL-08.08: dla resume określ checkpoint i dozwolony zakres zmiany; utracony szkic lub niepewny zapis kieruje do interwencji. Samo kliknięcie „Rozwiązano” nie potwierdza skutku Compensy.
9. PL-08.09: wyniki pokazują total/current counts i zapisane referenceDate. Zero jest no_matching_policies bez pliku. Niekompletny UFG albo błąd to inny stan; nie prezentuj go jako zero.
10. PL-08.10: zwróć powiązania RunSourceRow, aby z duplikatu można było otworzyć wspólny run/result. Nie używaj jedynie automation_runs.row_number jako wszystkich obsłużonych wierszy.
11. PL-08.11: pobranie sprawdza aktualną sesję/rolę/grant/ownership i integralność pliku. Brak/uszkodzenie/storage unavailable ma bezpieczny komunikat oraz odpowiedni kod. Nigdy publiczny URL katalogu exports.
12. PL-08.12: zachowaj executionId/workerSessionId na granicy wyników. Replay dostarczenia/eksportu daje jeden snapshot i artefakt; po niedostępnym API worker odtwarza staging bez powrotu do portalu.
13. PL-08.13: zbierz fixture counters akcji login/save/UFG i dowody DB/outbox/incident. Nie używaj osobnego „łatwiejszego” procesora, który omija produkcyjny LiveRunProcessor.

**Testy INT-01–12:** przypisany SMS bez wyników; obcy challenge; kod zaakceptowany/odrzucony; timeout i jedno resend; dwa równoległe submit/resend; niepewna dostawa; restart MFA; ręczne dane CAS; close/markRead nie rozwiązuje; zero vs incomplete; uszkodzony plik/odebrany grant; API down po UFG/stary worker.

**Bramka:** modal/UI→prawdziwe API→DB/Redis→worker fixture→wynik/pobranie przechodzą jako jeden proces i nie ujawniają kodu w trwałych magazynach.

## 9. PL-09 — ustawienia, operacje, audyt i raporty

**Pliki:** `admin.ts`, `admin-reports.ts`, `audit.ts`, `canonical-run-service.ts`, `health.ts`, `health-readiness.ts`, `runs.ts`, `artifact-download.ts`, `db.ts`; PL-07 dispatcher; strony admin/audit/results.

### 9.1. Ustawienia i centrum operacyjne

1. PL-09.01: sprawdź, czy każdy pokazany parametr ma wykonującą go regułę: enabledForNewRuns, maxNewRunsPerHour, local start/end, timezone i version. Nie dodawaj nieegzekwowanych ustawień.
2. PL-09.02: start single-row i admission grup partii używają tej samej transakcyjnej kontroli ustawień/limitu. Dwie równoległe rezerwacje na limicie 1 dają jeden nowy run; drugi jest 429 albo grupa pozostaje oczekująca, zależnie od API.
3. PL-09.03: przyjmij istniejącą semantykę limitu ruchomych 60 minut. Okno pracy ma jawny początek włącznie/koniec wyłącznie, obsługuje przejście przez północ i timezone. start=end wymaga jawnej walidacji zgodnej z kontraktem, nie ukrytego znaczenia „zawsze”.
4. PL-09.04: pauza zatrzymuje nowe admission, nie anulowanie przyjętych runów. Replay przyjętego runu/outboxa nie zużywa nowego limitu i nie znika po pauzie.
5. PL-09.05: settings CAS i audit zapisują się atomowo. Przy 409 UI pokazuje nowe ustawienie i zachowuje szkic do porównania; nie ponawia zapisu automatycznie.
6. PL-09.06: centrum pokazuje osobno liveness API, readiness DB/Redis, worker heartbeat, portal mode/config, pending outbox i oczekujące submission groups. „Usługi działają” nie oznacza „portale odebrane live”.
7. PL-09.07: diagnostyka zadań bez lease ma bezpieczny kod i instrukcję. Akcja admina wznowienia używa istniejącego run/resume/checkpoint, nie dowolnego „retry każdego statusu”. Nie umożliwiaj z panelu zdalnego restartowania kontenerów.

**Testy OPS-01–07:** CAS; równoległy limit; pause accepted run; midnight/DST/window; Redis down/worker stale; pending outbox po restartach; nieprawidłowa konfiguracja i brak grantów.

### 9.2. Spójność identyfikatorów audytu

8. PL-09.08: zinwentaryzuj resourceType/resourceId każdej akcji. Bieżące `runs.ts` zapisuje pobranie jako artifact z runId; audit tool filter oczekuje artifactId, a overview downloads wiąże wpis po runId.
9. PL-09.09: ustal docelowy kontrakt `artifact.downloaded → resourceType=artifact, resourceId=artifactId`. Zwracaj artifactId z wewnętrznego wyniku download service; nie wyprowadzaj go z nazwy pliku. Opcjonalny runId w metadanych to tylko bezpieczny identyfikator, nie dane polis.
10. PL-09.10: w jednym wydaniu popraw writer, audit tool filter, reports downloads i testy. Dodaj wersję semantyki bezpiecznego metadata dla nowych eventów, aby rozróżniać nowe i historyczne wpisy.
11. PL-09.11: zachowaj stare eventy bez nadpisywania ich treści. Warstwa read ustala effective artifact/run relation: nowy wpis przez artifactId; oznaczony legacy przez runId. Dla historycznych bez wersji rozstrzygaj jawnie po istniejącej relacji i rodzaju akcji; przy braku/niejednoznaczności nie zgaduj, pokaż nierozwiązane powiązanie w diagnostyce admina.
12. PL-09.12: jedno zdarzenie pobrania policz raz, także gdy obie ścieżki join są dostępne. UI pokazuje właściwy szczegół zasobu tylko po jego autoryzacji.
13. PL-09.13: rozszerz audit actions/resourceType i DB constraints dla decyzji korekty, conflict, submission/enrichment job i kontroli utrzymania. Przy filtrze narzędzia uwzględnij correction→source→import, conflict→source→import, submission/job→import oraz existing run/artifact/intervention.
14. PL-09.14: reviewer dostaje tylko allowlistę operacyjnych akcji/typów i obecnie przydzielone narzędzia z PL-04. Wpisy user/session/tool_grant/settings pozostają niedostępne. Auditor ma dziennik swojego tenanta, bez payloadów operacyjnych.

**Testy AUD-01–08:** nowy i legacy download; filtr tool; brak podwójnego count; correction/conflict/submission filters; audit rollback; 90-dniowe granice i cursor; reviewer allowlista; metadata bez sekretów/danych osobowych.

### 9.3. Raporty i skala

15. PL-09.15: przygotuj mały ręcznie policzony fixture obejmujący completed, no_matching_policies, failed, cancelled, in_progress, ponowiony delivery i otwarte/rozwiązane interwencje. Wyznacz expected counts przed odpaleniem testu, nie wyliczaj ich tą samą funkcją SQL.
16. PL-09.16: zachowaj jawne definicje: created po created_at; zakończenia po finished_at; completionRate według obecnego opisowego mianownika. Dla partii pokaż osobno rows/groups/runs; nie licz każdego duplikatu wiersza jako osobnego wykonania portali.
17. PL-09.17: odbierz from inclusive/to exclusive w Warsaw, format ISO i DST; cancelled nie może trafiać do „w toku”. Retry nie jest nowym runem. Zero polis nie jest failed.
18. PL-09.18: agregacje mają SQL scope tenant/tool i tylko uprawniony zakres. Auditor nie uzyskuje raportów operacyjnych przez link dziennika. Parametry/whitelist/limity zakresu czasu pozostają sprawdzane.
19. PL-09.19: przeprowadź pomiar importu około 30 tys. syntetycznych wierszy, list i raportów przy reprezentatywnej historii; zmierz czas odpowiedzi/pamięć/query plan. Ustal z właścicielem docelowy czas i hardware przed deklarowaniem SLA.
20. PL-09.20: usuń potwierdzone pełne odczyty/N+1. `EntityGroupingService.resolveRelatedRows` obecnie czyta wszystkie wiersze importu — dla wielu startów partii zastąp to zapytaniem o właściwe NIP/REGON/grupę z indeksami. Nie wykonuj pełnego skanu 30 tys. rekordów dla każdego wiersza.

**Testy REP-01–07:** known counts; daty i DST; retry; zero/cancelled; tenant/tool; row-vs-group counts; pomiar dużego importu bez nieograniczonego pobierania tabel.

**Bramka:** ustawienia działają przy wszystkich startach, a audit/raporty zgadzają się z danymi źródłowymi także dla starszych wpisów.

## 10. PL-10 — odbiór UX i pełnych ścieżek produktu

**Pliki:** nowe strony i komponenty, `workspace.tsx`, `enrichment-review.tsx`, `/admin`, `/account`, style; istniejące UI smoke; projektowany `platform-flow-smoke.cjs` i runner `test:platform-e2e`.

### 10.1. Interfejs

1. PL-10.01: wykorzystaj istniejące tokens/theme, logo i fonty. Każda nowa strona ma tytuł, rzeczywistą nawigację, puste stany, błędy, loading i link do dalszej czynności. Nie zastępuj funkcji dekoracyjnymi kaflami.
2. PL-10.02: wszystkie input/select mają label, akcje button, nawigacja link. Ikony mają nazwę albo są ukryte dla AT; widoczny fokus i skip-link do main.
3. PL-10.03: dialog ma focus trap, Escape, przywrócenie fokusu i opis skutku. Błędy inline/role alert; po walidacji fokus wskazuje pierwsze błędne pole. Timer nie zasypuje czytnika ekranu.
4. PL-10.04: tabele przewijają się we własnym obszarze; 320/375/768/1440/1920 px bez poziomego scrolla całej strony. Długie nazwy i komunikaty nie zasłaniają akcji.
5. PL-10.05: filtry/sort/page/selected IDs w URL. Linki można otworzyć w nowej karcie, Back wraca do poprzednich filtrów. returnTo dopuszcza tylko wewnętrzne ścieżki, zapobiegając przekierowaniu poza aplikację.
6. PL-10.06: przy niezapisanej korekcie/ustawieniu ostrzeż przed utratą zmian. Nie wyświetlaj podwójnych potwierdzeń przy zwykłym przejściu bez zmian. Animacje respektują reduced motion; sprawdź kontrast tekstów i stanów.

### 10.2. Runner rzeczywistego backendu

7. PL-10.07: rozszerz izolowany runner PL-01 o `test:platform-e2e` (projektowana komenda). Uruchom świeże DB/Redis, migracje, prawdziwy AppModule i Next, produkcyjny worker z portal fixtures oraz syntetyczny provider rejestru.
8. PL-10.08: browser nie używa `page.route` do odpowiedzi API w odbiorze całości; requests idą do rzeczywistego backendu. Nie podstawiaj guardów, SessionGuard ani uproszczonego procesora. Fixture dotyczy zewnętrznych usług/portali.
9. PL-10.09: logowanie i CSRF wykonuje realny użytkownik przez formularz. Sprawdzenia DB/Redis i liczniki fixture potwierdzają skutek; sam tekst PASS na ekranie nie wystarcza.
10. PL-10.10: istniejący `automation-flow-smoke` obejmuje siedem scenariuszy, ale `modalUI=false`. Podłącz modal do tego samego backendu albo wspólnego harnessu, nie tylko zwiększaj liczbę mockowanych smoke.
11. PL-10.11: rozszerz wymagane przypadki awarii z A8: restart w MFA, zapis/UFG, utracony lease, API down po odczycie, niekompletny wynik, zero i nieznany ekran. Testy mają dowodzić ograniczonej liczby save/UFG i poprawnego stanu interwencji.
12. PL-10.12: na końcu skanuj kontrolowane magazyny fixture po syntetycznym kodzie SMS oraz pola/klucze nieprzeznaczone do niego. Kod testowy/logi nie mogą drukować wartości SMS; testy warstwy pamięci kodu należy odróżnić od trwałych magazynów.
13. PL-10.13: harness raportuje statusy DB/outbox, liczbę działań fixture i artefakt zgodny z ustaloną datą; w `finally` zamyka przeglądarki/procesy i usuwa wyłącznie własne zasoby.

### 10.3. Minimalne scenariusze końcowe

| ID | Ścieżka i oczekiwany skutek |
| --- | --- |
| E2E-01 | Admin tworzy operatora → operator musi zmienić hasło → bez grantu nie widzi/nie uruchomi narzędzia |
| E2E-02 | Admin nadaje grant → operator importuje → logout/login/F5 → otwiera ten sam import i historię |
| E2E-03 | Operator proponuje korektę → reviewer zatwierdza → rekord jest operacyjnie poprawny; drugi reviewer ma 409 |
| E2E-04 | Rejestr fixture uzupełnia zgodny REGON, niejednoznaczny wynik trafia do przeglądu, konflikt zostaje rozstrzygnięty |
| E2E-05 | Wybór mixed rows → preview → submission → dwa kliknięcia → jeden zestaw kanonicznych runów; limity zachowane |
| E2E-06 | Worker żąda SMS → powiadomienie → modal → kod → wynik; assignee bez wyników nie może pobrać pliku |
| E2E-07 | Timeout/błędny kod → dozwolone wznowienie → wynik albo limit/interwencja; brak automatycznej pętli loginu |
| E2E-08 | Wygaśnięty lease/restart/API failure → recovery tego samego runu, bez nowej oferty/UFG i bez duplikatu eksportu |
| E2E-09 | Gotowy wynik pobrany → event znajdowany w audit po toolId → raport liczy jeden download; zero bez pustego XLSX |
| E2E-10 | Odebrany grant/sesja → następny GET/download odmówiony; otwarty incident przechodzi do puli admina |
| E2E-11 | Operator B/obcy tenant próbuje znanych ID → brak dostępu; reviewer nie pobiera, auditor tylko dziennik |
| E2E-12 | Dalsze strony list, strefy/DST, mobile/keyboard, 503 i późne odpowiedzi → zachowany dostępny, spójny UI |

**Bramka:** wszystkie właściwe scenariusze przechodzą bez pominięć w izolowanym środowisku; instrukcje ról opisują rzeczywiście dostępne funkcje.

## 11. PL-11 — retencja, backup, monitoring i wydanie

**Pliki:** `private-artifact-store.ts`, `result-staging.ts`, `db.ts`, `main.ts`, Dockerfile, compose, env examples, health; projektowane maintenance runner, skrypty backup/restore, konfiguracja proxy i instrukcje utrzymania.

### 11.1. Retencja

1. PL-11.01: spisz magazyny i relacje: imports/source, identities/policies/snapshots, submissions/job items, artifacts/export files, staging, audit/logs, profile i backup. Nie utożsamiaj szyfrowania PESEL ze szyfrowaniem całego systemu.
2. PL-11.02: parametry retencji osobne dla typów; produkcyjne usuwanie wyłączone do zatwierdzenia okresów. Dry-run zwraca liczniki i bezpieczne ID, nie dane klientów ani ścieżki prywatne w publicznym API.
3. PL-11.03: ochroną obejmij aktywne runy, oczekujące grupy/job items, otwarte interwencje, niepewne skutki portalowe i rekordy wymagane do ich rozstrzygnięcia. Nie usuwaj źródła trwającego zadania.
4. PL-11.04: cleanup artifact jest dwuetapowy: claim/oznaczenie niedostępności pod blokadą → idempotentne usunięcie zweryfikowanej ścieżki → finalizacja DB. Powtórzenie po przerwaniu nie narusza innych plików. Uzgodnij współbieżne download/export; pobranie rozpoczęte z utrwalonymi bytes może się zakończyć, nowe respektuje stan.
5. PL-11.05: orphans usuwaj tylko ze znanego prywatnego katalogu, po sprawdzeniu braku referencji i okresie zabezpieczającym zapis w toku. Odrzuć symlink/reparse/path poza katalogiem. Windows wymaga weryfikacji pełnej ścieżki i ACL, nie tylko mode 0600.
6. PL-11.06: snapshoty, tożsamości i polityki usuwaj zgodnie z FK/ochroną historii; nie pozostawiaj plaintext eksportu po skasowaniu jego metadanych. Audit ma własną politykę. Profile mają osobną procedurę wyłączenia konta, nie automatyczne cykliczne kasowanie.

**Testy RET-01–07:** expired vs active; open incident; pending submission; download/export race; restart cleanup; path escape/symlink; dry-run nie mutuje. Testy usuwają tylko syntetyczne pliki własnego katalogu.

### 11.2. Backup i odzyskiwanie

7. PL-11.07: skrypt backupu zapisuje spójny dump DB i manifest eksportów/wersji aplikacji. Wolumeny i kopie chronione według docelowego hosta; keyring backup oddzielny od danych. Nie wypisuj connection string ani kluczy.
8. PL-11.08: uwzględnij wszystkie wersje kluczy potrzebne do odszyfrowania danych. Profil kopiuj tylko po kontrolowanym zamknięciu Chromium lub metodą zapewniającą spójność; portal może nadal zażądać MFA.
9. PL-11.09: odtwórz w nowej izolowanej instancji DB/exports i klucze, sprawdź integralność oraz odczyt historycznego wyniku/pobranie. Nie przełączaj odtworzonego workera live; nie przywracaj automatycznie wysłania zadań w portale.
10. PL-11.10: dokument odzyskiwania opisuje wersję aplikacji/schematu, klucze, wyłączony dispatch przy odtworzeniu, weryfikację interwencji/checkpointów i decyzję operatora o wznowieniu. Nie zakładaj, że backup odtworzy ważną sesję portalu.

**Testy BAK-01–04:** pełny restore; brak/zły klucz; uszkodzony/brakujący eksport; odtworzenie nie wykonuje zewnętrznych akcji samoistnie.

### 11.3. Monitoring i wdrożenie

11. PL-11.11: metryki/alerty: stary heartbeat, długi pending outbox/grupa, run bez właściciela, nieobsłużony incident, dysk i backup. Progi i kanał są konfiguracją; zdefiniuj deduplikację, recovery i brak spamowania niezmienionym stanem.
12. PL-11.12: przed podłączeniem rzeczywistego kanału zatwierdź odbiorcę/drogę dostawy. Testy używają sink fixture; wysyłanie realnych wiadomości wymaga właściwej autoryzacji.
13. PL-11.13: API/web Dockerfile — multi-stage, minimum runtime, użytkownik bez roota i jawne prawa katalogów zapisu. Worker zachowuje zgodność wersji Playwright/Chromium i pwuser; nie naprawiaj uruchomienia wyłączeniem TLS/sandbox.
14. PL-11.14: ustaw rzeczywisty HTTPS origin/cookies i proxy. Zastąp bezwarunkowy trust proxy ustawieniem właściwym dla ograniczonej ścieżki sieci; testuj spoofing X-Forwarded-For. Publiczne wejście przez proxy, wewnętrzne API/DB/Redis/code inbox pozostają prywatne.
15. PL-11.15: wykonaj audit zależności/obrazów i oceń reachable paths. Historyczny npm audit wskazał moderate uuid przez exceljs/sequelize; nie stosuj bez oceny downgrade z `audit fix --force`. Aktualizacje odbierz regresją platformy i worker fixtures.
16. PL-11.16: przygotuj release checklist: commit/tag, schema version, konfiguracja bez sekretów w Git, backup/restore proof, rollout i rollback kodu zgodny ze schematem. CI uruchamia niezależne testy oraz izolowany backend; nie wymaga kont portali.
17. PL-11.17: wykonaj próby awarii usług/dysku/backup i sprawdź alarm. Dostarcz instrukcje admina/operatora/reviewera/audytora oraz restartu, pauzy, recovery, zmiany kluczy i utraty profilu.
18. PL-11.18: na docelowym VPS dopiero po platformie i A8 wykonaj nadzorowany A9 oraz test profilu po restarcie. Nie traktuj lokalnego pilota jako odbioru innego hosta/IP.

**Testy REL-01–06:** UID/prawa runtime; HTTPS/cookies/Origin; proxy spoofing; prywatne porty/internal routes; alert dedupe/recovery; rollback/restore rehearsal.

**Bramka:** działająca procedura odzyskania i obserwowania systemu; osobno odnotowany odbiór lokalny/live/docelowego hosta.

## 12. Rejestr projektowanych kontraktów i migracji

### 12.1. Endpointy do utworzenia lub rozszerzenia

| Kontrakt | Pakiet | Zabezpieczenie/uwaga |
| --- | --- | --- |
| `GET /api/imports` | PL-03 | Kolekcja tenant/tool/ownership, cursor |
| `GET /api/history/runs`, `/history/results` | PL-03 | Nowy format, stary `/runs` kompatybilny |
| `GET /api/review/corrections`, `/review/conflicts` | PL-05 | Admin/reviewer + view_results |
| `POST /api/review/corrections/:id/decision` | PL-05 | correction resolver, rowVersion, pending state, CSRF/audit |
| `POST /api/review/conflicts/:id/resolution` | PL-05 | conflict resolver, rowVersion, open state, kontrola canonical identity |
| `POST /api/imports/:id/enrichment-jobs` | PL-06 | Własny execute/admin, idempotency |
| `GET /api/enrichment-jobs/:id`, `POST .../:id/cancel` | PL-06 | Job→import, CAS dla cancel |
| `POST /api/imports/:id/run-submissions/preview` | PL-07 | Execute w zakresie źródła, bez skutków portalowych |
| `POST /api/imports/:id/run-submissions` | PL-07 | Fingerprint wyboru, idempotency, durable items |
| `GET /api/run-submissions/:id`, `/.../:id/items` | PL-07 | Submission→import, rozdzielone counts, paginacja |
| `POST /api/run-submissions/:id/cancel` | PL-07 | Wersja, świadome skutki na shared runs |
| Admin lists, istniejące `/api/audit/events` | PL-02/04/09 | Paginacja/role/historical resource mapping |

Dokładne DTO opisz przy implementacji w wspólnych typach; każde body ma odrzucać nieznane pola. Paginację i compatibility odbierz przed przełączeniem obecnych klientów. Opcjonalna zmiana nazwy endpointu wymaga jednoczesnej aktualizacji planu/testów/UI, nie pozostawienia dwóch sprzecznych opisów.

### 12.2. Migracje addytywne

| Zakres migracji | Wymagana weryfikacja |
| --- | --- |
| Indeksy i ewentualne kolumny wersji/statusów list | Query plans, fresh+upgrade, brak backfillu łamiącego stare rekordy |
| Audit actions/resource types/metadane nowej wersji | Istniejące CHECK zgodne z union; stare eventy czytelne |
| Decyzje danych/indeksy kolejki review | Existing regon_corrections i conflicts nie są tworzone ponownie |
| Enrichment job/items i lease | FK, unique idempotency, statusy/retry, brak raw provider body |
| Submission/item/group | Rozróżnienie importId/submissionId, unique, CAS/lease, pinned run |
| Stan sprzątania artefaktów / maintenance | Compatibility eksportu/download i restore, ochrona active data |

Dla każdej migracji: (1) obecny numer i schema, (2) specyfikacja FK/CHECK/index/backfill, (3) model ORM, (4) świeża baza, (5) upgrade kopii, (6) rerun, (7) zgodność starszej aplikacji przy rollbacku albo jawny warunek braku rollbacku. Nie nazywaj migracji „bezpieczną” bez tych dowodów.

## 13. Kolejność pracy, komendy i bramki

### 13.1. Zależności

1. PL-01 oraz niezależne poprawki PL-02.
2. PL-03 i PL-04: historie, katalog, role/guardy. Wczesny ekran audytora jest częścią pierwszego wydania pakietu.
3. PL-05: pełna ścieżka decyzji danych, wykorzystująca scope/role.
4. PL-06: mechanizm lookup i job. Brak wybranego rejestru blokuje realny adapter, nie fixture ani PL-07 dla gotowych REGON.
5. PL-07: partie po domknięciu wersjonowania/grupowania i kontroli ustawień; nie uruchamiaj ich live tylko dlatego, że UI już działa.
6. PL-08 i PL-09: interwencje/wynik, audyt/raporty i pełna zgodność z partiami.
7. PL-10: cała ścieżka produktu i wymagane awarie bez portali rzeczywistych.
8. PL-11: mechanizmy można przygotowywać wcześniej; końcowy odbiór wymaga zatwierdzonej polityki i docelowego środowiska.
9. A9: odrębny kontrolowany odbiór Everest/Compensy po A8. Nie blokuje projektowania platformy.

Przy niedostępnych usługach wykonuj kod i testy niezależne, ale pozostaw HTTP/DB/Redis gate otwartą. Nie przechodź do live w celu obejścia niedziałającego harnessu.

### 13.2. Komendy istniejące

```powershell
npm test
npm run build
npm run test:playwright -w @goldis/worker
npm run test:admin-ui-smoke -w @goldis/web
npm run test:tool-grants-ui-smoke -w @goldis/web
npm run test:w3-sms-ui-smoke -w @goldis/web
npm run test:w4-enrichment-ui-smoke -w @goldis/web
npm run test:db-integration
npm run test:automation-e2e
```

`test:db-integration` wymaga jawnej izolowanej konfiguracji. `test:automation-e2e` używa `Test-GoldisDatabase.ps1 -Automation` i Dockera. Smoke UI wymaga wcześniejszego builda web i podstawia API; nie odbiera DB. Zwykły `npm test` pomija część Chromium — osobna komenda jest obowiązkowa dla zmian wpływających na worker.

Projektowana nowa komenda: `npm run test:platform-e2e`. Dodaj ją dopiero z działającym runnerem. Do czasu implementacji nie wpisuj jej jako zaliczonej. W CI runner Windows zastąp odpowiednim izolowanym runnerem Linux albo świadomie użyj Windows; sam skrypt PowerShell nie gwarantuje uruchomienia na każdym executorze.

Testy dobieraj do zmiany: helper czasu → kontrakt i UI; nowe serwisy → DB/HTTP; schema → migracje; kolejka → Redis/restart; końcowy pakiet → cała ścieżka. Po przejściu wymaganych checks nie powtarzaj całego suite bez powodu.

### 13.3. Pierwszy konkretny pakiet agenta

1. Ustal baseline PL-01 i testy podstawowe; zanotuj aktualne blokady usług.
2. Wykonaj helper czasu i PL-02.01–06 z dowodem reprodukcji przed/po.
3. Wykonaj paginację PL-02.07–10 i potwierdzenia PL-02.11–13.
4. Wykonaj scope/listy historii PL-03.01–07, potem katalog i powrót do zasobu PL-03.08–13.
5. Udostępnij ekran audytora i test jego ograniczeń z PL-04; resztę ról domknij przed review.
6. Uruchom właściwe testy UI/API i, gdy dostępne, DB; zaktualizuj dziennik, nie deklarując ukończenia PL-05–11.

Pierwszy pakiet kończy się działającą administracją bez błędu czasu, pełnymi listami, historią i dostępem audytora. To reviewable przyrost produktu, nie zakończenie całej platformy.

## 14. Decyzje i sposób dokumentowania

| ID decyzji | Potrzebne ustalenie | Co może wykonywać agent przed odpowiedzią |
| --- | --- | --- |
| DEC-REG | Rejestr i wymagany dostęp do NIP → REGON | Interfejs providera, kolejka, DI, fixture, stany błędów |
| DEC-RET | Osobne okresy dla importów/wyników/staging/logów/audit/backup | Mechanizm i dry-run; usuwanie produkcyjne pozostaje wyłączone |
| DEC-OPS | Docelowy host/domena i droga alertów | Skrypty, template konfiguracji, lokalne testy sink |
| DEC-LIVE | Operator/uprawnione dane/SMS dla A9 | Wszystkie syntetyczne prace platformowe |
| DEC-SCALE | Hardware i oczekiwane czasy przy docelowej skali | Pomiary syntetyczne, usunięcie udowodnionych wąskich gardeł |

Pozostałe rutynowe wybory agent rozstrzyga według tego planu i istniejących reguł. Nie pytaj użytkownika ponownie o już udzieloną zgodę. Decyzja zewnętrzna nie usprawiedliwia pozostawienia niezależnego kodu lub fixture nieukończonym.

Po każdym podpunkcie zewnętrznie istotnym zapisz w `POSTEP_IMPLEMENTACJI.md`:

```text
ID: PL-xx.yy / test ID
Stan: implementacja | moduł PASS | DB/HTTP PASS | UI PASS | BLOCKED
Zmiana: konkretne pliki i zachowanie
Dowód: komenda + exit + liczba testów / fixture counters
Migracja: numer, fresh/upgrade/rerun i ograniczenia
Otwarte: konkretna bramka lub decyzja
```

Zaktualizuj aktualne podsumowanie w `STAN_IMPLEMENTACJI.md`; zachowaj historyczne wpisy jako historię. Uaktualnij instrukcje i kontrakty wokół finalnego zachowania. Raport nie zawiera SMS/sekretów/PESEL ani surowych odpowiedzi portali/rejestru.

## 15. Końcowe kryterium przekazania platformy

- [ ] PL-01–PL-10 mają dowody właściwego odbioru, nie tylko obecność plików.
- [ ] Import, dane do przeglądu, korekta, konflikt, job rejestru, submission, run, incident i wynik mają dostępną dalszą lub końcową czynność.
- [ ] Wszystkie role działają po ponownym logowaniu i po odebraniu dostępu; historyczne zasoby mają bezpieczne linki i paginację.
- [ ] Żaden przyjęty run nie zmienia tożsamości/dat przy retry; żaden terminal replay nie tworzy automatycznie nowej sprawy.
- [ ] Audit i raporty działają dla nowych i legacy rekordów; migracja kopii aktualnej bazy jest potwierdzona.
- [ ] Cały produkt przechodzi przez rzeczywisty backend z fixture portali/rejestru i wymaganymi awariami.
- [ ] PL-11 ma zatwierdzoną politykę i dowody restore/monitoringu przed oznaczeniem wydania do eksploatacji.
- [ ] Osobno podano stan providera rejestru live, A9 portali i hosta docelowego — brak którejś bramki jest jawny.

Agent przekazuje konkretną wersję, listę wykonanych podpunktów, uruchomione testy, dowody i dokładnie wskazane pozostałe blokady. Nie kończy stwierdzeniem „platforma gotowa”, jeśli pozostała niedostępna decyzja danych, nieprzetestowana ścieżka użytkownika lub otwarty wymagany odbiór.

## 16. Szczegółowe przypadki kontrolne o najwyższym ryzyku

Poniższe przypadki uzupełniają grupy testów powyżej. Sprawdzaj rzeczywisty skutek, nie tylko HTTP lub tekst UI. Stosuj losowe bezpieczne syntetyczne ID i liczby z fixtures; podane timestampy to dane testowe.

| ID | Przygotowanie i krok wykonania | Wymagany rezultat |
| --- | --- | --- |
| K-01 | Zapisany dueAt `2026-10-05T12:00:37.123Z`; otwórz formularz i zmień tylko assignee | Wyslane dueAt pozostaje identyczne, sekundy/ms zachowane; wyświetlana godzina Warsaw 14:00; zmieniony wyłącznie przydział i jego rewizja |
| K-02 | Przeglądarka w UTC; wpisz `2026-10-05 14:00` w edytowanym terminie Warsaw | API otrzymuje `2026-10-05T12:00:00Z`; wynik niezależny od strefy browsera |
| K-03 | Wpisz Warsaw `2026-03-29 02:30`, następnie `2026-10-25 02:30` | Pierwsza godzina odrzucona jako nieistniejąca; druga wymaga offsetu +02:00 albo +01:00 i zapisuje wybrany moment; brak cichego przesunięcia |
| K-04 | Użytkownicy ze wspólnym createdAt; pobierz pierwsze 100 i następne | Jednoznaczny tie-break userId, brak pominięć/duplikatów przy niezmienionym zbiorze, dostępny 101. użytkownik także do przydziału |
| K-05 | Operator A pobiera historię, następnie używa kursora A w sesji B lub innym tenancie | Brak odczytu zasobów A; walidowany scope kursora/filtrów i aktualna autoryzacja; bez wycieku counts |
| K-06 | Nadany view_results bez execute; kolejny test discover bez view_results | Pierwszy przypadek odczytuje wyłącznie dopuszczone wyniki bez startu; drugi pokazuje narzędzie bez operacyjnych wyników/download |
| K-07 | Dwie aktywne sesje; revoke jednej, następnie zmiana hasła | Po pierwszej operacji tylko wskazana sesja odrzucona; po zmianie hasła wszystkie poprzednie sesje odrzucone według kontraktu, nowe logowanie działa |
| K-08 | Dwaj ostatni admini równocześnie zmieniają role/wyłączają konto drugiego | Nie pozostaje zero aktywnych adminów; odmówiona operacja nie zapisuje niepełnego statusu ani audytu sukcesu |
| K-09 | Dwaj reviewerzy zatwierdzają tę samą pending correction z tą samą wersją | Jedna skuteczna decyzja, drugi 409 albo identyczny replay wg kontraktu; jeden skutek operacyjny, jeden audit decyzji, raw zachowany |
| K-10 | Próba zatwierdzenia korekty wiersza używanego przez aktywny portalowy run | 409, brak zmiany effectiveRegon/identity/link/checkpoint; UI podaje wymaganą dalszą czynność |
| K-11 | Wykluczony review item w starej submission, potem poprawna korekta | Korekta dopuszczona, stara submission nie startuje rekordu automatycznie; nowy preview/submission może go objąć |
| K-12 | Provider opóźnia wynik; w trakcie powstaje korekta albo rowVersion się zmienia | Stara odpowiedź nie jest stosowana, item ma jawny konflikt i brak nowego effectiveRegon; żaden pełny response nie trafia do logu |
| K-13 | Dwa różne źródłowe wiersze z tym samym NIP i różnymi nazwami | Jeden transport lookup w koordynowanym wykonaniu, dwie odrębne walidacje; nazwa niezgodna nie dziedziczy sukcesu zgodnej |
| K-14 | Dwukrotny POST tej samej submission z tym samym kluczem przed odpowiedzią; potem ten klucz z innym zakresem | Pierwsze dwa zwracają tę samą submission; różny zakres 409; jedna lista items/groups, brak dodatkowych runów/outboxów |
| K-15 | Limit 1/h; single-row i submission group jednocześnie | Jeden nowy AutomationRun i odpowiedni outbox; drugi request 429 albo group waiting_capacity; retry przyjętego runu nie liczy się ponownie |
| K-16 | Submission zarejestrowana przed północą Warsaw, druga grupa przyjmowana po północy | Obie grupy mają referenceDate zarejestrowanej partii; endpoint single-row nadal bierze własną datę startu |
| K-17 | Grupa ma runId zakończonego runu; ponów dispatcher po restarcie | Nie powstaje nowy run, login, save ani UFG; wynik albo błąd poprzedniego runu pozostaje przypięty |
| K-18 | Dwie submissions korzystają z jednego aktywnego runu; anuluj jedną | Niewymagane jej przyszłe groups cancelled; współdzielony run nadal obsługuje drugą; counts pierwszej nie udają cofnięcia zewnętrznego zapisu |
| K-19 | Przyjęty run queued, potem pauza nowych startów; równolegle następna grupa bez runId | Przyjęty run i jego outbox pozostają; nowa grupa czeka, nie tworzy runu podczas pauzy |
| K-20 | Przypisany operator z execute bez view_results otwiera incident, wysyła SMS i próbuje download | SMS przez realny modal działa; wynik/plik pozostają odmówione; code inbox/DB/BullMQ/logi nie przechowują kodu trwale |
| K-21 | Worker odczytał UFG/staging; API niedostępne, następnie restart/recovery | Ten sam run dochodzi do jednego wyniku/XLSX, fixture save/UFG nie rosną; stary lease nie zapisuje rezultatu |
| K-22 | Nowy download event z artifactId i historyczny z runId; filtr audit/report po toolId | Oba odpowiednie eventy są odnajdywane i policzone raz; obcy tool/tenant nie trafia do wyniku; stare eventy nie są nadpisywane |
| K-23 | Błąd insert audit po zmianie settings/decision/assignment | Transakcja cofa zmianę biznesową i powiązane records; UI widzi kontrolowany błąd, nie sukces |
| K-24 | Cleanup na expired artifact równolegle z export/download; przerwij po oznaczeniu DB, przed usunięciem pliku | Działające runy chronione; następny cleanup bezpiecznie kończy to samo usunięcie; brak pliku obcego runu i brak metadata wskazującego gotowy nieistniejący plik |
| K-25 | Odtwórz backup z kluczami, odtwórz ponownie bez klucza, pozostaw portale off | Pierwszy restore odczytuje wynik; drugi kończy bezpiecznym błędem odszyfrowania; żaden restore nie wykonuje live jobów samoczynnie |

## 17. Gotowe polecenie przekazania pracy agentowi

> Zaimplementuj domknięcie platformy Goldis według `docs/PLAN_IMPLEMENTACJI_PLATFORMY_DLA_AGENTA.md`. Zacznij od PL-01 i pierwszego pakietu w sekcji 13.3, następnie realizuj pozostałe PL-01–PL-11 według zależności. Sprawdź aktualny kod i repozytoryjne instrukcje, wykorzystuj istniejące mechanizmy, aktualizuj plan/dziennik po wykonaniu. W każdym pakiecie dostarcz całą ścieżkę API/DB/UI i właściwe testy, nie tylko szkic lub komponent. Portale rzeczywiste pozostają wyłączone; nie używaj danych klienta ani prawdziwego SMS. Brak usług albo decyzji zewnętrznej dokumentuj jako konkretną otwartą bramkę i wykonuj niezależne prace. Odbiór modułów, całej platformy, providera rejestru live, A9 i eksploatacji raportuj osobno. Nie uznawaj checklisty za ukończoną bez wskazanych dowodów.
