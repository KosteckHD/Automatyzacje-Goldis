# Lokalny Playwright i uruchomienie platformy

Worker utrzymuje jeden dedykowany profil Chromium i jest jego jedynym właścicielem. PZU lub Compensa mogą poprosić o ponowny SMS po wygaśnięciu sesji, restarcie, zmianie urządzenia albo własnej decyzji portalu; automatyzacja nie omija MFA. Zmienne `WORKER_LIVE_PORTALS=0` pozostają ustawieniem domyślnym.

## Konfiguracja Windows

1. Skopiuj `.env.windows.example` do prywatnego `.env.local`, uzupełnij lokalne hasła i klucze oraz ustaw ścieżki na swoim komputerze. Przykładowe klucze są placeholderami; wygeneruj własne losowe sekrety. Nie zapisuj `.env.local`, profilu Chromium ani plików staging w Git.
2. Na potrzeby trybu lokalnego uruchom PostgreSQL i Redis na portach loopback:

   ```powershell
   docker compose --env-file .env.local -f compose.yaml -f compose.local-browser.yaml up -d postgres redis
   ```

3. Uruchom API, panel i jeden widoczny worker z repozytorium:

   ```powershell
   npm ci
   npm run start:local -- -EnvFile .env.local
   ```

   Skrypt buduje workspace’y, wykonuje preflight bez ujawniania wartości środowiska, uruchamia migracje, ponawia preflight schematu i dopiero potem startuje trzy własne procesy. `Ctrl+C` zamyka tylko te procesy wraz z ich potomkami; nie wyszukuje ani nie kończy obcych Node/Chrome. Logi usług trafiają do `%LOCALAPPDATA%\Goldis\logs`.

4. Otwórz `http://localhost:3000`. Panel rozróżnia dostępność API/DB/Redis, heartbeat workera i stan „Portale wyłączone”. `/api/health/live` to liveness, `/api/health/ready` sprawdza DB/Redis, a `/api/health/automation` pokazuje bezpieczny stan workera/configu bez sekretów i ścieżek.

W trybie `off` nie są wymagane loginy i hasła portali, ale wymagane są dostępne usługi, klucz szyfrowania PESEL, sekret wewnętrznego kanału i prywatny trwały katalog profilu. Runy zostają w stanie oczekiwania na adapter i nie otwierają portali.

## Tryb kontenerowy

Pełen Compose uruchamia headless worker. Używaj go zamiast lokalnego workera, a nie równolegle z nim:

```powershell
docker compose up -d --build
```

Compose ma osobny trwały wolumen profilu i stagingu; plik selektorów jest montowany tylko do odczytu. `WORKER_LIVE_PORTALS` domyślnie wynosi `0`. Nie wpisuj sekretów do przykładowego pliku konfiguracji selektorów. Worker blokuje drugiego właściciela portali wspólną blokadą w PostgreSQL.

## Włączenie portali

Nie ustawiaj `WORKER_LIVE_PORTALS=1` z plikiem `config/portal-selectors.example.json`. Preflight live wymaga prawdziwych, zatwierdzonych selektorów, adresów HTTPS z listą dozwolonych originów, poświadczeń, schematu po migracji i 32-bajtowych kluczy stagingu. Konfiguracja nie może zawierać `UNVERIFIED`, `data-verified-*` ani ogólnych akcji w rodzaju `smsCodeSubmit: button`. Zestaw selektorów, w tym opcjonalny iframe SMS, zapamiętanie urządzenia, resend, ekran docelowy i znana reklama, wymaga własnej walidacji. Nieznany overlay ma zatrzymać run przed kliknięciem.

Pierwsze i późniejsze kody operator wpisuje do centrum interwencji. Platforma ogranicza czas i liczbę dodatkowych prób, a sam portal nadal decyduje o ważności kodu i zaufaniu do urządzenia. W tym repozytorium nie wykonywać teraz testu loginu ani wpisywania SMS.

## Zatwierdzona pozytywna ścieżka

- W Everest wyszukiwany jest `effectiveRegon`; PESEL pochodzi bezpośrednio z kolumny PESEL/REGON w wierszu typu **„Osoba fizyczna”**. Nie wybierać PESEL-u z wiersza działalności i nie otwierać szczegółów konta jako zastępstwa. Niejednoznaczność osoby/fimy zatrzymuje zadanie przed Compensą.
- W Compensie automatyzacja otwiera z homepage kafelek **Compensa Komunikacja**, wybiera **Ubezpieczający**, przekazuje PESEL z tego samego runu i skonfigurowany numer wyszukiwania **RST22339**.
- Po uzgodnieniu danych zapisuje ten sam szkic/ofertę, weryfikuje ją w UFG, otwiera **Szczegóły** i odczytuje kompletną tabelę polis OC. Eksport powstaje z trwałego snapshotu DB i zapisanej `referenceDate`.

Konfiguracja przykładowa jest wyłącznie szablonem. Moduły Playwright mają testy syntetyczne, ale przed użyciem bez nadzoru wymagają pełnego odbioru procesora i integracji DB/Redis/API. Pełny odbiór PZU nadal pozostaje oddzielną bramką wymagającą uprawnionego testu live.
