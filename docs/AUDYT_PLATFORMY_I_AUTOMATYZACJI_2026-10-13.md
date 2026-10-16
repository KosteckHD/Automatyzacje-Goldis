# Audyt platformy i automatyzacji Goldis — 13 października 2026

## Werdykt

**NO-GO dla publicznej produkcji z rzeczywistymi danymi.** Platforma ma zaimplementowany szeroki zakres MVP, a automat OC ma historyczny dowód pełnego przebiegu jednego rekordu. Aktualny kod przechodzi główną regresję. Pozostają jednak odtworzona luka importu XLSX, niedomknięta obsługa brakujących danych osoby, zbyt szerokie prawa usług oraz nieodebrane wdrożenie, odtworzenie i praca partii na portalach.

Projekt jest na etapie domknięcia i odbioru. Nie ma podstaw do traktowania go jako gotowej usługi tylko na podstawie zielonego builda. Nie przypisuję procentów: funkcje, bezpieczeństwo i odbiór środowiska mają różne bramki i nie można ich zastąpić jedną liczbą.

Najkrótsza droga do pierwszego wydania obejmuje istniejący automat OC i jawnie ustalony zakres przypadków. Pozostałe narzędzia katalogu nie mają tu potwierdzonego procesu wykonawczego i wymagają osobnego zakresu, jeśli mają wejść do tego samego wydania.

## Zakres i świeże dowody

Audyt dotyczy bieżącego drzewa roboczego, razem ze zmianami niezatwierdzonymi. `HEAD`: `e3a507ea8e534f06d698289bf1165f79691e5a6d`. Aktualny produkt nie jest reprezentowany przez ten commit. W chwili kontroli było 146 zmodyfikowanych śledzonych plików; liczba nie obejmuje nowych plików. Nie zmieniano kodu produktu, ustawień ani danych biznesowych w ramach audytu.

Przeczytano implementację API, workera, konfigurację web/proxy, Compose, Dockerfile, role DB, import i eksport, backup, przepływ zadań oraz dokumenty odbiorowe. Dodano raport, logi i ograniczony skrypt prób syntetycznych w [katalogu dowodów](audit-production-2026-10-13/).

| Sprawdzenie wykonane 13.10 | Wynik | Granica dowodu |
| --- | --- | --- |
| `npm run build` | PASS: core, API, worker, web | Kompilacja i build produkcyjny Next.js; bez uruchomienia docelowych kontenerów. |
| `npm test` | **329 PASS, 54 SKIP, 0 FAIL** | Core 13, API 208, worker 99 PASS / 54 SKIP, preflight 9. Pominięcia workera wymagają osobnego opt-in Playwright. |
| Everest / Compensa / UFG browser modules | **8/8, 29/29, 14/14 PASS**, bez SKIP | Fikcyjne strony i izolowane profile Chromium, bez kontaktu z portalami. Część testów pokrywa się z główną regresją. |
| PZU session browser suite | **18/18 PASS**, bez SKIP | Sesja, MFA, expiry, zapamiętanie urządzenia na fixture; nie jest to rzeczywisty SMS. |
| UI: security, leady, manager, uruchamianie zestawu, review, historia kasowania | **6/6 scenariuszy PASS** | Prawdziwy frontend i Chromium, syntetyczne/stubowane API. Nie zastępuje pełnego flow z PostgreSQL. |
| `test:backup-crypto` | **1/1 PASS** | Integralność szyfrowania kopii; nie odtworzenie działającej platformy. |
| `test:module:runner` | **11 PASS, 1 FAIL** | Nieaktualna lista modułów w teście pomija `leads`. |
| Ograniczone próby audytowe | **Wykryte problemy odtworzone** | Ekspansja kolumn XLSX, nieterminalne wyniki braku osoby/PESEL, domyślna akceptacja legacy plaintext w trybie production. |
| `npm audit --omit=dev` | **0 critical, 0 high, 7 moderate** | Skan online zależności. Kod wyjścia 1 oznacza otwarte zgłoszenia, nie brak skanu. |
| Docker / PostgreSQL / Redis / obrazy | **NIEZWERYFIKOWANE w tej sesji** | Docker Engine niedostępny: brak `dockerDesktopLinuxEngine`. Nie ponawiano integracji DB/Redis ani sandboxu kontenera. |
| Portale live / VPS / publiczny HTTPS / cold restore | **NIEODEBRANE przez ten audyt** | Nie logowano do portali, nie tworzono ofert ani zapytań UFG. Nie ma dostępu do docelowego VPS. |

