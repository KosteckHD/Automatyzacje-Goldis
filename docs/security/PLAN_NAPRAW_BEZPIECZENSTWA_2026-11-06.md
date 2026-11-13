# Plan implementacji napraw po audycie z 6 listopada 2026

Podstawa: [raport audytu](AUDYT_BEZPIECZENSTWA_2026-11-06.md). Ten dokument zachowuje pierwotny plan implementacji; rzeczywisty stan poprawek i wyniki odbioru są w [statusie wdrożenia](IMPLEMENTATION_STATUS_2026-11-06.md). Poniższe nazwy nowych plików i testów są propozycjami implementacyjnymi. Istniejących zmian użytkownika nie resetować ani nie nadpisywać.

**Rozwinięcie wykonawcze:** [osobna karta implementacji dla każdego znaleziska](naprawy-2026-11-06/README.md) zawiera kontrakty wejścia, kolejność operacji, projekt blokad i migracji, identyfikatory testów, wdrożenie oraz kryteria zamknięcia CYB-001–007 i DEP-001. Wspólne pakiety poniżej wyznaczają kolejność prac; karty doprecyzowują sposób wykonania. Manifest audytu jest historycznym dowodem jego stanu i nie jest zmieniany przy redakcji planu.

## Kolejność i zależności

1. SEC-A — walidacja słownika (CYB-001).
2. SEC-B — transakcja edycji, rewizji i audytu (CYB-002/003); po SEC-A.
3. SEC-C — limity parsera i procesów (CYB-004); niezależnie od SEC-B.
4. SEC-D — atomowy cykl zadania prowizji (CYB-005/006); wspólna implementacja, po ustaleniu kontraktu stanów.
5. SEC-E — spójna polityka auditor i cofniętych grantów (CYB-007); rozstrzygnąć przed zamknięciem testów ról.
6. SEC-F — zależności, build i regresja całej aplikacji.
7. SEC-G — odbiór PostgreSQL/Redis/HTTPS/restore na izolowanym środowisku; zamyka wydanie.

Każdy pakiet powinien być osobno przeglądalną zmianą z własnym dowodem odbioru. Właściciel A/B/D: backend; C: Python/backend; E: właściciel polityki dostępu + backend; F: utrzymanie; G: utrzymanie infrastruktury. Są to role do przypisania, nie deklaracja przydzielenia konkretnym osobom. Priorytet A–E: P1. F/G: bramki wydania; sama zmiana zależności DEP-001 ma P2.

## SEC-A — zamknąć wejście edycji słownika

Pliki: `apps/api/src/features/commissions/commissions.controller.ts`, `commissions.service.ts`; nowy `commission-dictionary-input.ts` lub równoważny moduł kontraktu oraz testy wejść/HTTP.

1. Przyjmować niezaufane body jako unknown i użyć wspólnego parsera runtime. Odrzucać null, tablice, brakujące pola, nieznane klucze, niewłaściwe typy i niedozwolone wartości. Sprawdzić revision jako dodatnią safe integer, agent jako dokładnie Ola lub Maciek, status jako wartość zamkniętego zbioru. Dla RATE wymagać skończonej liczby 0–100; dla pozostałych statusów ustalić jednoznaczną regułę braku/null stawki i zachować zgodność UI.
2. Walidować także granicę serwisu; wywołanie wewnętrzne nie może omijać parsera. Przed indeksowaniem wymagać własnej właściwości w agents i prawidłowego obiektu komórki. Brak komórki w uszkodzonym snapshotcie zwraca kontrolowany błąd bez mutacji.
3. Zachować istniejące ograniczenia sesji, execute, CSRF i osobnego prawa edycji. Nie stosować globalnej zmiany Object.prototype jako naprawy. Przejrzeć pozostałe indeksowania niezaufanych kluczy w rules i snapshotach.

