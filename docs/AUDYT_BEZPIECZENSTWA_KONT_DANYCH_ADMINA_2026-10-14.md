# Audyt bezpieczeństwa Goldis — konta, dane, administracja i konfiguracja

Data: 14 października 2026. Oceniono bieżące drzewo robocze w `C:\Users\micha\Desktop\Goldis-Automatyzacje`, razem z istniejącymi zmianami niezatwierdzonymi w Git. HEAD: `e3a507ea8e534f06d698289bf1165f79691e5a6d`; ten commit nie reprezentuje całości audytowanego kodu.

## Ocena

**Ochrona aplikacyjna jest znacznie lepsza niż w starszych raportach, ale nie ma podstaw do zatwierdzenia publicznej produkcji z rzeczywistymi danymi.** Najważniejsze otwarte problemy dotyczą dostępu do sekretów na komputerze, szerokiego dostępu do wyników OC, odporności kont uprzywilejowanych na kradzież hasła/sesji oraz niesprawnego resetowania haseł. Świeże wdrożenie z rozdzielonymi rolami DB ma dodatkowy błąd migracji.

Nie odtworzono anonimowego obejścia logowania ani awansu operatora do administratora w wykonanych próbach. To wynik sprawdzonych scenariuszy, nie zapewnienie odporności na wszystkie ataki. Testy dotyczą kodu, lokalnych fixture HTTP/przeglądarki i jednorazowych kontenerów. Nie były pentestem działającej domeny/VPS.

## Zakres i metoda

- Przegląd logowania, haseł, cookies, sesji, CSRF/origin, limitera Redis, ról, grantów, zakresów zasobów, administracji, konfiguracji narzędzi i odzyskiwania kont.
- Przegląd eksportów, PESEL, prywatnego magazynu plików, snapshotów DB, logów audytu, interfejsów wewnętrznych workera, parsera importu, Docker secrets, Compose i przykładowego Nginx.
- Inspekcja uprawnień NTFS plików środowiska. Dowody konfiguracji zawierają tylko obecność/długość sekretów i adres/rolę połączenia; nie zapisano wartości haseł ani kluczy.
- Świeży skan produkcyjnych zależności npm; testy dedykowanych modułów; własne próby HTTP i próba migracji z faktycznym kontem `goldis_migrator`.
- Nie logowano się do kont klientów, nie odczytywano rekordów rzeczywistej bazy, nie uruchamiano portali ubezpieczycieli ani skanowania obcych usług. Nie zmieniono konfiguracji, haseł ani uprawnień rzeczywistej instalacji.
- Na początku i po testach nie działały kontenery Goldis ani panel/API na badanych typowych portach. Docker Engine pozwalał uruchamiać kontenery jednorazowe. Native PostgreSQL nasłuchiwał na `0.0.0.0:5432` i `[::]:5432`; nie ustalano jego danych ani konfiguracji `pg_hba.conf`/firewalla.

## Wyniki według obszaru

| Obszar | Co działa | Co pozostaje ryzykowne |
| --- | --- | --- |
| Konta użytkowników | scrypt, minimum 15 znaków, limity konta/IP, błędy bez ujawniania istnienia konta, obowiązkowa zmiana hasła tymczasowego | Brak MFA platformy; bardzo mała lista haseł zakazanych; błąd administracyjnego resetu |
| Sesje | Podpis HMAC, stan/revokacja w DB, aktualna rola z DB, 8 h maksimum i 30 min bezczynności, revokacja po zmianie poświadczeń | Skradziona aktywna sesja pozostaje użyteczna; brak MFA i dodatkowego potwierdzenia ustawień; nie ma potwierdzonej detekcji nowego urządzenia/IP |
| Dostęp do danych | Granica tenant, kontrole backendu, 404 dla obcych zasobów, prywatny magazyn i szyfrowane eksporty | Wyniki OC dostępne szeroko wewnątrz organizacji; PESEL w pobranym XLSX; część danych jawna dla uprawnionego dostępu SQL/hosta |
| Administrator i konfiguracja | Osobna rola admin, CSRF, transakcje i blokady, potwierdzenia związane z operacją/payloadem/sesją dla zmian kont i grantów | Ustawienia narzędzi poza potwierdzeniem; lokalne pliki z sekretami mają zbyt szerokie ACL |
| Wdrożenie | Rozdzielone role DB/Redis, niepubliczne porty w bazowym Compose, overlay produkcyjny, wzór HTTPS/Nginx, parser bez sekretów DB | Świeża migracja zatrzymuje się; lokalne pliki konfiguracji są starsze niż kontrakt; brak odbioru docelowego HTTPS/hosta/restore |

