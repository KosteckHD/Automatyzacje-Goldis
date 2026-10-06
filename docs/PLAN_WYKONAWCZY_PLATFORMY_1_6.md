# Goldis — plan wykonawczy domknięcia platformy, punkty 1–6

Data: 6 października 2026. Status: plan, nie raport ukończenia. Zakres: funkcjonalna platforma na rzeczywistym API/PostgreSQL/Redis z syntetycznym rejestrem i portalami. Odbiór rzeczywistych Everest/Compensa (A9) oraz wydanie produkcyjne (PL-11) są osobnymi bramkami.

Ten dokument jest kolejką pracy dla agenta kodującego. Szczegółowe reguły pól, transakcji i przypadki graniczne pozostają w [PL-01–PL-10](PLAN_IMPLEMENTACJI_PLATFORMY_DLA_AGENTA.md). Przed wykonaniem pakietu porównaj je z bieżącym kodem, [stanem implementacji](STAN_IMPLEMENTACJI.md) i migracjami. Starszy [plan domknięcia](PLAN_DOMKNIECIA_PLATFORMY.md) opisuje część już zaimplementowanych PL-02/03/04 jako otwarte — nie odtwarzaj ich drugi raz.

## 0. Punkt startowy i reguły pracy

Na dzień planu `npm test` i `npm run build` przechodzą. Katalog, historie i `/audit` są zaimplementowane i mają testy syntetyczne; pełny odbiór DB/HTTP nadal jest otwarty. Brak `GOLDIS_TEST_DATABASE_ADMIN_URL`, Docker Engine nie działa; nie oznaczaj testu z tego powodu jako PASS. Kod aplikacji, migracje i lockfile są prawie w całości nieśledzone w Git. Ostatnia istniejąca migracja ma numer 023. W bieżącym API są pojedyncze runy, propozycja korekty i odczyt wzbogacenia; nie ma endpointów `review`, trwałych `enrichment-jobs` ani `run-submissions`.

1. Przed każdym pakietem odczytaj `git status`, ewentualne `AGENTS.md`, bieżący schemat i testy sąsiednich usług. Numer migracji i nazwy plików potwierdź ponownie; nie zakładaj, że stan z tej daty nie zmienił się.
2. Realizuj pionowy wycinek: kontrakt i model → migracja → transakcje i autoryzacja → API → UI → test jednostkowy → test DB/HTTP → test przeglądarkowy → wpis dowodowy. Nie zaliczaj pakietu po samym widoku lub mocku API.
3. Portal live pozostaw wyłączony. Harness używa fikcyjnych stron i syntetycznych osób. Żadnych danych klienta, prawdziwych kodów SMS ani rzeczywistych ofert w testach platformy.
4. Wspólne reguły mutacji: identyfikator aktora/tenanta z sesji, Origin i CSRF, walidowana allowlista body, capability i grant na zasobie, transakcja, blokada/CAS dla współdzielonego stanu oraz audyt w tej samej transakcji. Błąd audytu cofa zmianę.
5. Wspólne reguły odczytu: zakres tenant/owner/grant w SQL przed `LIMIT`, liczeniem i paginacją; szczegół po znanym ID ma tę samą ochronę. Nie zwracaj PESEL, kodów SMS ani danych polis w listach i audycie. Kursor nie nadaje uprawnienia.
6. Po każdym pakiecie zapisz w `STAN_IMPLEMENTACJI.md`: commit/wersję kodu, scenariusze i ich wynik, środowisko testowe, pominięcia, dowody DB/Redis/UI i otwarte bramki. `SKIP`, `BLOCKED` oraz test z podstawionym API nie są dowodem integracji.

## 1. Odtwarzalna baza prac i środowisko — PL-01 oraz ponowny odbiór PL-02/03

**Cel:** każdy agent uruchamia tę samą wersję platformy, a testy nie dotykają istniejącej bazy ani profilu portali.

### Kolejność implementacji

1.1. Zinwentaryzuj `git status`, `git ls-files`, `.gitignore`, `.dockerignore`, prywatne katalogi, `.env*`, profile Chromium, importy XLSX, staging, eksporty i logi. Sporządź listę źródeł do śledzenia; przejrzyj ją przed dodaniem. Utrwal kod, migracje, testy, przykłady konfiguracji i lockfile w kontrolowanej wersji, bez sekretów i danych klientów. Zapisz hash commitu w dzienniku.

