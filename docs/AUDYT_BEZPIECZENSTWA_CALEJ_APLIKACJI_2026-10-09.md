# Audyt bezpieczeństwa całej aplikacji Goldis

Data: **9 października 2026**, Europe/Warsaw. Audyt bieżącego katalogu roboczego, wraz ze zmianami niezatwierdzonymi w Git.

## Ocena

**Nie rekomenduję obecnie publicznego udostępnienia aplikacji z rzeczywistymi danymi.** Potwierdziłem dwie dodatkowe, praktyczne słabości: obejście walidacji zasobów importu przez zakres scalonych komórek oraz sterowanie adresem IP limitera przez nagłówek przekazywany przez Next.js. Pierwsza wymaga konta z prawem importu; druga występuje przy zaufaniu API do panelu i braku normalizacji nagłówków na zewnętrznej bramie.

Zabezpieczenia dostępu mają istotne pokrycie testowe: **744 próby na 93 chronionych trasach zakończyły się odmową**, bez uruchomienia usług biznesowych. Nie wykazałem anonimowego pobrania danych, przełamania granicy tenanta, SQL injection ani wykonania kodu na serwerze. To wynik zbadanych scenariuszy, nie dowód wykluczający każdą możliwą lukę.

Raport rozróżnia błędy odtworzone w sondach, potwierdzone właściwości kodu/konfiguracji oraz brakujące zabezpieczenia wymagane w rozważanym modelu publicznego wdrożenia. W szczególności jawność danych w bazie i szeroka rola administratora nie są same w sobie obejściem uwierzytelniania.

## Zakres i metoda

Objęto API NestJS, sesje i administrację, frontend Next.js, wspólne reguły i kryptografię, worker Playwright/BullMQ, import/przygotowanie XLSX, rejestry MF/GUS, interwencje SMS, eksporty, usuwanie i replay dziennika, PostgreSQL/Redis, Docker Compose, obrazy i skrypty startu/backupów oraz zależności npm.

Inwentaryzacja zawiera SHA-256 **312 plików źródłowych, testowych, konfiguracyjnych i skryptów**. Nie oznacza to jednakowego, ręcznego przeglądu każdej linii wszystkich 312 plików. Przegląd szczegółowy koncentrował się na granicach zaufania, wejściach użytkownika, uprawnieniach i trwałych magazynach. Lista i HEAD Git: [summary.json](security/full-audit-2026-10-09/summary.json).

Testy wykorzystywały dane syntetyczne, losowe identyfikatory, tymczasowe katalogi i oddzielne kontenery testowe. Nie uruchamiano pełnego przepływu portali, nie logowano się do zewnętrznych usług, nie wykonywano operacji kasowania na używanej bazie, nie wczytywano sekretów z istniejących `.env`. Odczytano lokalne adresy nasłuchu. Wszystkie kontenery utworzone przez testowe runnery zostały usunięte.

Testy API/core/workera przebudowały bieżący TypeScript. Testy Next.js używały oddzielnej kopii istniejącego produkcyjnego `.next`; nie wykonywano nowego buildu frontendu i nie nadpisywano używanego `.next`. Zewnętrzny HTTPS/proxy, firewall z drugiego hosta, produkcyjna baza i rzeczywiste profile przeglądarki nie były przedmiotem testów dynamicznych.

## Wyniki wykonanych kontroli