Odbiór: prawidłowa zmiana dla obu agentów działa; klucze prototypu, constructor, nieznana nazwa, null/obiekt/tablica, string zamiast liczby i stawka poza zakresem dają 400. Test na rzeczywistym serwisie stwierdza brak zmiany deskryptorów Object.prototype oraz brak save/audytu sukcesu po odrzuconym wejściu. HTTP testować z rzeczywistym serwisem, bez stubowania logiki: anonimowy, brak execute, brak grantu słownika i błędny CSRF są odrzucane. Test dotykający prototypu wykonywać w jednorazowym procesie.

Migracja: brak. Wycofanie: w razie regresji wyłączyć edycję słownika do poprawy; nie przywracać otwartego wejścia.

## SEC-B — jedna atomowa operacja edycji i audytu

Pliki: `commissions.service.ts`, `commissions.repository.ts`, testy serwisu i nowe testy integracyjne słownika. Istniejące publishDictionary/activateDictionary są punktem odniesienia dla API transakcji.

1. Po walidacji rozpocząć repository.transaction. Odczytać słownik po tenantId i dictionaryVersionId z blokadą UPDATE; sprawdzić status draft i expectedRevision po uzyskaniu blokady. Wszyscy piszący do tego rekordu muszą używać tego protokołu.
2. Odszyfrować, zmienić lokalny snapshot, podnieść rewizję i zapisać z transaction. audit.record otrzymuje tę samą transaction. Zwrócić sukces dopiero po commit. Alternatywa CAS jest dopuszczalna tylko z kontrolą jednego zmienionego rekordu i audytem w tej samej transakcji.
3. Edycja starej rewizji zwraca 409 bez efektów. Wyścig edit/publish ma pozostawić spójny snapshot: albo edycja poprzedza publikację, albo po publikacji edycja jest odrzucona. Zmiana nie może aktualizować opublikowanego słownika.
4. Sprawdzić przy analogicznym przeglądzie import/deleteFile/cancelRun/addResolution/eksport. Dla operacji obejmujących pliki zaprojektować staging/outbox lub kompensację; nie udawać, że rollback SQL cofa zapis/usunięcie pliku.

Odbiór na izolowanym PostgreSQL z dwoma niezależnymi połączeniami i barierą startu: dwa zapisy tej samej rewizji dają dokładnie jeden sukces i jeden 409; końcowy snapshot, hash i rewizja odpowiadają zwycięzcy. Awaria rzeczywistego insertu audytu wycofuje zmianę rekordu i rewizję. Obcy tenant nie zmienia rekordu. Kontrolować także edit/publish oraz odpowiedź po błędzie commit. Adapter pamięciowy nie zamyka tych testów.

Migracja: zasadniczo brak dla blokowania istniejącego rekordu; ewentualne indeksy/constraints dopiero po analizie schematu. Rollback: aplikacja poprzedniej bezpiecznej wersji lub wyłączenie mutacji; bez odtwarzania całej bazy dla błędu kodu.

## SEC-C — preflight XLSX i ograniczenie procesu Python

Pliki: `services/commission-engine/src/goldis_commissions/importers/workbook.py`, `client_dictionary.py`, `cli.py`, `transport/process_supervisor.py`, `transport/app.py`; testy unit/integration; uzupełniająco klient `apps/api/src/features/commissions/commission-engine-client.ts`.

