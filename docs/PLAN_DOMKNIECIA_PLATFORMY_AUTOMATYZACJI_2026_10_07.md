# Goldis — plan implementacji z testami poszczególnych modułów

Data: 7 października 2026. Rewizja 2, zgodna z decyzją użytkownika o zachowaniu kontroli nad pełnym procesem. Baza kodu: `e3a507ea8e534f06d698289bf1165f79691e5a6d` oraz lokalne poprawki opisane w `STAN_IMPLEMENTACJI.md`.

Dokument jest instrukcją przyszłych prac dla agenta kodującego. Nie jest potwierdzeniem implementacji ani raportem nowych testów. Każdy pakiet kończy się testami wyprodukowanego kodu i udokumentowaniem wyniku.

## 0. Zakres pracy i kontrola użytkownika

### 0.1. Granice wykonania

1. Agent implementuje wszystkie opisane funkcjonalności i sprawdza je osobno: testami jednostkowymi, kontraktowymi, integracją konkretnego modułu z HTTP/DB/Redis oraz testami jego interfejsu.
2. Z planu usunięto zadanie zaliczenia całego przepływu platformy. Nie tworzyć ani nie uruchamiać wspólnego scenariusza import → rejestr → review → submission → Everest → Compensa → SMS → UFG → wynik → pobranie. Nie dodawać go do CI pod inną nazwą.
3. Pełne uruchomienie procesu biznesowego, jego odbiór oraz praca na prawdziwych portalach pozostają pod kontrolą użytkownika. Agent nie uruchamia pilotażu live, małej serii ani zadań na danych klientów w ramach tego planu.
4. Każdy test modułu otrzymuje własne syntetyczne dane wejściowe i kończy się na kontrakcie wyjściowym tego modułu. Test submission kończy się na DB/outbox i kontrolowanym odbiorniku kolejki; nie uruchamia procesora portalowego. Test eksportu otrzymuje gotowy syntetyczny snapshot; nie pobiera danych z portali.
5. Testy adapterów Everest, Compensa i UFG korzystają z lokalnych fikcyjnych stron, tymczasowego profilu i liczników operacji. Dopuszczalne są integracje wewnątrz jednego adaptera, bez połączenia ich w pełny proces.
6. Testy MF/BIR korzystają z lokalnego serwera z przygotowanymi odpowiedziami. Aktywacja dostawcy live, użycie klucza produkcyjnego i sprawdzanie danych użytkownika wymagają odrębnego zlecenia użytkownika.
7. Istniejących testów pełnego procesu i ich historycznych wyników nie usuwać. Komendy `test:automation-e2e` i `test:platform-e2e` nie należą do automatycznej listy wykonania tego planu.
8. Oddzielać status „kod modułów gotowy do odbioru użytkownika” od „pełny proces odebrany”. Ten drugi status nie wynika z testów modułów. W przekazaniu zapisać `DO_ODBIORU_UZYTKOWNIKA`, bez deklarowania pełnego odbioru.
9. Niniejsza rewizja zastępuje wcześniejsze zalecenia automatycznego pełnego odbioru w starszych dokumentach. Pozostałe wymagania funkcjonalne, jakościowe i bezpieczeństwa nadal obowiązują.

### 0.2. Rozpoznanie stanu wejściowego

1. Sprawdzić `git status`, lokalne zmiany, instrukcje repozytorium i aktualny numer migracji. Nie nadpisywać zmian użytkownika; każdy pakiet opisać względem rzeczywistego kodu.
2. Migracje 001–027, review, trwałe enrichment jobs i run submissions już istnieją. Rozszerzać te mechanizmy zamiast budować konkurencyjne rozwiązania.
3. Zachować poprawki bootstrap HTTP: wspólne `createHttpApplication`, limity JSON 100 KB / 5 MB oraz pojedynczy prefiks `/api` enrichment. Ich regresje mają pozostać zielone.
4. Stan wejściowy: runner enrichment otrzymywał `null`; dodano adapter MF VAT, osobny runtime worker, health, trwały budżet, rzeczywisty batch i współdzielony cache wyników. GUS oraz pełne operacyjne UI pozostają do wykonania.
5. Pozostają m.in. zmiana writer audytu pobrania na artifactId, ograniczenie pełnego skanowania importu w grupowaniu i rozszerzenie centrum operacyjnego.
6. Przebudowa Dockera i migracja odizolowanej kopii bazy z 7 października są już opisane w dzienniku. Nie powtarzać operacji na istniejącej bazie wyłącznie w celu testowania nowego kodu.
7. Historyczny PASS zachować jako dowód poprzedniej wersji, bez przedstawiania go jako testu nowej implementacji.

### 0.3. Procedura obowiązująca dla każdej zmiany

1. Przeczytać aktualny kod i testy; wskazać brakujące zachowanie oraz pliki objęte zmianą.
2. Opisać wejście, wyjście, stany błędu, uprawnienia, transakcje, ponowienia i granicę testowanego modułu.
3. Dodać test wykazujący brak lub regresję. Dla nowej funkcji najpierw zapisać oczekiwane zachowanie.
4. Wprowadzić minimalną spójną implementację. Jeśli potrzebny schemat, dodać następną migrację i sprawdzić upgrade oraz ponowne uruchomienie migratora.
5. Tenant/actor/rola pochodzą z aktualnej sesji i członkostwa. Scope SQL stosować przed liczeniem i paginacją; mutacje zabezpieczać Origin/CSRF, walidacją body, wersją/CAS lub blokadą.
6. Dane domenowe i audyt zapisywać w tej samej transakcji. Operacji sieciowych nie wykonywać w długiej transakcji; przed zapisem ponownie zweryfikować prawa, wersję i lease.
7. Uruchomić testy jednostkowe, kontrakt HTTP, izolowaną integrację DB/Redis i odpowiedni test UI. Dodać wymagane testy bezpieczeństwa i awarii konkretnego modułu.
8. Sprawdzić sąsiednie funkcje dotknięte zmianą i build. Testów nie powtarzać bez nowej zmiany, błędu lub nierozstrzygniętego ryzyka.
9. Zapisać komendy, expected/actual, wersję, wynik i sprzątanie. Rozróżniać `PASS`, `FAIL`, `SKIP` i `BLOCKED`; pominięty test nie jest zaliczony.
10. Każdy zmieniony widok sprawdzić przy 320, 768 i 1920 px, obsłudze klawiatury, pustej liście, 409/503 i spóźnionej odpowiedzi. Dane późnego requestu nie mogą nadpisywać nowszego wyboru lub draftu. Przed kodem Next przeczytać `apps/web/AGENTS.md` i odpowiednią lokalną dokumentację Next wskazaną w tym pliku.

### 0.4. P0 — najpierw odseparować uruchamianie testów

Pliki startowe: `scripts/Test-GoldisDatabase.ps1`, `apps/api/scripts/run-db-integration.cjs`, `apps/api/scripts/migration-smoke.cjs` oraz `scripts/test-module.cjs`. Runner modułowy jest już zaimplementowany; dalsze kroki P0 to rozszerzanie testów jego izolacji przy nowych modułach.

