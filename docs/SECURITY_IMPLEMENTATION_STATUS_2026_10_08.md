# Stan wdrożenia poprawek bezpieczeństwa

Zakres wynika z [audytu](AUDYT_BEZPIECZENSTWA_2026_10_08.md) i [planu implementacji](PLAN_IMPLEMENTACJI_NAPRAW_BEZPIECZENSTWA_2026_10_08.md). Ten raport rozdziela zmiany w kodzie od odbioru na PostgreSQL, Redis i HTTPS; nie stanowi potwierdzenia gotowości produkcyjnej.

## Zaimplementowane w kodzie

- **Poświadczenia i sesje (P01 / SEC-01):** rewizja poświadczeń, wspólna blokada advisory per użytkownik w transakcjach logowania i zmian administracyjnych, ponowny odczyt hasha/statusu/roli przed zapisem sesji oraz globalne unieważnianie sesji po zmianie/resetowaniu hasła i wyłączeniu konta. Migracja 031. Dodano test porządku i deduplikacji blokad.
- **Autoryzacja i role (P02 / SEC-02 / C-01):** `submission:read` wymaga `view_results`; grant pobrania jest niezależny od prawa odczytu; twarda granica tenant poprzedza wyjątki owner/assignee; listy i scope nie rozszerzają się przez pobieranie. Migracja 032 rozdziela flagi w DB.
- **Limity (P03 / SEC-03/04, P06):** limity loginu, konta, IP i ponownej autentykacji współdzielą Redis, używają HMAC do kluczy, fail-closed i nie kasują nowszej generacji po spóźnionym sukcesie. Dodano limit 300 żądań API/IP na 60 s przed parserami JSON/multipart. `TRUST_PROXY_IPS` ufa wyłącznie jawnej liście adresów.
- **Hasła i bootstrap (P04 / SEC-05/06/09):** nowy profil scrypt v1, czytnik starego formatu i opportunistyczny rehash, wspólna polityka haseł, odpowiedź loginu bez ujawnienia istniejącego konta oraz bezpieczny bootstrap, który nie nadpisuje administratora i wymusza zmianę hasła przy pierwszym logowaniu.
- **Granty i przydziały (P05 / SEC-08/10):** odczyt partii wymaga `view_results`, zachowanie narzędzia disabled jest filtrowane, a cofnięcie uprawnienia lub roli zdejmuje niekwalifikujący się przydział z dziennikiem aktywności.
- **Import i health (P06 / SEC-07):** limit body i multipart, preflight archiwum ZIP/XLSX z limitami liczby wpisów/rozmiaru/kompresji/komórek/czasu, blokadą DTD/XXE, relacji zewnętrznych i formuł, limit współbieżności parsera oraz współdzielony, ograniczony probe gotowości.
- **CSP, cache i logi (P07/P08):** nonce CSP dla dynamicznego Next, `no-store`, nagłówki anty-iframe i nosniff; błędy loginu zapisuje się tylko w ograniczonym próbkowaniu, z anonimowym aktorem i minimalnymi metadanymi.
- **Bezczynność sesji (część P09):** migracja 033 zapisuje `last_activity_at`; sesja jest cofana po 30 minutach bezczynności. UI sygnalizuje aktywność tylko przez 60 sekund po zaufanym zdarzeniu użytkownika, a resolver sprawdza limit przed odświeżeniem i atomowo nie wskrzesza wygasłej sesji.
- **Izolowane zestawy odbiorowe (P00):** `test:module:security-db` tworzy disposable PostgreSQL dla scenariuszy użytkowników/sesji i tenantów; `test:module:security-redis` tworzy własny oznaczony kontener Redis z portem loopback i usuwa tylko ten kontener. Runner usuwa odziedziczone sekrety/flagi i nie dopuszcza shared Redis do testu.
- **Compose:** web/API i sieć danych zostały rozdzielone; web ma stabilny adres, który API może jawnie ufać dla forwarding headers. PostgreSQL/Redis nie publikują portów.
- **Zależności (P11):** Next podniesiono do 16.4.0, a rozwiązany `source-map-js` do 1.2.2. Wyjątki pozostałych zgłoszeń opisuje [decyzja zależności](security/DEPENDENCY_DECISIONS_2026_10_08.md).

## Dowody wykonane

- `npm ci` — PASS; odtworzyło 333 pakiety z lockfile.
- `npm test` — PASS: core 13/13, API 159/159, worker 66 PASS/37 SKIP, preflight 3/3; workerowe skipy dotyczą istniejących fixture portali/live i nie są odbiorem integracji.
- `npm run test:module:security` — 52/52 PASS, w tym granica 30 minut i przekazanie sygnału aktywności.
- `npm run test:module:runner` — 11/11 PASS; rejestruje osobno moduły security, PostgreSQL, Redis i browser.
- `npm run test:module:security-browser` — PASS na Next 16.4.0; przeglądarka blokuje surowy inline `<script>`, nonce zgadza się z HTML, `no-store` i nagłówki anty-iframe są obecne; lokalna sonda potwierdza, że polling bez interakcji nie wysyła sygnału, a kliknięcie tak.
- `npm run build` — PASS dla core, API, worker i web; strony Next są renderowane dynamicznie.
- `docker compose config --quiet` — PASS dla konfiguracji z syntetycznymi wartościami wymaganych zmiennych.
- `npm audit` po aktualizacji — 0 high, 7 moderate; pozostałe ścieżki i ograniczenia są jawnie opisane. Nie uruchamiano `npm audit fix --force`.

## Bramy nadal otwarte

- Nie wykonano testów PostgreSQL/Redis z użyciem oddzielnych usług. Docker Engine nie odpowiada w bieżącym środowisku (`docker info` nie może połączyć się z Docker Desktop Linux Engine); migracji 031–033 ani testów konkurencji nie uruchomiono na bazie.
- Limity wymagają potwierdzenia na prawdziwym Redisie, w tym między replikami, z outage/recovery i topologią proxy. Testy bieżące są syntetyczne.
- Import jest limitowany i parsowany bez częściowego zapisu, ale nie ma odrębnego procesu z twardym limitem RSS. Nie przeprowadzono testu obciążeniowego ani pomiaru KDF.
- Sprawdzono negatywny inline script, nie pełny stored-XSS z prawdziwym zapisem/odczytem DB. SQL jest używany z bind/replacements w istniejących ścieżkach, lecz planowany test HTTP → PostgreSQL z payloadami SQL injection czeka na izolowaną bazę.
- **P09 jest częściowy:** działa idle timeout. Brakuje TOTP/recovery, ograniczonego logowania MFA i świeżego step-up dla admina; zmiany uprzywilejowane nie wymagają jeszcze ponownego potwierdzenia.
- **P10 jest częściowy:** Compose ma rozdział sieci i prywatne porty danych, ale brak produkcyjnego profilu HTTPS/edge, kont runtime/migratora z najmniejszymi prawami, Redis ACL i black-box testu staging.
- Nowych testów `security-db` i `security-redis` nie uruchomiono: Docker Desktop Linux Engine jest niedostępny. Wymagają wykonania po starcie izolowanego środowiska; nie oznaczono pominięcia jako PASS.
- Pełna macierz ról/grantów/statusów, migracja/rollback starej bazy, Redis ACL, real HTTPS, MFA/recovery i testy przeglądarkowe dla czterech ról/logout/back-cache wymagają dalszego odbioru.

Dlatego ustalenia SEC-01–SEC-10 i pakiety P09/P10/P12 nie są oznaczone jako w pełni odebrane. Kod ogranicza część ryzyk, ale odbiór integracyjny i produkcyjny pozostaje otwarty.
