# Wdrożenie produkcyjne Goldis

Ta procedura opisuje docelowy wariant: domena kieruje do Nginx na VPS, Nginx kończy TLS i przekazuje ruch wyłącznie do frontendu Next.js na `127.0.0.1`. API, PostgreSQL, Redis, parser i workery nie dostają publicznych portów. Używaj jej dopiero po wybraniu VPS i domeny; przykładowy host `goldis.example.com` nie jest skonfigurowanym adresem.

## 1. Przygotuj wydanie

1. Wydziel czysty commit z kodem, migracjami, testami, konfiguracją Compose i dokumentacją. Nie pakuj `.env*`, katalogu sekretów, eksportów, stagingu, profilu portali ani danych z workspace. Obecnego dużego, zmodyfikowanego workspace nie oznaczaj jako release bez przeglądu plików.
2. Zbuduj obrazy PostgreSQL, Redis, API, workera Playwright i web z tego samego commita. Opublikuj je w wybranym registry i zapisz niezmienne referencje `image@sha256:...`. Nie wpisuj digestu testowego ani tagu `latest` do `.env.production`.
3. Wypełnij zaufane identyfikatory builda i digest API (`GOLDIS_BUILD_VERSION`, pełne `GOLDIS_BUILD_COMMIT`, `GOLDIS_IMAGE_DIGEST`) w środowisku kontenera. Manifest wydania ma zawierać digesty wszystkich obrazów, najwyższą migrację, hash `docker/postgres/apply-runtime-grants.sql` oraz wynik testów. Po czystym commicie użyj `npm run release:manifest -- --env /etc/goldis/env.production --output /var/lib/goldis/releases/<wersja>/release-manifest.json`.
4. Zbuduj plik środowiska z `.env.production.example`. Ustaw domenę HTTPS, dozwolony adres proxy `172.30.10.10`, digesty pięciu obrazów, provider `mf-vat`, środowisko MF `production`, `WORKER_LIVE_PORTALS=0` i prawidłową wersję aktywnego klucza. Usuń puste wartości przykładu, których Compose wymaga.
5. Utwórz `/etc/goldis/secrets` z właścicielem `root:root` i trybem `0700`; każdy plik ustaw jako `0600`. Wygeneruj niezależne hasła dla PostgreSQL/Redis i 32-bajtowe klucze aplikacyjne. Wypełnij URL-e usługowe zgodnie z `deploy/secrets/README.md`; pliki logowania do portali mogą pozostać puste, dopóki live jest wyłączony. Hasło administratora początkowego usuń z hosta po udanym bootstrapie, zgodnie z procedurą organizacji.
6. Wskaż `GOLDIS_SECRETS_DIR=/etc/goldis/secrets`. Zachowaj `.env.production` jako `root:root`, tryb `0600`; w tym pliku są ścieżki/identyfikatory obrazów, nie wartości haseł.
7. Zainstaluj wersje Docker Engine/Compose wymagane przez pliki produkcyjne. Przed uruchomieniem sprawdź `docker version`, `docker compose version`, miejsce na dysku oraz dostępność wszystkich digestów.
8. Sprawdź konfigurację przed startem:

   ```sh
   node scripts/validate-production-compose.cjs --env /etc/goldis/env.production
   GOLDIS_SECRETS_DIR=/etc/goldis/secrets docker compose --project-name goldis \
     --env-file /etc/goldis/env.production -f compose.yaml -f compose.production.yaml config --quiet
   ```

   Pierwsza komenda sprawdza digesty, brak buildów/portów publicznych, sieci, proxy i HTTPS. Druga kontroluje rozwiązaną konfigurację Compose.

## 2. Przygotuj domenę i HTTPS