1. Przed każdym eager load_workbook wykonać ograniczony preflight ZIP i strumieniowy XML. Sprawdzać wymiary z faktycznych indeksów komórek, a nie wyłącznie deklarację dimension; liczbę arkuszy, komórek, węzłów XML, długość tekstu, liczbę scaleń i sumę ich rozwiniętych powierzchni. Odrzucać uszkodzone/nieprawidłowe zakresy oraz DTD/encje. Wszystkie sumy muszą mieć górne granice; sprawdzenie jednego scalenia nie wystarcza. Nie materializować komórek podczas preflight.
2. Dla słownika zachować obecne limity 40 arkuszy, 25 000 wierszy i 64 kolumn jako górne granice, o ile zaakceptowane fixture ich potrzebują. Proponowany początkowy budżet ekspansji scaleń to 10 000 łącznie, do potwierdzenia na syntetycznych i zatwierdzonych zanonimizowanych słownikach. Określić osobny limit łączny komórek i XML; nie mnożyć limitu per arkusz bez limitu całego pliku. Stary importer słownika także musi przechodzić preflight albo zostać wycofany z użycia.
3. Rozważyć read_only=True tylko po sprawdzeniu wymaganych stylów/stawek i zachowania scaleń. Zachować keep_vba=False, zakaz zewnętrznych łączy, brak wykonywania formuł i poprawne formaty procentów. Kontrola API jest dodatkową warstwą; silnik musi sam odmawiać niebezpiecznego wejścia.
4. W supervisorze zastosować globalny budżet procesów i ograniczone oczekiwanie na slot, a nie wyłącznie unikalność executionId. Timeout obejmuje cały cykl procesu: start, stdin, odczyt i wait. W każdym błędzie kill, anulowanie readerów i oczekiwanie na ich zakończenie oraz usunięcie wpisu active. Nie pozwalać, aby przekroczenie stdout/stderr pozostawiło proces do końca timeoutu.
5. Limitować faktycznie odczytane bajty requestu/response, nie polegać wyłącznie na Content-Length lub response.json bez ograniczenia. Ustalić kontrolowane kody 400/413/422 dla pliku, 429/503 dla braku slotu i 408 dla czasu; komunikaty bez lokalnych ścieżek i wejścia użytkownika. Zweryfikować redirect:error w kliencie wewnętrznym, jeśli przekierowania nie są częścią kontraktu.

Odbiór: guard testowy dowodzi odrzucenia wielkiego zakresu PRZED load_workbook. Testować wiele małych scaleń przekraczających sumę, błędne indeksy, fałszywą dimension, limity ZIP/XML i poprawny plik kontrolny. Zaliczyć istniejące testy importu, reguł i eksportu. Testy supervisora: pełne stdout/stderr, timeout stdin, błędny proces, anulowanie oraz odzyskanie slotu — bez osieroconych procesów. Integracyjny HTTP z tokenem i bez tokena, wyłącznie na loopback. Pomiar pamięci wykonywać na ograniczonych fixture i izolowanym kontenerze, bez celowego OOM.

Migracja danych: brak; aktualizacja wersji parsera i obrazu silnika. Rollback: wyłączyć import słownika przy regresji i zachować poprzednie opublikowane snapshoty; nie wracać do nieograniczonego parsera. Retest w Dockerze wymagany mimo sukcesu Windows.

## SEC-D — atomowe przejęcie, anulowanie i publikacja prowizji

Pliki: `apps/api/src/commission-worker.ts`, `features/commissions/commissions.service.ts` (cancelRun), model/repozytorium, ewentualna kolejna migracja; nowe testy worker-state i DB/Redis.

1. Spisać tabelę dozwolonych przejść: queued→running; running→completed/completed_with_findings/failed/cancel_requested; queued→cancelled; cancel_requested→cancelled. Terminalne stany nie wracają do running przez replay. Retry wymaga jawnej ścieżki i aktualnej próby. Nie zmieniać znaczenia odrębnej, celowo zlecanej ponownej analizy.
2. Przejęcie zadania: jedna transakcja z blokadami w stałej kolejności run→dispatch albo równoważny CAS. Wymagać właściwego tenanta, stanu i aktualnego tokenu. Tylko zwycięzca uruchamia silnik. Dla odtwarzania po awarii potrzebny jest lease/fencing z nowym tokenem; sam status running nie wystarcza. completed dispatch/run kończy replay bez efektów.
3. Publikacja: w transakcji zablokować ten sam run, zweryfikować running i token, następnie zapisać snapshot, status końcowy, dispatch oraz pojedynczy audyt. Sprawdzać affected rows/RETURNING; zero rekordów oznacza przerwanie i rollback. Snapshot nie może być nadpisany przez przegraną/starszą próbę. Uzgodnić klucz idempotencji audytu sukcesu, żeby retry commit nie duplikowało zdarzenia.
4. cancelRun używa tej samej blokady i transakcyjnego audytu. Gdy anulowanie zatwierdzi się pierwsze, brak publikacji. Gdy sukces zatwierdzi się pierwszy, anulowanie zwraca stan terminalny bez zamiany zakończonego runu na cancel_requested. Zamknięcie dispatchu odpowiada wynikowi runu.
5. Zastosować ten sam fencing do markFailure, retries, recovery i obsługi błędów — opóźniony błąd starej próby nie może zmienić ukończonego/anulowanego zadania. Błąd DB przy odczycie cancel nie może być traktowany jako pozytywne pozwolenie publikacji.