1.2. Wybierz **jeden** profil testowy: izolowany Compose albo Windows z dedykowaną bazą/Redis. Runner ma tworzyć zasoby o losowych nazwach i wyraźnym właścicielu, dopuszczać wyłącznie lokalne/testowe URL oraz usuwać w `finally` tylko własne zasoby. Nie kieruj runnera na zastany PostgreSQL na 5432 bez dowodu izolacji. Nie startuj drugiego workera z tym samym profilem przeglądarki.

1.3. Ustal zgodne wersje Node/npm, PostgreSQL, Redis, Chromium i Playwright. `preflight:local` ma wykazać brakujące parametry bez wypisywania ich wartości. Zapewnij powtarzalną sekwencję: zależności → migracje → API/Redis readiness → worker → web → test. Portal mode = `off` w tym etapie.

1.4. Rozszerz migracyjny smoke o automatyczne wykrywanie bieżącej listy migracji (obecnie 001–023), fresh DB, upgrade schematu legacy, powtórne uruchomienie migracji oraz migrację **odizolowanej kopii** aktualnej bazy. Sprawdź `SequelizeMeta`, FK, CHECK i indeksy. Nie edytuj już zastosowanych migracji; nowe schematy dodawaj migracją addytywną.

1.5. Przygotuj fixture z dwoma syntetycznymi tenantami, dwoma adminami, operatorami A/B, reviewerami, auditorem, użytkownikiem bez grantu i kontem nieaktywnym. Dodaj 101 użytkowników, ponad 51 interwencji/runów, importy gotowe i wymagające przeglądu, korektę, konflikt, wynik, zero oraz uszkodzony artefakt.

1.6. Na prawdziwym API/DB ponownie odbierz istniejące PL-02/03 i `/audit`: termin Warsaw/DST, dalsze strony, URL po nowym logowaniu, role i odmowy po cofnięciu grantu. Zmierz `EXPLAIN ANALYZE` dla historii/audytu na reprezentatywnej próbce; indeks dodaj tylko po wykazanym problemie.

### Testy i bramka

- `ENV-01` świeża instalacja i `ENV-02` upgrade legacy mają ten sam oczekiwany schemat; `ENV-03` ponowny start migratora nie zmienia danych.
- `ENV-04` przerwanie runnera sprząta własne zasoby, pozostawia cudzy kontener/bazę nietknięte; `ENV-05` niepoprawny lub zewnętrzny DB URL kończy się przed mutacją.
- `ENV-06` skan commitu, obrazu, logów i fixture nie wykrywa sekretów, kodów SMS, rzeczywistych danych ani profilu portali.
- `HIS-DB` dwa tenanty, dwóch operatorów, kursor i znany URL: każdy widzi tylko uprawnione rekordy; 101. użytkownik i 51. zgłoszenie są osiągalne.
- Uruchom `npm test`, `npm run build`, `npm run test:db-integration`, odpowiednie smoke UI i migracyjne testy fresh/legacy. Bramka jest zielona wyłącznie przy rzeczywistym DB/Redis; niedostępny Docker oznacza BLOCKED i dalszą pracę nad niezależnym kodem.

## 2. Model tenantowy, korekty i konflikty — PL-05

**Cel:** każdy stan `pending correction` i `open conflict` ma bezpieczną, trwałą drogę do decyzji bez zmiany tożsamości aktywnego runu.

### Kolejność implementacji

2.1. Przejrzyj `canonical_entities`, `source_entity_links`, `canonical_run_groups`, powiązania starych importów i istniejące globalne indeksy NIP/REGON. Zdefiniuj regułę własności canonical entity w tenant. Zaprojektuj addytywny backfill `tenant_id` i nowe unikalności `(tenant_id, nip_normalized)` oraz `(tenant_id, regon)` dla niepustych wartości. Wykryj rekordy współdzielone przez różne tenanty; przygotuj jawny plan rozdzielenia z zachowaniem linków i runów, bez arbitralnego przypisania.

