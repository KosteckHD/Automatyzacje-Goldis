# Audyt bezpieczeństwa Goldis — 8 października 2026

W aplikacji znaleziono błąd wyścigu pozwalający trwającej zmianie hasła nadpisać reset administratora, nieprawidłowe egzekwowanie grantów odczytu partii oraz braki w limitowaniu prób uwierzytelnienia i kosztownych żądań. W przejrzanych ścieżkach nie znaleziono bezpośredniej podatności JS/XSS ani SQL injection. Nie jest to potwierdzenie bezpieczeństwa całego wdrożenia.

Najpierw należy naprawić SEC-01, SEC-02 i ochronę prób uwierzytelnienia SEC-03/04. Pozostałe ustalenia i wymagane testy są poniżej. Audyt nie zmienia kodu aplikacji ani konfiguracji uruchomionych usług.

## Zakres i metoda

- Badany stan: bieżący katalog roboczy, **łącznie z istniejącymi zmianami niezatwierdzonymi**, na bazie HEAD `e3a507ea8e534f06d698289bf1165f79691e5a6d`.
- Technologie: Next.js/React, NestJS/Express, Sequelize/PostgreSQL, BullMQ/Redis, worker Playwright.
- Przegląd: kontrolery API i dekoratory uprawnień, sesje/CSRF, polityka ról i grantów, zakres danych w listach, surowe zapytania SQL i ich dynamiczne fragmenty, miejsca renderowania danych w UI, wywołania JavaScript w workerze, import XLSX i konfiguracja Compose.
- Uruchomiono `npm test`, `npm audit --json` i dedykowane scenariusze dowodowe na zbudowanym kodzie.
- Scenariusze dowodowe wykorzystują syntetyczne sekrety, zastępcze modele DB, model liczników Redis i tymczasowy serwer HTTP na loopback. **Nie wykonują zapytań do rzeczywistej bazy ani Redis.**
- Nie odczytywano prywatnych plików `.env`; nie uruchamiano portali, pełnego procesu automatyzacji, migracji ani testów na rzeczywistych danych. Nie badano aktywnego reverse proxy, TLS, przeglądarki ani infrastruktury produkcyjnej.

P1 / wysokie oznacza naprawę pilną. P2 / średnie oznacza istotną lukę lub brak kontroli wymagający naprawy. P3 / niskie oznacza ograniczony skutek. Priorytety są oceną kontekstową, nie wyliczeniem CVSS. Ustalenia warunkowe i zalecenia wzmacniające zabezpieczenia są oddzielone od odtworzonych błędów.

## Ocena wymaganych obszarów

| Obszar | Wynik |
| --- | --- |
| JS injection / XSS | Nie znaleziono bezpośredniej ścieżki wykonania danych użytkownika jako HTML/JS. Renderowanie tekstu przez React i przekazywanie argumentów do Playwright są poprawne w przejrzanych miejscach. Brakuje jawnej polityki CSP i ochrony przed osadzaniem panelu. |
| SQL injection | Nie znaleziono przepływu danych użytkownika do składni SQL. Używane są ORM, `bind`, `replacements` lub parametry `$1…`. Dynamiczne fragmenty przejrzanych list są budowane z fragmentów kodu i dozwolonych wartości. |
| Rate limiting | Logowanie ma atomowe liczniki Redis: 5 prób na parę login/IP i 60 na IP przez 15 minut. Brakuje licznika konta niezależnego od IP, limitu zmiany hasła i ogólnej ochrony kosztownych endpointów. |
| Autoryzacja | Guards, tenant i właściciel zasobu zwykle są sprawdzane po stronie API. Wyjątki: odczyt partii używa prawa wykonania; listy interwencji pomijają stan narzędzia; przydział nie ma własnego obowiązkowego sprawdzenia tenanta w guardzie. |
| Autentykacja | HMAC sesji, sprawdzanie sesji w DB, cofanie sesji i CSRF są zaimplementowane. Problemy: wyścig reset/zmiana hasła, zbyt niski koszt scrypt, słabe hasło bootstrap, nielimitowana ponowna weryfikacja hasła i różnica czasu dla istniejącego konta. |
| Funkcjonalności według roli | Polityka backendu rozdziela admin/operator/reviewer/auditor. Nie znaleziono zwykłego wejścia operatora do funkcji admina. Potwierdzono jednak niespójność grantów partii i brak zdejmowania przydziałów po edycji grantu. |

## Ustalenia