Odbiór na PostgreSQL/Redis: terminalny replay nie wywołuje silnika i nie zmienia hasha, dat ani liczby zdarzeń; dwa dostarczenia dają jedno przejęcie; cancel vs commit przetestowane w obu kolejnościach; stary token po odzyskaniu lease nie publikuje; crash przed/po commit nie duplikuje wyniku. Po awarii audytu brak snapshotu/statusu sukcesu. Cancel queued nie zostawia wykonywalnego dispatchu. Użyć dwóch klientów DB i barier testowych, nie losowego sleep jako dowodu wyścigu.

Migracja: dopiero po analizie istniejących pól attempt/dispatch zdecydować, czy potrzebne są lease, claim lub unikalność audytu. Dodać nową migrację, nie edytować wykonanych migracji. Przed wdrożeniem zatrzymać i opróżnić lub kontrolowanie zamrozić worker prowizji, zinwentaryzować aktywne próby. Nie mieszać starego i nowego konsumenta. Rollback wymaga zatrzymania konsumentów; zachować zgodny schemat i nie cofać tokenów fencing.

## SEC-E — spójna rola × capability

Pliki: `features/authorization/tool-access.ts`, `authorization-policy.ts`, `features/leads/business-leads.service.ts`, `features/admin/admin-users.service.ts`, dokumentacja roli i rzeczywiste testy HTTP/DB.

1. Przyjąć jedną macierz dla list/get/export/snapshot/dashboard/navigation. Zalecenie planu: auditor czyta wyłącznie audyt, zgodnie z instrukcją administratora. Zamierzony wyjątek biznesowy musi zostać jawnie rozstrzygnięty przed implementacją ograniczenia; odtworzony odczyt sam nie rozstrzyga intencji.
2. Ograniczenie roli jest górną granicą; grant nie podnosi capability ponad tę granicę. Centralną politykę wykorzystywać w serwisach i katalogu narzędzi. Ukrycie przycisku w UI nie jest zabezpieczeniem danych.
3. Przy zmianie roli transakcyjnie dezaktywować niezgodne granty, cofać sesje i zapisywać audyt. Obsłużyć istniejące granty jednorazową kontrolowaną migracją lub komendą z dry-run; nie usuwać praw dozwolonych nowej roli.
4. Osobno ustalić kontrakt wcześniej przyjętej pracy po revoke/disable. Rekomendacja: nowe zlecenia zawsze odrzucone; dalsze wykonanie jawnie autoryzowane jako praca organizacji albo zatrzymywane przez unieważnienie dopuszczenia/fencingu. Nie udostępniać workerowi pełnych tabel sesji w celu tej kontroli.

Odbiór: auditor bez grantu, ze starym view/download oraz po operator→auditor i nowym loginie; rzeczywiste list/get/export/snapshot/navigation zgodne z macierzą. Dla rekomendowanej restrykcyjnej polityki odmowa bez danych i bez utworzenia eksportu. Pozytywne przypadki operator/manager/reviewer oraz obcy tenant. Kontroler ze stubem serwisu nie zamyka odbioru.

Migracja/rollback: jeśli czyszczone granty, zachować zredagowany raport liczby i rodzaju zmian; nie odtwarzać automatycznie dawnych praw przy rollbacku aplikacji. Zmianę polityki zakomunikować administratorom.

## SEC-F — zależności i regresja