W kontrolowanych plikach lokalnych tryb portali pozostaje `0`; `.env.local` ma wzbogacanie rejestru `disabled`, a wariant Compose wskazuje `development` i `mf-vat`. Odczytano wyłącznie jawne flagi trybu, bez wypisywania sekretów. Na sprawdzanych portach lokalnych 3000/3001/3022/55432/56379 nie wykryto listenerów. Nie oznacza to stanu innego hosta.

## Co jest już zbudowane

**Platforma:** import i walidacja danych, przygotowanie i korekty, deduplikacja, wybór/start zestawu, kolejka i outbox, kontrola pauzy/anulowania, role i granty, sesje/CSRF, administracja i audyt, leady i przydziały, raporty i powiadomienia, obsługa SMS, historia i wyniki. Kasowanie ma podgląd, ponowne potwierdzenie hasła, trwały job, tombstone i journal/replay. Istnieje model zachowania wyników leadów innych użytkowników po usunięciu źródłowego importu.

**Automat OC:** adaptery PZU/Everest → Compensa → UFG → snapshot → API/XLSX; trwały profil przeglądarki, blokada jednego workera portalowego, `concurrency=1`, lease/fencing, checkpointy akcji, szyfrowany staging oraz kontrola niepewnego wyniku. To realna implementacja automatyzacji, nie sam panel do uruchamiania skryptu.

[Odbiór live z 10.10](TEST_CALEGO_FLOW_LIVE_2026-10-10.md) dokumentuje ukończony rekord: 49 polis w snapshot i 3 w XLSX, porównanie z DB oraz pojedyncze rozpoczęcie sprawy/zapis/UFG w udanym zadaniu. [Test dwóch wierszy](TEST_DWOCH_WIERSZY_LIVE_2026-10-10.md) potwierdził sukces pierwszego i zatrzymanie drugiego przy braku osoby, bez przejęcia poprzedniej tożsamości. To odbiór historycznej wersji i konkretnego przypadku. Po nim zmieniono m.in. kontrakt eksportu, role i leady; obecnego wydania nie odebrano ponownie live.

Poprawki po wcześniejszym audycie są widoczne w kodzie: limity scalonych komórek, szyfrowanie nowych eksportów AES-256-GCM, oddzielne konta DB bez superusera i DDL dla runtime, sandbox Chromium w Compose oraz przykład Nginx zastępujący wejściowe nagłówki forwarding. Wcześniejsze stwierdzenia, że tych mechanizmów w ogóle nie ma, są nieaktualne. Ich zakres i konfiguracja nadal wymagają domknięcia poniżej.

## Braki i priorytety

### G01 — P0: nadal możliwa nieograniczona ekspansja XLSX

**Odtworzone.** Walidator [workbook-archive.ts](../apps/api/src/workbook-archive.ts) liczy fizyczne wiersze, komórki i scalenia, lecz nie ogranicza zakresów `<cols><col min/max>`. Plik syntetyczny około **6,5 KB z czterema komórkami** przeszedł preflight; ExcelJS następnie utworzył **25 000 obiektów kolumn**. Wynik zapisano w [logu prób](audit-production-2026-10-13/bounded-audit-probes.log), a reprodukcja jest w [skrypcie](audit-production-2026-10-13/bounded-audit-probes.cjs).