| Kontrola | Wynik | Granica dowodu |
| --- | --- | --- |
| Pełny `npm test` w środowisku z odciętymi usługami i portalami | **286 PASS, 37 SKIP, 0 FAIL** | Core 13, API 191, worker 77 PASS/37 SKIP, preflight 5. Skipy nie są odbiorem portali. |
| `test:module:security-db` | **PASS** | Izolowany PostgreSQL, migracje 001–051, users/tenant-scope; wybrane role, sesje, granty, submissions, preparation i wyniki workera. |
| `test:module:security-redis` | **PASS** | Izolowany Redis, limity pary login/IP i IP, `Retry-After`. Brak pełnego odbioru ACL/awarii/wielu replik. |
| `test:module:deletion` | **PASS** | Izolowana baza: step-up, artifact/run/import, tombstones, retry, blokady późnych zapisów, journal i odtworzenie starej kopii. |
| `test:backup-crypto` | **1 PASS** | Szyfrowanie bajtów, błędne hasło i naruszenie integralności; bez pełnego cold restore. |
| Macierz dostępu anonimowego | **100 tras, 93 chronione, 744 odmowy** | Rzeczywiste kontrolery/guards; syntetyczne usługi/DB/limiter. Dodatkowo 49 odmów HEAD oraz 5 stanów unieważnienia sesji. |
| Kopia Next.js + Chromium | **93 odmowy przez rewrite, 12 widoków, 6 ścieżek plików 404** | Brak prywatnego znacznika danych; bez rzeczywistego HTTPS i kont użytkowników. |
| Sonda CSP w kopii Next.js | **PASS** | Wstrzyknięty inline script zablokowany; strict-dynamic, brak unsafe-eval, no-store, DENY i nosniff. Nie jest to pełny stored-XSS. |
| Import ze scalonym zakresem | **Luka odtworzona** | Około 6,5 KB, 2 fizyczne wiersze/4 komórki; walidacja przechodzi, proces parsera z limitem heap 96 MiB zgłasza OOM. |
| Przekazywanie adresu IP | **Luka odtworzona** | Kopia Next.js i backend z zaufanym bezpośrednim proxy: po 429 zmiana samego X-Forwarded-For daje 200. Budżet sondy wynosi 3. |
| Konfiguracja klucza PESEL | **Błąd odtworzony** | Syntetyczne `local-v1`: preflight bez błędów, szyfrowanie odmawia z PESEL_ENCRYPTION_CONFIG_INVALID. |
| Sonda poufności | **5 obserwacji odtworzonych** | Jawny payload ORM, czytelny eksport z PESEL, brak jawnego sandboxu, dowolny host HTTPS w configu, szeroki admin download. |
| `npm audit --omit=dev --json` | **0 critical, 0 high, 7 moderate** | Zgłoszenia pakietów/łańcuchów; nie 7 niezależnych exploitów. Bez skanu pakietów OS obrazów. |

Logi i JSON znajdują się w [katalogu dowodowym](security/full-audit-2026-10-09/). Kod nowych sond: [full-security-audit-probes-2026-10-09.cjs](../scripts/full-security-audit-probes-2026-10-09.cjs); adapter zachowujący wcześniejsze dowody: [full-security-audit-anonymous-2026-10-09.cjs](../scripts/full-security-audit-anonymous-2026-10-09.cjs). Sukces sond odtwarzających brak zabezpieczenia nie oznacza braku luk.

## Ustalenia i naprawy

### FA-01 — duży zakres scalonych komórek omija limity importu — wysokie, P1

**Status: nowa luka odtworzona.** [Walidator](../apps/api/src/workbook-archive.ts:140) liczy fizyczne elementy XML `row` i `c`, ale nie uwzględnia komórek powstających ze scalonych zakresów. Po walidacji [parser](../apps/api/src/workbook.ts:18) wywołuje ExcelJS bez pomijania `mergeCells`. ExcelJS tworzy obiekty wszystkich komórek w prostokącie scalania.

Syntetyczny XLSX zawierał dwie linie danych arkusza i scalenie `A3:XFD1000`, implikujące **16 351 232 komórki**. Archiwum około 6,5 KB zostało zaakceptowane. Wywołanie rzeczywistego `parseTransportWorkbook` w dziecku z heap 96 MiB wygenerowało fatalny błąd pamięci; proces był dodatkowo ograniczony czasem do 5 sekund. Dowód: [new-probes.json](security/full-audit-2026-10-09/new-probes.json).

Konto z prawem importu może przesłać mały plik zużywający zasoby procesu API. Nie próbowano wyczerpywać pamięci działającego API; awaria produkcyjna przy jego konkretnym limicie pamięci jest wnioskiem z nieograniczonej ekspansji, a nie wykonanym atakiem. Timer walidatora kończy się przed `xlsx.load`, a limit dwóch parserów nie ogranicza pamięci pojedynczego odczytu.