1. Ujednolicić pyproject.toml z requirements.lock oraz rzeczywistą metodą builda. Zbudować czysty obraz i wykonać audyt zainstalowanych pakietów, nie wyłącznie pliku lock. Zachować skan 17 wpisów OSV jako osobny dowód.
2. Dla DEP-001 sprawdzić aktualizacje rodziców i zgodność API/CommonJS/ESM. Nie używać audit fix --force ani ślepego override uuid major. Jeśli bezpieczna aktualizacja nie jest dostępna, wyjątek musi mieć właściciela, uzasadnienie osiągalności i termin ponownego przeglądu, np. przed następnym wydaniem i maksymalnie za 30 dni. Raport ma nadal pokazywać advisory.
3. CI uruchamia testy regresji A–E oraz aktualny npm/pip audit, weryfikację sekretów bez ich wypisywania, skan obrazów/SBOM i identyfikację digestów. Pinowanie Actions do SHA w osobnym hardeningu.
4. Po zmianach wykonać odpowiednie testy jednostkowe, HTTP, kontraktowe i architektoniczne; build web/API/worker/core oraz istniejące syntetyczne testy bezpieczeństwa przeglądarki i importów. Testów LIVE i pełnego procesu nie uruchamiać jako skutku samego builda.

Odbiór: brak nierozpatrzonych high/critical, wyjątki moderate jawne i aktualne, powtarzalny build i zgodność wersji testowanych z wydawanymi. Zielony audit nie zastępuje testów własnych błędów logiki.

## SEC-G — bramki rzeczywistego środowiska

1. Utworzyć izolowany projekt PostgreSQL/Redis z syntetycznymi tenantami i rolami. Wykonać macierz 159 tras: anonimowy, dozwolony/niedozwolony użytkownik, inny właściciel/tenant, cofnięta sesja/grant, wyłączone konto, błędny/brak CSRF i nadmiarowe pola. Nie wszystkie kombinacje muszą istnieć dla każdej trasy, ale każdy brak zastosowania wymaga uzasadnienia. Aktualizować inwentarz dowodami, nie zbiorczą etykietą PASS.
2. Testować faktyczne role PostgreSQL i ACL Redis: brak dostępu workera do sesji i obcych namespace, brak UPDATE/DELETE audytu, brak CONFIG/FLUSH i uprawnień admin. Awaria Redis ma odmawiać autoryzowanych operacji zależnych od budżetu zgodnie z kontraktem.
3. Na izolowanym Linuxie potwierdzić nonroot, read-only, seccomp/capabilities, limity i włączony sandbox przeglądarki. Zweryfikować rzeczywisty proxy, TLS/HSTS/secure cookies, blokadę internal, prywatne porty oraz brak obejścia limitów przez podszyte forwarded headers.
4. Cold restore do nowych wolumenów: weryfikacja szyfrowania/manifestu, replay dziennika kasowań, brak powrotu usuniętych danych, unieważnione tokeny recovery. Zmierzyć RPO/RTO. Sprawdzić offsite, retencję, alarm braku backupu i odzyskiwanie po przerwaniu procedury. Nie wykonywać restore do używanej bazy.

Warunek zamknięcia planu: A–E mają regresje i wyniki DB/HTTP, F identyfikuje wydawany artefakt i jawne wyjątki, G dostarcza dowody infrastruktury i restore. Otwartej bramki nie zastępuje test z adapterem pamięciowym.

## Wdrożenie i dowody

Przed wdrożeniem zachować zaszyfrowany backup i manifest obrazów, migracji, lockfile oraz hashy źródeł. Najpierw silnik z limitami, następnie zgodne API i worker po zatrzymaniu starszych konsumentów; szczegółową kolejność potwierdzić kontraktami danej zmiany. Retest na stagingu z danymi syntetycznymi. Monitorować kody odrzuceń importu, 409 rewizji, odrzucone stare tokeny, opóźnienia kolejki i niespójne stany bez logowania plików, haseł, SMS ani danych klientów.

Dla każdego CYB zapisać: commit/build, środowisko, polecenie/test, expected/actual, exit code, ograniczenia oraz odnośnik do wyniku. Historyczne harnessy pokazujące błąd zachować jako dowód; naprawę odbierają testy z nowymi, bezpiecznymi oczekiwaniami. Manifest końcowy utworzyć po zamknięciu dowodów. Nie oznaczać aplikacji jako bezpiecznej wyłącznie na podstawie liczby PASS.