Kod `Column.fromModel` w zainstalowanym ExcelJS rozwija zakres do `max`, bez limitu po stronie tej biblioteki. Znacznie większa wartość może więc wyczerpać pamięć lub czas CPU procesu API — to wniosek z odtworzonej ekspansji i kodu biblioteki. Celowo nie wykonywano próby zabicia API ani dużego payloadu. Limit 10 s dotyczy walidatora, a późniejsze `workbook.xlsx.load` działa w tym samym procesie i poza tym limitem. Compose nie definiuje limitów pamięci usług.

**Do wykonania:** walidować granice i sumę ekspansji kolumn, współrzędne oraz pozostałe struktury rozwijane przez ExcelJS; odrzucać niepoprawne zakresy. Oddzielić kosztowne parsowanie od API z rzeczywistym limitem czasu/pamięci. Ograniczyć zasoby usług.

**Odbiór:** złośliwy plik odrzucony przed rozwinięciem, legalny duży import działa, dwa równoległe importy nie wyłączają loginu/health/API; testy obejmują zakresy kolumn i limit parsowania, nie tylko ZIP/scalenia.

### G02 — P1: brak osoby/PESEL nie domyka zestawu automatyzacji

**Odtworzone na produkcyjnej pętli `LiveRunProcessor` z atrapą repozytorium i adaptera, bez DB/portali.** `not_found`, `missing_pesel` i `unsupported_entity_type` kończą się w `identity_review`, które nie jest terminalne. Brak PESEL jest przy tym mapowany na `IDENTITY_AMBIGUOUS`. [live-run.ts](../apps/worker/src/live-run.ts:377) zachowuje tę ścieżkę, mimo że plan adaptacji wymaga jawnego zakończenia brakujących danych i kontynuacji partii.

[Run submissions](../apps/api/src/run-submissions.ts:502) mapuje taki wynik na `waiting_attention`; [runner zestawu](../apps/api/src/prepared-set-executions.ts:390) czeka na domknięcie bieżącego chunku przed następnym; leady wymagają zakończenia operacji. Analiza kodu wskazuje więc na możliwość zatrzymania dalszych chunków i udostępnienia wyników zestawu przez rekord bez danych. Nie oznacza to zablokowania całej kolejki BullMQ: inne już dopuszczone joby mogą przejść. Skutek na pełnym zestawie wymaga regresji DB/E2E.

**Do wykonania:** rozróżnić brak osoby, brak PESEL, nieobsługiwany przypadek i prawdziwą niejednoznaczność; pierwsze przypadki zakończyć według uzgodnionej polityki jako terminalny brak wyniku/błąd. Review pozostawić dla przypadków faktycznie rozwiązywalnych ręcznie. Uzgodnić statusy live, syntetycznego pipeline, submission, chunków i leadów.

**Odbiór:** sukces → brak osoby → sukces, również przez granicę chunku i po restarcie; poprawne wyniki stają się dostępne, brak danych nie tworzy leada `ready` ani fałszywego zera polis. Osobny test `missing_pesel` ze stabilnym reason code.

### G03 — P1: rozdzielenie kont DB nie realizuje jeszcze minimalnych praw

**Potwierdzone w konfiguracji.** [ensure-runtime-roles.sh](../docker/postgres/ensure-runtime-roles.sh:63) daje API i workerowi `SELECT/INSERT/UPDATE/DELETE` na wszystkich tabelach, także przyszłych. Worker mający kontakt z zewnętrznym portalem może na poziomie DB modyfikować użytkowników, granty, sesje i audyt. Konta nie mają DDL/superusera, ale pozostają zbyt szerokie.

Ponadto [Compose](../compose.yaml:96) umieszcza hasło migratora w komendzie tego samego kontenera, w którym pozostaje API. Oddzielenie migracji od runtime nie jest pełne. Dockerfile API i web nie przełączają na nieuprzywilejowanego użytkownika. Redis nie ma uwierzytelniania/ACL w prywatnej sieci aplikacji.