**Naprawa:** jeśli scalenia nie są potrzebne, odrzucać je lub pomijać `mergeCells` przy odczycie i zweryfikować znaczenie importowanych danych. Ograniczyć współrzędne wierszy/komórek, zakresy i pozostałe struktury rozwijane przez bibliotekę. Odczyt XLSX przenieść do oddzielnego procesu z twardymi limitami pamięci/czasu i kontrolą awarii.

**Odbiór:** sonda jest odrzucana przed ekspansją albo odczyt ignoruje scalenie w bounded workerze; równoległy zwykły odczyt API nadal działa. Sprawdzić także rzadkie wysokie numery wierszy, duże `cols`, walidacje, style i wiele zakresów, bez obciążania używanej instalacji.

### FA-02 — panel przekazuje podrobiony IP do zaufanego API — wysokie, P1

**Status: nowa luka odtworzona w topologii zgodnej z Compose.** [Compose](../compose.yaml:49) ufa adresowi usługi web. [Middleware](../apps/api/src/http-bootstrap.ts:11) używa `request.ip`, a [limiter](../apps/api/src/login-rate-limiter.ts:229) buduje budżet API na podstawie IP. Next.js zachowuje już dostarczony `X-Forwarded-For`; rewrite przekazuje go dalej. Samo zaufanie do adresu bezpośredniego proxy nie gwarantuje wiarygodności treści nagłówka.

Sonda przez kopię produkcyjnego Next zwróciła IP podany przez klienta. Czwarte żądanie z tym samym nagłówkiem dało 429, zmiana nagłówka na inny adres dała 200. Użyto rzeczywistego middleware, zaufania proxy i małego syntetycznego budżetu; nie wykonywano 301 żądań do działającej aplikacji ani pełnego bypassu na prawdziwym Redisie. [Dowód](security/full-audit-2026-10-09/new-probes.json).

**Skutek:** możliwość rotacji budżetu IP, osłabienia limitów API/loginu i celowego zużywania budżetu innego adresu. Niezależny limiter konta nadal ogranicza próby na pojedynczy login. W lokalnym wariancie z pustym `TRUST_PROXY_IPS` nagłówek nie jest zaufany przez API; opisane obejście dotyczy wariantu z zaufanym panelem lub proxy. Brama usuwająca podrobione nagłówki może zamknąć ten scenariusz, ale nie ma jej w dostarczonym Compose.

**Naprawa:** publiczna brama ma usuwać wejściowe nagłówki forwarding i wystawiać adres wyłącznie z zaufanej ścieżki. Zablokować bezpośredni dostęp do web/API omijający bramę. Zdefiniować wszystkie dozwolone hops i kontrolować nagłówki również na granicy Next → API. Nie przyjmować dowolnego XFF jako tożsamości klienta.