2.2. Wprowadź migrację etapami: kolumna i backfill → walidacja relacji → nowe indeksy/FK/ograniczenia → usunięcie starych globalnych indeksów dopiero po dowodzie poprawności. Nie uznawaj samego nowego pola za izolację: każda ścieżka grupowania, lookupu, startu runu i resolution musi uwzględniać tenant. Test migracji obejmuje fresh, legacy i kopię aktualnego schematu.

2.3. Ustal DTO kolejek `GET /api/review/corrections` i `GET /api/review/conflicts`: stabilny kursor, filtr statusu/importu/narzędzia, tylko minimum danych potrzebnych do decyzji. Scope reviewer = aktualny grant; admin = tenant; operator widzi status własnej propozycji, nie kolejkę decyzji; auditor nie widzi danych operacyjnych. ID kandydata canonical z body nie jest dowodem dostępu.

2.4. Zaimplementuj decyzję korekty (`approved`/`rejected`, `expectedRowVersion`, kod przyczyny). W jednej transakcji blokuj rekord źródłowy, propozycję i wymagane powiązania w ustalonym porządku. Ponownie sprawdź wersję, grant, stan i brak aktywnego runu/przyjętej grupy. Zatwierdzenie waliduje REGON, aktualizuje `effectiveRegon`, issues, provenance, rowVersion i grupowanie; `raw` pozostaje. Odrzucenie zachowuje wartość operacyjną. Decyzja i audit są atomowe.

2.5. Zaimplementuj rozstrzygnięcie konfliktu (`link_existing`, `recheck`, `reject_link` według zatwierdzonego kontraktu). Serwer sprawdza zgodność identyfikatorów i tenanta kandydata, wersję, aktualny stan oraz skutki aktywnego runu. Podobna nazwa sama nie wystarcza do połączenia. Sprzeczny NIP/REGON wymaga korekty, a nie obejścia indeksu fikcyjnym ID. Recheck bez rozstrzygnięcia zostawia rekord w review.

2.6. Dodaj `/review`: dwie kolejki, szczegół/proweniencja, skutki decyzji, potwierdzenie, loading, 409 z odświeżeniem bez automatycznego ponowienia, stan pusty i błąd 503. Lista operatora pokazuje status jego zgłoszenia; kontrolki decyzji wyłącznie dla uprawnionych. Linki po F5 wracają do zasobu.

### Testy i bramka

- `TEN-01` dwa tenanty z tym samym NIP/REGON istnieją niezależnie; `TEN-02` znane ID obcego kandydata, konfliktu i korekty nie ujawnia danych ani nie pozwala na mutację.
- `REV-01` approve aktualizuje effective/valid issues/grouping, zachowując raw; `REV-02` reject nie zmienia effective; `REV-03` błędny REGON i sprzeczny canonical są odrzucone.
- `REV-04` dwie równoległe decyzje: dokładnie jedna finalizacja, druga 409; `REV-05` nieaktualna wersja, brak grantu, nieaktywna sesja i CSRF/Origin denial nie zmieniają DB.
- `REV-06` błąd zapisu audytu wycofuje wszystkie zmiany; `REV-07` aktywny run i przyjęta grupa nie otrzymują nowej tożsamości po korekcie; `REV-08` known URL i kursor podlegają aktualnemu zakresowi.
- Testuj serwisy, migrację, HTTP z prawdziwym PostgreSQL, UI bez mockowania API w teście odbiorczym. Bramka: każda propozycja/konflikt ma końcową decyzję lub jawną blokadę z dalszą czynnością.

## 3. Trwałe wzbogacanie NIP → REGON — PL-06

**Cel:** operator uruchamia i obserwuje lookup, a wynik stosuje się raz do zgodnego wiersza; rekordy z gotowym REGON działają nawet przy awarii rejestru.

### Kolejność implementacji

3.1. Oddziel mechanizm od decyzji o dostawcy. Mechanizm i testy buduj na fixture zgodnym z `RegistryProvider`; konkretny adapter oprzyj dopiero na wybranym źródle i jego aktualnej oficjalnej dokumentacji. Brak konfiguracji providera zwraca kontrolowaną niedostępność, nigdy wynik testowy jako produkcyjny.