**Do wykonania:** osobny jednorazowy job migracji z własnym sekretem; uprawnienia workera tylko do potrzebnych tabel/operacji, osobna rola wzbogacania jeśli to uzasadnia zakres; odcięcie tabel uwierzytelniania od workera; nieuprzywilejowane kontenery API/web; Redis ACL zgodne z BullMQ i limiterem.

**Odbiór:** na rzeczywistych rolach runtime udany przebieg, ale odmowa DDL i odmowa zapisu przez worker do użytkowników/grantów/sesji. Kontener API po migracji nie zawiera sekretu migratora.

### G04 — P1: ochrona administracji i wymuszenie konfiguracji production

Sesje, CSRF, limity i unieważnianie po zmianie hasła/roli są zaimplementowane. **Step-up hasłem działa przy kasowaniu**, lecz reset hasła, zmiana roli i granty administratora nie wymagają świeżego potwierdzenia. Nie znaleziono implementacji MFA/TOTP/recovery dla logowania platformy. Portalowy SMS nie jest MFA platformy. [Reset hasła](../apps/api/src/admin.ts:1026) opiera się na istniejącej sesji admina i CSRF.

Odtworzono także przyjęcie legacy plaintext przez `decryptStoredArtifactBytes` przy `NODE_ENV=production` i pominiętym `ARTIFACT_REQUIRE_ENCRYPTION`. Windows preflight wymaga flagi w production, ale nie jest wywoływany przez start Compose/API; Compose domyślnie ustawia ją na `0`. To ryzyko błędnej konfiguracji istniejącego magazynu, nie stwierdzenie, że nowe eksporty są jawne — nowe zapisy wymagają klucza i są szyfrowane.

**Do wykonania:** świeże potwierdzenie operacji uprzywilejowanych i MFA administratorów lub uzgodniona silna brama dostępu dla ograniczonego pilota. Walidacja produkcyjna przy starcie usług: HTTPS/origin, zaufane proxy, wymagane klucze, szyfrowanie, sandbox i tryb portali. Sekrety przechowywane i rotowane poza wydaniem. Ustalić ochronę dysków DB/profili i zasady retencji kontaktów, snapshotów, eksportów, audytu oraz kopii.

**Odbiór:** błędna konfiguracja produkcyjna uniemożliwia start/gotowość; stara sesja nie wystarcza do zmiany roli/resetu; legacy eksporty po kontrolowanej migracji nie są pobierane jako plaintext.

### G05 — P1: brakuje produkcyjnego backupu i pełnego cold restore

[Backup lokalny](../scripts/Backup-GoldisLocal.ps1:130) jest narzędziem Windows, interaktywnie pyta o hasło, kopiuje pliki przed dumpem DB i nie zatrzymuje zapisów. Nie gwarantuje wspólnego punktu odtworzenia DB/artefaktów podczas aktywnej pracy. Wyklucza journal kasowań z kluczem i profil portalowy. Wykluczenie journalu jest jawne i wymaga osobnej, aktualnej kopii poza historycznymi backupami DB; repo nie dostarcza jej automatycznej replikacji.

[Test lokalnej kopii](../scripts/Test-GoldisLocalBackup.ps1:54) sprawdza checksumy i `pg_restore --list`. Nie przywraca platformy, co sam komunikuje. Historyczny smoke PostgreSQL backup/restore nie zastępuje odtworzenia kompletnego wdrożenia na drugim hoście.

**Do wykonania:** bezobsługowy zaszyfrowany backup docelowych wolumenów na osobnym storage, spójny punkt DB/plików, osobne trwałe zabezpieczenie aktualnego journalu i jego klucza, escrow kluczy oraz procedura odzyskania sesji portali. Alert dla brakującej kopii i próba przywrócenia z replay kasowań przed otwarciem ruchu.

