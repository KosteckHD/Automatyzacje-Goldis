# Goldis · platforma narzędzi

Aktualny zakres adaptacji według ustaleń z 12 października 2026 opisuje [plan adaptacji platformy](docs/PLAN_ADAPTACJI_PLATFORMY_DO_USTALEN_2026-10-12.md), a implementacja i pozostałe bramki produkcyjne są w [statusie realizacji](docs/REALIZACJA_PLANU_ADAPTACJI_2026-10-12.md). Zasady VPS, HTTPS, kont PostgreSQL i szyfrowania historycznych eksportów są w [instrukcji wdrożenia](docs/WDROZENIE_PRODUKCYJNE_I_ROLE_BAZY_2026-10-12.md).

Pierwsze narzędzie przygotowuje bazę firm do weryfikacji polis OC. Szczegółowy zakres, testy i bramki odbioru opisuje [plan implementacji](docs/PLAN_IMPLEMENTACJI.md).

Bieżące wyniki testów i zakres następnych prac są w [stanie implementacji](docs/STAN_IMPLEMENTACJI.md).

Aktualny [plan implementacji z 7 października, rewizja 2](docs/PLAN_DOMKNIECIA_PLATFORMY_AUTOMATYZACJI_2026_10_07.md) opisuje wzbogacanie NIP → REGON, wszystkie moduły automatyzacji, kolejność pakietów i ich osobne testy funkcjonalności, bezpieczeństwa oraz awarii. Pełne uruchomienie i odbiór procesu pozostają pod kontrolą użytkownika; agent nie wykonuje ich automatycznie. To podstawowy plan następnych prac; starsze wpisy opisują także stan historyczny.

Szczegółowy plan administracji platformą, dostępu do narzędzi i wyników, sesji, operacji, interwencji, ustawień, audytu oraz raportów znajduje się w [planie administracji platformą](docs/PLAN_ADMINISTRACJI_PLATFORMY.md).

Aktualna kolejność domknięcia wszystkich funkcjonalności platformy — historii importów, korekt, rejestru NIP → REGON, partii, ról, interwencji i odbioru całości — znajduje się w [planie domknięcia platformy](docs/PLAN_DOMKNIECIA_PLATFORMY.md). Plan zawiera zależności, kryteria zakończenia i pierwszy zakres kodowania po audycie z 5 października.

Agent kodujący powinien korzystać ze [szczegółowego planu implementacji platformy](docs/PLAN_IMPLEMENTACJI_PLATFORMY_DLA_AGENTA.md): kroki PL-01–PL-11, pliki, projektowane API i dane, kolejność transakcji, testy, migracje i kryteria przekazania.

Frontend aplikacji używa teraz motywu czarno-złotego, logo Goldis, lokalnych fontów i wybranych komponentów React Bits. [Plan wizualny Goldis](docs/PLAN_FRONTEND_CZARNO_ZLOTY.md) opisuje decyzje oraz zakres dalszych bramek. Osobny [podgląd mockupów](docs/design/goldis/README.md) nadal pokazuje demonstracyjne układy; zrzuty produkcyjnego frontendu z danymi syntetycznymi są w `docs/design/goldis/implemented`.

Opis bieżących funkcji panelu admina, macierz ról, obsługa sesji, reset konta i znaczenie ustawień są w [instrukcji administratora](docs/INSTRUKCJA_ADMINA.md).

[Audyt bezpieczeństwa z 8 października](docs/AUDYT_BEZPIECZENSTWA_2026_10_08.md) opisuje ustalenia dotyczące injection, uwierzytelniania, autoryzacji i limitów. [Szczegółowy plan napraw bezpieczeństwa](docs/PLAN_IMPLEMENTACJI_NAPRAW_BEZPIECZENSTWA_2026_10_08.md) rozpisuje każdy problem krok po kroku, z plikami, migracjami, zależnościami, testami odbioru i procedurą wdrożenia oraz rollbacku.

[Audyt bezpieczeństwa całej aplikacji z 9 października](docs/AUDYT_BEZPIECZENSTWA_CALEJ_APLIKACJI_2026-10-09.md) zawiera świeże wyniki testów PostgreSQL/Redis, 744 odmowy dostępu anonimowego oraz odtworzone problemy ekspansji scalonych komórek XLSX, przekazywania IP przez Next.js i konfiguracji klucza PESEL. Raport podaje priorytety, dowody i warunki odbioru; nie potwierdza gotowości do publicznego wdrożenia.