3.2. Zdefiniuj `enrichment_jobs` i `enrichment_job_items`: tenant/import/actor, idempotency key i hash wyboru, status/wersja, expectedRowVersion, lease, retry/nextAttemptAt i bezpieczny errorCode. Dodaj FK, CHECK i unikalność jobu oraz `(job_id,source_row_id)`; kolejka przenosi ID, nie NIP, surową odpowiedź ani dane osobowe.

3.3. Wystaw autoryzowane API: start na imporcie z wyborem wierszy/zakresu, odczyt postępu, anulowanie z CAS. Sprawdź owner/execute, tenant i grant przy **każdym** requestcie. Ten sam klucz + identyczny payload zwraca ten sam job, zmieniony payload daje 409. Nie wybieraj wierszy na podstawie aktualnej strony tabeli UI.

3.4. Runner deduplikuje identyczny NIP w jobie, ogranicza globalną współbieżność, ma lease i wznowienie po restarcie. Wywołanie sieciowe jest poza długą transakcją. Po odpowiedzi blokuje item/row, ponownie sprawdza wersję, brak korekty i runu, kwalifikację oraz zgodność nazwy/identyfikatorów. Dopiero potem stosuje `effectiveRegon`, provenance i nowe issues/grupowanie w tej samej transakcji co finalizacja itemu.

3.5. Rozróżnij matched, not_found, ambiguous/manual_review i błędy transportowe. 429/5xx mają limitowany backoff i `nextAttemptAt`; timeout przerywa request. Replay po utracie odpowiedzi nie zwiększa wersji drugi raz. Cancel zatrzymuje przyszłe itemy, nie odwraca już zatwierdzonych zmian.

3.6. UI pokazuje kwalifikujące, ukończone, w review, oczekujące po limicie, błędne i anulowane wiersze oraz źródło/czas pochodzenia wyniku. Dla każdego stanu dostępna jest poprawna następna czynność. Nie ujawniaj identyfikatorów i raw odpowiedzi w logach/audycie.

### Testy i bramka

- `REG-01` zgodny wynik przechodzi import → job → effectiveRegon → ponowne grupowanie; `REG-02` 0/wiele/obcy podmiot prowadzi do review bez automatycznego startu.
- `REG-03` ten sam NIP w wielu wierszach daje jeden lookup, ale osobną walidację wersji i nazwy; `REG-04` 429, 5xx, timeout, zły format i brak konfiguracji mają właściwe stany i ograniczone retry.
- `REG-05` korekta w czasie lookupu, cofnięty grant, cancel/restart i replay po utraconym ACK nie powodują nadpisania ani duplikatu; `REG-06` obcy tenant/znane ID, CSRF, Origin i nieuprawniona rola są odrzucane.
- `REG-07` skan DB/Redis/logów nie znajduje surowej odpowiedzi w kolejce/audycie; dane źródłowe raw pozostają. Bramka platformy: pełny fixture E2E bez skipów. Bramka rzeczywistego providera jest osobno otwarta do chwili dostępnego, autoryzowanego smoke.

## 4. Trwałe partie i dispatch — PL-07

**Cel:** jeden wybór wielu wierszy ma trwały identyfikator, rozlicza każdy wiersz i uruchamia tylko dopuszczone kanoniczne runy.

### Kolejność implementacji