1. Sporządzić mapę procesów potomnych i dziedziczonych zmiennych. Obecne `GOLDIS_AUTOMATION_E2E=1` powoduje uruchomienie dodatkowych scenariuszy w `migration-smoke.cjs`; sama nazwa „DB integration” nie gwarantuje ograniczonego zakresu.
2. Jawny manifest obejmuje migrations, registry, review, submission, auth, sms, results, audit-reports, Everest, Compensa i UFG. Dodatkowe komendy `everest-browser`, `compensa-browser`, `ufg-browser` włączają lokalne fixture Chromium, bez uruchomienia live.
3. Wyodrębnić potrzebne istniejące asercje do osobnych zestawów. Każdy zestaw ma własny seed, oczekiwane efekty i cleanup; zakończenie testu nie wywołuje następnego modułu.
4. Runner modułowy jawnie wyłącza odziedziczone przełączniki pełnego procesu i live. Nie wystarczy zakładać, że terminal nie ma ich ustawionych. Zmienne procesu nadrzędnego przywracać po zakończeniu.
5. Tworzyć tymczasowy PostgreSQL/Redis, losowe nazwy, osobne porty i katalogi z oznaczeniem właściciela. Przed mutacją odrzucać konfigurację wskazującą istniejącą bazę, współdzielony Redis lub profil użytkownika.
6. Test HTTP startuje tę samą fabrykę aplikacji co produkcja. Transport zewnętrzny kierować wyłącznie do lokalnego fixture; nieoczekiwany host ma natychmiast przerwać test.
7. Sprzątanie działa po sukcesie, błędzie i przerwaniu; usuwa wyłącznie zasoby utworzone przez dany runner, po sprawdzeniu własności i rzeczywistej ścieżki.
8. Dodać test kontraktu runnera: wybór submission nie startuje workera portalowego; eksport nie startuje lookup; odziedziczone flagi pełnego procesu nie rozszerzają zakresu.

**Testy P0:** błędny moduł odrzucony; nieizolowany URL odrzucony przed zapisem; dziedziczone flagi neutralizowane; błąd procesu potomnego raportowany; zasoby posprzątane; obcy zasób pozostaje nienaruszony. Dopiero potem używać nowych komend modułowych w kolejnych pakietach.

### 0.5. Mapa kodu i kontraktów do sprawdzenia przed zmianą

Wpisy są punktami startowymi w istniejącym repozytorium. Agent rozszerza je po analizie importów i zależności; nie zakłada, że sama zmiana wskazanego pliku zamyka moduł.

| Obszar | Istniejące punkty startowe |
| --- | --- |
| Import/review/grupowanie | `apps/api/src/imports.ts`, `review.ts`, `review-service.ts`, `entity-grouping-service.ts` i ich testy |
| Submission | `apps/api/src/run-submissions.ts`, `run-submissions.http.test.ts`, `apps/web/app/run-submission-launcher.tsx`, `submissions/[id]/submission-detail.tsx` |
| Everest | `apps/worker/src/everest-identity-provider.ts` i `everest-identity-provider.test.ts` |
| Compensa | `apps/worker/src/compensa-session.ts`, `compensa-form.ts`, `compensa-offer-saver.ts`, `compensa-offer-checkpoint.ts` i ich testy |
| SMS | `apps/api/src/auth-challenges.ts`, `sms-retry-policy.ts`, `apps/worker/src/auth-challenges.ts` i testy HTTP/UI |
| UFG | `apps/worker/src/compensa-ufg.ts` i `compensa-ufg.test.ts` |
| Wyniki/eksport | `apps/api/src/worker-results.ts`, `runs.ts`, `apps/worker/src/result-staging.ts`, `result-staging-checkpoint.ts`, `result-forwarder.ts` |
| Prawa/sesje | `apps/api/src/authorization-policy.ts`, `authorization-guard.ts`, `session-auth.test.ts` i powiązane usługi |
| Audyt/raporty | `apps/api/src/audit.ts`, `audit-search.http.test.ts`, `admin-reports.ts` |
| Migracje/runtime | `apps/api/src/migrations/`, `http-bootstrap.ts`, `compose.yaml`, skrypty startu i preflight |

Przy zmianie wspólnego typu dodać test zgodności producenta i konsumenta na tym samym syntetycznym kontrakcie, ale uruchamiany osobno po obu stronach. Szczególnie sprawdzić: decyzja REGON → effective source, submission → payload runId, challenge → jednorazowy handoff, UFG → snapshot i snapshot → finalizacja. Nie łączyć tych prób w pełny proces.

## 1. REG — kompletne wzbogacanie NIP → REGON

Pliki: `apps/api/src/registry-provider.ts`, `registry-lookup.ts`, `registry-result.ts`, `registry-enrichment.ts`, `enrichment-jobs.ts`, `enrichment-worker.ts`, health/admin, `apps/web/app/enrichment-review.tsx`, `compose.yaml`, `scripts/Start-GoldisLocal.ps1` i przykłady konfiguracji.

### REG-01. Dostawca, konfiguracja i kontrakt

1. Zachować wybór bezpłatnego MF Wykaz podatników VAT jako pierwszego adaptera bez klucza. Brak wpisu lub REGON w tym wykazie nie dowodzi nieistnienia firmy; zapewnić ręczną ścieżkę korekty.
2. Przygotować także bezpłatny GUS BIR. Produkcja wymaga klucza otrzymanego od GUS; implementacja adaptera i testy syntetyczne nie wymagają wysyłania wniosku w imieniu użytkownika.
3. Przed kodowaniem transportu przeczytać aktualną oficjalną specyfikację i potwierdzić pola, limity, błędy oraz adresy. Nie przenosić założeń z wyszukiwarki WWW na API.
4. Wprowadzić fabrykę `disabled`, `mf-vat`, `gus-bir`. Oddzielić konfigurację transportu od domenowej decyzji dopasowania; testowy fixture nie jest dostawcą dostępnym w produkcji.
5. Konfiguracja obejmuje timeout, rozmiar odpowiedzi, współbieżność, retry, TTL i budżet. Klucz BIR pozostaje sekretem serwera, bez odczytu w panelu/logach.
6. Produkcyjne adresy kontroluje kod lub konfiguracja wdrożenia: HTTPS, poprawny TLS, bez redirect do obcego hosta. API użytkownika nie przyjmuje dowolnego URL.
7. Kontrakt wejścia: NIP jako tekst po checksum, utrwalony dzień danych rejestru i źródło zapytania. Dzień dostawcy ustalać w Europe/Warsaw; nie mylić go z datą wyboru polis.
8. Kontrakt wyjścia: dostawca/wersja, dzień danych, fetchedAt, minimalne kandydaty NIP/REGON/nazwa/typ jednostki i typowany status. Odrzucać rachunki bankowe, reprezentantów i inne zbędne dane.

**Testy:** nieznany provider i niepoprawna konfiguracja blokują start; disabled nie przejmuje jobów; brak sekretu BIR daje czytelny stan; NIP z zerem zachowuje tekst; wadliwy checksum nie wywołuje transportu; URL użytkownika nie może zmienić hosta.