| ID | Priorytet | Problem | Dowód |
| --- | --- | --- | --- |
| SEC-01 | P1 / wysokie | Zmiana hasła może nadpisać zatwierdzony reset i wydać nową sesję | Deterministycznie odtworzona kolejność operacji, rzeczywisty kontroler i scrypt, modele DB zastępcze |
| SEC-02 | P2 / średnie | Prawo wykonania zastępuje prawo odczytu partii | Rzeczywisty guard, kontroler i serwis; modele DB zastępcze |
| SEC-03 | P2 / średnie | Brak limitu konta niezależnego od IP; konfiguracja proxy może współdzielić limit | Rzeczywisty limiter z modelem Redis; konfiguracja z kodu |
| SEC-04 | P2 / średnie | Brak limitu sprawdzania obecnego hasła podczas jego zmiany | 12 kolejnych rzeczywistych weryfikacji; brak 429 |
| SEC-05 | P2 / średnie | Koszt scrypt poniżej zalecanej konfiguracji | Kod i aktualne wytyczne OWASP |
| SEC-06 | P2 / średnie | Pierwszy administrator może dostać jednoznakowe hasło | Rzeczywisty bootstrap i scrypt; zastępcze modele DB |
| SEC-07 | P2 / średnie | Publiczne kosztowne endpointy i import nie mają ogólnego limitu żądań/zasobów | 65 publicznych żądań HTTP readiness; przegląd importu |
| SEC-08 | P2 / średnie | Listy interwencji nie respektują wyłączonego narzędzia | Przegląd SQL; bez odtworzenia na PostgreSQL |
| SEC-09 | P3 / niskie | Różnica czasu odpowiedzi ujawnia istnienie aktywnego loginu | Pomiar kontrolera z rzeczywistym scrypt; bez pomiaru sieciowego |
| SEC-10 | P3 / niskie | Edycja grantu nie usuwa przydziałów po utracie praw | Rzeczywisty kontroler z mutowalnym modelem grantu |

### SEC-01 — reset hasła można nadpisać żądaniem już w toku

**Kod:** `apps/api/src/session.ts:294`, `:296`, `:301`, `:303`, `:314`; reset administratora: `apps/api/src/admin.ts:876`.

`changePassword` pobiera użytkownika i weryfikuje obecne hasło przed rozpoczęciem transakcji. Po wyliczeniu nowego hasha zapisuje ten sam, wcześniej pobrany obiekt. W transakcji nie sprawdza ponownie wersji hasła, aktywności sesji, członkostwa ani aktualnego stanu konta. Reset administratora blokuje rekord użytkownika, ale późniejszy zapis ze starego obiektu może nadpisać jego rezultat.

Odtworzona kolejność:

1. Żądanie użytkownika przechodzi autoryzację i weryfikuje stare hasło.
2. Administrator zatwierdza reset: zmienia hash, ustawia `mustChangePassword=true` i cofa poprzednie sesje.
3. Wcześniejsze żądanie użytkownika zaczyna własną transakcję, nadpisuje hash, ustawia `mustChangePassword=false` i tworzy nową aktywną sesję.

**Skutek:** reset wykonywany jako reakcja na przejęcie konta może nie odebrać atakującemu trwałego dostępu. Wymagane są wcześniejsza aktywna sesja, znajomość starego hasła i odpowiednia kolejność współbieżnych żądań. Nie jest to obejście logowania przez anonimowego użytkownika.

**Dowód:** `AUTH-PASSWORD-RESET-RACE`: hash administratora został zastąpiony; starej sesji cofnięto dostęp, lecz powstała nowa aktywna sesja. Test wymusza określone przeplatanie na zastępczych modelach; test współbieżności na PostgreSQL pozostaje konieczny.

**Naprawa:** ujednolicić kolejność blokad w zmianie/resetowaniu hasła i operacjach cofania sesji. Przed zapisem, wewnątrz transakcji, zablokować aktualne rekordy i sprawdzić sesję oraz aktualną wersję poświadczeń. Jeżeli hash/wersja zmieniły się od weryfikacji albo sesja została cofnięta, odmówić zapisu i wydania cookie. Samo otoczenie obecnego kodu transakcją nie naprawi użycia starego obiektu.

**Test odbioru:** równoległe reset/zmiana hasła oraz cofnięcie sesji/zmiana hasła. Po zatwierdzonym resecie lub cofnięciu sesji trwające stare żądanie nie może nadpisać poświadczeń ani utworzyć sesji.

### SEC-02 — odczyt partii egzekwuje niewłaściwy grant