1. Ustaw rekordy A/AAAA domeny na VPS. Otwórz przychodzący SSH zgodnie z portem administracyjnym oraz TCP 80/443; nie wystawiaj portów 3001, 3010, 3022, 5432 ani 6379. Sprawdź też reguły IPv6 i zaporę hosta. Zweryfikuj SSH przed odrzuceniem pozostałych reguł.
2. Zainstaluj Nginx i klienta ACME. Najpierw opublikuj tymczasowy vhost HTTP, który obsługuje wyłącznie `/.well-known/acme-challenge/` z `/var/www/letsencrypt`. Uzyskaj certyfikat dla wybranej domeny, a następnie wpisz tę domenę do `deploy/nginx/goldis.conf.example` i ustaw ścieżki certyfikatu.
3. Skopiuj pełny plik Nginx do konfiguracji hosta i wykonaj `nginx -t`. Po poprawnym teście przeładuj usługę. Włącz automatyczne odnawianie certyfikatu i monitoruj jego termin ważności.
4. Zachowaj `proxy_set_header X-Forwarded-For $remote_addr`, `Forwarded ""`, ograniczenie 20 MiB i blokadę `/api/internal/`. Nginx ma być jedynym publicznym wejściem; adres frontendowego kontenera musi nadal zgadzać się z `TRUST_PROXY_IPS`.

## 3. Uruchom aplikację bez automatów live

1. Zaloguj się do VPS, zrób kontrolną kopię pustego środowiska i uruchom usługi:

   ```sh
   GOLDIS_SECRETS_DIR=/etc/goldis/secrets docker compose --project-name goldis \
     --env-file /etc/goldis/env.production -f compose.yaml -f compose.production.yaml up -d
   ```

   Compose najpierw inicjuje PostgreSQL/role, wykonuje migracje i granty, uruchamia bootstrap pierwszego administratora, a potem pozostałe usługi. Nie ustawiaj live na `1` w tym kroku.
2. Sprawdź `docker compose ... ps`, readiness, logi z kodami błędów oraz zajęte porty. Logi muszą pozostać bez haseł, OTP, PESEL-u, cookies i treści odpowiedzi portalu.
3. Sprawdź lokalnie `https://<domena>/`, logowanie, zmianę hasła, role, upload syntetycznego pliku, pobranie syntetycznego wyniku oraz `/api/health/ready`. Uruchom `node scripts/runtime-check.cjs` z `GOLDIS_RUNTIME_BASE_URL=https://<domena>` i oczekiwanym providerem `mf-vat`.
4. Z hosta potwierdź, że tylko Nginx nasłuchuje publicznie. Frontend powinien być związany z loopback; publiczny request na `/api/internal/`, API, parser, DB i Redis ma być niedostępny.
5. Wykonaj test backupu, walidację pliku i odtworzenie do oddzielnego projektu/nowych wolumenów według `deploy/backup/README.md`. Nie uznawaj szyfrowania samego pliku za sprawdzone odtworzenie.
6. Wykonaj odbiór funkcji MF VAT i syntetyczne scenariusze automatyzacji. Pozostaw portal-workera bez logowania live, dopóki nie zakończy się nadzorowany odbiór kont i akcji nieodwracalnych.

## 4. Odbiór live

Włącz `WORKER_LIVE_PORTALS=1` dopiero dla zatwierdzonego, ograniczonego zakresu. Najpierw sprawdź osobno sukces, brak osoby, brak PESEL, brak polis, niejednoznaczność, SMS poprawny/wygasły, timeout i wznowienie z checkpointu. Nigdy nie wznawiaj niepewnego zapisu/UFG przez ręczne ustawienie statusu lub usunięcie checkpointu. Zwiększaj partię po pomiarze czasu, RAM, CPU i wolnego dysku; każdy odbiór zapisz przy konkretnym commicie i digestach.

VPS, DNS, certyfikat, konto registry, sekrety produkcyjne, live portale i alarmowy kanał operatora nie są obecnie skonfigurowane. Procedura nie oznacza, że produkcja została uruchomiona.