**Odbiór:** zmiana XFF/Forwarded/X-Real-IP nie zmienia efektywnego klienta ani budżetu; przetestować listy adresów, IPv4/IPv6, dostęp bezpośredni i wiele proxy na rzeczywistej topologii. [Dokumentacja Express](https://expressjs.com/en/guide/behind-proxies/) opisuje zależność bezpieczeństwa od zachowania ostatniego zaufanego proxy.

### FA-03 — wszystkie usługi bazy korzystają ze wspólnego superusera — wysokie, P1

**Status: potwierdzona konfiguracja, wcześniejszy dowód bazy.** [Compose](../compose.yaml:6) inicjalizuje PostgreSQL jako `goldis`, a API, migracje, enrichment i worker używają tego samego loginu. Rola inicjalizacyjna oficjalnego obrazu ma szerokie uprawnienia; wcześniejsza sonda z 9 października potwierdza `rolsuper` i inne prawa: [postgres-role-evidence](security/postgres-role-evidence-2026-10-09.json). Nie sprawdzano praw loginu w istniejącej bazie użytkownika. Bieżące testy DB używały własnych baz, nie zmieniały ról instalacji.

**Skutek:** przejęcie jednego procesu daje możliwość odczytu całej bazy, zmiany danych i lokalnego audytu; granice tenantów w kodzie nie są niezależną granicą dla tego konta.

**Naprawa/odbiór:** osobny migrator/owner i konta runtime API/enrichment/workera z minimalnymi prawami do wymaganych tabel i operacji. Udowodnić odmowę DDL, odczytu zbędnych tabel i modyfikacji audytu przez konta, które tego nie potrzebują. Nie uruchamiać migracji jako część każdego startu konta runtime.

### FA-04 — PESEL wraca do jawnego trwałego XLSX — wysokie, P1

**Status: odtworzone.** [Eksport](../apps/api/src/export.ts:49) wpisuje odszyfrowany PESEL do arkusza. [Magazyn](../apps/api/src/private-artifact-store.ts:50) zapisuje zwykłe bajty XLSX. Sonda ponownie otworzyła zapisany plik bez klucza i odczytała syntetyczny PESEL.

Uprawnienia pliku/katalogu oraz chroniony download ograniczają dostęp aplikacyjny. SHA-256 zapewnia wykrywanie zmienionych bajtów, lecz nie poufność. Kradzież wolumenu, zwykłej kopii eksportów lub odczyt przez inny uprzywilejowany proces ujawnia tę treść.

**Naprawa/odbiór:** szyfrować artefakt na dysku niezależnym kluczem, odszyfrowywać dopiero po autoryzacji pobrania albo generować na żądanie bez jawnej trwałej kopii. Sprawdzić migrację istniejących plików, osierocone pliki, rotację kluczy, retencję i backupy. Rozważyć pominięcie PESEL w eksporcie tam, gdzie nie jest potrzebny; wymaga to decyzji o wymaganiach biznesowych.

### FA-05 — przejęta sesja admina wystarcza do resetu kont i grantów — wysokie, P1 dla dostępu publicznego

**Status: potwierdzony brak dodatkowej bariery, bez symulowanego przejęcia.** [Zmiany administracyjne](../apps/api/src/admin.ts:109) sprawdzają aktywną sesję/rolę, CSRF i aktualność poświadczeń. [Reset hasła](../apps/api/src/admin.ts:1026), granty, role i ustawienia nie wymagają świeżego podania hasła ani MFA. Step-up istnieje dla kasowania, co nie zabezpiecza pozostałych operacji. Szeroki admin download jest świadomą polityką roli i nadal ma granicę tenanta.

**Naprawa/odbiór:** MFA lub brama dostępu z MFA, świeży step-up dla resetów/grantów/ról/ustawień i kontrolowane recovery. Testy mają odmówić tych zmian dla ważnej sesji bez świeżego potwierdzenia oraz po zmianie rewizji, roli, terminu lub unieważnieniu step-up.

### FA-06 — Chromium nie ma jawnie włączonego sandboxu i współdzieli silną tożsamość workera — wysokie, P1

**Status: odtworzona konfiguracja uruchomienia; bez exploita przeglądarki.** [BrowserSession](../apps/worker/src/browser.ts:45) nie ustawia `chromiumSandbox: true`. Domyślna wartość Playwright jest false, zgodnie z [dokumentacją autora](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox). Worker ma konto DB z FA-03, klucze PESEL/stagingu i hasła portali. Trwały profil stanowi osobny magazyn cookies i danych przeglądarki.

**Naprawa/odbiór:** zweryfikowany sandbox i wymagany profil uruchomienia kontenera/hosta; osobna tożsamość i minimalne prawa DB; rozdzielenie procesu sterującego i przeglądarki, ograniczony egress. Nie uznać samego dopisania flagi za odbiór: potwierdzić skuteczne działanie sandboxu i odmowę dostępu przejętego testowego procesu do zbędnych kluczy/danych. Dodać politykę czyszczenia i dostępu do profilu.

### FA-07 — dane źródłowe i snapshoty pozostają jawne w bazie — wysokie w modelu kradzieży dumpa

**Status: odtworzony payload ORM i przegląd schematu.** [ImportService](../apps/api/src/imports.ts:75) zapisuje jawne nazwy, osoby decyzyjne, adresy i identyfikatory. Kopie występują w przygotowaniach/snapshotach/rekordach wynikowych; szyfrowanie PESEL nie obejmuje całego tego grafu. Nie wykonywano pomiaru szyfrowania dysku hosta.

**Naprawa/odbiór:** określić wrażliwe pola i kopie, zminimalizować dane oraz zdecydować o szyfrowaniu pól/rekordów i oddzielnej ochronie kluczy; zabezpieczyć dumpy i backupy. Szyfrowanie dysku nie chroni przed kontem DB odczytującym dane, a szyfrowanie z kluczem w tym samym przejętym procesie nie chroni przed tym procesem. Odbiór musi oddzielić scenariusz kradzieży dumpa od kompromitacji runtime.

### FA-08 — profil produkcyjny nie wymusza kompletnej konfiguracji bezpieczeństwa — średnie, P2; blokada przed publicznym wdrożeniem

**Status: przegląd kodu/Compose.** API używa `NODE_ENV=${APP_ENV:-development}`. [Cookie Secure](../apps/api/src/session.ts:338) zależy od `NODE_ENV`, a [start API](../apps/api/src/main.ts:8) nie waliduje całego origin/HTTPS/sekretów jako spójnego profilu produkcyjnego. Nie ma gotowej bramy TLS/HSTS w repozytorium. To nie jest wada samego lokalnego HTTP na loopback.

**Naprawa/odbiór:** osobny profil produkcyjny, start odmawiający przy błędnym origin/sekretach/proxy, HTTPS/HSTS na edge i brak dostępu z pominięciem edge. Sprawdzić Secure cookie, proxy, logi i odmowy przez rzeczywiste HTTPS. Nie utożsamiać `next start` z pełnym bezpiecznym wdrożeniem API.

### FA-09 — lokalny start wystawia web/API na wszystkich interfejsach — średnie, P2

**Status: nowa obserwacja runtime i kodu.** W chwili audytu panel nasłuchiwał na `::`:3000, API na `0.0.0.0`:3001, a odbiornik SMS na `127.0.0.1`:3022. API jawnie używa [0.0.0.0](../apps/api/src/main.ts:14); [lokalny skrypt](../scripts/Start-GoldisLocal.ps1:132) uruchamia Next bez `-H 127.0.0.1`, mimo podawania adresu loopback w instrukcji. [Dowód nasłuchu](security/full-audit-2026-10-09/local-listeners.json).

Nie sprawdzano osiągalności z drugiego komputera ani reguł Windows Firewall. Nasłuch wildcard nie dowodzi publicznej dostępności, lecz sprawia, że izolacja lokalnej instalacji zależy od zewnętrznych reguł sieciowych.

**Naprawa/odbiór:** parametryzować host API, lokalnie wymuszać loopback i `next start -H 127.0.0.1`. Nasłuch wewnątrz kontenera traktować oddzielnie od lokalnego procesu hosta. Potwierdzić adresy socketów i brak dostępu z drugiego hosta przy docelowych regułach firewall.

### FA-10 — konfigurator generuje klucz PESEL niezgodny z kryptografią — średnie, P2

**Status: nowy błąd odtworzony.** [Setup](../scripts/Initialize-GoldisLocal.ps1:47) tworzy keyring `local-v1` i [wersję aktywną](../scripts/Initialize-GoldisLocal.ps1:82) o tej samej nazwie. [Kryptografia](../packages/core/src/pesel-crypto.ts:33) dopuszcza wyłącznie dodatnie wersje liczbowe. [Preflight](../scripts/preflight-contract.cjs:34) nie weryfikuje tej zgodności.

Sonda potwierdziła preflight bez błędów i błąd `PESEL_ENCRYPTION_CONFIG_INVALID` przy szyfrowaniu. Mechanizm odmawia pracy, nie przechodzi na zapis PESEL jawnym tekstem. Nie oceniano i nie zmieniano obecnych prywatnych plików konfiguracyjnych.

**Naprawa/odbiór:** uzgodnić wersjonowanie setup/example/preflight/core i przetestować wygenerowaną konfigurację poprzez faktyczny encrypt/decrypt. Migrację istniejących kluczy zaprojektować bez utraty danych; nie regenerować kluczy zamiast poprawienia metadanych wersji.

### FA-11 — kanał czasowy identyfikuje loginy z hashem legacy — średnie, P2

**Status: ponownie odtworzone.** [Legacy KDF](../apps/api/src/password-hash.ts:6) używa N=16384, aktualny i dummy N=131072; koszt jest podnoszony dopiero po udanym logowaniu. Mediana nieudanego loginu legacy wyniosła **37,05 ms**, nieistniejącego **284,96 ms**. Po 16 próbek, losowa kolejność; limiter syntetyczny i baza stubowana. [Dowód](security/full-audit-2026-10-09/anonymous-access-evidence-2026-10-09.json).

Warunek: takie hashe muszą pozostawać w rzeczywistej bazie; ich liczby nie sprawdzano. Nie wykazano odgadywania znaków hasła. `timingSafeEqual` chroni porównanie klucza, nie wyrównuje całej ścieżki logowania.

**Naprawa/odbiór:** kontrolowany reset/upgrade i wyłączenie legacy albo porównywalny profil pracy wszystkich nieudanych ścieżek. Nie zmieniać parametrów odczytu starego hasha bez migracji i nie zastępować rozwiązania samym losowym sleep. Powtórzyć timing na DB i z rzeczywistymi limitami.

### FA-12 — Redis nie ma uwierzytelniania/ACL — średnie, P2

**Status: konfiguracja.** [Compose](../compose.yaml:23) uruchamia Redis z AOF, bez hasła/ACL; usługi korzystają z tej samej sieci. Port hosta jest ograniczony do loopback, co jest korzystne i nie oznacza otwartego publicznie Redisa.

Przejęcie procesu w tej sieci umożliwia ingerencję w kolejki i budżety limitera. **Naprawa/odbiór:** odrębne ACL/tożsamości dla BullMQ i limitera, minimalne komendy/prefixy oraz właściwe połączenia TLS/tunel przy różnych hostach. Udowodnić odmowę odczytu/zmiany kluczy innych usług i zweryfikować wymagane komendy bibliotek.

### FA-13 — usunięcie artifact/run/import nie oznacza pełnego usunięcia danych osoby/tenanta — średnie, P2

**Status: ograniczony kontrakt, pozytywne testy obsługiwanego zakresu.** [Job](../apps/api/src/deletion-jobs.ts:190) dopuszcza artifact/run/import, odrzuca tenant. Wykonane testy potwierdzają kaskady, pliki eksportów, tombstones i journal dla tych zakresów. Nie obejmują całości profilu przeglądarki, zewnętrznych usług, cache rejestru, wszystkich logów i kopii zapasowych. Szczegóły: [graf kasowania](INWENTARYZACJA_GRAFU_KASOWANIA_2026-10-09.md).

**Naprawa/odbiór:** jednoznacznie komunikować zakres; przypisać retencję i purge każdemu magazynowi oraz przetestować przywrócenie kopii z różnych epok. Dziennik i jego klucz są wyłączone z zwykłego backupu — wymagają oddzielnej, sprawdzonej procedury odzyskania. Nie deklarować pełnego usunięcia osoby na podstawie samego PASS import-scope.

### FA-14 — pozostają umiarkowane zgłoszenia zależności — średnie, P2

**Status: świeży npm audit.** Siedem wpisów wynika z dwóch głównych advisory: `uuid` przez ExcelJS/Sequelize oraz `sprintf-js` przez argparse/Umzug. [Pełny wynik](security/full-audit-2026-10-09/npm-audit-production.json).

Advisory autora uuid dotyczy v3/v5/v6 z zewnętrznym buforem, a przejrzane użycia Sequelize są v1/v4. Nie potwierdzono osiągalnego z HTTP exploita tej ścieżki. [Advisory autora uuid](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq). Zgłoszenie sprintf-js dotyczy nieograniczonej precyzji formatu; przejrzane użycia argparse dotyczą CLI. [Rekord advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

**Naprawa/odbiór:** sprawdzona aktualizacja lub kontrolowana wymiana łańcuchów, ewentualnie udokumentowany czasowy wyjątek z analizą osiągalności. Nie wykonywać niezgodnych downgrade proponowanych przez audit bez regresji. Osobno zeskanować biblioteki OS i przeglądarkę w gotowych obrazach.

### FA-15 — brak niezależnej kontroli ruchu wychodzącego workera — średnie, P2

**Status: konfiguracja, bez żądań zewnętrznych.** Lista `allowedOrigins` sprawdza deklarowany config, ale [loader](../apps/worker/src/portal-runtime-config.ts:52) dopuszcza dowolny prawidłowy host HTTPS wpisany w tym samym pliku. Sonda potwierdziła to bez połączenia sieciowego. To wymaga kontroli configu; nie wykazano SSRF sterowanego komórką Excela.

**Naprawa/odbiór:** niezależny allowlist egress, blokady adresów wewnętrznych/metadata, kontrola redirectów i podzasobów, minimalne wyjścia enrichment do rejestrów. Sam sprawdzony URL głównej strony nie ogranicza wszystkich połączeń przeglądarki. Testować próby niedozwolonych połączeń ze specjalnego środowiska.

### FA-16 — obrazy API/web mają szeroki runtime i proces root — średnie, P2

**Status: przegląd Dockerfile, bez skanu zbudowanego obrazu.** [API](../apps/api/Dockerfile:3) i [web](../apps/web/Dockerfile:4) kopiują cały kontekst, instalują workspace i nie ustawiają użytkownika nieuprzywilejowanego. Worker ustawia `USER pwuser`. `.dockerignore` chroni `.env` i część magazynów; nie zastępuje weryfikacji zawartości obrazu.

**Naprawa/odbiór:** wieloetapowe obrazy z minimalnymi artefaktami runtime, non-root, minimalne capabilities, read-only rootfs tam, gdzie możliwy, jawne katalogi zapisu i limity zasobów. Skan zawartości obrazu na sekrety/dane, UID procesu i prawa wolumenów; nie oznaczać samego `COPY . .` jako potwierdzonego wycieku sekretów.

### FA-17 — brak pełnego odbioru odzyskiwania i sygnalizacji wynoszenia danych — średnie, P2

**Status: brak zweryfikowanej procedury operacyjnej.** Są szyfrowane backupy lokalne i audyt pobrań; brak pełnego cold restore po utracie hosta, kompletnego odbioru osobnego journal/key oraz dostarczonych alertów na masowe odczyty/pobrania/granty. Kontrola metadata audytu opiera się m.in. na nazwach kluczy i nie gwarantuje poufności dowolnego tekstu wartości.

**Naprawa/odbiór:** odtworzenie na oddzielnym środowisku z kontrolą braku powrotu skasowanych danych; osobna kopia kluczy/journal; alerty i budżety user/tenant/bajty, chroniony audyt poza prawami runtime. Testy markerów danych w logach, kontrolowanego seryjnego pobrania i awarii zależności. Nie uznawać testu kryptograficznego bajtów za odbiór całego backupu.

## Zabezpieczenia, które potwierdzono

- Backend odrzuca brak/błędny podpis sesji, token bez aktywnego wpisu, replay po logout, wyłączone konto, cofnięte członkostwo, zmienioną rewizję poświadczeń, wygaśnięcie i bezczynność. Rola pochodzi z DB; awaria resolvera nie daje dostępu.
- Testy DB potwierdziły wybrane granice tenant/owner, aktualne granty, blokady po cofnięciu uprawnień podczas pracy i transakcyjne operacje. Odrębny download grant nie rozszerza automatycznie prawa odczytu.
- Origin/CSRF i guards są po stronie API. Podrobienie roli/tożsamości w nagłówkach nie zastępuje sesji. Origin nie jest uwierzytelnieniem klienta spoza przeglądarki.
- Redis limiter działa przed parsowaniem body, odmawia przy niedostępnej usłudze w przewidzianym kodzie. Aktualny KDF ma limity współbieżności/kolejki. Problem FA-02 dotyczy wiarygodności IP, nie braku samego licznika.
- Import ma limity bajtów ZIP/XML, wpisów, fizycznych wierszy/komórek, kompresji i parserów; blokuje DTD/relacje zewnętrzne/formuły. FA-01 pokazuje brak ochrony przed jedną strukturą ekspansji, mimo tych kontroli.
- Eksporty zapisują wartości tekstowe jako tekst, nie dowolne formuły. Magazyn używa kluczy UUID i ogranicza ścieżki. Download weryfikuje stan, tombstone oraz hash pliku.
- PESEL i staging korzystają z AES-256-GCM, wersji klucza i powiązania z kontekstem. Testy wykrywają tampering/wrong context. Nie rozwiązuje to jawnego eksportu z FA-04 ani niezgodnej konfiguracji FA-10.
- Wyniki workera wymagają sekretu usługowego i aktualnego wykonania/lease; test DB odrzuca stare, wygasłe i anulowane wykonania oraz rollbackuje zapis przy utracie uprawnienia wykonania.
- SMS w sprawdzonym przepływie nie trafia do DB/Redis; endpoint odbiornika odrzuca brak/błędny sekret i token sesji użyty jako sekret.
- W przejrzanym produkcyjnym TS/TSX nie znaleziono bezpośrednich sinków `dangerouslySetInnerHTML`, JS eval/new Function, wyłączania TLS ani wejścia użytkownika sklejonego z SQL. Zapytania używają bind/replacements lub ORM; przegląd nie zastępuje kampanii injection na każdym endpointcie.

## Kolejność domknięcia

1. **Naprawy bieżącego kodu:** FA-01 import, FA-02 forwarding/IP, FA-09 lokalny bind i FA-10 setup/preflight. Każdy problem ma powyżej konkretną sondę lub dowód i kryterium odbioru.
2. **Granice uprawnień i wykonania:** FA-03 konta DB, FA-05 MFA/step-up, FA-06 sandbox i separacja, FA-12 ACL Redis, FA-15 egress, FA-16 runtime obrazów.
3. **Poufność i cykl danych:** FA-04 eksporty, FA-07 źródła/snapshoty, FA-13 retencja/purge, FA-17 restore i monitoring. FA-11 zamknąć przed publicznym logowaniem, jeżeli istnieją konta legacy.
4. **Odbiór wdrożenia:** FA-08 HTTPS/edge/start, ponowny FA-14 scan zależności/OS oraz pełna macierz ról i negatywne testy przez docelową sieć. Po naprawach ponowić nowe sondy i odpowiednie moduły; dotychczasowe PASS nie są odbiorem przyszłych zmian.

## Granice wniosków i przekazanie

Nie wykonywano pełnego pentestu infrastruktury, przeglądu zewnętrznych portali ani oceny prawnej. Nie ma pomiaru skuteczności timing przez Internet, pełnego stored-XSS HTTP→DB→browser, presji pamięci działającej instalacji, testu każdego wariantu równoległości i całej macierzy ról ani pełnego restore po utracie maszyny.

W audycie **nie zmieniono kodu produkcyjnego, konfiguracji prywatnej ani danych użytkownika**. Dodano raport, skrypty odtwarzające obserwacje i nowy katalog dowodów; testy aktualizowały ignorowane buildy API/core/workera. Wcześniejsze artefakty audytu zachowano.

Raport uzupełnia [audyt z 8 października](AUDYT_BEZPIECZENSTWA_2026_10_08.md), [audyt poufności](AUDYT_POUFNOSCI_DANYCH_VPS_2026-10-09.md) i [audyt anonimowego dostępu](AUDYT_DOSTEPU_BEZ_LOGOWANIA_I_TIMING_2026-10-09.md). Stan z 8 października, w którym DB/Redis były jeszcze nieodebrane, jest historyczny: bieżące izolowane zestawy wykonano i zaliczono. Nie domyka to brakujących zabezpieczeń opisanych powyżej.