Bieżący podział na zmiany w kodzie i otwarte bramy PostgreSQL/Redis/HTTPS znajduje się w [raporcie stanu wdrożenia poprawek bezpieczeństwa](docs/SECURITY_IMPLEMENTATION_STATUS_2026_10_08.md); nierozwiązane zgłoszenia npm są opisane w [decyzjach zależności](docs/security/DEPENDENCY_DECISIONS_2026_10_08.md).

Aktualny plan napraw po przeglądzie z 1 października, z zależnościami, checklistą dla agenta i testami bez kodu PZU, jest w [planie napraw i odbioru bez SMS PZU](docs/PLAN_NAPRAW_I_ODBIORU_BEZ_SMS_PZU.md).

Kolejność zmian w kodzie, kontrakty między usługami i testy prac możliwych bez SMS opisuje [plan wykonawczy automatyzacji](docs/PLAN_WYKONAWCZY_AUTOMATYZACJI.md).

Aktualne bramki odbioru żywego przepływu PZU → Compensa → UFG i kolejność pozostałych prac opisuje [plan domknięcia automatyzacji OC](docs/PLAN_DOMKNIECIA_AUTOMATYZACJI_OC.md).

Wykonanie krok po kroku i wynik każdej bramki należy zapisywać w [dzienniku postępu](docs/POSTEP_IMPLEMENTACJI.md).

## Obecny stan