## Ustalenia wymagające działania

Priorytet P1 oznacza pilne działanie przed dostępem z niezaufanej sieci lub rozpoczęciem produkcji. P2 oznacza poprawę ochrony i świadomą decyzję o ryzyku. Poziom ryzyka jest oceną scenariusza, nie wynikiem CVSS.

### S01 — P1 / wysokie: inne lokalne konta Windows mogą czytać i zmieniać sekrety

**Potwierdzone na tej maszynie.** `.env` i `.env.compose.local` dziedziczą ACE `Modify, Synchronize` dla `BUILTIN\Użytkownicy` (SID grupy Users: `S-1-5-32-545`) oraz dodatkowych lokalnych tożsamości. `Modify` obejmuje odczyt i zapis. `.env.local` ma wyłączone dziedziczenie i dostęp ograniczony do właściciela, SYSTEM oraz administratorów.

Pliki z szerokim ACL zawierają m.in. `SESSION_SECRET`, `GOLDIS_ADMIN_PASSWORD`; `.env.compose.local` także `WORKER_AUTH_SECRET`. Odczyt może ujawnić poświadczenia/klucze, a zapis umożliwia podmienienie konfiguracji przy kolejnym uruchomieniu. Wymagany jest dostęp lokalny albo przejęcie procesu działającego jako inne uprawnione konto Windows. Nie wykazano pobrania `.env` przez anonimowe HTTP. Nie zakładamy, że zapisane hasło bootstrap jest nadal aktualnym hasłem admina. Sam klucz podpisu sesji również nie zastępuje wymaganego aktywnego wpisu sesji w DB.

**Działanie:** ograniczyć ACL wszystkich kopii sekretów, sprawdzić kto miał do nich dostęp, usunąć zbędne stare kopie i przeprowadzić odpowiednią rotację używanych poświadczeń/kluczy. Rotację kluczy szyfrowania wykonać z zachowaniem możliwości odszyfrowania istniejących danych. Nie kasować dotychczasowego keyringu bez migracji danych.

**Odbiór:** niezależne konto zwykłego użytkownika nie może odczytać ani zmienić plików; aplikacja uruchamia się z docelowym właścicielem. Sekrety nie są śledzone w Git i `.env*` są wyłączone z kontekstu Docker — tę część zweryfikowano.

Dowód: [env-acl.json](audit-security-2026-10-14/env-acl.json), [config-metadata.jsonl](audit-security-2026-10-14/config-metadata.jsonl). Skrypty tworzenia nowej konfiguracji/secret files przewidują ograniczenie ACL, ale nie naprawiają automatycznie wszystkich historycznych kopii.

### S02 — P1 / wysokie przy publicznym dostępie: MFA nie chroni kont platformy

Logowanie w [session.ts](../apps/api/src/session.ts), linia 247, wymaga loginu i hasła. Nie znaleziono drugiego czynnika platformy, WebAuthn ani passkeys w tym przepływie. Obecne cykle MFA/SMS dotyczą logowania do portali ubezpieczycieli, nie do Goldis. Dokument `REALIZACJA_PLANU_PO_AUDYCIE_2026-10-13.md` jawnie odnotowuje odłożenie MFA zgodnie z wcześniejszą decyzją.