**Kod:** `apps/api/src/tool-access.ts:45`, `apps/api/src/run-submissions.ts:109`, `:422`, `:428`, `:438`, `:443`, `:666`, `:674`.

`capabilityForPermission` nie mapuje `submission:read` na `view_results`. Dodatkowo `get` i `listItems` wywołują `assertCanExecute`, zamiast sprawdzić prawo odczytu. Operator posiadający `canExecute=true`, `canViewResults=false` może pobrać `GET /api/run-submissions/:id/items` dla własnego importu, mimo braku prawa odczytu. Operator z `canViewResults=true`, `canExecute=false` otrzymuje 403.

**Skutek:** ujawnienie identyfikatorów wierszy/zadań, stanów wykonania i błędów poza przyznanym grantem. Nie potwierdzono przez ten błąd odczytu cudzego tenanta, cudzych importów, pełnych polis ani plików wynikowych.

**Dowód:** `AUTHZ-SUBMISSION`, rzeczywisty łańcuch guard → kontroler → serwis z zastępczą DB.

**Naprawa:** mapować `submission:read` na `view_results`; oddzielić kontrolę odczytu od wykonania w serwisie. Odczyt wyników powinien działać przy maintenance i bez `canExecute`, zgodnie z pozostałymi ścieżkami odczytu. Przetestować kombinacje grantów, właścicieli i ról przez HTTP.

### SEC-03 — rozproszony brute force i wspólny limit za proxy

**Kod:** `apps/api/src/login-rate-limiter.ts:71–88`, `apps/api/src/session.ts:203–204`, `apps/api/src/http-bootstrap.ts:21`, `apps/web/next.config.ts:5`, `compose.yaml` (`TRUST_PROXY_HOPS` domyślnie 0).

Limiter posiada tylko klucz pary login/IP i klucz IP. Każdy nowy adres daje kolejne pięć prób tego samego loginu. W modelu liczników rzeczywisty limiter zaakceptował 60 prób tego samego konta z 12 IP; szósta próba z pierwszego IP została poprawnie zablokowana. Nie testowano rzeczywistego Redis, współbieżności ani TTL w tym scenariuszu. Kod wykonuje operację jednym skryptem Lua; istniejące testy uruchomione w audycie również używają modelu Redis. Brak klucza konta wynika bezpośrednio z kodu.

Osobnym problemem jest domyślne `trust proxy=0` przy przekazywaniu `/api` przez Next.js. **Wniosek z konfiguracji, nie pomiar działającego wdrożenia:** API zwykle widzi wtedy adres serwera web, a nie klienta, więc użytkownicy współdzielą limit 60 prób/15 min. Błędne loginy atakującego mogą blokować logowanie innym; poprawne logowania też zużywają licznik IP, bo `clearPair` kasuje wyłącznie licznik pary.