Źródła kontraktu: [MF API](https://www.gov.pl/web/kas/api-wykazu-podatnikow-vat), [MF zakres wykazu](https://www.gov.pl/web/kas/informacje-o-wykazie), [GUS BIR](https://api.stat.gov.pl/Home/RegonApi?lang=pl). Potwierdzony kontrakt MF search ma limit 100 zapytań dziennie i do 30 NIP w rzeczywistym zapytaniu batch; adapter implementuje oba endpointy i został sprawdzony wyłącznie lokalnym HTTP fixture. Metoda check nie służy do pozyskania REGON.

### REG-02. Adapter MF

1. Na podstawie oficjalnego kontraktu wybrać search po NIP i zaimplementować mapowanie pojedynczego oraz zbiorczego wyniku do właściwego NIP.
2. Walidować status HTTP, Content-Type, rozmiar, schemat i identyfikatory odpowiedzi. REGON przechowywać jako tekst; null, pusty, wadliwy lub obcy wynik nie uzupełnia danych.
3. Oddzielić: zgodny wynik, brak w wykazie, brak REGON, wiele kandydatów, konflikt, wadliwa odpowiedź, niedostępność i limit.
4. Timeout kończy rzeczywisty request przez AbortSignal. Retry jest ograniczony, tylko dla określonych błędów przejściowych; nie logować pełnej odpowiedzi ani URL zawierającego NIP.
5. Wyniki batch przypisywać według NIP, nigdy pozycji tablicy. Obcy NIP, duplikat lub brak odpowiedzi dla części żądania nie może przesunąć mapowania pozostałych rekordów.
6. Limit dostawcy przekłada się na trwały cooldown/nextAttemptAt, bez ciasnej pętli i bez terminalnego błędu całej kolejki.

**Testy lokalnego serwera:** 0/1/wiele kandydatów, null REGON, zła nazwa/NIP/checksum, przestawiona kolejność batch, duplikaty, niepełny batch, 429/5xx, zły JSON/Content-Type, przekroczony rozmiar, timeout i abort. Sprawdzać status, liczbę requestów i brak nieuprawnionych zapisów/logów.

### REG-03. Adapter GUS BIR

1. Zaimplementować oficjalny transport i mapowanie do wspólnego kontraktu, bez osłabienia reguł dopasowania.
2. Sesję dostawcy utrzymywać w pamięci; po wygaśnięciu wykonać ograniczony relogin. Zsynchronizować odnowienie między równoległymi zapytaniami, aby uniknąć lawiny logowań.
3. Parser XML wyłącza DTD i external entities; ogranicza rozmiar oraz głębokość. Błędy dostawcy mapować na bezpieczne typowane stany.
4. Nie wybierać automatycznie pierwszej jednostki lokalnej ani pierwszego kandydata. Niejednoznaczność prowadzi do review.
5. W przekazaniu oddzielić gotowość adaptera w fixture od dostępności produkcyjnego klucza. Nie uruchamiać fallback bez jawnej polityki i pochodzenia wyniku.

**Testy:** poprawne i wadliwe XML, próba XXE/DTD, wiele jednostek, błędny klucz, wygasła sesja, równoczesne odnowienie, timeout, jeden dozwolony relogin bez pętli. Testy nie łączą się z produkcyjnym GUS.

### REG-04. Trwały budżet, batching i cache

1. Zinwentaryzować istniejące claim/lease i limit joba 500. Zachować limit, dopóki osobna walidacja nie uzasadni zmiany.
2. Dodać port batch lub koordynator lookup. Batching ma oznaczać rzeczywiste wspólne wywołanie HTTP, nie serię pojedynczych requestów nazwaną batch.
3. Dodać migrację trwałego budżetu provider/dzień/wyjście sieciowe i rezerwacji requestu. Rezerwować atomowo przed HTTP; wspólny limit obejmuje repliki i tenantów używających tego samego wyjścia.
4. Niepewnie dostarczony request liczyć konserwatywnie jako zużycie. Restart nie resetuje budżetu; limit zewnętrznie zużyty na tym samym IP powoduje cooldown.
5. Deduplikować NIP; cache jest związany z dostawcą, dniem danych i TTL. Brak wyniku ma osobny krótki TTL. Cache nigdy nie nadaje prawa do obcego joba.
6. Po wyczerpaniu budżetu utrwalać następny termin i powód oczekiwania; nie oznaczać wszystkich itemów jako failed.
7. Opcjonalny fallback posiada osobny budżet i pochodzenie danych; nie uruchamiać dwóch źródeł bez zdefiniowanej polityki.

**Testy DB/transport:** dwa workery walczą o ostatni slot; restart zachowuje zużycie; 31 NIP dzieli się na poprawne żądania przy potwierdzonym limicie 30; duplikaty nie mnożą lookup; cache wygasa; Warsaw midnight zmienia dzień; cooldown nie generuje pętli; obcy tenant nie odczytuje danych cache/jobów.

### REG-05. Bezpieczny zapis, korekty i anulowanie

1. HTTP wykonywać poza transakcją zapisu. Claim utrwala actor/tenant, wersję, lease i zakres danych wejściowych.
2. Przed commit ponownie sprawdzić eligibility, aktualne uprawnienia, wersję wiersza, cancel oraz własność lease.
3. Zgodny kandydat może uzupełnić wyłącznie pusty effectiveRegon wraz z pochodzeniem. Raw pozostaje niezmienione; nie zastępować ręcznej korekty ani snapshotu rozpoczętego runu.
4. Niejednoznaczność, różnica nazwy lub konflikt identyfikatorów trafiają do review. Nie poluzowywać reguły nazwy tylko po to, aby test przeszedł.
5. Grupowanie po zmianie jest tenantowe, z kontrolą wersji, razem z audytem w transakcji. Błąd audytu powoduje rollback.
6. Cancel blokuje nowe claims i, jeśli możliwe, przerywa transport. Spóźniona odpowiedź nie zapisuje anulowanego lub przejętego itemu.
7. Retry dotyczy jawnie wybranych itemów, posiada audyt i nie resetuje budżetu dostawcy.

**Testy DB:** korekta podczas HTTP, cancel przed/po odpowiedzi, wygasły/przejęty lease, dwa zapisy, cofnięty grant/konto, błąd audytu i istniejący run. Asercje obejmują niezmienione raw, brak nadpisania, spójny job/item/row/group/audit oraz właściwy 409/odmowę.

### REG-06. Runtime i interfejs

1. Zastąpić `null` fabryką providerów z jawnym disabled. Dodać osobny enrichment worker do Compose i zarządzanych procesów Windows.
2. Start po gotowych migracjach, własny heartbeat, restart policy, zamknięcie transportów i zwolnienie lease przy zatrzymaniu.
3. Preflight/health rozróżniają disabled, brak konfiguracji, provider unavailable, budżet wyczerpany, worker offline i ready. Disabled nie konsumuje pending items; start joba daje czytelny powód odmowy.
4. UI pokazuje dostawcę, ograniczenie pokrycia, liczniki stanów, powód oczekiwania i nextAttemptAt. Lista jobów/itemów: paginacja, URL, F5 i stan po ponownym logowaniu.
5. Ambiguous/not-found/manual-review prowadzą do konkretnej korekty lub konfliktu. Cancel/retry zabezpieczyć CAS i prawami; reviewer nie startuje lookup, auditor widzi tylko dozwolony audyt.
6. W przykładach konfiguracji wdrożenie pozostaje disabled do aktywacji przez użytkownika; status nie może sugerować gotowości live.

**Testy:** osobny job wzbogacania na syntetycznym seedzie, rzeczywiste API/DB/worker i lokalny provider; restart/cancel/limit, F5, 409 i błąd sieci, klawiatura/fokus, brak sekretów w UI. Test kończy się po wyniku joba i korekcie; nie tworzy submission ani nie uruchamia portali.

**Kryterium pakietu REG:** adaptery, budżet, decyzje, worker i UI mają dowody modułowe. Brak klucza BIR jest jawnym ograniczeniem konfiguracji live, bez blokowania testów syntetycznych i bez deklarowania pełnego pokrycia wszystkich firm.

## 2. ENV — odtwarzalny build, migracje i konfiguracja runtime

1. Dodać identyfikację build/commit/schema w odczycie administratora; publiczny health nie ujawnia ścieżek, sekretów ani konfiguracji.
2. Testować migracje na świeżej bazie i syntetycznym starym schemacie. Drugi migrator nie zmienia danych; nowy schemat zachowuje FK, tenant scope i oczekiwane counts.
3. Jeśli potrzebna zgodność rzeczywistych danych, użyć wyłącznie odizolowanej kopii z zatwierdzonego backupu, bez workerów i zewnętrznych wywołań. Nie wykonywać testowych mutacji na bazie użytkownika.
4. Migrację 024 traktować jako wymagającą backup/restore do rollback danych. Nie obiecywać prostego down ani zgodności starego kodu bez dowodu.
5. Budować API/web/portal worker/enrichment worker z lockfile i zadeklarowanych obrazów. Upgrade major PostgreSQL/Redis nie jest częścią zwykłego przebudowania aplikacji.
6. Test konfiguracji Compose wykonywać na zasobach testowych. Portal mode off; procesor portalowy wyłączony podczas testów innych modułów. Sprawdzać readiness, heartbeat i restart usługi bez tworzenia zadania biznesowego.
7. CI uruchamia build, testy jednostkowe i jawnie wybrane izolowane moduły. Nie wymaga sekretów portali i nie uruchamia wspólnego pełnego procesu.
8. Przygotować manifest wydania, migracji i rollback. Test na zasobach izolowanych nie jest poleceniem kolejnego wdrożenia na istniejącą instalację.

**Testy ENV:** fresh/legacy/repeat migration, brak konfiguracji, niezgodny schema, publiczny/admin version endpoint, HTTP 100 KB / internal 5 MB / 400 / 413, pojedynczy prefiks enrichment, restart testowych wolumenów, drugi właściciel profilu i sprzątanie po przerwaniu. Utrzymać regresje `http-bootstrap.test.ts` i `enrichment-jobs.http.test.ts`.

## 3. FUNC/SEC/REC — funkcjonalności testowane osobno

### FUNC-01. Import, korekty, konflikty i review

1. Porównać parser XLSX z kontraktem nagłówków, wymaganych/nieobowiązkowych pól, identyfikatorów tekstowych i błędów wiersza.
2. Każdy stan danych ma zrozumiały powód i dostępną dalszą czynność; wadliwy rekord nie staje się gotowy przez samą zmianę etykiety.
3. Korekta/propozycja/approve/reject mają wersję/CAS, aktualne prawa i audyt. Dwie konkurencyjne decyzje dają jeden zapis i konflikt drugiej.
4. Grupowanie ograniczyć tenantem i importem. Korekta nie modyfikuje wejścia istniejącego runu ani nie uruchamia automatyzacji.
5. UI zachowuje draft po 409, strony po F5, selekcję dozwolonych rekordów, opis konfliktu i stan błędu bez utraty danych.

**Testy:** parser poprawnych/wadliwych XLSX i zer w NIP/REGON, izolowany seed review, dwie decyzje, rollback audytu, obcy import/row/group ID, operator/reviewer/auditor, paginacja i UI. Test kończy się na zatwierdzonej korekcie/grupie, bez lookup i submission.

### FUNC-02. Pojedyncze zlecenie i partia

1. Preview jest tylko odczytem: zakres, explicit rows, wersje/fingerprint, data odniesienia, grupowanie i jednoznaczne exclusions.
2. Zmiana danych po preview wymaga odświeżenia; podwójny click/request z kluczem idempotencji tworzy jeden submission.
3. Single-row i batch korzystają z jednej reguły admission: pauza, okres, limit i kanoniczna grupa. Sprawdzenia muszą działać atomowo przy konkurencji.
4. Run, powiązania źródeł, outbox i audyt powstają spójnie; w Redis przekazywać identyfikator zadania, bez danych osobowych.
5. Cancel submission dotyczy nieprzyjętych grup. Status już przyjętego runu ma osobną politykę; nie cofać go przypadkowo przez anulowanie partii.
6. Lista/detail pokazują liczniki rekordów i grup, powód oczekiwania, przyjęte runId, paginację i stan po F5.

**Testy:** preview bez zapisu, stale fingerprint/409, idempotencja, single+batch przy limicie 1, pauza, cancel, retry outbox i błąd audytu. Rzeczywiste HTTP/DB/Redis z kontrolowanym odbiornikiem kolejki; żadnego startu portal processor. UI kończy na statusie submission.

### FUNC-03. Adapter Everest

1. Zweryfikować aktualny kontrakt selektorów, roli konta, identyfikatora i dopasowania osoby; nie przenosić sprzecznych dawnych instrukcji bez porównania z obecnym kodem.
2. Zachować sesję/profil i ograniczone ponowienie logowania/MFA. Dla testów używać nowego prywatnego profilu i lokalnej strony.
3. Wyszukiwać dokładny effectiveRegon i potwierdzać zgodność widocznej tożsamości. Obca osoba/identyfikator prowadzą do bezpiecznej odmowy lub interwencji.
4. Wynik minimalizować zgodnie z kontraktem. PESEL i dane uwierzytelniania nie trafiają do logów, błędów ani kolejki.

**Testy jednego adaptera:** sesja aktualna/wygasła, REGON z zerem, brak/wiele/obcy wynik, opóźniony rendering, zmieniony selector, timeout, MFA jako kontrolowany kontrakt. Test kończy się na wyniku Everest; nie otwiera Compensy.

### FUNC-04. Adapter Compensa, formularz i zapis sprawy

1. Test dostaje gotową syntetyczną tożsamość. Zweryfikować sesję, właściwą rolę i zgodność osoby przed zmianą formularza.
2. Uzupełniać wyłącznie brakujące pola z zatwierdzonego źródła/korekty. Konflikt danych blokuje zapis; nie zgadywać powiatu ani innych wymaganych wartości.
3. Utrwalać zamiar zapisu i case/checkpoint; potwierdzenie przypisać do tej samej sprawy i runu.
4. Przy utracie odpowiedzi sprawdzić stan tej samej sprawy. Jeśli wynik niepewny, interwencja; nie wykonywać drugiego kliknięcia zapisu w ciemno.
5. Wznowienie używa istniejącej sprawy; nie tworzy nowego szkicu dla tego samego zamiaru.

**Testy lokalnej strony:** puste i uzupełnione pola, konflikt osoby, brak wymaganych danych, dwa wywołania, restart checkpointu, timeout przed/po zapisie, cancel i wygasły lease. Licznik zapisów jest najwyżej jeden dla danego zamiaru. Test kończy się na kontrakcie sprawy; bez UFG i eksportu.

### FUNC-05. SMS i interwencje

1. Jedno oczekiwanie tworzy jeden aktualny challenge/incident z przypisaniem. Uprawnienie do obsługi SMS oddzielić od uprawnienia do wyników.
2. Kod utrzymywać tylko tak długo, jak wymaga jednorazowy handoff; bez utrwalania w DB, logu, audycie i kolejce.
3. Błędny/wygasły kod, timeout i limit prób mają oddzielne stany oraz jasną czynność w UI.
4. Przy niepewnej dostawie nie ponawiać automatycznie. Resend jest jawny, uprawniony, limitowany i kontrolowany przez CAS; unieważnia wcześniejszy challenge/kod bez resetowania globalnego budżetu prób.
5. Restart/cofnięcie sesji lub konta unieważniają niebezpieczne handoff. Assignment do inactive jest odrzucony; osierocony incident ma drogę przejęcia przez administratora.
6. Modal czyści kod po wysłaniu/zamknięciu, chroni przed podwójnym submit, zachowuje fokus i pokazuje trwały status.

**Testy:** syntetyczny code inbox/odbiornik, HTTP/DB/Redis i osobny modal; dobry/zły/wygasły kod, podwójne submit/resend, niepewna dostawa, restart, revoke, brak CSRF, obcy incident, operator bez results. Sprawdzać jedno przekazanie, brak sekretu i ten sam runId. Test kończy się na stanie interwencji, bez wyników portali.

### FUNC-06. Adapter UFG i kompletność danych OC

1. Dostarczyć gotową syntetyczną sprawę i aktualny checkpoint. Weryfikację wykonywać raz dla danego zamiaru; restart uzgadnia stan tej samej sprawy.
2. Odczytać pełną kolekcję OC wraz z licznikiem, paginacją/wirtualizacją i identyfikacją duplikatów. Numer wymagany przez formularz nie jest filtrem wynikowych polis.
3. Walidować nagłówki, pola, daty i zgodność liczności. Wynik częściowy lub uszkodzony ma jawny błąd, bez przekazania jako kompletny snapshot.
4. Zero polis jest poprawnym oddzielnym wynikiem. Timeout i niepewny stan kierują do uzgodnienia/interwencji, bez nowej sprawy lub ponowienia w ciemno.

**Testy lokalnego adaptera:** zero/1/wiele stron, wirtualizacja, powtarzające się wiersze, zła data/kolumna/liczność, opóźnienie, utrata sesji i restart checkpointu. Liczniki weryfikacji potwierdzają brak podwójnego skutku. Test kończy się na kontrakcie snapshotu, bez eksportu.

### FUNC-07. Finalizacja wyniku, XLSX i pobranie

1. Test otrzymuje gotowy syntetyczny snapshot, run i execution token. Zweryfikować tenant, lease i fencing przed zapisem; odrzucić stary/obcy/anulowany token zgodnie z polityką runu.
2. Snapshot i liczniki utrwalać spójnie: wszystkie OC, aktualne według `endDate >= referenceDate`, completed/no_matching_policies/failed jako odrębne stany.
3. Eksport tworzyć przez staging i atomową finalizację, z metadanymi, checksum i prywatną ścieżką. Zero wyników nie tworzy pustego artefaktu, jeśli taki jest obecny kontrakt produktu.
4. NIP/REGON/numery polis w XLSX zachowują tekst i zera. Pobranie ma właściwe nagłówki, aktualną sesję/grant/tenant, kontrolę integralności i audyt.
5. Retry dostarczenia snapshotu lub eksportu nie uruchamia portali. Rozstrzygać przerwanie między plikiem a metadata bez duplikatów i bez utraty gotowego wyniku.
6. Po F5 wynik odczytuje się z DB/artefaktu; UI wyświetla osobno brak wyników, błąd i gotowy plik.

**Testy DB/storage/HTTP/UI:** granica daty, zero/pełny/częściowy snapshot, stary token, podwójna dostawa, crash przed/po rename/metadata, disk full, brak/zły checksum, traversal/symlink, obcy tenant, revoke i rollback audytu. Oczekiwany jeden snapshot/artefakt dla idempotentnego wyniku. Test nie wykonuje żadnego lookup ani portalu.

### SEC-01. Macierz uprawnień

1. Przygotować dwa syntetyczne tenanty, operatorów, administratorów, reviewera, auditora, inactive i użytkownika bez grantu.
2. Dla każdej nowej trasy testować dozwolony odczyt/mutację, direct URL i znane ID obcego ownera/tenanta, także counts, filtry i paginację.
3. Zmiana roli/grantu/statusu przy otwartej karcie działa na następnym request. Cookie roli nie jest źródłem prawa; zaakceptowany run ma jawną politykę dalszego wykonania.
4. Sprawdzić reset/zmianę hasła, mandatory password change, logout i revoke sessions. Równoczesna degradacja dwóch ostatnich adminów nie usuwa ostatniego aktywnego administratora.
5. Brak/zły Origin/CSRF, body actor/tenant, nadmiarowe pola, wadliwy cursor i oversized body nie wywołują skutku ubocznego.
6. Skanować odpowiedzi/logi/audyt/kolejkę/nazwy plików wyłącznie syntetycznymi markerami PESEL/SMS/sekretów; nie wypisywać danych produkcyjnych.

**Dowód:** tabela endpoint × rola × tenant z expected/actual oraz potwierdzenie braku zapisu/ujawnienia. Testy wykonuje się osobno w modułach, bez łączenia ich w proces biznesowy.

### REC-01. Awarie na granicach modułów

1. Dla każdego zmienionego modułu wskazać injection points: claim, outbox, external intent, potwierdzenie zapisu, commit snapshotu, rename i metadata, acknowledgement.
2. Przerywać wyłącznie własny testowy proces i dostarczać ten sam komunikat ponownie. Przed wznowieniem sprawdzać lease/checkpoint/fencing.
3. Symulować niedostępny Redis/API/provider, utraconą odpowiedź, disk full i anulowanie oczekiwania SMS w oddzielnych zestawach z gotowym seedem.
4. Niepewne skutki zewnętrzne uzgadniać lub przekazać do interwencji. Nie naprawiać ich przez automatyczny nowy run/sprawę.

**Dowód:** dla konkretnego modułu policzone writes/intents/requests/artefakty oraz stan po restarcie. Brak podwójnego skutku jest warunkiem gotowości tego modułu; nie uruchamiać wspólnej macierzy awarii całego procesu.

## 4. REP/PERF — audyt, raporty, operacje i skala

### REP-01. Tożsamość artefaktu i zgodność historycznego audytu

1. Zmienić kontrakt wewnętrznego pobrania tak, aby zwracał artifactId; nowy writer zapisuje resourceType=artifact/resourceId=artifactId i wersję semantyki.
2. Zachować odczyt historycznych wpisów z runId, bez przepisywania starego audytu. Zmienić razem writer, filtry/scope, raporty i testy.
3. Gdy wpis pasuje nową i legacy relacją, liczyć go raz. Niejasne powiązanie jest diagnostyką uprawnionego administratora, bez przecieku do obcego tenanta.

**Testy:** wyłącznie syntetyczny seed nowych/starych wpisów i artefaktów, pojedyncze pobranie oraz odczyt raportu; ręcznie policzone counts, brak podwójnego liczenia i prawa reviewera/auditora.

### REP-02. Definicje raportów i centrum operacyjne

1. Rozdzielić source rows, kanoniczne groups, submission i rzeczywiste runs. Retry dostarczenia nie zwiększa liczby wykonań.
2. Opisać period/current, completed/zero/failed/cancelled i podstawę daty, np. finishedAt. Okresy `from` inclusive / `to` exclusive liczyć w Europe/Warsaw.
3. Dodać do centrum operacyjnego enrichment worker/provider/budget, pending jobs, submission groups/reasons, oldest pending i outbox. API online nie oznacza gotowości automatyzacji.
4. Paginować wszystkie listy po zastosowaniu scope; nie liczyć na wszystkich tenantach i dopiero później filtrować.

**Testy:** znany seed bez uruchamiania jobów, ręcznie policzone metryki, północ i oba przejścia DST, 101 kont oraz 51+ zasobów, dalsze strony i UI błędów/F5. Status disabled/offline/limit musi odpowiadać faktycznej konfiguracji.

### PERF-01. Grupowanie i wydajność lokalna

1. Seedować 30 tys. syntetycznych wierszy i reprezentatywną historię w odizolowanej bazie. Nie tworzyć 30 tys. lookup ani runów portalowych.
2. Zapisać sprzęt, czas, pamięć, liczbę SQL i EXPLAIN ANALYZE. Zmierzyć stan wyjściowy, następnie ustalić kryteria na podstawie pomiaru; nie deklarować niezmierzonego SLA.
3. Zastąpić pełne pobieranie `resolveRelatedRows` wyszukaniem po znormalizowanych indeksowanych NIP/REGON i tenant/import.
4. Jeśli potrzebne kolumny/indexy/backfill, dodać migrację i sprawdzić upgrade. Wynik grupowania/konfliktów ma być zgodny z referencyjnymi przykładami sprzed optymalizacji.
5. Usunąć potwierdzone N+1 i pełne odczyty tabel dla jednej strony, raportu lub eksportu. Osobno mierzyć lokalną pracę i oczekiwanie wynikające z limitów dostawcy.

**Testy:** porównanie semantyki przed/po na zestawie konfliktów, query counts, zakres tenant/import, paginacja i powtórny pomiar. Raport zawiera actual oraz ograniczenia sprzętu, bez operacji zewnętrznych.

## 5. REL — utrzymanie i przygotowanie wydania

### REL-01. Retencja i bezpieczne pliki

1. Opisać kategorie źródeł, snapshotów, eksportów, staging, jobów, audytu i profili. Nie zgadywać okresów retencji: jeśli brak decyzji produktu, pozostawić cleanup wyłączony i udokumentować potrzebną decyzję.
2. Cleanup ma dry-run i trwałe claim/delete/finalize; chroni aktywne runy, otwarte incydenty, pending oraz niepewne skutki portalowe.
3. Sprawdzić granice katalogów prywatnych, Windows ACL i reparse points/symlink. Profili przeglądarki nie usuwać jak zwykłych plików eksportu.

**Testy:** czas graniczny, aktywny zasób, równoczesny download/export, przerwane usunięcie i ponowienie, obca ścieżka/owner. Używać wyłącznie tymczasowych plików.

### REL-02. Backup i restore

1. Przygotować backup DB z manifestem plików/wydania i oddzielną ochroną wersji kluczy. Profil kopiować po zamknięciu Chromium, bez obietnicy trwałej ważności sesji portalu.
2. Restore wykonywać na izolowanej instancji: portale off, dispatch wyłączony, bez tworzenia jobów.
3. Porównać counts, FK, tenant scope, integralność eksportów i możliwość odczytu danych kluczem; brak/zły klucz ma bezpiecznie blokować dostęp.
4. Dokumentować zmierzone RPO/RTO, brakujący plik i procedurę odzyskania. Brak dowodu jest ograniczeniem, nie PASS.

**Testy:** syntetyczny backup/restore, brak/zły klucz, uszkodzony/brakujący eksport, drugi restore i przerwanie. Test nie uruchamia procesu biznesowego po odtworzeniu.

### REL-03. Monitoring, runtime i zależności

1. Monitorować heartbeaty obu workerów, budget/cooldown, oldest pending/outbox, incident bez obsługi, dysk i backup. Progi i odbiorców wyrazić konfiguracją.
2. Alerty deduplikować i zamykać po recovery. Testować lokalnym sink; rzeczywiste powiadomienie do innej osoby wymaga zlecenia użytkownika.
3. Runtime API/web uruchamiać bez roota, z minimalnymi obrazami i prywatnymi portami. HTTPS, cookies, Origin oraz zaufany proxy skonfigurować zgodnie z docelowym wdrożeniem.
4. `TRUST_PROXY_HOPS` domyślnie ma wartość 0; zaufać przekazanym IP dopiero po jawnym ustawieniu znanej liczby proxy (0–5). Sprawdzić spoofing X-Forwarded-For i zachowanie limitów; zmiana infrastruktury nie może osłabić rate limit ani CSRF.
5. Przejrzeć zależności/obrazy, ocenić rzeczywistą osiągalność błędów i poprawić je z regresją. Nie używać `audit fix --force` bez oceny zmian.

**Testy:** stale heartbeat, budżet wyczerpany, dedup/recovery alertu, brak dysku/backup, proxy spoofing, cookie/Origin, restart testowego serwisu bez jobów i skan konfiguracji na syntetyczne sekrety.

### REL-04. Przekazanie użytkownikowi

1. Przygotować release manifest: wersja kodu, image digests, schema, konfiguracja disabled/off, migracje, backup oraz instrukcje rollout/rollback.
2. Instrukcje czterech ról opisują import, rejestr/pokrycie/limity, review, single/batch, SMS/resend, wynik, cancel, pauzę, recovery i zmianę kluczy.
3. Zaktualizować README, stan i dziennik: wskazać bieżący plan, testy modułowe i ograniczenia; stare wyniki pozostają historyczne.
4. Przekazać listę działających funkcji, dowody testów, znane ograniczenia i potrzebną konfigurację. Nie wykonywać pełnego odbioru, pilotażu live ani serii w ramach przekazania.

**Kryterium REL:** utrzymanie sprawdzone na izolowanych zasobach, dokumentacja zgodna z kodem, brak automatycznej aktywacji live. Użytkownik sam kontroluje pełne uruchomienie i odbiór.

## 6. Kolejność implementacji dla agenta

| Pakiet | Kolejność prac | Warunek zakończenia |
| --- | --- | --- |
| P0 | Inwentaryzacja → runner modułowy → izolacja → testy jego kontraktu | Brak niejawnego pełnego procesu i zasobów użytkownika w testach |
| P1 | REG-01 → REG-02: konfiguracja, fabryka i MF | Kontrakt i lokalny transport, walidacja i błędy |
| P2 | REG-04 → REG-05: budżet, batch/cache, claim i zapis | Izolowane DB/HTTP: konkurencja, restart, cancel, brak nadpisania |
| P3 | REG-03 → REG-06: BIR, runtime, UI/review | Testy adaptera i osobnego joba wzbogacania; stan disabled zgodny z konfiguracją |
| P4 | ENV: build/version, migracje, runtime i CI | Powtarzalny izolowany start; CI uruchamia wybrane moduły |
| P5 | FUNC-01 → FUNC-07, każdy osobno | Import/review, submission, Everest, Compensa, SMS, UFG i wynik mają własne dowody |
| P6 | SEC-01 → REC-01 dla zmienionych modułów | Odmowy bez skutków, brak przecieków i podwójnych operacji |
| P7 | REP-01 → REP-02 → PERF-01 | Właściwy audyt/counts/scope/paginacja i udokumentowany pomiar |
| P8 | REL-01 → REL-04 | Retencja, restore, monitoring, bezpieczeństwo runtime i przekazanie |

Testy bezpieczeństwa i awarii dodawać już przy implementacji modułu; P6 uzupełnia macierz, zamiast odkładać zabezpieczenia na koniec. Nie przechodzić dalej z nieznanym wynikiem obowiązkowego testu. Jeśli zadanie zależy od brakującej decyzji/konfiguracji, zapisać ograniczenie i wykonywać pozostałe niezależne prace.

## 7. Uruchamianie testów i raportowanie

### 7.1. Istniejące polecenia

Po kontroli zakresu zestawu i konfiguracji testowej dostępne są:

```powershell
npm run test -w @goldis/core
npm run test -w @goldis/api
npm run test -w @goldis/worker
npm run test:preflight
npm run build
```

Przed szerokim zestawem sprawdzić, czy nowy test nie uruchamia pełnego procesu. Jeśli taki test jest w zestawie, wybrać konkretny plik lub wydzielony moduł. Build nie zastępuje testu działania.

Istniejące regresje HTTP po build API można uruchomić osobno:

```powershell
node --test apps/api/dist/http-bootstrap.test.js
node --test apps/api/dist/enrichment-jobs.http.test.js
```

Domyślne testy workera pomijają część prób przeglądarkowych. Dla adaptera wybrać konkretny skompilowany plik testowy i ograniczony do procesu testu `PLAYWRIGHT_INTEGRATION=1`, lokalny fixture oraz nowy profil. Nie włączać tej flagi globalnie dla wszystkich testów bez kontroli zakresu; po wykonaniu przywrócić poprzednie środowisko.

Istniejące smoki UI obejmują m.in. `test:w4-enrichment-ui-smoke`, `test:review-ui-smoke`, `test:run-submission-ui-smoke`, `test:w3-sms-ui-smoke`, `test:admin-ui-smoke`, `test:history-ui-smoke`, `test:audit-ui-smoke` w workspace `@goldis/web`. Przed uruchomieniem sprawdzić fixture, seed, cleanup i zakres. Mock UI oznaczyć jako test UI; integrację rzeczywistego API/DB wykazać osobno dla tego samego modułu. Nie kierować smoka do istniejącej instalacji z danymi użytkownika.

### 7.2. Komendy modułowe

Runner i komendy zostały zaimplementowane. Poniższe zestawy są osobne; `*-browser` oznacza wyłącznie lokalne syntetyczne strony Chromium:

```text
test:module:migrations
test:module:backup-restore
test:module:registry
test:module:registry-jobs
test:module:review
test:module:submission
test:module:auth
test:module:sms
test:module:results
test:module:audit-reports
test:module:everest
test:module:everest-browser
test:module:compensa
test:module:compensa-browser
test:module:ufg
test:module:ufg-browser
test:module:grouping
```

Każda komenda wskazuje jawne pliki i nie uruchamia dalszego dispatch. Kontrakt runnera — 7/7 — sprawdza allowlistę, sanitację środowiska, brak portali live oraz właściwy katalog fixture. `registry-jobs` uruchamia tylko swój disposable PostgreSQL. Pełne komendy wymienione w 0.1 nie są wykonywane automatycznie.

### 7.3. Dowód zamknięcia każdego pakietu

1. Zakres kodu/diff, wersja/commit i migracje; stan lokalnych nieutrwalonych zmian.
2. Nazwa modułu, jego wejście/wyjście i dokładna granica testu.
3. Zasoby fixture i zabezpieczenie przed dotknięciem instalacji użytkownika.
4. Komendy, scenariusze oraz osobne PASS/FAIL/SKIP/BLOCKED.
5. Niezależnie policzone expected/actual: zapisy, requesty, liczniki działań i artefakty odpowiednie dla modułu.
6. Wynik testów praw, konkurencji, przerwania i idempotencji.
7. Potwierdzenie cleanup oraz pozostałe ograniczenia/konfiguracja.
8. Pełny odbiór procesu: `DO_ODBIORU_UZYTKOWNIKA`; nie zmieniać tego statusu na podstawie testów modułów.

## 8. Definicja gotowości kodu do odbioru użytkownika

1. Wszystkie funkcjonalności P0–P8 są zaimplementowane albo mają wyraźnie opisany brak, jego powód i zależność. Przy brakach nie oznaczać całego kodu jako kompletnego.
2. Każdy zaimplementowany moduł ma zaliczone wymagane testy funkcjonalne, kontraktowe, integracyjne, bezpieczeństwa i awarii; build przechodzi.
3. Uprawnienia, tenant scope, audyt, idempotencja i ochrony danych działają także przy konkurencji i restarcie.
4. UI pokazuje rzeczywisty stan, ścieżkę obsługi błędu i ograniczenia dostawcy; brak konfiguracji live nie jest ukrywany jako ready.
5. Wydanie i utrzymanie mają aktualną dokumentację oraz dowody izolowanych testów. Portale live i dostawcy produkcyjni pozostają w stanie ustalonym przez użytkownika.
6. Testy poszczególnych modułów potwierdzają jakość wyprodukowanego kodu. Decyzja o uruchomieniu pełnego procesu i uznaniu platformy za odebraną należy do użytkownika i pozostaje poza zadaniami wykonawczymi tego planu.

## Dziennik wykonania — 7 października 2026

Ta tabela rejestruje pracę po przepisaniu planu. PASS dotyczy wyłącznie wskazanego modułu i syntetycznego kontraktu; nie jest zaliczeniem pełnego procesu.

| Krok | Wynik | Dowód / granica | Pozostało |
| --- | --- | --- | --- |
| P0 — izolacja testów | Przyjęty | `npm run test:module:runner` — 10/10; runner wskazuje jawne pliki, neutralizuje inherited full-flow/live flags, sekrety i URL-e usług; `*-browser` włącza Playwright jawnie, DB modules tworzą wyłącznie zasoby testowe z etykietą właściciela. | Rozszerzać testy cleanup/interruption i nieizolowanych zasobów, jeśli pojawią się nowe runner paths. |
| REG-01/02 — MF VAT | Częściowo przyjęty | `npm run test:module:registry` — 52/52. Adapter MF wykonuje HTTP search po NIP i batch do 30; fixture sprawdzają błędy, kolejność, brak/obcy/duplikat, limity, timeout, redirect i minimalizację pól. | Brak wyniku MF nie dowodzi nieistnienia firmy. Bez lookupu zewnętrznego. |
| REG-03 — GUS BIR | Adapter + syntetyczne testy przyjęte | Oficjalny SOAP 1.2/WS-Addressing, lokalna sesja, batch do 20, maksymalnie jeden relogin, whitelist pól, DTD/XXE blocked, limity XML/HTTP. `npm run test:module:registry` obejmuje fixture dla kontraktu, sesji, limitów i błędów. | Produkcja wymaga klucza wydanego przez GUS; provider domyślnie disabled, bez wniosku ani requestu live. |
| REG-04 — budżet/batch/cache | Implementacja i izolowany test przyjęte | Migracja 028 atomowo rezerwuje limit MF 100 / GUS 6000 requestów na dzień Warsaw; migracja 029 przechowuje krótki cache HMAC. Disposable PostgreSQL potwierdził cache po rekonstrukcji, brak surowego NIP/pól dodatkowych, batch MF 30+1 i mapowanie po NIP. | Aktywacja wymaga klucza HMAC; provider GUS dodatkowo wymaga klucza BIR. Wspólne quota per IP zależą od topologii wyjścia sieciowego. |
| REG-05 — wynik/retry | Implementacja i izolowane testy przyjęte; tenant/owner oraz korekty sprawdzone | Disposable PostgreSQL potwierdza `NO_REGON`, cooldown/retry, disabled, cancel CAS, cofnięty grant przed/w trakcie lookupu, disabled account, konkurencyjne claimy, stale lease/fencing, stare `rowVersion` i rollback row/version/cache po błędzie audytu. Nowa macierz odrzuca start/list/read/items/cancel dla obcego tenant i operatora niebędącego właścicielem; brak zmiany stanu/audytu. Wyścig korekty: oczekująca blokuje zapis rejestrowy, zatwierdzona ręczna wartość zachowuje się przy spóźnionej odpowiedzi. | Szersza macierz ról i uprawnień dla pozostałych modułów SEC-01 jest odrębną pracą; ten wiersz zamyka zakres właściciela/tenanta i korekt w REG-05. |
| REG-06 — runtime/health/UI | Integracja osobnego jobu, restart procesu i panel limitu sprawdzone | Lokalny HTTP fixture → produkcyjny controller/guard → disposable PostgreSQL → dwa kolejne procesy `dist/enrichment-worker.js`: pierwszy kończy job, po jego zatrzymaniu drugi odzyskuje trwały job utworzony przy workerze offline; requesty=2, budżet=2, cache bez surowego NIP. Test sprawdza status offline po upływie freshness window. API podaje limit, remaining, `limitReached` i następne warszawskie północne resetowanie; runtime smoke weryfikuje lokalną datę i 00:00. Playwright potwierdza odczyt resetu `Europe/Warsaw`, F5, 401, 409 bez auto-retry, stronę 50+2, cooldown oraz layout 320–1920 px. | Produkcja wymaga decyzji/klucza BIR; proces biznesowy i portale nadal wyłączone. Recovery przetestowano z trwałym jobem oczekującym, nie z przerwaniem aktywnego requestu HTTP do dostawcy. |
| REP-01 — identyfikacja artefaktu w audycie | Implementacja, kontrakt i test DB przyjęte | Writer `artifact.downloaded` używa `resourceType=artifact` oraz ID artefaktu. Reviewer/report scope dopasowuje `artifact_id` albo historyczne `run_id`; `EXISTS` utrzymuje pojedynczy event raz. `test:module:reports` seeduje dwa artefakty jednego runu i dwa rodzaje audytu; ręczny wynik potwierdza, że legacy event jest liczony raz mimo wielu trafień relacji. Moduły results 10/10 i audit-reports 2/2 zaliczone. | Brak otwartej luki w tym zakresie modułowym; pozostałe kwestie raportów ujęto w REP-02/REL. |
| REP-02 — definicje raportów i centrum operacyjne | Agregaty, scope tenantowy, paginacja i rzeczywisty HTTP→DB przyjęte | `test:module:reports` aplikuje 001–030 na disposable PostgreSQL, seeduje dwa tenanty, sprawdza ręczne counts, filtr narzędzia, granice okresu, historyczny i nowy audit download, 52 runy na strony 50+2. Rzeczywista trasa HTTP z sesją/admin guard odpytuje tę samą bazę: brak sesji=401, obaj admini=200 i każdy dostaje wyłącznie swój tenant. `test:module:audit-reports` — 2/2, runner — 9/9, `admin-ui-smoke` — PASS. | DST 23/25 h jest testowany oddzielnie przez HTTP kontrakt; UI i rzeczywisty route DB mają osobne smoke. |
| REL-03 — zaufanie proxy / adres IP | Ochrona przed spoofingiem wdrożona i testowana | `TRUST_PROXY_HOPS` ma domyślnie 0; ograniczona konfiguracja 0–5. `test:module:auth` — 18/18: bez zaufanego proxy spoofowany `X-Forwarded-For` nie zmienia `req.ip`, a jawny 1 hop jest honorowany; niepoprawne wartości odrzucone. Compose i przykłady środowiska ustawiają bezpieczne 0. | W docelowym wdrożeniu ustawić liczbę zaufanych proxy zgodną z rzeczywistą topologią; nie włączać wartości 1 bez potwierdzenia pojedynczego kontrolowanego proxy. |
| PERF-01 — selektywne grupowanie po NIP | Indeks, semantyka i lokalna skala/SQL pomierzone | Migracja 030 tworzy odwracalny indeks wyrażeniowy. Najnowszy `test:module:grouping`: 30 000 wierszy, EXPLAIN 0,038 ms, resolver 52,74 ms, 25 SQL dla dwóch dopasowań, 443 SQL dla grupy 40. Pełny skan semantyczny 30 047 rekordów i resolver zwróciły te same 3 rekordy, deduplikację NIP+REGON i konflikt `SAME_REGON_DIFFERENT_NIP`; indeks użyty, 0 zewnętrznych requestów. | To powtarzalny test syntetyczny, nie SLA. 443 SQL dla szerokiej grupy ujawnia koszt per-row dalszego rozstrzygania; optymalizacja bulk wymaga kryterium docelowego sprzętu i weryfikacji semantyki. Docelowy benchmark i szerokie obciążenie produkcyjne pozostają otwarte. |
| ENV — build/migracja/runtime | Build, migracje i przebudowa Compose przyjęte | `npm run build` — PASS po zmianach raportu/PERF-01; `docker compose --env-file .env.compose.local up -d --build --wait` — PASS z końcowego drzewa zmian. Zbudowano cztery obrazy API/web/portal worker/enrichment worker i odtworzono cztery usługi aplikacyjne; PostgreSQL/Redis oraz ich wolumeny zachowano. Wszystkie 6/6 usług healthy/running. `/api/health/ready=200` (`database=true`, `redis=true`), `/api/health/enrichment=200` z worker/provider disabled, `/admin=200`, niezalogowane `/api/admin/operations/summary=401`. DB Compose ma 30 migracji (`030-source-row-nip-index`) oraz indeks `source_rows_batch_nip_normalized_idx`; disposable migracje 001–030 i rerun — PASS. | Commit i registry digest są bezpiecznie `null`, gdy build nie przekazał tych metadanych; nie przypisywać brudnemu lokalnemu drzewu fikcyjnego commitu ani digestu. Wykonać test backupu eksportów/keyringu, wrong-key i rollbacku wydania oraz przygotować release manifest z rzeczywistymi identyfikatorami obrazów. |
| REL-02 — disposable backup/restore | Logical DB dump/restore do schematu 030 i syntetyczny eksport sprawdzone | `test:module:backup-restore` weryfikuje label efemerycznego kontenera, wykonuje `pg_dump -Fc`, odtwarza do nowej DB przez `pg_restore --single-transaction`, porównuje sentinel i 30 migracji. Osobny syntetyczny `tar.gz` raportu XLSX jest listowany, odtwarzany i porównywany SHA-256; ścieżki bezwzględne/traversal są odrzucane. Najnowszy pomiar: dump 384 ms, restore 691 ms; bez API, workerów i external actions. | Test nie kopiuje rzeczywistego named volume eksportów ani kluczy, nie sprawdza złego klucza i nie wyznacza RPO/RTO systemu. Wymagany pełny runbook backupu aplikacyjnego i restore exports/keyring przed zamknięciem REL-02. |
| FUNC — review/submission/auth/SMS/results/audit | Testy modułowe PASS | Po pojedynczym buildzie i sekwencyjnym wykonaniu jawnych list z runnera: review 9/9; submission 1/1; auth 16/16; SMS 27/27; results 10/10; audit-reports 2/2; runtime manifest 1/1; registry 52/52. `admin-ui-smoke`: runtime manifest, worker/budżet/job count, CSRF, paginacja, obsługa 503, DST i responsywność 320–1920 — PASS. | Wymagane osobne testy fault injection / integracje z DB/Redis dla pozostałych granic oraz macierz scope/performance raportów; UI smoke używa syntetycznego API. |
| FUNC — Everest/Compensa/UFG | Lokalny browser fixture PASS | Everest 3/3, Compensa 22/22, UFG 4/4 na syntetycznych stronach Chromium. Warianty bez `-browser` poprawnie pomijają 2/16/2 testy wymagające przeglądarki. Runner kontraktowy 7/7; `WORKER_LIVE_PORTALS=0`. | Nie jest to odbiór sesji/selektorów na portalach live ani test produkcyjnego procesora. |
| Pełny flow / live | Poza tym wykonaniem | Żadnego wspólnego flow, lookupu MF/GUS, PZU/Compensa, danych klienta ani małej serii nie uruchomiono. | `DO_ODBIORU_UZYTKOWNIKA`; użytkownik zachowuje pełną kontrolę nad decyzją i terminem. |

Podczas testów pierwsze uruchomienie fixture Compensy z katalogu root zakończyło się błędem `ENOENT`; po dodaniu `testCwd=apps/worker` i osobnych komend browser suites Compensa/UFG/Everest przeszły bez skipów. Pierwsze UI grants smoke oczekiwało jednego dowolnego formularza, ale UI ma odrębny formularz jednego wiersza i osobny formularz submission. Asercja została zawężona do obu jawnych klas; ponowny smoke zaliczony. Testy modułowe zlecające wspólny build nie mogą być uruchamiane równolegle; końcowa seria użyła jednego builda, potem wykonała jawne zestawy sekwencyjnie z odizolowanym środowiskiem każdego modułu. Te poprawki dotyczą test harnessów, nie zmieniają decyzji użytkownika o pełnym przepływie.