**Odbiór:** drugi czysty host przywraca logowanie, role, wyniki i zaszyfrowane pobrania; skasowane dane nie wracają, cudze zachowane leady pozostają. Zmierzyć cele z planu: RPO ≤ 24 h i RTO ≤ 8 h. Obecnie nie są potwierdzonymi parametrami usługi.

### G06 — P1: potrzebny odbiór kompletnej topologii i procesu wydania

Repo ma przykład Nginx i instrukcję VPS, lecz audyt nie ma dowodu działającej domeny/TLS/zapory na docelowym hoście. Przykład prawidłowo zastępuje XFF; sam plik nie dowodzi, że publiczny łańcuch Nginx → Next → API uniemożliwia spoofing IP. Ustawić origin/cookie i dokładny adres proxy, sprawdzić brak publicznego API/DB/Redis/workera.

Przykład Nginx nie ustawia `client_max_body_size`. Bez nadpisania w nadrzędnej konfiguracji obowiązuje domyślne **1 MB**, podczas gdy import API dopuszcza **16 MiB**. To ryzyko 413 dla legalnych importów po wdrożeniu. Uzgodnić limit całego multipart i API, sprawdzić go przez HTTPS. Źródło wartości domyślnej: [dokumentacja Nginx](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size).

Brakuje konfiguracji alertów i wyznaczonego operatora incydentów. Są health/heartbeat, ale nie ma dostarczonego odbioru alertowania dla disk-full, offline workera, zaległej kolejki, timeoutu SMS, błędów portali/rejestru i wieku backupu. Worker/web nie mają własnych healthchecków Compose. Obrazy są budowane lokalnie z całego drzewa; manifest identyfikatorów istnieje w API, ale Compose nie przekazuje commit/digest. Nie znaleziono wersjonowanego pipeline CI/release.

**Odbiór:** release commit i digest obrazów, migracja z kopii obecnego schematu, zewnętrzne testy HTTPS/XFF/CSRF/autoryzacji, kontrolowany reboot, awaria zależności, działające alerty i rollback zgodny ze schematem. Release nie może odwoływać się do commita, który pomija większość implementacji.

### G07 — P1 warunkowo: GUS jest w kodzie, lecz nie ma kompletnej ścieżki uruchomienia

[Fabryka providerów](../apps/api/src/registry-provider-factory.ts:49) obsługuje `gus-bir`; skrypt startu Windows też go akceptuje. Tymczasem [preflight](../scripts/preflight-contract.cjs:15) dopuszcza tylko `disabled` i `mf-vat`. Compose nie przekazuje `GUS_BIR_USER_KEY`, `GUS_BIR_ENVIRONMENT` ani interwału GUS do enrichment-workera. Ustawienie `gus-bir` bez zmiany Compose kończy się brakiem wymaganego klucza, nawet jeśli jest w prywatnym pliku hosta.

**Do wykonania:** zdecydować, czy pierwsza produkcja obejmuje MF, GUS czy oba; spójny kontrakt env/preflight/Compose i rzeczywisty odbiór dostawcy. Jeśli MVP obejmuje wyłącznie MF, jasno ograniczyć konfigurację i nie deklarować gotowego wdrożenia GUS.

**Odbiór:** NIP → wynik/kontrolowany brak, limit/dostawca offline/cache/restart joba na docelowym środowisku. Awaria lookupu nie zmienia poprawnej tożsamości i nie blokuje pozostałych wierszy.

### G08 — P2: główna zielona regresja pomija czerwony test runnera i odbiory

[Test runnera](../scripts/test-module.test.cjs:8) nie uwzględnia `leads`, choć moduł jest w manifestach. To nieaktualna asercja, nie odtworzony błąd aplikacji. `npm test` jej nie uruchamia, podobnie jak UI, integracji DB/Redis i kryptografii backupu. Trzeba uaktualnić oczekiwanie i stworzyć jawny zestaw bramek release.