- Działają: panel Next.js, logowanie, import `.xlsx` do PostgreSQL, filtrowany podgląd, kolejki korekt i konfliktów, submission, audyt/raporty, migracje oraz lokalny Docker Compose. Wartość REGON z importu pozostaje oddzielona od zatwierdzanej wartości operacyjnej.
- Kolejka BullMQ i osobny worker obsługują zadania pojedynczych wierszy; portalowy procesor pozostaje wyłączony. Osobny enrichment worker obsługuje trwałe zadania rejestru, ale provider także domyślnie pozostaje wyłączony.
- W kodzie są podłączone ścieżki PZU → Compensa → UFG → snapshot/eksport, SMS z centrum interwencji, wersjonowane poprawki danych i kontrolowane punkty wznowienia. Build i testy syntetyczne nie są odbiorem integracji DB/API/Redis pełnego procesora.
- Panel administracyjny obejmuje granty, konta/sesje, centrum operacyjne, przydział, ustawienia, audyt i raporty; kod zawiera migracje do 051. Istniejąca lokalna baza wymaga kontrolowanego startu, aby zastosować migracje. Sterowanie pojedynczym runem wymaga aktualnej rewizji i idempotency key. Sesje wygasają po 30 minutach bezczynności, a polling nie przedłuża ich bez niedawnej interakcji użytkownika. Wzbogacanie obsługuje MF VAT (batch do 30 NIP) oraz GUS BIR (batch do 20), z trwałym limitem, krótkim HMAC-cache i widocznym stanem workera/dostawcy. Testy adapterów korzystają wyłącznie z lokalnych fixture; produkcyjny GUS wymaga klucza od [GUS BIR](https://api.stat.gov.pl/Home/RegonApi?lang=pl), którego jeszcze nie skonfigurowano. Odbiór bezpieczeństwa DB/Redis/HTTPS i pomiary wydajności pozostają otwarte; szczegóły są w raporcie stanu bezpieczeństwa. Stan testów opisują [stan implementacji](docs/STAN_IMPLEMENTACJI.md) i [dziennik postępu](docs/POSTEP_IMPLEMENTACJI.md).
- `WORKER_LIVE_PORTALS=0` i `GOLDIS_ENRICHMENT_PROVIDER=disabled` pozostają ustawieniami domyślnymi. Agent nie uruchamia wspólnego pełnego procesu ani portali live; decyzja o odbiorze całego procesu należy do użytkownika.

Żądania HTTP do MF VAT/GUS BIR mają trwały odstęp w PostgreSQL i obsługę `Retry-After`. Portalowy worker ma osobną zmienną `WORKER_PORTAL_MIN_ACTION_INTERVAL_MS` (domyślnie `1000` ms), która odstępia kontrolowane kliknięcia/zmiany w tym samym profilu i ponownie sprawdza lease po czekaniu. Obejmuje punkty sterowane przez adapter, nie każde wewnętrzne żądanie JavaScript strony; nie jest deklaracją oficjalnego limitu portalu.

Arkusz `Realizacja` wymaga kolumny `Nazwa` oraz co najmniej jednej z kolumn `NIP` lub `REGON`; pozostałe pola są opcjonalne na etapie importu. Poprawny NIP bez REGON można później wyszukać przez skonfigurowanego dostawcę rejestru. Wynik otrzymuje nazwę `{REGON}_{nazwa_dzialalnosci}_{imie_nazwisko_osoby_decyzyjnej}.xlsx`, jeśli osoba jest podana, a w przeciwnym razie `{REGON}_{nazwa_dzialalnosci}.xlsx`. Wcześniejszy import można wgrać ponownie, aby uzupełnić nowe pola.

## Uruchomienie lokalne

Najpierw domykamy i odbieramy właśnie tę instalację lokalną; VPS jest późniejszy i nie blokuje prac. Wymagane: Node.js 22+, npm i Docker Desktop. Pierwszą lokalną konfigurację przygotuj przez `npm run setup:local`: skrypt tworzy prywatny `.env.local` z losowymi sekretami, ustawia dostęp do pliku dla bieżącego użytkownika i nie nadpisuje istniejącej konfiguracji. Hasło pierwszego administratora jest w tym pliku; przy pierwszym logowaniu system wymusi jego zmianę. Portale i dostawcy rejestru pozostają wyłączeni. Porty PostgreSQL/Redis są publikowane wyłącznie na loopback jako `55432/56379`. Nie dodawaj plików `.env` do Git.

Jeśli `.env.local` pochodzi ze starszej wersji i nie zawiera odrębnych ról DB, najpierw uruchom `npm run upgrade:local:db-roles`. Skrypt aktualizuje wyłącznie lokalne adresy i hasła ról w pliku konfiguracji; istniejący wolumen PostgreSQL zachowuje dane, a role i uprawnienia zostaną zastosowane przy kolejnym starcie.

```bash
npm ci
npm run setup:local
npm run start:local
```

Skrypt startowy sam uruchamia PostgreSQL i Redis w odizolowanym projekcie Compose `goldis-local`, wykonuje build, preflight i migracje, a następnie uruchamia API, panel i widocznego workera. Panel: `http://127.0.0.1:3000`. API readiness: `http://127.0.0.1:3001/api/health/ready`. `Ctrl+C` zatrzymuje procesy aplikacji; kontenery bazy i Redis oraz dane zostają zachowane. Aby zatrzymać także te usługi bez kasowania danych, użyj `docker compose -p goldis-local --env-file .env.local -f compose.yaml -f compose.local-browser.yaml stop postgres redis`. Wariant pełnego headless Compose używa osobnego `.env.compose.local` i nie może działać równolegle z lokalnym workerem.

Zaszyfrowaną kopię bazy, kluczy z `.env.local`, eksportów i stagingu można utworzyć przez `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Backup-GoldisLocal.ps1`. Dla spójnego zrzutu aplikacja i workery muszą być zatrzymane; skrypt odmawia pracy, gdy porty lokalne są zajęte. Ustawione hasło backupu (minimum 16 znaków) trzeba przechować osobno. Kopię sprawdza `scripts/Test-GoldisLocalBackup.ps1 -BackupPath <plik.goldis-backup>`: weryfikuje szyfrowanie, manifest, SHA-256 i czytelność dumpa PostgreSQL bez podmieniania działającej bazy. Dziennik kasowań i jego klucz leżą lokalnie obok eksportów (`%LOCALAPPDATA%\Goldis\deletion-journal`) i są celowo pomijane w archiwum; zachowaj je i przenieś oddzielnie przy zmianie maszyny. Po odtworzeniu bazy/plików offline, przed startem aplikacji, uruchom `npm run restore:deletion-journal`. Komenda stosuje journal do zakresów artifact/run/import i nie uruchamia panelu ani workerów. Pełne odtworzenie archiwum backupu do używanej bazy nadal wymaga osobnego, kontrolowanego odbioru; nie odtwarzaj backupu do działającej bazy.

## Struktura

- `apps/web` — Next.js i React
- `apps/api` — NestJS, import i Sequelize
- `apps/worker` — kolejka BullMQ i Playwright; żywy przebieg jest zaimplementowany za flagą, ale czeka na zweryfikowaną konfigurację ekranów i test odbiorczy
- `packages/core` — wspólne reguły danych i typy
- `docs` — plan prac i lokalny plik wejściowy (plik `.xlsx` jest ignorowany przez Git)