4.1. Ustal semantykę: `ImportBatch` to plik, `RunSubmission` to prośba o wykonanie. Dodaj tabele submission, items i groups zgodnie z [PL-07](PLAN_IMPLEMENTACJI_PLATFORMY_DLA_AGENTA.md#7-pl-07--wybor-zakresu-trwala-partia-i-dispatch). Item = źródłowy wiersz; group = jeden planowany kanoniczny run; run pozostaje w obecnym modelu. Zachowaj wersje źródeł i jedną `referenceDate` w Warsaw dla submission.

4.2. Dodaj preview dla listy rowNumbers lub zakresu fromRow–toRow. Waliduj limity i źródłowe numery, nie indeks widocznej tabeli. Odpowiedź rozdziela selected/ready/review/excluded/unique groups/already active i zawiera fingerprint wyboru, rowVersion i grup. Preview nie uruchamia portali ani nie zapisuje runów.

4.3. POST submission ponownie sprawdza fingerprint, grant, wersje i grupowanie. Jedna transakcja utrwala wszystkie items i eligible groups. Idempotency key + hash kanonicznego wyboru: replay zwraca tę samą submission, inna treść to 409. Podwójne kliknięcie i utrata odpowiedzi nie tworzą kolejnej partii.

4.4. Dispatcher pobiera należne grupy z lease/CAS. Przed admission sprawdza aktywność konta i rolę aktora, grant, ustawienia, okno czasu, limit nowych runów, stan wiersza i brak konfliktu. Trwałego zadania nie uzależniaj od istnienia sesji przeglądarki po wylogowaniu; świeże żądania API nadal wymagają aktualnej sesji. Wspólna logika single-row i partii rezerwuje limit transakcyjnie; ustal jeden porządek blokad dla settings/import/source/canonical/group. Pauza blokuje **nowe admission**, nie outbox runu już przyjętego.

4.5. W tej samej transakcji admission powstają powiązanie `group.run_id`, `RunSourceRow`, nowy run (jeśli potrzebny), outbox i audit. Dołączenie do zgodnego aktywnego runu nie zużywa nowego limitu. Inna referenceDate lub osoba nie może zostać ukryta pod tym samym wynikiem. Po ustawieniu `group.run_id` retry nigdy nie tworzy nowego runu — także po stanie terminalnym.

4.6. Dodaj GET submission, stronicowane items oraz cancel z expectedVersion. Cancel odcina nieprzyjęte grupy; aktywny/skutkowy run wymaga istniejącej bezpiecznej procedury zatrzymania, a współdzielony run nie może zostać skasowany kosztem innej submission. Każdy item otrzymuje wynik, zero, błąd, review, exclusion albo anulowanie; otwarta interwencja to jawne waiting_attention.

4.7. UI: wybór i zakres, podgląd przed startem, potwierdzenie, trwały ekran `/submissions/[id]`, liczniki osobno dla wierszy/grup/runów, bezpieczny polling, F5/Back i link do wyniku/interwencji. Dwa kliknięcia używają tego samego klucza. Nie obiecuj ukończenia, gdy część jest blocked/review.

### Testy i bramka

- `SUB-01` mixed selection z duplikatami i różnymi osobami daje oczekiwane counts i powiązania; `SUB-02` double-click, retry HTTP i restart po commit tworzą jedną submission oraz najwyżej jeden właściwy run na grupę.
- `SUB-03` dwa starty przy limicie 1 oraz pojedynczy start przeciw partii przy limicie 1 dają tylko jeden nowy admission; `SUB-04` pauza, okno nocne i przejście przez północ nie zmieniają przypiętej referenceDate ani przyjętego outboxa.
- `SUB-05` cancel kontra dispatch, shared run, terminal replay i utrata lease nie tworzą nowej oferty; `SUB-06` cofnięty grant, nieaktywny aktor, obcy tenant, CSRF/Origin i znane ID nie omijają kontroli.
- `SUB-07` błąd audytu lub outboxa wycofuje admission; `SUB-08` suma kategorii items i groups równa się wybranym rekordom/grupom także po błędzie jednego wiersza. Odbiór wymaga prawdziwej DB/Redis, restartu procesów i liczników fixture portali.

## 5. Cztery role, interwencje, wyniki, audyt i raporty — PL-04/08/09

**Cel:** każda rola kończy swoją pracę w granicach aktualnych praw, a historia, pobranie i raport opisują ten sam stan.

### Kolejność implementacji

5.1. Utrwal macierz role × capability × tenant × owner × grant dla admina, operatora, reviewera i auditora. Dokończ testy loginu, zmiany hasła, dwóch sesji, logout/revoke all, disable/role change, wymuszonej zmiany hasła i równoległej ochrony ostatniego admina. Odbierz przydziały interwencji po utracie uprawnień. `/audit` już istnieje — weryfikuj jego aktualny scope, nie twórz drugiego ekranu.

5.2. Po dodaniu review/job/submission rozszerz resolver zasobów i capability na każdą nową trasę. Kolekcja filtruje SQL przed paginacją; szczegół sprawdza relację z importem i tenantem. Reviewer ma decyzje danych i ograniczony audyt przy grancie, bez startu portali/pobrania; auditor tylko dziennik tenantowy bez operacyjnego payloadu; przypisany operator SMS dostaje minimalny kontekst, nie polisę właściciela.

5.3. Uporządkuj interwencje: jeden otwarty incident/run, read/assignment/resolution osobno, deadline Warsaw, CAS, właściwy challenge po bezpośrednim URL, anulowanie i restart. SMS pozostaje jednorazowy: kod bez trwałego zapisu, limit prób, jawny resend, brak automatycznego ponowienia przy niepewnej dostawie. Samo oznaczenie incidentu jako rozwiązany nie potwierdza skutku portalu.

5.4. Wynik obejmuje total/current counts, `referenceDate`, `completed` i `no_matching_policies` jako różne stany. Pokaż wszystkie powiązane `RunSourceRow`, także duplikaty. Niekompletny UFG/błąd nie jest zerem. Pobranie każdorazowo sprawdza sesję, grant, owner i integralność prywatnego pliku; brak/uszkodzenie/storage down ma kontrolowany status.

5.5. Ujednolić audyt pobrania: nowy event `artifact.downloaded` wiąże `resourceType=artifact` i `resourceId=artifactId`; stare eventy z runId czytaj przez jednoznaczną warstwę kompatybilności, bez przepisywania historii. Rozszerz typy audytu dla decyzji/job/submission. Raporty liczą zdarzenie raz, rozdzielają rows/groups/runs, zero od failed, daty created/finished i zakres Warsaw z DST.

5.6. Sprawdź ustawienia przy równoległym admission partii i single-row. Centrum operacyjne rozróżnia API liveness, DB/Redis readiness, heartbeat workera, portal mode/config, outbox i oczekujące grupy. Zmierz import około 30 tys. syntetycznych wierszy, listy, audyt i raporty; usuń potwierdzone pełne skany/N+1 (zwłaszcza `resolveRelatedRows`) po `EXPLAIN ANALYZE`.

### Testy i bramka

- `ACL-01` każda rola przechodzi dozwolone trasy i dostaje odmowę na niedozwolonych; `ACL-02` obcy tenant, obcy operator i znany URL nie ujawniają szczegółu/listy/licznika; `ACL-03` cofnięcie grantu/sesji blokuje **następny** GET i download, również przy otwartej karcie.
- `ACL-04` dwóch adminów równolegle nie usuwa ostatniego aktywnego admina; `ACL-05` przydział nieaktywnemu operatorowi jest niemożliwy, otwarte zadanie ma dalszą drogę administracyjną.
- `INT-01` SMS przez UI→API→DB/worker fixture, odrzucenie/expiry/resend/limit/restart; `INT-02` dwie równoległe próby kodu i niepewna dostawa nie tworzą ponownego wysłania; `INT-03` skan trwałych magazynów i logów nie znajduje testowego kodu.
- `RES-01` completed z poprawnym XLSX, zero bez pliku, incomplete jako błąd/interwencja; `RES-02` uszkodzony plik lub odebrany grant kończy bez wycieku; `RES-03` staging replay po awarii API daje jeden snapshot/artefakt bez powrotu do portalu.
- `AUD-01` nowy i legacy download znajdują się po toolId i są liczone raz; `AUD-02` reviewer nie widzi kont/sesji/ustawień; `REP-01` ręcznie policzony fixture daje dokładne agregaty, w tym DST, cancelled i retry.
- `PERF-01` wynik pomiaru 30 tys. wierszy zawiera hardware, plan zapytań, czas i pamięć. Nie deklaruj SLA bez ustalonego progu. Bramka: pełne role/API/DB/UI, brak krytycznych pełnych skanów i zgodny audyt/raport.

## 6. Pełny odbiór platformy — PL-10

**Cel:** udowodnić działanie połączonego produktu, a nie tylko osobnych testów serwisów i UI.

### Kolejność implementacji

6.1. Dodaj `test:platform-e2e` dopiero wraz z działającym runnerem. Runner tworzy własne DB/Redis, migruje schemat, startuje prawdziwy AppModule, Next i produkcyjny worker z fikcyjnymi stronami portali oraz syntetycznym providerem. Przeglądarka **nie** podstawia odpowiedzi API przez `page.route`; test przechodzi realne logowanie, cookies, CSRF i guardy.

6.2. Użyj tego samego procesora workerowego, outboxa, lease, stage i eksportera co aplikacja. Fixture zlicza login, save, UFG i zwraca kontrolowane odpowiedzi/awarie. Dowód łączy UI, odpowiedź HTTP, wiersze DB, zadania Redis, liczniki fixture oraz treść/nazwę XLSX. Każdy scenariusz ma własne dane i oczekiwane liczniki zapisane **przed** uruchomieniem.

6.3. Uruchom sekwencję `E2E-01–12` z [sekcji PL-10.3](PLAN_IMPLEMENTACJI_PLATFORMY_DLA_AGENTA.md#103-minimalne-scenariusze-koncowe): konto i grant; import/historia po F5; korekta i konflikt; job rejestru; submission; SMS i wynik; timeout/limit; recovery; audyt/raport; cofnięcie grantu; odmowy tenant/role; dalsze strony, DST i błędy UI. Każdy test wskazuje oczekiwane efekty DB/outbox i brak dodatkowego save/UFG.

6.4. Dodaj macierz awarii: restart API/worker w MFA, przed/po save i UFG, utrata lease, API niedostępne po odczycie, niekompletna tabela, zero, nieznany ekran, uszkodzony artefakt i konflikt idempotencji. Nie akceptuj „PASS”, jeśli fixture ukrył checkpoint lub użył uproszczonego procesora.

6.5. Odbierz UI dla czterech ról przy 320/375/768/1440/1920 px, klawiaturze i focus trap dialogów, back/forward, otwarciu znanego URL, loading/empty/403/409/503, DST oraz `prefers-reduced-motion`. Testy wizualne z mock API są pomocnicze; co najmniej krytyczne ścieżki muszą działać z prawdziwym backendem.

6.6. Skanuj kontrolowane DB, Redis, logi i artefakty po syntetycznym kodzie SMS oraz po niezamierzonych danych osobowych w audit/queue. W `finally` zamknij przeglądarki, workery i procesy; usuń tylko zasoby runnera. Zapisz dokładny raport wyników i ograniczeń. Po odbiorze uaktualnij README, instrukcje admina/operatora/reviewera/auditora i jedno bieżące zestawienie statusów.

### Testy i bramka

- `npm test`, `npm run build`, `npm run test:playwright -w @goldis/worker`, `npm run test:db-integration`, `npm run test:automation-e2e` oraz nowe `npm run test:platform-e2e` muszą być zielone tam, gdzie dotyczą zmienionego kodu. Nie sumuj zwykłych testów workera (z pominięciami Chromium) i przebiegu Playwright jako dwóch niezależnych zestawów.
- Końcowe `E2E-01–12` przechodzą bez pominięć na rzeczywistym API/DB/Redis; krytyczne awarie mają dowód braku podwójnego save/UFG/run/artefaktu. Każdy zasób ma prawidłową następną lub końcową czynność.
- Bramka **platforma funkcjonalnie kompletna**: PL-01–PL-10 odebrane na fixture, wszystkie cztery role i aktualne prawa, migracja fresh/legacy/kopia, brak ujawnienia danych między tenantami i kompletna macierz wyników. To nie zalicza dostawcy rejestru live, A9 portali ani wydania do eksploatacji.

## Przekazanie każdego pakietu

Agent zapisuje: identyfikator pakietu i wykonane kroki; commit; zmienione API/tabele/UI; komendy i wyniki testów z datą; nazwę izolowanego środowiska; oczekiwane i zmierzone liczniki; dowód odmów bezpieczeństwa; regresje; dokładnie wskazane `PASS`, `FAIL`, `SKIP`, `BLOCKED`; pozostałe decyzje. Następny pakiet zaczyna się po odbiorze zależności. Gdy zewnętrzna decyzja o rejestrze nie zapadła, implementacja mechanizmu na fixture może postępować, ale status providera live pozostaje otwarty.