Poprzedni czerwony test migracji dotyczący odczytu OC managera został zmieniony w aktualnym pliku. Dokument adaptacji deklaruje późniejszy PASS migracji 001–058. W tym audycie DB nie był dostępny, więc nie powielam starego FAIL ani nie oznaczam dzisiejszego odbioru migracji jako PASS.

Siedem moderate w npm wymaga aktualnej decyzji właściciela i terminu przeglądu. To siedem wpisów pakietów, nie siedem niezależnych potwierdzonych exploitów. Nie należy wykonywać automatycznego `audit fix --force` proponującego niezgodne zmiany rodziców.

## Minimalny plan przejścia do produkcji

| Kolejność | Zakres pracy | Warunek zamknięcia |
| --- | --- | --- |
| 1 | G01, G02, G08: parser, brak danych osoby, runner testów | Regresja zielona; ograniczone zasobowo importy; zestaw sukces–brak danych–sukces domyka się i udostępnia poprawne wyniki. |
| 2 | G03, G04, G07: prawa, migrator, admin, production env, provider | Testy realnych kont DB, odcięcie sekretu migratora, walidacja startu, spójny kontrakt dostawcy. |
| 3 | G06: staging identyczny z planowaną produkcją | TLS/proxy/origin/cookie/zapora, sandbox i migracje odebrane na docelowym obrazie. |
| 4 | G05 oraz monitoring | Cold restore na drugim hoście, replay kasowań, zmierzone RPO/RTO i działające alerty. |
| 5 | Odbiór biznesowy i portale | Aktualny kontrakt danych/XLSX, partia i awarie zaakceptowane według protokołu niżej. |
| 6 | Identyfikowalne wydanie i ograniczony start | Commit/digest/rollback, wyznaczony operator, limity partii i zwiększanie ruchu według wyników. |

Minimalny protokół odbioru automatu:

1. Lokalnie/staging: 3–5 syntetycznych rekordów przez rzeczywisty web/API/DB/Redis/worker, od importu do wyniku/leada/przydziału/pobrania. Macierz admin/manager/operator/reviewer/auditor, brak sesji i odmowa cudzych zasobów.
2. Portale: kilka różnych uprawnionych rekordów; sukces, brak osoby, brak PESEL, brak polis, niejednoznaczność i niedostępny typ podmiotu. Pierwsze wydanie ma wymieniać odebrane przypadki; adapter live wyszukuje REGON i osobę, ale nie ma odbioru wszystkich typów firm.
3. Rzeczywisty SMS dla PZU i Compensy: kod poprawny/wygasły, timeout i ponowienia, restart, izolacja uprawnień uruchamiającego. Dzisiejsze testy pokrywają te mechanizmy na fixture.
4. Restart/utrata połączenia w punktach: przed rozpoczęciem sprawy, po zamiarze zapisu, po zapisie, po zamiarze UFG, po snapshot, podczas publikacji XLSX. Niepewna akcja nie tworzy drugiej oferty/zapytania UFG; wynik można bezpiecznie dostarczyć ponownie.
5. Ręczna praca na tych samych kontach: utrata sesji, zmiana formularza i wygasły profil. Brak przeniesienia danych pomiędzy rekordami.
6. Dłuższa reprezentatywna partia i kilka równoległych użytkowników. Automat portalowy jest pojedynczy; zmierzyć czas na rekord, przepustowość, czas oczekiwania, pamięć i rozrost dysku. Ustalić limit pierwszej produkcji z tych pomiarów.
7. Porównać snapshot → API → aktualny XLSX → lead i zachowany wynik po kasowaniu importu. Historyczny plik z 10.10 nie potwierdza nowego układu eksportu.

Decyzja GO wymaga zamknięcia G01, pozostałych blokerów wybranego zakresu i dowodów odbioru środowiska. Samo przepisanie flagi `WORKER_LIVE_PORTALS=1` nie jest wdrożeniem ani odbiorem produkcji.