Limiter pomaga przeciw zgadywaniu i masowym próbom. Nie powstrzymuje użycia prawidłowego hasła zdobytego phishingiem, złośliwym oprogramowaniem lub wyciekiem innej usługi. Ponowne podanie tego samego hasła przy operacji administracyjnej nie stanowi osobnego czynnika. Przejęcie konta admin/manager ma większy zasięg niż konta operatora.

**Działanie:** przed publicznym dostępem wdrożyć MFA przynajmniej dla admin/manager (preferowane passkeys/WebAuthn), wraz z bezpiecznym enrollment, odzyskiwaniem i kontrolą wyłączenia MFA. Jeśli pozostaje decyzja o odłożeniu, ograniczyć dostęp do zaufanej sieci/VPN i zapisać akceptację tego ryzyka.

**Odbiór:** samo poprawne hasło konta uprzywilejowanego nie wystarcza do utworzenia sesji; recovery nie obchodzi wymaganego czynnika. Zalecenie odpowiada [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

### S03 — P1 / wysokie dla poufności: operator może pobierać wyniki OC mimo braku/cofnięcia grantu

**Potwierdzona świadoma polityka dostępu, nie anonimowe obejście.** [tool-access.ts](../apps/api/src/tool-access.ts), linie 23–41, przyznaje operatorom i managerom `canViewResults` i `canDownloadResults` dla `oc-policy-verification` niezależnie od indywidualnego grantu. Pozostają one prawdziwe również przy grancie z wszystkimi wartościami `false` i wyłączonym narzędziu. [resource-scope.ts](../apps/api/src/resource-scope.ts) oraz wyjątek w [authorization-guard.ts](../apps/api/src/authorization-guard.ts) rozszerzają odczyt wyników OC poza własne importy, w obrębie tego samego tenant.

Eksport [export.ts](../apps/api/src/export.ts), linie 38–41, zawiera PESEL, dane kontaktowe i osobę decyzyjną. Magazyn przechowuje plik zaszyfrowany, ale użytkownik otrzymuje zwykły XLSX. Pobranego pliku nie można odzyskać przez późniejszą revokację sesji/grantu. Przejęty operator może więc mieć szerszy dostęp niż przydzielone mu leady. Nie wykazano odczytu między tenantami.

**Działanie:** uzgodnić, czy każdy operator ma widzieć wszystkie wyniki organizacji i pełne identyfikatory. Jeżeli nie — zawęzić odczyt do przydziału/właściciela i egzekwować osobny grant pobierania; rozważyć eksport bez PESEL dla ról niewymagających tego pola. Jeżeli tak — UI, dokumentacja i akceptacja ryzyka muszą jasno mówić, że cofnięcie grantu OC nie odbiera wspólnego odczytu/pobrania. Nie zmieniać tej reguły po cichu, ponieważ jest częścią obecnego modelu produktu.

**Odbiór:** osobne testy operatorów A/B, odebrania grantu, zmiany przydziału i wyłączenia narzędzia, z oczekiwanym wynikiem ustalonym przez właściciela platformy. Zasada minimalnych uprawnień: [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

Dowód odtworzenia reguły: [probes.json](audit-security-2026-10-14/probes.json). To próba funkcji polityki; nie pobierano rzeczywistych plików klientów.

### S04 — P1 / wysokie po kradzieży sesji: ustawienia narzędzia nie wymagają ponownego uwierzytelnienia

**Odtworzono HTTP na fixture.** `PATCH /api/admin/tools/:toolId/settings` w [admin.ts](../apps/api/src/admin.ts), linia 573, sprawdza rolę admin, aktywność konta/sesji, CSRF i `expectedVersion`. Nie wymaga `confirmationToken` ani ponownego hasła; lista akcji w [privileged-actions.ts](../apps/api/src/privileged-actions.ts) nie zawiera tej zmiany.

W próbie aktywna syntetyczna sesja admina z poprawnym CSRF zmieniła stan narzędzia i limit na `10000` bez dodatkowego potwierdzenia: **200**. Anonimowy dostęp: **401**; operator: **403**; obcy origin: **403**; brak CSRF: **403**. To luka w ochronie po przejęciu sesji/komputera, nie podatność typu CSRF. Atakujący musiałby dysponować sesją i tokenem CSRF lub działać z kontekstu użytkownika.

**Działanie:** objąć ustawienia potwierdzeniem związanym z toolId, wersją, payloadem i idempotency key, analogicznie do zmian kont/grantów. W przyszłości wykorzystać drugi czynnik dla działań wysokiego ryzyka.

**Odbiór:** aktywna sesja admina bez świeżego potwierdzenia nie może zmienić ustawień; podmiana limitu/celu/wersji unieważnia potwierdzenie. Dowód: [probes.cjs](audit-security-2026-10-14/probes.cjs), [probes.json](audit-security-2026-10-14/probes.json).

### S05 — P1 / wysokie operacyjnie: reset hasła przez admina i zespół koliduje z walidacją audytu

[admin.ts](../apps/api/src/admin.ts), linia 1095, i [team.ts](../apps/api/src/team.ts), linia 177, zapisują `metadata: { credentialReset: true, ... }`. [audit.ts](../apps/api/src/audit.ts), linie 75–88, odrzuca każdy klucz zawierający `credential` i rzuca `AUDIT_METADATA_SENSITIVE_KEY`. W obu ścieżkach jest to wewnątrz transakcji zmiany hasła/revokacji.

**Odtworzono oba resety na rzeczywistym, jednorazowym PostgreSQL z syntetycznymi kontami i poprawnymi potwierdzeniami operacji.** Każdy zakończył się `AUDIT_METADATA_SENSITIVE_KEY`; sprawdzono, że hash hasła i rewizja pozostały niezmienione, a zużycie potwierdzenia zostało wycofane. W próbie wywołano rzeczywiste metody kontrolera/service i transakcje DB, bez transportu HTTP. Zwykła zmiana własnego hasła ma inny metadatum i nie jest objęta tym zgłoszeniem. Brak działającego resetu utrudnia odzyskiwanie kont i reakcję na incydent; nie pozwala sam w sobie przejąć konta.

**Działanie:** użyć niesensytywnego identyfikatora zdarzenia/metadanych (np. semantycznej nazwy operacji w bezpiecznym polu), zachowując blokadę logowania rzeczywistych poświadczeń. Dodać test powodzenia obu resetów z prawdziwą transakcją, revokacją sesji i audytem.

**Odbiór:** nowy hash zostaje zapisany, rewizja rośnie, stare sesje są odwołane, obowiązkowa zmiana hasła jest ustawiona, audyt powstaje; nie ma hasła/hashu w metadanych. Dowód: [runtime-db-probe.log](audit-security-2026-10-14/runtime-db-probe.log). Baza wymagała diagnostycznej korekty TEMP opisanej w S06; kod resetu/audytu/potwierdzenia pozostał niezmieniony.

### S06 — P1 dla wydania / wysokie operacyjnie: migrator nie może wykonać świeżej migracji

**Odtworzono na nowym PostgreSQL 17.** Uruchomiono niezmieniony `docker/postgres/ensure-runtime-roles.sh`, następnie migracje faktyczną rolą `goldis_migrator`. Migracja `024-canonical-entity-tenant-scope.js` zatrzymała się na `permission denied to create temporary tables in database "goldis"`.

Skrypt odbiera prawa DB od PUBLIC i przyznaje migratorowi `CONNECT`, lecz nie przyznaje `TEMPORARY` wymaganego przez migrację. To może zablokować nową instalację lub restore do świeżej bazy. Nie jest dowodem nadmiernych uprawnień użytkowników platformy.

**Działanie:** przyznać `TEMPORARY` wyłącznie migratorowi albo usunąć tę zależność z migracji. Nie przyznawać tego prawa wszystkim runtime rolom. Odbiór musi obejmować migrację od pustej bazy z docelową rolą i ponowne uruchomienie bez zmian.

Dowód: [runtime-db-unmodified.log](audit-security-2026-10-14/runtime-db-unmodified.log), [runtime-db-probe.cjs](audit-security-2026-10-14/runtime-db-probe.cjs). Wariant diagnostyczny `--allow-temp-fixture` dodaje TEMP tylko w jednorazowej bazie, aby zbadać dalsze mechanizmy; jego ewentualny wynik PASS nie oznacza poprawności niezmienionego wdrożenia.

### S07 — P2 / średnie, warunkowe: lokalny start może wystawiać panel i API do sieci

[main.ts](../apps/api/src/main.ts), linia 18, wiąże API do `0.0.0.0`. [Start-GoldisLocal.ps1](../scripts/Start-GoldisLocal.ps1), linia 161, uruchamia Next bez jawnego `-H 127.0.0.1`. Lokalny origin używa HTTP; cookie API otrzymuje `Secure` dopiero dla `NODE_ENV=production`. Samo podanie użytkownikowi adresu `127.0.0.1` nie ogranicza nasłuchu.

Nie uruchamiano rzeczywistej lokalnej aplikacji, więc ekspozycję opisujemy jako skutek konfiguracji kodu, zależny również od firewalla. Bazowy/produkcyjny Compose mapuje web na loopback i nie publikuje API; to lepsza granica. Zaobserwowany native PostgreSQL na wszystkich interfejsach wymaga osobnej kontroli hosta, nie jest automatycznie dowodem publicznie dostępnej bazy Goldis.

**Działanie:** jawny bind loopback dla lokalnego API i Next, blokada ruchu przychodzącego do usług danych, a dostęp innych osób wyłącznie przez odebraną bramę HTTPS. Zweryfikować też prawidłowe IP klienta: lokalny Next rewrite i pusty `TRUST_PROXY_IPS` mogą powodować wspólny budżet IP dla klientów zamiast poprawnej identyfikacji.

**Odbiór:** porty lokalne widoczne tylko na loopback; z drugiej maszyny nieosiągalne. W publicznej topologii fałszywe X-Forwarded-For nie zmieniają klienta w limiterze. Obecny Nginx nadpisuje forwarding, lecz nie odebrano go na rzeczywistej domenie.

### S08 — P2 / średnie: długość hasła nie wyklucza łatwych fraz

[password-policy.ts](../apps/api/src/password-policy.ts) wymaga minimum 15 znaków, ale bloklista ma dziewięć pozycji, z czego część jest krótsza niż minimum. `passwordpassword` przechodzi walidację — odtworzono to w próbie syntetycznej. Nie wiadomo, czy którykolwiek użytkownik ma takie hasło; nie czytano hashów klientów ani nie zgadywano ich haseł.

**Działanie:** wprowadzić lokalną listę popularnych/skompromitowanych haseł lub weryfikację przez rozwiązanie, które nie wysyła pełnego hasła do podmiotu trzeciego. Zachować obsługę długich fraz i menedżerów haseł. **Odbiór:** testy dla popularnych fraz >=15 znaków, haseł Unicode i poprawnych losowych haseł. Dowód: [probes.json](audit-security-2026-10-14/probes.json).

### S09 — P2 / średnie: poufność względem osoby z dostępem do SQL/hosta jest ograniczona

PESEL jest szyfrowany w rekordach tożsamości; eksporty i staging używają AES-GCM. Jednocześnie imiona/nazwiska, kontakty, adresy i dane polis/snapshotów są przechowywane jako TEXT/JSONB: [db.ts](../apps/api/src/db.ts), m.in. linie 250–251, 938–939, 1348 i 1427. Runtime API może odczytywać dane niezbędne do obsługi użytkowników i ma dostęp do kluczy deszyfrujących eksporty/PESEL.

Nie należy obiecywać, że szyfrowanie plików ukrywa całą platformę przed administratorem hosta, operatorem infrastruktury z prawami systemowymi lub osobą, która przejęła proces API. Izolacja ról ogranicza zasięg przejęcia workera, ale nie zastępuje ochrony hosta i kluczy. Nie zweryfikowano BitLocker/LUKS/szyfrowania dysku VPS.

**Działanie:** określić zakres dostępu osób utrzymujących infrastrukturę; ograniczyć konta hosta/DB, szyfrować wolumeny i backupy, chronić klucze oddzielnie od kopii danych, rozważyć szyfrowanie pól według wymagań modelu zagrożeń. Stosować minimalizację danych, retencję i kontrolę eksportów. Wewnętrzny HTTP/Postgres/Redis w Compose działa w sieci hosta; przy przeniesieniu usług na różne hosty potrzebny jest osobny kontrakt szyfrowanego transportu.

Zalecenia: [OWASP Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html). To ograniczenie ochrony przed uprawnionym dostępem infrastrukturalnym, nie dowód publicznego wycieku.

### S10 — P2 / średnie: zgłoszenia zależności wymagają utrzymania przeglądu

Świeże `npm audit --omit=dev --json`: **0 critical, 0 high, 7 moderate**. Siedem wpisów dotyczy dwóch źródłowych advisory i ich ścieżek zależności: `uuid` oraz `sprintf-js`, przez ExcelJS/Sequelize/Umzug. Nie są to siedem odtworzonych exploitów platformy.

Obecne użycia Sequelize sprawdzone w zainstalowanych plikach odwołują się do UUID v1/v4; advisory `uuid` dotyczy innych wariantów i nieprawidłowego bufora. Dotychczasowy dokument decyzji zależności odnotowuje także v4 w ExcelJS i brak formatu `sprintf` z HTTP. Nie odtworzono wykorzystania tych advisory przez API. Proponowane przez npm naprawy obejmują niezgodne downgrade, więc nie stosowano `audit fix --force`.

**Działanie:** utrzymywać uzasadnione wyjątki, kontrolować osiągalność podatnego kodu przy zmianach pakietów, aktualizować zgodnie z migracją biblioteki i skanować każde wydanie. Dowód: [npm-audit-production.json](audit-security-2026-10-14/npm-audit-production.json). Źródła: [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c).

## Zabezpieczenia, które potwierdzono w obecnym kodzie/testach

- Scrypt z solą losową; bieżący profil N=131072/r=8/p=1, porównanie timing-safe, limit współbieżnych KDF i kolejki. Dla nieistniejącego konta wykonywana jest kosztowna weryfikacja zastępcza. Legacy hashe są podnoszone po poprawnym logowaniu.
- Sesja ma podpis HMAC; rola nie pochodzi z cookie. API sprawdza aktywność użytkownika/członkostwa/sesji, wygaśnięcie i rewizję poświadczeń. Polling bez sygnału interakcji nie utrzymuje sesji bez końca.
- Cookies sesji mają HttpOnly i SameSite=Strict; w produkcji również Secure. Mutacje kontrolują origin/fetch-site i CSRF powiązany z podpisaną sesją. To nie chroni przed złośliwym rozszerzeniem lub przejętym komputerem.
- Limiter Redis ogranicza próby pary konto/IP, konta i IP oraz reauth. Awaria Redis kończy się odmową/503; żądania nie przechodzą bez limitera. Rzeczywisty test jednorazowego Redis przeszedł.
- Granica tenant preceduje wyjątki właściciela/przydziału. Role operator/manager nie dają dostępu do AdminController. Przekazanie roli w cookie nie nadaje takiej roli po stronie serwera.
- Potwierdzenia zmian kont/grantów są krótkotrwałe, powiązane z aktorem, sesją, rewizją poświadczeń, akcją, celem, payloadem i idempotencją. Kasowanie ma osobną ścieżkę podglądu/step-up. Brak takiej ochrony dla ustawień odnotowano w S04.
- Eksporty w prywatnym magazynie są szyfrowane AES-256-GCM z AAD wiążącym artifactId; odczyt sprawdza integralność i tombstones. Nie wystawia się magazynu jako katalogu statycznego. PESEL jest szyfrowany z kontekstem run/source; publiczny JSON usuwa prywatne pola.
- Produkcyjny CSP z nonce blokował wstrzyknięty skrypt inline w prawdziwej przeglądarce; potwierdzono no-store, nosniff i zakaz osadzania strony w ramce.
- Walidator XLSX ogranicza ekspansję ZIP, scalenia, zakresy/kolumny, formuły, DTD i zewnętrzne relacje; parser jest wydzielony w Compose bez sekretów DB. Testy regresyjne dawnych problemów przeszły. Nie testowano awarii/OOM kontenera parsera na topologii produkcyjnej.
- W Compose istnieją osobne role DB, Redis ACL, Docker secrets, nieuprzywilejowani użytkownicy kontenerów i jawny sandbox Chromium dla workera. Niezależna próba SQL na jednorazowej bazie po migracjach 001–059 i zastosowaniu allowlisty potwierdziła: brak superuser/createdb/createrole/replication/bypassrls/inherit dla czterech ról, brak CREATE w public dla runtime, brak odczytu hashów haseł przez portal/enrichment worker i brak UPDATE/DELETE audytu przez runtime. Enrichment worker nie może aktualizować runów, portal worker może. Baza wymagała TEMP dla migratora; to nadal nie jest odbiór niezmienionego wdrożenia ani starej instalacji.

## Testy i dowody

| Próba | Wynik | Granica dowodu |
| --- | --- | --- |
| `npm run test:module:security` | 67 PASS, 0 FAIL/SKIP | Część testów korzysta z modeli/fixture, nie rzeczywistej DB |
| `npm run test:module:auth` | 26 PASS, 0 FAIL/SKIP | Pokrycie częściowo powtarza moduł security; obejmuje HTTP/origin/CSRF |
| `npm run test:module:results` | 27 PASS, 0 FAIL/SKIP | Eksporty, szyfrowanie, staging, nagłówki pobierania |
| `npm run test:module:security-redis` | PASS | Jednorazowy rzeczywisty Redis; limity i Retry-After. Nie odbiór produkcyjnego ACL |
| `npm run test:module:security-browser` | PASS | Build Next i rzeczywisty Chromium z syntetycznym backendem; CSP/nonce/idle signal |
| `node scripts/test-production-compose.cjs` | PASS | Konfiguracja z syntetycznymi sekretami/digestami. Nie uruchomienie obrazów/TLS |
| `node docs/audit-security-2026-10-14/probes.cjs` | PASS | Dowody S03/S04/S05-walidator/S08; HTTP z modelami fixture |
| `npm run test:module:security-db` | FAIL | Skrypt używa usuniętego eksportu `BootstrapAdminService`; `TypeError: BootstrapAdminService is not a constructor`. To wada bramki testowej, nie wykazane obejście uprawnień |
| Własna świeża DB, niezmienione role i migracje | FAIL na migracji 024 | Rzeczywisty brak TEMP migratora, S06 |
| Istniejący `runtime-permissions-smoke.cjs` na świeżej DB | FAIL | SELECT odwołuje się do aliasu `r` bez FROM; `missing FROM-clause entry for table "r"` |
| Własna świeża DB, diagnostyczny wariant TEMP | PASS niezależnych kontroli ról i odtworzenia obu błędów resetu | Migracje 001–059 i allowlista wykonane. Korekta TEMP dotyczy wyłącznie jednorazowej bazy; istniejącego błędu skryptu smoke nie zaliczono jako PASS |

Logi i odtwarzalne próby są w [audit-security-2026-10-14](audit-security-2026-10-14/). Wykonano 120 zaliczonych uruchomień testów w trzech modułach, z częściowym powtórzeniem testów między modułami; nie należy przedstawiać tego jako 120 różnych scenariuszy bezpieczeństwa. Kontenery jednorazowe są usuwane z kontrolą etykiety właściciela.

## Czego nie uznano za odebrane

1. Pełnej macierzy izolacji użytkownik/użytkownik i tenant/tenant z rzeczywistą DB: obecny dedykowany moduł blokuje stary eksport bootstrap. Oddzielny skrypt kontroli praw ma także błędny SELECT bez FROM. Naprawić obie bramki i ponowić, w tym leady, wyniki historyczne, raporty i pobieranie po cofnięciu dostępu. Niezależny audyt wybranych praw SQL przeszedł, lecz nie zastępuje tej macierzy.
2. Rzeczywistej konfiguracji ról, ACL Redis, firewall, HTTPS, nagłówków IP, cookies i blokady `/api/internal/` w docelowym środowisku. Nginx zawiera poprawny kierunek konfiguracji, ale jest plikiem przykładowym.
3. Aktualności instalacji lokalnej: `.env.local` nadal wskazuje starszą rolę `goldis`, Redis bez poświadczeń i nie zawiera kilku wymaganych sekretów/URL ról. To nie jest potwierdzenie uprawnień istniejącego konta DB, bo nie łączono się do tej bazy. Aktualny skrypt startowy powinien odmówić uruchomienia takiej konfiguracji. Nie regenerować ani nie nadpisywać jej bez kontrolowanej migracji danych/sekretów.
4. Pełnego cold restore zaszyfrowanego backupu wraz z kluczami i aktualnym journalem kasowań na drugim hoście, RPO/RTO, retencji i kopii poza maszyną.
5. Zewnętrznych alarmów o nowych logowaniach, zmianach ról/grantów, blokadach kont i podejrzanych pobraniach. Login failures są próbkowane globalnie do 5 wpisów/15 min, bez IP i nazwy konta; to ogranicza koszt i dane w logach, lecz nie zastępuje oddzielnych metryk/alertów ataku. `ipHash` sesji jest ustawiany na null.
6. Uprawnień dostawcy VPS, wsparcia administracyjnego i operatorów backupu; nie było dostępu do takiego środowiska. Dla integracji MF/GUS/PZU/Compensa należy osobno określić uprawnione przepływy danych i retencję. MF adapter wysyła NIP do ustalonego endpointu dostawcy; nie używa dowolnego URL użytkownika.

## Kolejność domknięcia

1. Ograniczyć ACL historycznych plików sekretów i rozstrzygnąć rotację; poprawić reset haseł oraz TEMP migratora i bramkę DB.
2. Ustalić zakres wspólnego dostępu OC/PESEL i zasięg eksportów; objąć ustawienia admina świeżym potwierdzeniem.
3. Uzgodnić i wdrożyć ochronę MFA/VPN kont uprzywilejowanych; poprawić bloklistę haseł i jawny loopback lokalnego startu.
4. Odebrać pełną macierz uprawnień i konfigurację rzeczywistej instalacji; następnie HTTPS/proxy/ACL/host oraz backup, restore i alarmy.
5. Powtórzyć skan zależności i próby anonimowe/użytkownika/admina dla konkretnego wydania z commitem i digestami obrazów.

Żaden z zapisanych wyników nie potwierdza, że ktoś włamał się do platformy. Ustalenia pokazują możliwe drogi dostępu, błędy ochrony/odzyskiwania oraz granice obecnych dowodów.
