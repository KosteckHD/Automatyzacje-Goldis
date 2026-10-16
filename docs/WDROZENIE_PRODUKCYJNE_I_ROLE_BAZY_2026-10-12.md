# Wdrożenie produkcyjne i role bazy danych

Kod planu adaptacji jest zaimplementowany lokalnie, ale platforma nie została wdrożona na VPS ani odebrana przez użytkownika. Ta instrukcja opisuje pozostałe czynności infrastrukturalne i warunki otwarcia dostępu publicznego.

## Elementy gotowe w repozytorium

- Nowy arkusz przechodzi sprawdzenie ZIP/XML przed ExcelJS, w tym limity scalonych komórek.
- Eksporty są zapisywane jako AES-256-GCM z losowym IV i uwierzytelnieniem powiązanym z UUID artefaktu. Klucze pozostają poza repozytorium i wspierają rotację wersji.
- Skrypt `scripts/migrate-artifacts-to-encrypted.cjs` wznawialnie szyfruje historyczne eksporty. Przed zmianą sprawdza SHA-256 zapisany w bazie i nie nadpisuje pliku przy niezgodności.
- Produkcyjne pobieranie odmawia zwrotu starego, niezaszyfrowanego eksportu, gdy `ARTIFACT_REQUIRE_ENCRYPTION=1`.
- PostgreSQL ma odrębne role `goldis_migrator`, `goldis_api` i `goldis_worker`. Migrator zarządza schematem, a API i worker dostają DML bez uprawnienia do DDL ani superusera. Usługa Compose `db-roles` przygotowuje role także na istniejącym wolumenie.
- Kontener workera uruchamia Chromium z `chromiumSandbox: true` jako `pwuser`, z `no-new-privileges` i domyślnym profilem seccomp Moby rozszerzonym wyłącznie o syscalle `clone` i `unshare` potrzebne dla nieuprzywilejowanych przestrzeni nazw Chromium. Kontener nie dostaje `SYS_ADMIN` ani `seccomp=unconfined`.
- PostgreSQL, Redis, API i web mają porty hosta przypięte do loopback; worker nie publikuje portu hosta.
- `deploy/nginx/goldis.conf.example` zastępuje wejściowe nagłówki `X-Forwarded-*` adresem klienta widzianym przez bramę.

## Przygotowanie VPS

1. Ustaw domenę i certyfikat TLS w Nginx na hoście. Publiczny ruch prowadź wyłącznie do web na `127.0.0.1:3000`; nie publikuj 3001, 5432, 6379 ani 3022 na interfejsie publicznym.
2. Uzupełnij prywatny plik środowiska: `APP_ENV=production`, `PUBLIC_APP_ORIGIN=https://<domena>`, `ARTIFACT_REQUIRE_ENCRYPTION=1`, osobne długie sekrety DB dla migratora/API/workera, klucze PESEL/artefaktów, sekret sesji, sekret workera i cache MF. Klucze oraz plik trzymaj poza repozytorium z ograniczonym dostępem.
3. Ustaw `TRUST_PROXY_IPS` na dokładny adres IP kontenera web widziany przez API. Przykład Compose używa `172.30.10.10`; potwierdź go w rzeczywistej sieci przed uruchomieniem.
4. Zrób zaszyfrowany backup bazy, eksportów, stagingu, sekretów/kluczy i dziennika kasowań. Najpierw odtwórz go w izolowanym środowisku. `db-roles` uruchamia idempotentne nadanie uprawnień, także przy istniejącym wolumenie.
5. Zatrzymaj API i oba workery, pozostawiając PostgreSQL. Uruchom konwersję historycznych eksportów na dokładnie tym samym obrazie kodu:

   ```sh
   docker compose run --rm --no-deps api node scripts/migrate-artifacts-to-encrypted.cjs
   ```

   Polecenie powinno wypisać jedynie liczbę zaszyfrowanych i już zaszyfrowanych artefaktów. Przy błędzie zatrzymaj wdrożenie i sprawdź integralność kopii oraz SHA w bazie. Po poprawnej konwersji ustaw `ARTIFACT_REQUIRE_ENCRYPTION=1` i uruchom usługi.
6. Weryfikuj staging: role bazy i odmowę DDL dla API/workera, HTTPS, cookie secure, origin/CSRF, próbę sfałszowania `X-Forwarded-For`, upload z olbrzymim zakresem scalonym, download eksportu, role użytkowników i usuwanie z replay journalu. Sprawdź sandbox w rzeczywistym obrazie workera poleceniem `docker compose run --rm --no-deps worker node scripts/chromium-sandbox-smoke.cjs`; oczekiwany wynik to `CHROMIUM_SANDBOX_SMOKE_PASS`.

Profil seccomp bazuje na [oficjalnym profilu Moby](https://github.com/moby/profiles/blob/main/seccomp/default.json). Przy zmianie silnika Docker porównaj profil z wersją zainstalowaną na VPS i ponów smoke; nie zastępuj go profilem `unconfined` ani dodatkowym `SYS_ADMIN`.
7. Zapisz release commit, digest obrazów, wynik migracji, checksumy backupu, RPO/RTO oraz protokół testu cold restore na drugim hoście. Włącz alerty dla braku backupu, braku miejsca, offline workera, zaległej kolejki, błędów MF/portali, `manual_required` oraz niespójnych artefaktów.
8. Użytkownik wykonuje i zatwierdza lokalny odbiór aplikacji. Dopiero potem wykonuje się nadzorowany staging na dozwolonych kontach portalowych. `WORKER_LIVE_PORTALS` pozostaje `0` do tego odbioru.

Do czasu przejścia tych czynności produkcja publiczna nie jest gotowa. Nie ma tu jeszcze domeny/certyfikatu, VPS, zewnętrznych sekretów, konfiguracji monitoringowej, produkcyjnego digestu obrazu ani zatwierdzenia lokalnego i stagingowego flow.