**Naprawa:** dodać atomowy, stopniowany limit konta niezależny od IP, zachować ochronę IP i ograniczać koszt globalny. Chronić przed celowym blokowaniem kont. Ustalić zaufane proxy i zasady nadpisywania `X-Forwarded-For`; nie włączać zaufania do dowolnych nagłówków ani dowolnej liczby proxy. Testować przez rzeczywistą ścieżkę web → API. Zalecenie limitu konta: [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#login-throttling).

### SEC-04 — zmiana hasła daje nielimitowany mechanizm zgadywania

**Kod:** `apps/api/src/session.ts:285–296`; w `AppModule` brak ogólnego guarda rate limiting.

Po wejściu z ważną sesją i CSRF można wielokrotnie sprawdzać `currentPassword`. `LoginRateLimiter` jest używany tylko w logowaniu. 12 kolejnych nieudanych prób zmiany hasła dotarło do rzeczywistego scrypt i zwróciło 401, bez 429.

**Skutek:** możliwość odgadywania hasła właściciela przejętej sesji oraz obciążenia CPU/puli wątków. Weryfikacja dotyczy użytkownika z sesji, więc nie daje dowolnego wyboru konta ofiary.

**Naprawa:** licznik ponownego uwierzytelnienia per użytkownik/sesja plus IP i limit kosztu. Po przekroczeniu zwracać 429/Retry-After przed scrypt. Rejestrować bezpieczne zdarzenia odmowy bez haseł, cookie i CSRF.

### SEC-05 — za mały koszt scrypt i niewersjonowany format parametrów

**Kod:** `apps/api/src/password-hash.ts:5`, `:20`.

Konfiguracja to `N=16384, r=8, p=1`. OWASP wskazuje m.in. `N=2^17, r=8, p=1`, a dla `N=2^14` wariant `p=5`. Obecna konfiguracja nie odpowiada tym minimalnym profilom. Dotyczy to kosztu łamania hashy po ich wycieku, a nie bezpośredniego obejścia poprawnego hasła. [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).

**Naprawa:** dobrać koszt po benchmarku i ograniczyć równoległość weryfikacji. Dodać wersję i parametry do formatu hasha, zachować weryfikację obecnego `scrypt$salt$key`, stopniowo przeliczać po poprawnym logowaniu. **Nie zmieniać tylko stałych używanych przez `derive`: spowodowałoby to odrzucanie wszystkich istniejących hashy.** Przy zwiększeniu N trzeba dobrać odpowiedni `maxmem`.

### SEC-06 — bootstrap nie egzekwuje polityki hasła administratora

**Kod:** `apps/api/src/bootstrap-admin.ts:9–26`; `apps/api/src/db.ts:44` (`mustChangePassword` domyślnie false).

Bootstrap sprawdza jedynie, czy hasło istnieje i ma nie więcej niż 1024 znaki. Przy pustej bazie akceptuje hasło `x` i tworzy administratora bez wymuszenia zmiany. Tworzenie kont przez panel wymaga co najmniej 14 znaków.

**Skutek:** możliwość uruchomienia aplikacji z bardzo słabymi poświadczeniami najważniejszego konta. Dotyczy pierwszego uruchomienia i konfiguracji operatora; audyt nie ustala siły rzeczywistego hasła.

**Naprawa:** wspólna polityka hasła również w bootstrapie, odmowa startu z niedozwolonym hasłem, świadoma polityka pierwszej zmiany. Dodać testy pustej bazy i niepoprawnych konfiguracji.

### SEC-07 — kosztowne HTTP i XLSX nie mają pełnego budżetu zasobów

**Kod:** `apps/api/src/module.ts:37`, `apps/api/src/health.ts:13–22`, `:35–43`; `apps/api/src/imports.ts:317`, `:327`; `apps/api/src/workbook.ts:13–15`.

`GET /api/health/ready` jest publiczny i przy każdym żądaniu wykonuje sprawdzenie DB oraz otwiera połączenie Redis. 65 kolejnych żądań HTTP bez sesji zwróciło 200 i wywołało po 65 kontroli zależności. Test używa zastępczych zależności: nie mierzy maksymalnego RPS ani rzeczywistego obciążenia Redis.

Poza logowaniem nie znaleziono ogólnego limitera API. Limit nowych runów na godzinę, limit 500 wierszy partii i budżety providerów chronią pracę biznesową, lecz nie liczbę HTTP, podglądów, pobrań i parsowań. Import ogranicza skompresowany plik do 16 MiB, ale odczytuje XLSX w pamięci, bez własnego limitu rozpakowanych danych, liczby wierszy/komórek i czasu parsowania. Nie wykonywano testu ZIP bomb.

**Naprawa:** cache statusu readiness, współdzielone połączenie/probe z ograniczeniem współbieżności; prosty publiczny liveness i kontrolowany dostęp do szczegółowej gotowości. Dodać budżety per endpoint/IP/użytkownik/tenant. Dla XLSX ograniczyć rozpakowany rozmiar i liczbę elementów oraz odizolować parsowanie z limitem czasu/pamięci. Testy obciążeniowe wykonać wyłącznie na izolowanym środowisku.

### SEC-08 — listy interwencji omijają stan disabled narzędzia

**Kod:** `apps/api/src/interventions.ts:53–56`, `:90`, `:143–158`; porównanie: `apps/api/src/resource-scope.ts:5–19`, `apps/api/src/tool-access.ts:28`.

Listy i summary sprawdzają grant, tenant i właściciela/przydział, lecz nie łączą `tools` i nie odrzucają `status='disabled'`. Kolekcja przechodzi przez `session-list`, więc PermissionGuard nie sprawdza konkretnego narzędzia. Przy zachowanym grancie użytkownik może otrzymać metadane interwencji i identyfikatory wyzwań z wyłączonego narzędzia, mimo że inne odczyty zostały zablokowane.

**Dowód:** statyczny przegląd zapytań; scenariusz disabled nie został wykonany na PostgreSQL. Nie potwierdzono wysłania SMS ani pobrania artefaktu po wyłączeniu narzędzia — odrębne ścieżki mają kontrolę grantu i statusu.

**Naprawa:** wspólna reguła statusu i zakresu kolekcji, zgodna dla listy, summary, szczegółów i akcji. Test: ten sam użytkownik i grant, narzędzie available → maintenance → disabled, oczekiwane zachowanie każdej ścieżki.

### SEC-09 — czas odpowiedzi ujawnia istnienie loginu

**Kod:** `apps/api/src/session.ts:211–213`.

Brak użytkownika pomija scrypt wskutek `!user || …`. Istniejący aktywny użytkownik z błędnym hasłem wykonuje kosztowną weryfikację. Przy 12 próbach na każdą gałąź mediana w ostatnim pomiarze wyniosła około 0,10 ms dla braku użytkownika i 28,99 ms dla istniejącego. DB i limiter były zastępcze, więc to dowód różnicy ścieżek, nie pomiar skuteczności enumeracji przez Internet.

**Naprawa:** dla nieistniejącego konta wykonać weryfikację syntetycznego, stałego hasha o aktualnym koszcie; zachować ten sam komunikat/status i wcześniejszy limiter. Nie zastępować tego zwykłym opóźnieniem.

### SEC-10 — edycja grantu nie zdejmuje istniejących przydziałów

**Kod:** `apps/api/src/admin.ts:354–365`.

`grant` i `existing` są tym samym obiektem. `Object.assign(grant, requested, …)` nadpisuje flagi przed obliczeniem `lostView` i `lostExecute`. Warunki utraty praw stają się zawsze fałszywe przy istniejącym grancie; funkcja zdejmowania przydziałów nie jest wywoływana. Scenariusz `AUTHZ-GRANT-ASSIGNMENTS` potwierdził zapis obu flag jako false i brak wywołania zdejmowania przydziałów.

**Skutek:** użytkownik pozostaje przypisany do pracy, do której utracił prawa, wbrew dokumentacji administracyjnej. Aktualne kontrole grantu nadal blokują chronione operacje, dlatego nie klasyfikuję tego jako potwierdzonego wykonania akcji po cofnięciu praw. Osobny endpoint całkowitego revoke wykonuje zdejmowanie przydziałów.

**Naprawa:** zachować poprzednie flagi przed mutacją obiektu i na ich podstawie obliczyć utracone prawa; testować różnicę utraty wykonania, odczytu i całkowitego cofnięcia grantu na prawdziwych instancjach Sequelize.

## Ustalenie warunkowe C-01 — przydział pomija obowiązkowy tenant

**Kod:** `apps/api/src/authorization-guard.ts:157–163`.

Wyjątki `isAssignedInterventionRead`, `isAssignedRunRead`, `isAssignedSms` są alternatywą dla `canPerform`, a nie jej ograniczeniem. Sprawdzają użytkownika i rolę, lecz nie tenant. Przy syntetycznym zasobie obcego tenanta przypisanym do tego użytkownika guard dopuścił odczyt runu; grant sprawdził dla tenanta użytkownika.

**Warunek istotnie ogranicza ryzyko:** obecny endpoint przydzielania sprawdza zgodność tenanta i aktywne członkostwo (`apps/api/src/admin.ts:622–636`). Nie znaleziono ścieżki pozwalającej zwykłemu użytkownikowi samodzielnie utworzyć taki przydział. To luka obrony na wypadek niespójnych danych, importu/przyszłej integracji lub kont użytkowników w wielu tenantach, a nie odtworzony pełny atak między tenantami.

**Naprawa:** sprawdzać zgodność tenanta bezwarunkowo przed wszystkimi wyjątkami. Rozważyć również wymuszenie spójności przydziału z członkostwem w bazie. Dodać testy cross-tenant dla każdego wyjątku i odmowę mimo poprawnego grantu narzędzia.

## JS injection / XSS i SQL injection — co sprawdzono

**JS/XSS:** w produkcyjnym kodzie aplikacji nie znaleziono `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, `new Function`, dynamicznego `eval` ani `srcDoc`. Wartości nazw firm, loginów i powodów są renderowane jako tekst React. Próba renderowania `<img src=x onerror=alert(1)>` przez rzeczywisty renderer React dała zakodowany tekst. To test mechanizmu React, nie test każdej strony w przeglądarce. Wywołania `.evaluate(fn, argument)` w workerze mają funkcje z kodu i argumenty przekazywane osobno; dane z wyszukiwania trafiają do `.fill`. `returnTo` w `workspace.tsx:281–290` sprawdza origin, dozwoloną ścieżkę i odrzuca `//` oraz backslash. Redis `.eval` wykonuje stałe Lua, nie JavaScript z danych wejściowych.

**SQL:** przejrzano surowe query API/workerów, filtry historii/review/audytu i `sequelize.literal`. Wartości są przekazywane przez ORM, `bind`, `replacements` lub parametry pg `$1…`; `literal` zawiera stałe zwiększanie wersji, bez wejścia użytkownika. Dynamiczne składniki SQL list (`conditions`, `projection`, `countsJoin`, `reviewerPolicy`, `ownerFilter`) są wybierane z fragmentów kodu. Sequelize `replacements` escapuje wartości, ale nie jest tym samym co przygotowany statement `bind`. Test rzeczywistego mechanizmu replacements z `' OR 1=1 --` zachował payload wewnątrz literału SQL.

Nie uruchamiano pełnych prób injection przeciwko PostgreSQL ani przeglądarce. Nie zastępuje to testów stored XSS na danych z XLSX/providerów i testów każdego filtra przez HTTP. `sanitizePublicOutput` służy ukrywaniu PESEL/ścieżek; nie należy traktować go jako sanitizera HTML ani zabezpieczenia SQL.

## Macierz dostępu po stronie backendu

Podstawą jest `apps/api/src/authorization-policy.ts:53–82`. Grant może zawęzić uprawnienia roli; sam grant nie daje prawa zarezerwowanego dla innej roli.

| Funkcjonalność | Admin | Operator | Reviewer | Auditor |
| --- | --- | --- | --- | --- |
| Tworzenie importów, enrichment i runów | Tenant, execute, dostępne narzędzie | Własne dane, execute | Nie | Nie |
| Odczyt importów, runów i enrichment | Tenant | Własne dane, view_results; ograniczone wyjątki przydziału | Tenant, view_results | Nie |
| Odczyt partii submission | Tenant | Własne dane; obecnie błędnie execute, SEC-02 | Brak `submission:read` w polityce | Nie |
| Anulowanie partii/runów i wznowienie SMS | Tenant w polityce | Własne dane, execute | Nie | Nie |
| Wysyłanie kodu SMS | Tenant | Własny lub przypisany run, execute | Nie | Nie |
| Pobieranie artefaktu | Tenant | Własny run, download_results | Nie | Nie |
| Proponowanie korekty REGON | Tenant | Własny import, view_results | Nie | Nie |
| Zatwierdzanie korekt i konfliktów | Tenant | Nie | Tenant, view_results | Nie |
| Manual data i wznowienie review | Tenant | Nie | Nie | Nie |
| Audyt | Tenant | Nie | Zdarzenia operacyjne narzędzi z aktualnym grantem | Audyt tenanta |
| Konta, role, granty, ustawienia, raporty administracyjne | Tenant | Nie | Nie | Nie |
| Własne sesje i zmiana hasła | Tak | Tak | Tak | Tak |

Wyjątki i ograniczenia: `RunSubmissionService.cancel` dodatkowo wymaga `submission.actorUserId === actor.actorUserId`, również dla admina, więc administrator nie zawsze może anulować cudzą partię mimo dopuszczenia w polityce. To rozbieżność funkcjonalna wymagająca decyzji i testu, nie eskalacja uprawnień. Recenzent może zatwierdzać korekty, ale manual-data i resume-review są obecnie wyłącznie dla admina — zgodnie z kodem, nie na podstawie widoczności przycisków.

## Zabezpieczenia działające w przejrzanym zakresie

- Rola nie jest przyjmowana z cookie: pobierana jest z aktywnego członkostwa w DB, z kontrolą aktywnego użytkownika.
- Sesja HMAC zawiera losowe CSRF i identyfikator sesji; porównania podpisu są odporne na prostą różnicę czasu. Sesja v2 musi być aktywna i niewygasła w DB.
- Cookie sesyjne ma HttpOnly i SameSite=Strict; Secure jest ustawiane przy `NODE_ENV=production`. Wygaśnięcie jest bezwzględne po 8 godzinach.
- Mutacje wymagają oczekiwanego Origin i w przypadku cookie sesji CSRF powiązanego z podpisaną sesją. Wylogowanie ma celowy wyjątek CSRF, ale nadal wymaga Origin.
- Admin API wymaga SessionGuard i AdminOnlyGuard. Polityka odmawia operatorowi cudzych importów, reviewerowi startu runów i auditorowi odczytów operacyjnych.
- Listy historii i review ograniczają tenant/właściciela/grant przed stronicowaniem, a nie dopiero w UI.
- Pobranie artefaktu ma odrębne uprawnienie, walidację magazynu oraz `private, no-store` i `nosniff`; ścieżki nie są udostępniane przez statyczny publiczny katalog.
- Worker-result wymaga sekretu Bearer, identyfikatora aktywnego wykonania i walidowanych danych. Kod SMS jest jednorazowy, ma TTL/limit prób i nie jest utrwalany w DB/Redis przez inbox.
- Awaria Redis blokuje logowanie zamiast wyłączyć limiter. Limity biznesowe startów używają wspólnej blokady ustawień; nie stwierdzono na tej ścieżce prostego równoległego obejścia limitu.

## Dalsze wzmocnienia

1. **CSP i ochrona przed osadzaniem panelu:** `apps/web/next.config.ts` zawiera rewrites, lecz nie ma konfiguracji nagłówków. Nie znaleziono CSP, `frame-ancestors` ani X-Frame-Options w konfiguracji aplikacji. Przygotować politykę kompatybilną z Next.js, bez bezmyślnego dodawania `unsafe-inline/unsafe-eval`; objąć skrypty nonce/hash oraz `object-src`, `base-uri` i `frame-ancestors`. To brak dodatkowej ochrony, nie dowód XSS. Nie ustalono, czy nagłówki dostarcza zewnętrzny proxy. [OWASP CSP](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html).
2. **Prywatne odpowiedzi API:** większość odpowiedzi sesji, użytkowników i danych operacyjnych nie ma jawnego `Cache-Control: private, no-store`; wyjątki znaleziono dla SMS/artefaktów. Dodać spójną politykę prywatnych danych i zweryfikować rzeczywiste cache przeglądarki/proxy. Brak nagłówka sam w sobie nie potwierdza współdzielonego wycieku.
3. **Konta uprzywilejowane:** brak MFA logowania do panelu i ponownego uwierzytelnienia dla zmiany roli/resetu kont/grantów. SMS portali nie jest drugim czynnikiem panelu. Rozważyć MFA/passkeys/SSO, ponowne uwierzytelnienie dla najważniejszych zmian i limit bezczynności sesji. [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
4. **Odmowy i monitoring:** audyt zapisuje powodzenia logowania i działań administracyjnych, ale nie znaleziono rejestracji błędnych logowań/429 w ich ścieżkach. Dodać bezpieczne liczniki/alerty bez poświadczeń i bez nieograniczonego zapisu każdej próby atakującego.
5. **Konfiguracja wdrożenia:** Compose domyślnie ustawia API w development i HTTP loopback; jest to konfiguracja lokalna. W rzeczywistym wdrożeniu sprawdzić HTTPS, NODE_ENV, Secure cookie, bezpieczny Origin i sieciową niedostępność wewnętrznych endpointów. Sam Origin nie uwierzytelnia klienta poza przeglądarką.
6. **Uprawnienia infrastruktury:** Compose wykorzystuje konto utworzone przez POSTGRES_USER również dla usług aplikacji oraz Redis bez hasła na sieci usług. Rozdzielić konto migracyjne od kont runtime o minimalnych prawach i zweryfikować izolację/ACL Redis. Ogranicza to skutki kompromitacji usługi; nie jest dowodem SQL injection.

## Zależności

Zapis `npm audit --json` z dnia audytu: **9 pakietów zgłoszonych jako podatne: 2 high, 7 moderate, 0 critical**. To liczba pakietów, również zgłoszeń propagowanych przez zależności; nie dziewięć niezależnych odtworzonych ataków na Goldis. Surowy wynik znajduje się w [npm-audit-2026-10-08.json](security/npm-audit-2026-10-08.json).

| Pakiet/łańcuch | Zainstalowany stan | Ocena osiągalności |
| --- | --- | --- |
| Next.js | 16.3.7; skan wskazuje poprawkę 16.3.8 | Wymaga aktualizacji i regresji. SSRF Image Optimization wymaga `images.remotePatterns`; obecny config ich nie ma, więc ten konkretny warunek nie występuje. Zgłoszenie cache poisoning GHSA-4jqv-mc3x-m676 dotyczy Pages Router SSG/ISR; obecne źródła korzystają z App Router. Innych warunków nie zweryfikowano dynamicznie. |
| source-map-js przez Next → PostCSS | 1.2.1, poprawka 1.2.2 | DoS przez złośliwe indexed source maps; nie znaleziono ścieżki przyjmującej mapy źródeł od użytkowników aplikacji. Osiągalność w build/dev wymaga osobnej oceny. |
| uuid przez ExcelJS i Sequelize | 8.3.2 | Advisory dotyczy m.in. v3/v5/v6 z dostarczonym buforem. Nie potwierdzono osiągalnego wywołania z buforem kontrolowanym przez użytkownika. |
| sprintf-js → argparse → ts-command-line → Umzug | sprintf-js 1.0.3 | Skan zgłasza DoS formatowania; nie znaleziono wejścia HTTP do tej ścieżki CLI/migracji. |

Warunki SSRF opisuje [advisory autora Next.js](https://github.com/vercel/next.js/security/advisories/GHSA-cjq9-62q9-8jv4), warunki cache poisoning [osobne advisory Next.js](https://github.com/vercel/next.js/security/advisories/GHSA-4jqv-mc3x-m676), a poprawkę source-map-js [release autora 1.2.2](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2). Wersję docelową Next wskazano na podstawie zapisanego skanu npm; strony autora w czasie audytu prezentują częściowo zamaskowane numery poprawek.

Nie wykonywano `npm audit fix`. Propozycje skanu obejmują również downgrade Sequelize/ExcelJS/Umzug do niezgodnych wersji major — nie powinny być stosowane automatycznie. Naprawić osiągalne problemy i aktualizacje bezpieczne dla używanych API, pozostałe zgłoszenia rozstrzygnąć analizą osiągalności i testami.

## Wyniki i powtarzanie dowodów

`npm test` zakończył się kodem 0:

| Zestaw | Zaliczone | Pominięte | Błędy |
| --- | ---: | ---: | ---: |
| Core | 13 | 0 | 0 |
| API | 142 | 0 | 0 |
| Worker | 66 | 37 | 0 |
| Preflight | 3 | 0 | 0 |
| Razem | **224** | **37** | **0** |

37 testów workerów pominięto zgodnie z ich konfiguracją; nie są traktowane jako zaliczone. Testy API zawierają modele zastępcze, więc ich nazwy HTTP nie oznaczają integracji z prawdziwą DB. Nie wykonano odbioru DB/Redis ani migracji.

Log istniejących testów: [existing-tests-2026-10-08.log](security/existing-tests-2026-10-08.log).

Dedykowany skrypt [security-audit-2026-10-08.cjs](../scripts/security-audit-2026-10-08.cjs) wykonał 10 grup scenariuszy; wyniki: [audit-evidence-2026-10-08.json](security/audit-evidence-2026-10-08.json). Skrypt **potwierdza zachowania z audytu, w tym błędy**. Jego kod 0 oznacza udane odtworzenie dowodów, nie brak podatności. Po naprawach należy zastąpić asercje potwierdzające podatności testami oczekiwanej odmowy.

```powershell
npm test
node scripts/security-audit-2026-10-08.cjs
npm audit --json
```

Skrypt zawsze nadpisuje we własnym procesie adres DB syntetycznym adresem loopback i stubuje używane operacje; nie ładuje `.env`, nie tworzy kont w rzeczywistej bazie i nie uruchamia workerów. Korzysta z `dist` utworzonego przez `npm test`.

## Kolejność napraw i kryteria zamknięcia

1. SEC-01: serializacja/reset i rewalidacja poświadczeń/sesji. Dodać deterministyczny test oraz rzeczywisty test współbieżności PostgreSQL.
2. SEC-02 i C-01: właściwy grant odczytu i bezwarunkowa izolacja tenanta. Testy HTTP obejmujące każdą rolę, granty, cudzych właścicieli i tenantów.
3. SEC-03/04/07: liczniki konta, ponownego uwierzytelnienia i budżety endpointów; poprawna identyfikacja klienta za proxy. Testy na izolowanym Redis, następnie przez web → API oraz kontrolowane testy obciążenia.
4. SEC-05/06: silna polityka bootstrap i wersjonowany koszt hashy, test zgodności starych poświadczeń.
5. SEC-08/10: jedna polityka list/interwencji i poprawne wyliczanie utraty grantu; testy DB stanu disabled i zdejmowania przydziałów.
6. SEC-09, CSP, prywatne cache i zależności; testy przeglądarkowe stored XSS i clickjacking, kontrola nagłówków po HTTPS.

Zamknięcie audytu wymaga testów na izolowanej DB/Redis i przeglądarce po naprawach. Obecny raport identyfikuje i odtwarza błędy na kodzie oraz danych syntetycznych; nie nadaje aplikacji statusu „bezpieczna produkcyjnie”.
