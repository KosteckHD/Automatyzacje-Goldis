# Plan włączenia automatyzacji OC w głównej platformie Goldis

Data utworzenia: 17 października 2026. Aktualizacja: 18 października 2026. Status: **uruchamianie automatyzacji z platformy włączone, bez limitu godzinowego; w przeglądarce workera potwierdzono rzeczywisty formularz SMS PZU, pierwsze poprawne MFA pozostaje niewykonane**. Pełny odbiór L6 pozostaje niezakończony. Aktualną diagnostykę przeglądarki i ramki opisuje sekcja 13, a zmianę limitu sekcja 12; wcześniejsze checkpointy są historyczne.

Cel: umożliwić uruchamianie automatyzacji Everest → Compensa → UFG → XLSX z panelu `http://127.0.0.1:3000`, początkowo pod nadzorem operatora. Przygotowanie tego dokumentu nie aktywuje portali ani nie zleca operacji na danych klientów.

## 1. Stan początkowy i zakres

Odczyty wykonane podczas przygotowania planu:

| Element | Stan potwierdzony |
| --- | --- |
| Główny projekt Compose | `goldis-local`; panel 3000, API 3001 |
| API, baza, kolejka, worker | Działają; health automatyzacji zwraca `servicesReady=true`, `worker=online` |
| Tryb workera | `WORKER_LIVE_PORTALS=0`; `automationReady=false` |
| Konfiguracja zamontowana w workerze | `config/portal-selectors.example.json`; walidator zwraca `PORTAL_CONFIG_UNVERIFIED_SELECTOR` |
| Dane logowania portali w sekretach workera | PZU i Compensa: brak niepustego kompletu login/hasło |
| Staging wyników | Klucz i jego wersja są skonfigurowane; sam odczyt nie potwierdza pełnego dostarczenia wyniku |
| Profil przeglądarki | Oddzielny trwały wolumen Dockera; stan zalogowania nie został sprawdzony |
| Wcześniejszy odbiór live | Oddzielna instalacja `goldis-acceptance-20261015`, API 3101 i panel 3100 |

Mechanizm uruchamiania zadań, kolejka, produkcyjny procesor, interwencje SMS i eksport już istnieją. Wykorzystać je; rozszerzać implementację tylko tam, gdzie przegląd lub odbiór wykaże konkretną lukę.

W zakresie jest przygotowanie głównej lokalnej instalacji oraz jej odbiór pod nadzorem. Publiczny VPS, domena, TLS, całodobowy monitoring i pełna praca bez nadzoru należą do osobnego [planu wdrożenia produkcyjnego](PLAN_WDROZENIA_PRODUKCYJNEGO_2026-10-16.md).

## 2. Kolejność i odpowiedzialność

| Etap | Wynik | Zależności | Wykonawca |
| --- | --- | --- | --- |
| L0 | Aktualna inwentaryzacja i procedura powrotu | — | Agent |
| L1 | Wersjonowany zestaw konfiguracji portali | L0 | Agent |
| L2 | Poprawne podłączenie sekretów do głównego workera | L0 | Agent; operator udostępnia poświadczenia prywatnym kanałem |
| L3 | Kontrola gotowości i blokad przed aktywacją | L1–L2 | Agent |
| L4 | Przygotowany profil oraz obsługa logowania i SMS | L3 | Agent technicznie; operator obsługuje dostęp i SMS |
| L5 | Kontrolowane włączenie głównego workera live | L3–L4 i uzgodniony zakres live | Agent/operator |
| L6 | Jeden pełny przebieg z panelu 3000 | L5 i wskazany przypadek | Operator przy wsparciu agenta |
| L7 | Przekazanie do lokalnej pracy pod nadzorem | L6 | Agent i operator |

Na początku każdego etapu ponownie odczytać stan środowiska. Powyższe wyniki są migawką, a nie gwarancją przyszłego stanu.

## L0. Ustalić stan instalacji i możliwość powrotu

- [x] Sprawdzić stan Git, obrazy uruchomionych usług, migracje, konfigurację Compose i aktualne źródła sekretów bez wypisywania ich wartości.
- [x] Ustalić jeden sposób pracy: w tym planie główny worker działa w Docker Compose. Nie uruchamiać równolegle hostowego workera na Windows.
- [x] Sprawdzić aktywne runy, oczekujące submissiony, dispatch outbox, kolejkę Redis i właściciela profilu. Nie usuwać ani nie ponawiać zastanych zadań zbiorczo.
- [x] Zanotować aktualne limity, pauzę nowych uruchomień i pozostałe ustawienia operacyjne. Ustalić, które blokady dotyczą przyjmowania nowych zleceń, a które faktycznego pobierania istniejącej kolejki.
- [x] Przed zmianą używanej instalacji przygotować prywatną kopię bazy oraz konfiguracji i zapisać identyfikatory poprzednich obrazów. Zachować istniejące klucze i ich wersje. Poprzedni obraz workera nie jest już dostępny lokalnie; opisano to w checkpointcie.
- [x] Opisać powrót do poprzedniej konfiguracji i trybu `off`, z zachowaniem DB, eksportów, profilu i stagingu.

**Odbiór:** znany stan wszystkich oczekujących zadań, wskazana instalacja i obrazy, dostępna procedura powrotu. Brak niezamierzonego uruchomienia portali.

## L1. Przygotować rzeczywistą konfigurację portali

Punkty pracy: `scripts/prepare-acceptance-portal-config.cjs`, `config/*.observed.json`, `apps/worker/src/portals/shared/portal-runtime-config.ts`, `compose.yaml`.

- [x] Porównać konfigurację i skompilowane adaptery z dowodami ostatnich odebranych prób. Generator ma nadal oznaczenia pilotażowe; sam fakt wygenerowania pliku nie stanowi odbioru.
- [x] Przygotować oddzielny, jednoznacznie nazwany artefakt konfiguracji dla głównej instalacji. Zapisać jego wersję i SHA-256 oraz powiązanie z wersją adapterów i dowodami odbioru.
- [x] Zachować obsłużone przypadki: osoby i firmy, wiele kont tej samej osoby, brak wyniku Everest, niekompletne dane Compensy, pominięcie dodatkowego dialogu ubezpieczającego oraz niepewny zapis.
- [x] Potwierdzić uzgodniony numer rejestracyjny używany do rozpoczęcia Komunikacji; operator potwierdził numer 18 października.
- [x] Ustawić `WORKER_PORTAL_CONFIG_PATH_HOST` na rzeczywisty plik hosta. Zachowano kontenerową ścieżkę `WORKER_PORTAL_CONFIG_PATH=/run/config/portal-selectors.json` i montowanie tylko do odczytu.
- [x] Uruchomić walidator na pliku widzianym wewnątrz docelowego kontenera. Aktualnie zamontowany plik głównego workera zwrócił `PORTAL_CONFIG_VALID`; hash odpowiada potwierdzonemu kandydatowi. Nie otwierano portali.

**Odbiór:** worker widzi właściwy plik, hash odpowiada przygotowanemu artefaktowi, walidacja przechodzi bez `UNVERIFIED` i zastępczych selektorów. Potwierdzona jest struktura konfiguracji; aktualne działanie na portalach sprawdza etap L6.

## L2. Podłączyć poświadczenia i zachować klucze

Punkty pracy: `.env.local` poza Git, `scripts/Write-GoldisComposeSecrets.ps1`, sekrety Compose.

- [x] Ustalić źródło uprawnionych poświadczeń PZU i Compensy. Można wykorzystać istniejące dane wskazane przez operatora; nie przenosić całego środowiska odbiorowego do głównego.
- [x] Uzupełnić prywatnie `PZU_LOGIN`, `PZU_PASSWORD`, `COMPENSA_LOGIN`, `COMPENSA_PASSWORD`. Nie wpisywać wartości do dokumentacji, poleceń z widocznymi argumentami, logów ani raportów.
- [x] Zapisać pliki sekretów z obecnymi ograniczeniami ACL. Przy ponownym użyciu generatora sprawdzić jego pełny zakres: zapisuje także sekrety inne niż portalowe, więc nie może przypadkowo nadpisać ich pustymi lub starymi wartościami.
- [x] Potwierdzić obecność poświadczeń w plikach zamontowanych w workerze, raportując wyłącznie wynik obecne/brak.
- [x] Sprawdzić długość i wersję klucza stagingu oraz zgodność wewnętrznego sekretu worker–API. Zachować istniejące klucze stagingu, PESEL i eksportów; ich rotacja nie należy do aktywacji.

**Odbiór:** komplet poświadczeń jest dostępny docelowemu procesowi; sekrety nie pojawiają się w wynikach diagnostyki. Na tym etapie nie wykonuje się prób logowania do portali.

## L3. Sprawdzić gotowość i możliwość wstrzymania wykonania

Punkty pracy: `scripts/preflight-contract.cjs`, `scripts/local-preflight.cjs`, `apps/worker/src/application/worker-runtime*.ts`, `apps/api/src/features/health/` oraz istniejące ekrany statusu.

- [ ] Wykorzystać istniejący preflight i uzupełnić tylko brakujące kontrole trybu kontenerowego: poprawność konfiguracji, obecność poświadczeń, klucze, uprawnienia do profilu/stagingu, DB/Redis oraz kanał wyników i SMS. Obecność plików i kluczy potwierdzono; dostarczenie wyniku oraz challenge SMS pozostają niezweryfikowane.
- [x] Kontrole przygotowawcze wykonywać bez tworzenia runów i bez nawiązywania połączeń z portalami. Nie uruchamiać bezpośrednio hostowego preflightu z zajętym portem odbiornika jako jedynego kryterium poprawności kontenera.
- [x] Sprawdzić istniejącą możliwość startu workera z wstrzymanym pobieraniem zadań (`startRunWorker({ startPaused: true })`) i sposób jej użycia w docelowym uruchomieniu. Dodać obsługiwany tryb przygotowania tylko wtedy, gdy obecny entrypoint go nie udostępnia.
- [x] Zapewnić, że brak konfiguracji lub poświadczeń zatrzymuje uruchomienie live przed pobraniem zlecenia, z bezpiecznym kodem błędu.
- [x] Sprawdzić zabezpieczenie przed drugim workerem i użyciem tego samego profilu przez inny proces. Blokada PostgreSQL nie chroni wspólnego profilu używanego przez proces podłączony do innej bazy.
- [x] Opisać znaczenie `/api/health/automation`: `automationReady=true` potwierdza infrastrukturę i konfigurację workera, ale nie gwarantuje aktywnej sesji portalowej ani braku przyszłego SMS.
- [x] Jeśli interfejs sugeruje gwarantowane zalogowanie na podstawie tego healtha, poprawić komunikat. Przy zmianach UI zastosować `apps/web/AGENTS.md`.

**Odbiór:** brakujące wymagania są wykrywane przed wykonaniem zadania; worker może zostać przygotowany bez skonsumowania zaległej kolejki. Operator rozumie różnicę między gotowością techniczną i sesją portalu.

## L4. Przygotować profil przeglądarki i SMS

- [x] Zachować trwały profil i staging głównego workera. Porównać ich właściciela i uprawnienia z użytkownikiem procesu w kontenerze.
- [x] Nie zakładać, że profil Windows użyty podczas odbioru można przenieść do Chromium w Linuksie. Domyślnie przygotować sesję w docelowym profilu kontenerowym.
- [x] Wykorzystać obecny mechanizm logowania i interwencji. Pierwszą próbę połączono z uzgodnionym wierszem 18031; worker rozpoznał SMS PZU i utworzył interwencję. Kodu nie podawano zgodnie z ograniczeniem operatora.
- [ ] Jeżeli potrzebne będzie przygotowanie widocznej przeglądarki, ustalić obsługiwany sposób dostępu do tego samego profilu i wyłącznego właściciela przed uruchomieniem. Nie wyłączać sandboxa Chromium w ramach obejścia problemów.
- [ ] Operator wpisuje SMS przez centrum interwencji. Sprawdzić dostarczenie do właściwego workera i challenge, odrzucenie starego kodu, timeout i możliwość ponownego uwierzytelnienia.
- [ ] Po restarcie zachować profil i wynikające z niego sesje, ale akceptować ponowne MFA wymagane przez portal. Nie obiecywać trwałego braku SMS.

**Odbiór:** znany sposób pierwszego logowania i ponownego uwierzytelnienia, jeden właściciel profilu, działający kanał interwencji. Sam odczyt plików profilu nie jest potwierdzeniem zalogowania.

## L5. Włączyć live w kontrolowanym zakresie

- [x] Po zakończeniu przygotowania uzgodnić z operatorem jeden przypadek, konto, zakres i moment aktywacji. Operator wybrał wiersz 18031, potwierdził numer w konfiguracji, zaakceptował opis logowania i polecił włączyć działanie w platformie. Zachowano zakaz wpisywania kodu SMS Everest.
- [x] Wstrzymać przyjmowanie nowych zleceń i sprawdzić osobno blokadę pobierania już oczekujących zadań. Podczas przygotowania zastosowano obie pauzy; po akceptacji operatora odblokowano admission i kolejkę, zgodnie z sekcją 10.
- [x] Ponownie sprawdzić kolejkę, outbox i zadania aktywne. Przed odblokowaniem nie było zadań do pobrania, aktywnych runów ani oczekujących wpisów outbox. Następnie zlecono jeden uzgodniony run.
- [x] Zastosować konfigurację i `WORKER_LIVE_PORTALS=1` w projekcie `goldis-local`, z jawnym wskazaniem `.env.local` i właściwych plików Compose. Odtworzono wyłącznie worker, przy globalnie wstrzymanej kolejce.
- [x] Potwierdzić aktualny heartbeat, `portalMode=live`, `portalConfig=valid`, `automationReady=true` oraz brak drugiego właściciela przeglądarki. Kontener zdrowy; główny worker rozpoczął logowanie PZU dla uzgodnionego runu.
- [x] Dopuścić wyłącznie uzgodniony przebieg L6. Z panelu zlecono jeden run dla 18031; nie przenoszono kolejek, importów ani historii z instalacji odbiorowej 3100.

**Odbiór:** docelowy worker pracuje live z odebraną konfiguracją i poświadczeniami, bez niezamierzonych zadań.

## L6. Odebrać jeden pełny przebieg uruchomiony z panelu

Test biznesowy na rzeczywistych portalach wykonuje operator albo agent na jego odrębne, konkretne zlecenie. Wcześniejsze próby w oddzielnej instalacji stanowią dowód zachowania adapterów; ten odbiór dotyczy konfiguracji głównej platformy.

- [x] Wskazać jeden zaakceptowany przypadek. Operator wybrał 18031 do pojedynczego przebiegu, został poinformowany o możliwości utworzenia formularza Compensy i potwierdził numer oraz flow. Oczekiwany pełny wynik to zapisany wynik UFG i XLSX; jeśli PZU wymaga SMS, uzgodniony zakres kończy się na oczekiwaniu bez kodu.
- [x] Uruchomić zadanie standardową ścieżką panelu 3000. Kliknięto formularz pojedynczego wiersza; powstał run `42eda996-cf3c-4031-8c0d-056f611924e5`, dokładnie jeden POST z numerem 18031. Nie wywoływano procesora ani nie dodawano zadań bezpośrednio do Redis.
- [ ] Potwierdzić ciąg: panel → API → admission/outbox → kolejka → główny worker → Everest → Compensa Komunikacja → zapis → UFG → snapshot → XLSX.
- [ ] Potwierdzić, że znaleziony identyfikator należy do tego samego przypadku, a start, zapis i UFG nie są niezamierzenie powtarzane.
- [ ] Obsłużyć SMS przez panel, jeżeli portal go zażąda. Brak SMS w udanej próbie nie zalicza osobnego scenariusza ponownego uwierzytelnienia.
- [ ] Pobrać XLSX przez platformę i porównać dane oraz liczby z trwałym snapshotem i wynikiem portalu. Nie wymagać równości wszystkich odczytanych polis z liczbą w eksporcie, jeżeli eksport filtruje je według zapisanej daty odniesienia.
- [ ] Sprawdzić końcowy status, opis przyczyny, historię, audyt i zamknięcie interwencji. Zapisać identyfikatory runu, wersje konfiguracji/obrazów, czas oraz wynik kontroli.
- [ ] Niepewny zapis albo utrata sesji na niezapisanym formularzu zatrzymuje odbiór do przeglądu. Ponowienie wymaga uzgodnienia dalszej operacji.

**Odbiór:** jeden przebieg rozpoczęty w głównym panelu kończy się poprawnym wynikiem i pobranym, porównanym XLSX; brak niezamierzonej drugiej operacji i nierozliczonych zadań.

## L7. Przekazać instalację do pracy pod nadzorem

- [ ] Uzgodnić zakres użytkowania, limity, operatora interwencji i godziny pracy. Zachować sekwencyjne wykonanie workera, dopóki szersza równoległość nie została osobno odebrana.
- [ ] Zaktualizować instrukcję lokalnego uruchomienia i instrukcję administratora: plik środowiska, właściwy projekt Compose, adres panelu, status portali, SMS, pauza, zatrzymanie i wznowienie.
- [ ] Opisać obsługę: brak wyników, niekompletne dane Compensy, pominięty ubezpieczający, nieznany stan i niepewny zapis.
- [ ] Zapisać końcowy status **LOKALNA_PRACA_POD_NADZOREM_ODEBRANA** z datą, wersją obrazów, hashem konfiguracji i ograniczeniami. Nie nadawać tego statusu po samym health 200.

## 3. Weryfikacja implementacji i dowody

Nie powtarzać całych historycznych kampanii bez potrzeby. Dla rzeczywistych zmian wykonać odpowiednie kontrole:

| Zmiana | Wymagany dowód |
| --- | --- |
| Konfiguracja i mount | Walidacja wewnątrz kontenera oraz zgodność SHA-256; bez połączeń portalowych |
| Sekrety | Obecność kompletu, uprawnienia i brak wartości w raportach; zachowane klucze |
| Preflight/start workera | Testy syntetyczne: błędna konfiguracja, brak poświadczeń, start wstrzymany, drugi właściciel |
| Health lub komunikaty UI | Test rozróżnienia konfiguracji od sesji; sprawdzenie zmienionego widoku |
| Kanał SMS | Testy istniejących mechanizmów dla właściwego challenge, starego kodu i timeoutu; live tylko jeśli objęty zleceniem |
| Główna instalacja | Jeden uzgodniony przebieg L6 oraz kontrola wyniku i braku duplikacji |
| Zatrzymanie i powrót | Kontrola procedury na bezpiecznej granicy, z zachowaniem checkpointów i stagingu |

Raport nie zawiera haseł, SMS, cookies ani danych klientów. Szczegółowe dowody portalowe przechowywać prywatnie poza Git. Nieuruchomione sprawdzenia oznaczać `NOT_RUN`, zablokowane `BLOCKED`; planowane kryteria nie są wynikami `PASS`.

## 4. Procedura zatrzymania i ograniczenie po odbiorze

1. Wstrzymać nowe przyjęcia i pobieranie kolejnych zadań zgodnie z mechanizmami sprawdzonymi w L3. Samo przełączenie live na `off` nie zastępuje zatrzymania kolejki.
2. Bieżący run doprowadzić do bezpiecznej granicy. W razie zagrożenia dalszym niepożądanym działaniem zatrzymać wykonanie i oznaczyć wynik jako wymagający uzgodnienia; restart nie może wywołać ślepego ponowienia zapisu.
3. Zachować identyfikator formularza, checkpointy, staging i historię. Zmienić tryb na `off` lub przywrócić poprzednią konfigurację/obraz zgodnie z L0.
4. Przed ponownym dopuszczeniem zadań uzgodnić stan formularza w portalu i stan DB.

**Nierozstrzygnięte ograniczenie:** automatyczne odzyskanie niezapisanego formularza Compensy po utracie sesji na podstawie samego numeru nie zostało potwierdzone. Pierwszy zakres użytkowania przewiduje ręczny przegląd takiego przerwania. Pełna praca bez nadzoru wymaga osobnego rozwiązania i odbioru tego scenariusza.

## 5. Dokumenty i istniejące mechanizmy

- [Odbiór automatyzacji i ograniczenia](ODBIOR_AUTOMATYZACJI_2026-10-17.md)
- [Historia prób 18020–18030](TEST_FLOW_18020_18030_2026-10-17.md)
- [Lokalny Playwright i uruchomienie](URUCHOMIENIE_PLAYWRIGHT_LOKALNIE.md)
- [Instrukcja administratora](INSTRUKCJA_ADMINA.md)
- [Osobny plan wdrożenia produkcyjnego](PLAN_WDROZENIA_PRODUKCYJNEGO_2026-10-16.md)
- `compose.yaml`, `scripts/Start-GoldisLocal.ps1`, `scripts/Write-GoldisComposeSecrets.ps1`
- `apps/worker/src/application/worker-runtime.ts`, `apps/api/src/features/health/health-readiness.ts`

## 6. Checkpoint wykonania — 17 października 2026

Wykonano samodzielnie wszystkie przygotowania, które nie wymagają sesji operatora ani decyzji o uruchomieniu rzeczywistego przypadku. Żadne logowanie do PZU lub Compensy, MFA/SMS, wybór sprawy ani run live nie zostały wykonane. Nie zatwierdzono pełnego odbioru automatyzacji.

| Etap | Status | Wynik |
| --- | --- | --- |
| L0 | `PARTIAL` | Inwentaryzacja, pusta kolejka, backupy i procedura powrotu zapisane. Poprzedni obraz workera o ID `sha256:b1e320968f1aadaccbc0bb73236ba44726e8f066e99f5b78130601cfdf8270ee` nie jest już dostępny lokalnie, więc dokładnego odtworzenia tego obrazu nie potwierdzono. |
| L1 | `BLOCKED_OPERATOR` | Kandydat konfiguracji został powiązany z adapterami i zwalidowany bez kontaktu z portalem. Numer rejestracyjny, konto i zakres przypadku wymagają potwierdzenia operatora; plik kandydata nie jest podłączony. |
| L2 | `PASS_FILES_ONLY` | Cztery pliki poświadczeń są niepuste i zamontowane do docelowego workera; klucze stagingu i worker–API zachowano. Poprawność loginu i hasła w portalu pozostaje `NOT_RUN`. |
| L3 | `PARTIAL` | Gotowość, fail-fast, pauza pobierania, blokada profilu i znaczenie health zostały sprawdzone. Syntetyczne testy challenge SMS przeszły; prawdziwy challenge z portalu oraz dostarczenie XLSX pozostają `NOT_RUN`. |
| L4 | `BLOCKED_OPERATOR` | Trwały profil i staging należą do `pwuser` i mają prawa `755`; plik blokady ma `600` i jest własnością uruchomionego workera. Sesji portalowej ani MFA nie sprawdzono. |
| L5–L7 | `BLOCKED_OPERATOR` | Wymagają potwierdzonego zakresu i jednego przypadku, aktywacji live, udziału przy logowaniu/SMS oraz odbioru wyniku z platformy. |

### Stan instalacji po checkpointcie

- Projekt `goldis-local` nadal obsługuje panel `http://127.0.0.1:3000` i API `http://127.0.0.1:3001`. API, web, PostgreSQL, Redis, parser, enrichment worker i worker są zdrowe.
- Worker ma `WORKER_LIVE_PORTALS=0` i `WORKER_START_PAUSED=1`. Health zwraca `servicesReady=true`, `worker=online`, `portalMode=off`, `portalConfig=unavailable`, `automationReady=false`, `message=Portale wyłączone.`
- Worker montuje nadal `config/portal-selectors.example.json`; walidator głównej konfiguracji raportuje `PORTAL_CONFIG_UNVERIFIED_SELECTOR`. Tego pliku nie podmieniono kandydatem.
- W bazie są dwa runy `cancelled` i dwa wpisy outbox `consumed`. Nie ma runów aktywnych, oczekujących dispatchy ani zadań w Redis (`wait`, `active`, `delayed`, `prioritized`, `waiting-children` = 0). W ustawieniach admission jest włączone, limit godzinowy i okno godzinowe nie są ustawione, strefa to `Europe/Warsaw`; dlatego pauza workera pozostaje jawna.
- Zastosowano 63 migracje; ostatnia to `063-company-run-identities.js`.
- Profil i staging są wolumenami Dockera. Proces działa jako `pwuser`; katalogi mają właściciela `pwuser:pwuser` i prawa `755`. Aktywny `.goldis-worker.lock` ma prawa `600` i należy do tego workera.

### Konfiguracja prywatna i backupy

- Zweryfikowany backup bazy znajduje się w `C:\Users\micha\AppData\Local\Goldis\backups\automation-activation-20261017\goldis-local-before-portal-setup-20261017-200213.dump` (SHA-256 `abc4163788084172452731bc7c5f057214ffb94f9f9799066e7ac9af18d4b90a`). `pg_restore --list` zakończył się poprawnie.
- Migawka Compose sprzed przygotowań: `C:\Users\micha\AppData\Local\Goldis\backups\automation-activation-20261017\compose.yaml.before-automation-activation-20261017` (SHA-256 `b4aad186101ab5107e126b3325349c97f9f5b9db15633e5476535dc799ee41d1`). Przykładowa konfiguracja portali i prywatny `.env.local` również mają kopie w tym katalogu backupów.
- Poświadczenia są w ACL-ograniczonym `C:\Users\micha\Desktop\Goldis-Automatyzacje\.goldis-local-secrets`. Katalog jest w `.gitignore` i `.dockerignore`; żadna wartość sekretu nie trafia do tego raportu.
- Kandydat portali leży poza repozytorium: `C:\Users\micha\AppData\Local\Goldis\portal-config\portal-selectors-main-candidate-acceptance-18025-20261017.json`, SHA-256 `a85c953ffc2fdb7e8aa4ea20a5480603b94f7924e0f335217a3ddfd590e0fd9d`. Walidator wewnątrz workera zwrócił `PORTAL_CONFIG_VALID`; metadane potwierdzają `CANDIDATE_NOT_CONNECTED` i brak prób logowania.
- Użyto wyłącznie projektu Compose. Nie wykonywano migracji, importu, kasowania ani wznowienia runów w ramach checkpointu.

### Obrazy i poprawka ochrony sekretów

- Obrazy API i web przebudowano z aktualnych źródeł, a usługi odtworzono zdrowo. Aktualne ID: API `sha256:7e209e26dd4f18773de943aeab7b69c6505ae860cfbe7c31e0a01883488f6d7e`, web `sha256:ddedb03400667502713dbbf9da1e2047ff38d0ca222445b2230d7c8ada1114bd`, worker `sha256:20cb40d04cac6257508bcd9aedfea6cb5e561ad96ea46728af8333c4f988db1f`.
- Wcześniejszy lokalny build workera przypadkowo zawierał kopię `.goldis-local-secrets`, ponieważ katalog nie był wtedy wykluczony z kontekstu Dockera. Obrazu nie publikowano. Poprawiono `.dockerignore`, przebudowano worker i sprawdzono, że katalog nie występuje w nowych obrazach API, web ani workera; cztery sekrety nadal są dostępne wyłącznie przez mounty runtime.
- Z cache BuildKit usunięto pięć prywatnych rekordów należących tylko do tego wadliwego builda (około 1,54 GB); nie czyszczono współdzielonego cache ani innych obrazów. Istnieje jednak dodatkowy, nieużywany i niezamontowany katalog `C:\Users\micha\AppData\Local\Goldis\secrets-automation-20261017` z 30 kopiami plików sekretów. Próba usunięcia tego katalogu została odrzucona przez automatyczną kontrolę polecenia; katalog pozostaje ograniczony ACL. Usunąć go po powrocie operatora przez zwykłe zarządzanie plikami.

### Wykonane kontrole

- Buildy `@goldis/worker`, `@goldis/api` i `@goldis/web` zakończyły się powodzeniem; API i panel przebudowano również w Dockerze i oba kontenery są zdrowe.
- Testy syntetyczne konfiguracji workera oraz blokady profilu przeszły; testy health API: 4/4; kontrakt preflight: 12/12; testy challenge/SMS, stagingu wyników i akceptacji wyniku: 52/52. Gotowy komunikat panelu znajduje się w zbudowanym bundle web.
- `/api/health/automation` celowo nie pokazuje gotowości live. Kandydat ma poprawną strukturę, ale nie jest konfiguracją głównej instalacji; nie potwierdzono działania na stronie PZU/Compensa.

### Czynności wymagające operatora

1. Potwierdzić właściwe konto i numer rejestracyjny w konfiguracji kandydata oraz zakres danych, dla których wolno użyć automatów.
2. Uzgodnić jeden przypadek L6 i spodziewany wynik, w tym ryzyko utworzenia formularza w Compensie.
3. Być obecnym na pierwszym logowaniu oraz ewentualnym MFA/SMS i wpisać kod przez centrum interwencji platformy.
4. Wskazać moment kontrolowanego przejścia na live; przed nim sprawdzić kolejkę i dopuścić wyłącznie uzgodniony przypadek.
5. Obejrzeć końcowy status, historię i XLSX oraz zaakceptować przekazanie L7.

Do tego czasu zachować `WORKER_LIVE_PORTALS=0`, `WORKER_START_PAUSED=1` i odłączony kandydat konfiguracji.

## 7. Odświeżenie stanu i kandydat sprawy — 18 października 2026

Użytkownik jest dostępny do kontynuacji i poprosił o pomoc w znalezieniu sprawy. Wykonano wyłącznie odczyt lokalnej bazy; nie odczytywano nazwisk, PESEL-i, telefonów ani wartości polis, nie kontaktowano się z portalami i nie uruchomiono żadnego zadania.

- Wszystkie usługi nadal są zdrowe. Health potwierdza `servicesReady=true`, `worker=online`, `portalMode=off`, `portalConfig=unavailable`, `automationReady=false`; worker ma `WORKER_START_PAUSED=1` i `WORKER_LIVE_PORTALS=0`.
- Runy i kolejka nie zmieniły się: dwa runy `cancelled`, dwa outbox `consumed`, brak submissionów, a liczniki wszystkich stanów Redis wynoszą zero. Główna konfiguracja nadal wskazuje przykład.
- W głównej bazie jest import `45784330-03e0-4b03-af99-bcbc393b6c77` z 30 229 wierszami; 28 726 wierszy nie ma błędów importu. Wiersz `18031` jest poprawny importowo, ma `effective_regon` i nie ma runu w głównej instalacji. To kandydat do sprawdzenia przez operatora, a nie zatwierdzona sprawa: odczyt nie potwierdza uprawnień, właściwego numeru rejestracyjnego ani tego, czy istnieje już formularz w Compensie.
- Wiersze 18020–18030 były wcześniej podjęte w odrębnej instalacji odbiorowej; nie proponować ich do ponownej operacji na portalach bez osobnego sprawdzenia ryzyka duplikatu.
- Dodatkowy chroniony katalog kopii sekretów `C:\Users\micha\AppData\Local\Goldis\secrets-automation-20261017` nadal istnieje; nie jest montowany ani wskazany w `.env.local`/Compose.

Przed podłączeniem konfiguracji i przejściem L5 użytkownik ma potwierdzić w panelu wiersz, numer rejestracyjny, właściwy zakres/konto oraz zgodę na pojedynczą operację, która może utworzyć formularz Compensy.

## 8. Checkpoint operatora — 18 października 2026

Operator wskazał wiersz `18031` jako kandydata i zastrzegł, że nie ma dostępu do klienta, więc nie należy wpisywać ani obsługiwać kodu SMS Everest. Nie wykonano logowania do portali ani nie utworzono runu.

Kontrola konfiguracji wykazała, że odłączony kandydat głównej konfiguracji został przygotowany dla wcześniejszej sprawy i zawiera stały numer rejestracyjny Compensy przypisany do tamtego pilota. Adapter używa tego numeru podczas rozpoczęcia nowej Komunikacji. Nie ma potwierdzenia, że odpowiada on wierszowi `18031`, dlatego nie podłączono kandydata. Przebieg uruchamiany standardowo z panelu po zalogowaniu do Everest kontynuuje do Compensy; nie znaleziono bezpiecznego ustawienia ograniczającego go do samej próby Everest. Brak SMS nie gwarantowałby więc zatrzymania przed kolejną operacją.

Stan po kontroli: API health `servicesReady=true`, `worker=online`, `portalMode=off`, `portalConfig=unavailable`, `automationReady=false`; worker nadal ma `WORKER_LIVE_PORTALS=0` i `WORKER_START_PAUSED=1`. Uwierzytelniony odczyt Redis zwrócił `PONG`, a liczniki `wait`, `active`, `delayed`, `prioritized` i `waiting-children` są równe zero. Nie zmieniono `.env.local`, konfiguracji montowanej ani kolejki.

**L6 pozostaje `BLOCKED_OPERATOR`.** Przed pojedynczym przebiegiem operator musi potwierdzić numer rejestracyjny dla wybranej sprawy, uprawnienie i zakres użycia oraz brak istniejącej Komunikacji/formularza w Compensie. Jeśli operator nadal nie ma dostępu do klienta lub właściwego numeru, run pozostaje niewykonany. Kod SMS nie może być pomijany ani zastępowany.

## 9. Potwierdzenie numeru i przygotowanie live — 18 października 2026

Operator potwierdził numer rejestracyjny w konfiguracji i polecił przygotować pojedynczy przebieg. Wybrany wcześniej wiersz pozostaje `18031` w imporcie `45784330-03e0-4b03-af99-bcbc393b6c77`. Jednocześnie operator poprosił o przedstawienie flow logowania i selektorów do jego oceny przed logowaniem; nie ma obecnie dostępu do kodu SMS Everest. Nie ma potrzeby ponownego potwierdzania już zaakceptowanego numeru ani wyboru wiersza.

### Zastosowane zmiany i potwierdzony stan

- Prywatna kopia potwierdzonej konfiguracji: `.goldis-local-secrets/portal-selectors-main-confirmed-20261018.json`. SHA-256 `a85c953ffc2fdb7e8aa4ea20a5480603b94f7924e0f335217a3ddfd590e0fd9d`; hash odczytany wewnątrz docelowego kontenera jest identyczny. Walidator zwrócił `PORTAL_CONFIG_VALID`.
- `.env.local` wskazuje ten plik przez `WORKER_PORTAL_CONFIG_PATH_HOST`; hostowe `WORKER_PORTAL_CONFIG_PATH` również wskazuje potwierdzony plik. Compose nadal ustawia wewnątrz kontenera `/run/config/portal-selectors.json` i montuje go tylko do odczytu.
- Ustawiono `WORKER_LIVE_PORTALS=1`, `WORKER_START_PAUSED=0` i odtworzono tylko worker. Kod nie dopuszcza jednocześnie `live=1` i lokalnej flagi `startPaused=1`, dlatego przed zmianą zastosowano **globalną pauzę kolejki** przez BullMQ `Queue.pause()`.
- Przez standardowe API administratora, z kontrolą CSRF i wersji ustawień, wyłączono nowe przyjęcia i ustawiono limit jednego nowego runu na godzinę. Aktualnie `enabledForNewRuns=false`, `maxNewRunsPerHour=1`, `version=2`; okno godzinowe i strefę `Europe/Warsaw` zachowano. Limit godzinowy nie jest trwałą listą dozwolonych spraw; przed wznowieniem należy dopuścić dokładnie uzgodniony wiersz i ponownie zamknąć przyjęcia.
- Odczyt po odtworzeniu: kontener `running/healthy`; health `servicesReady=true`, `worker=online`, `portalMode=live`, `portalConfig=valid`, `automationReady=true`. Cztery sekrety portalowe nadal są niepuste.
- Globalna pauza kolejki potwierdzona odczytem. Stany `wait`, `active`, `paused`, `delayed`, `prioritized`, `waiting-children` mają zero zadań. W DB nadal tylko dwa runy `cancelled` i dwa outbox `consumed`; żadnego nowego runu nie utworzono. Wiersz `18031` nadal nie ma runu.
- Kontrola procesów w workerze wykazała zero procesów Chromium. Nie otwarto portali, nie wykonano prób logowania i nie zażądano SMS.
- Obraz workera pozostał `sha256:20cb40d04cac6257508bcd9aedfea6cb5e561ad96ea46728af8333c4f988db1f`; nie zmieniano kodu wykonawczego ani nie przebudowywano obrazu.

### Opis logowania i korekta wcześniejszego ustalenia

Pełny opis kroków, dokładnych selektorów, wykrywania sesji, SSO i MFA zapisano w [flow logowania](FLOW_LOGOWANIA_PORTALI_2026-10-18.md). To opis konfiguracji i kodu do oceny operatora, a nie dowód działania dzisiejszych stron.

W aktualnym kodzie **i uruchomionym obrazie** istnieje tryb `WORKER_PZU_LOGIN_TEST_RUN_ID`, który po uwierzytelnieniu PZU zatrzymuje wskazany run przed wyszukiwaniem REGON i przed Compensą. Wcześniejsze stwierdzenie z sekcji 8 o braku takiego mechanizmu było zbyt szerokie. Tryb ten obecnie nie jest włączony; bieżący Compose nie przekazuje tej zmiennej. Zwykły przebieg po uwierzytelnieniu kontynuuje pełny proces.

### Backup i dalszy krok

Kopia `.env.local` sprzed zmiany oraz poprzednie ustawienia admission i kolejki są w ACL-ograniczonym `.goldis-local-secrets/automation-activation-20261018-1792328164111/`. Wartości sekretów nie są zapisane w dokumentacji. Hash kopii środowiska sprzed zmiany: `7e3fbfc3c19823aff57e08ab4f3b15e503d41cfefaeae66ecb219a835544f09d`.

Następny krok jest zależny od żądanej przez operatora oceny flow logowania. Do tego czasu utrzymać globalną pauzę kolejki i wyłączenie admission. Po ocenie przygotować i dopuścić wyłącznie jeden uzgodniony run z panelu, sprawdzić jego identyfikator i kolejkę przed wznowieniem. Jeśli Everest wymusi SMS, pozostawić interwencję bez wpisywania kodu i bez żądania ponownego wysłania. Pełny odbiór L6 i przekazanie L7 pozostają niewykonane.

## 10. Włączenie działania i pierwsza próba z panelu — 18 października 2026

Operator zaakceptował cały przedstawiony flow i polecił: „pozwól automatyzacji na działanie w platformie”. Akceptacja zastępuje oczekiwanie na ocenę z sekcji 9. Nadal obowiązuje wcześniejsze ograniczenie: bez kodu SMS Everest i bez żądania ponownego wysłania kodu.

### Aktywacja

- Przed odblokowaniem ponownie potwierdzono brak oczekujących lub aktywnych zadań, brak submissionów oraz brak nierozliczonych dispatchy. Dwa wcześniejsze runy były `cancelled`.
- Wznowiono kolejkę `oc-verification` przez standardowe BullMQ `Queue.resume()` i odczytano `isPaused=false`.
- Przez uwierzytelnione API administratora, z CSRF i sprawdzeniem wersji, ustawiono `enabledForNewRuns=true`, pozostawiając limit `maxNewRunsPerHour=1`, strefę `Europe/Warsaw` i brak ograniczenia godzinowego. Aktualna wersja ustawień: `3`; zmiana potwierdzona ponownym GET. Czas potwierdzenia: `2026-10-18T13:08:06.028Z`.
- Worker pozostał `live`, konfiguracja `valid`, health `automationReady=true`. Flagi to `WORKER_LIVE_PORTALS=1`, `WORKER_START_PAUSED=0`; nie ma już globalnej pauzy kolejki.
- Praca pozostaje sekwencyjna (`concurrency=1`). Limit godzinowy dotyczy przyjmowania nowych runów, nie rozwiązuje blokady MFA już uruchomionego zadania.

### Jeden rzeczywisty przebieg

Użyto umiejętności `webapp-testing` i oddzielnej sesji przeglądarki skierowanej wyłącznie do lokalnego panelu 3000. Sesja użytkownika w przeglądarce aplikacji wygasła; istniejące dane administratora wykorzystano prywatnie do uwierzytelnienia lokalnej sesji. Po zakończeniu sesję techniczną wylogowano, a przeglądarkę zamknięto. Profil portalowy workera pozostał osobny.

W istniejącym formularzu „Kontrola pojedynczego wiersza” wpisano `18031` i jednokrotnie kliknięto „Sprawdź gotowość wiersza”. Nie uruchamiano zbiorczego zestawu ani lookupu rejestru. Zamknięta rewizja przygotowania importu była już dostępna.

| Pole | Wynik |
| --- | --- |
| Import | `45784330-03e0-4b03-af99-bcbc393b6c77` |
| Wiersz wejściowy i przedstawiciel runu | `18031` |
| Run | `42eda996-cf3c-4031-8c0d-056f611924e5` |
| Liczba wywołań formularza tworzenia runu | `1` |
| Odczyt `queued` | `2026-10-18T13:12:04.043Z` |
| Odczyt `pzu_login` | `2026-10-18T13:12:06.065Z` |
| Odczyt `waiting_for_sms` | `2026-10-18T13:12:16.216Z` |
| Interwencja | `kind=sms`, `portal=pzu`, `reasonCode=SMS_REQUIRED` |
| Wysłany kod / ponowny SMS | Nie / nie |
| XLSX | Niedostępny; pełny przebieg nie został zakończony |

Ścieżka panel → API → outbox → kolejka → główny worker → żądanie SMS PZU została zaobserwowana na rzeczywistym zadaniu. Nie potwierdzono uwierzytelnienia po SMS, wyszukania tożsamości, działania Compensy, UFG ani wyniku XLSX w głównej instalacji. Pełny odbiór L6 pozostaje częściowy; nie nadano statusu `LOKALNA_PRACA_POD_NADZOREM_ODEBRANA`.

Raport bez danych klienta zapisano prywatnie w `.goldis-local-secrets/automation-activation-20261018-1792328164111/single-run-18031.json`, a stan aktywacji w `activation.enabled.json`. Zrzut samej sekcji statusu, bez tabel danych klienta: `output/automation-18031-status-20261018.png`.

Pozostawić zadanie w obsłudze interwencji. Bez podania kodu challenge PZU ma w kodzie limit pięciu minut; po wygaśnięciu potrzebna jest jawna obsługa operatora. Nie ponawiać runu, formularza ani wysyłki kodu automatycznie. Przy ponownym uruchamianiu z panelu obowiązuje limit jednego nowego runu na godzinę.

## 11. Weryfikacja rozpoznania SMS — 18 października 2026

Operator zakwestionował, czy portal rzeczywiście wymagał SMS. Odczyt implementacji potwierdził lukę detektora: `PortalSession.readState()` oznaczał `waiting_for_sms` już po wykryciu jednej widocznej ramki `iframe#secfense_iframe`, bez sprawdzenia formularza wewnątrz ani metody uwierzytelniania. Wcześniejsze stwierdzenie o potwierdzonym żądaniu SMS było zbyt kategoryczne. Zaobserwowano detekcję ramki przez worker, a nie udokumentowany odczyt rzeczywistego formularza SMS.

### Dowody dotyczące próby 18031

- Run `42eda996-cf3c-4031-8c0d-056f611924e5` ma obecnie `waiting_for_manual_data`, `error_code=SMS_DELIVERY_UNCERTAIN`. Challenge PZU ma `status=invalidated`, `attempt_count=0`. Nie ma zewnętrznego numeru sprawy Compensy.
- Zdarzenie `sms_delivery_uncertain` zapisano `2026-10-18T13:16:48.688Z`; ważność challenge kończyła się `2026-10-18T13:17:15.027Z`. Przerwanie nastąpiło 26,339 sekundy przed terminem, więc nie przedstawiać go jako potwierdzonego zwykłego timeoutu. Bieżący zapis nie ustala przyczyny wewnętrznego przerwania.
- Nie zachowano DOM-u ani obrazu zawartości ramki portalowej z tego momentu. Zrzut panelu dowodzi wyłącznie statusu nadanego przez aplikację. Nie dowodzi dostarczenia SMS ani jego faktycznej konieczności.
- Nie ponowiono logowania, nie uruchomiono drugiego runu i nie żądano kolejnego kodu w ramach diagnostyki.

### Poprawka i kontrola

Detektor ramkowego MFA wymaga teraz jednego widocznego pola kodu i jednego widocznego przycisku zatwierdzenia wewnątrz ramki. Opcjonalny, walidowany `smsFramePath` pozwala sprawdzić rzeczywistą ścieżkę dokumentu ramki, rozróżniając ekran SMS od innej metody z podobnymi kontrolkami. Dla PZU przygotowano `/internalauth/authenticate/sms`, zgodnie z historycznym przechwyceniem w `config/pzu-sms.observed.json`. Nierozpoznana lub ładująca się ramka pozostaje `unknown`; nie powoduje wysłania formularza logowania widocznego za nią. Zmieniono również parser i generator konfiguracji, aby zachować tę ścieżkę.

Nowe lokalne testy odtworzyły problem na starym kodzie: fałszywy SMS dla TOTP, pustej ramki oraz ramki z jeszcze niewczytanym formularzem. Trzy testy nie przeszły przed poprawką. Po poprawce przeszły cztery nowe scenariusze, pozostałe testy sesji PZU/Compensy, parsera i generatora — łącznie 38 kontroli. Testy były syntetyczne, z przechwyconymi żądaniami do domeny testowej; nie logowały do portali.

Przygotowany prywatny plik `.goldis-local-secrets/portal-selectors-main-sms-detection-20261018.json` ma SHA-256 `90c4e051a71b7ce6548331a6d1088bb67e3acdadb1849c18388455c89528efcd`. Zmieniono wyłącznie parametr `pzu.session.smsFramePath`; numer rejestracyjny i pozostałe ustawienia są identyczne z potwierdzoną konfiguracją. Raport przygotowania: `sms-detection-config.json` w prywatnym katalogu aktywacji.

Zachowano poprzedni obraz jako `goldis-worker:sms-detection-rollback-20261018`. Poprawkę wdrożono w głównym workerze: obraz `sha256:07d748449b1a691e1184a7a69cbff83bbf9c034c948371c0c3e31d9e415c5409`, start kontenera `2026-10-18T13:34:17.957Z`. Zamontowany hash konfiguracji jest zgodny z przygotowanym wariantem `90c4e051a71b7ce6548331a6d1088bb67e3acdadb1849c18388455c89528efcd`, a parser zachowuje właściwy `smsFramePath`.

Przed odtworzeniem sprawdzono, że nie ma aktywnej pracy ani oczekujących dispatchy, i na czas podmiany wstrzymano kolejkę. Po kontroli kontenera wznowiono kolejkę; odczyt `2026-10-18T13:34:57.072Z` potwierdził `queuePaused=false` i zero zadań we wszystkich stanach. Admission pozostało `enabledForNewRuns=true`, limit `1/h`, wersja `3`. Health: worker `online`, portale `live`, konfiguracja `valid`, `automationReady=true`; kontener zdrowy. Nowy obraz nie zawiera `.goldis-local-secrets`, a kontrola procesów workera wykazała zero procesów Chromium — nie rozpoczęto kolejnego logowania.

Run 18031 nadal ma `waiting_for_manual_data / SMS_DELIVERY_UNCERTAIN`; liczba runów nie wzrosła. Nie zmieniano historii zdarzeń ani interwencji, nie przesłano kodu i nie żądano ponownej wysyłki. Kopia środowiska sprzed podmiany jest w prywatnym `env.before-sms-detection`, a dowody wdrożenia w `sms-detection-deployment.json` i `sms-detection-queue-restored.json` w katalogu aktywacji.

Pełne rozstrzygnięcie, czy poprzednia konkretna ramka zawierała rzeczywisty SMS, pozostaje niepotwierdzone; poprawka eliminuje odtworzone fałszywe alarmy dla przyszłych prób. Nie traktować `SMS_DELIVERY_UNCERTAIN` jako dowodu dostarczenia kodu ani nie naprawiać historii na podstawie przypuszczenia.

## 12. Usunięcie limitu godzinowego — 18 października 2026

Na jednoznaczne polecenie operatora usunięto tymczasowy limit jednego nowego runu na godzinę. Ustawienie `maxNewRunsPerHour=null` zapisano przez standardowe API administratora z kontrolą CSRF i wersji. Ponowny GET potwierdził brak limitu, `enabledForNewRuns=true` i wersję ustawień `4` o `2026-10-18T13:48:32.753Z`.

Nie trzeba czekać do wcześniej podanej godziny zwolnienia limitu. Sekwencyjne wykonanie workera pozostaje właściwością wykonawczą i nie stanowi godzinowego ograniczenia przyjęć. W ramach zmiany nie tworzono ani nie ponawiano runu. Dowód zapisano prywatnie w `hourly-limit-removed.json` w katalogu aktywacji.

## 13. Bezpośredni odczyt aktualnego ekranu i profilu workera — 18 października 2026

Operator poprosił o ustalenie, czy MFA jest rzeczywiste, z jakiej przeglądarki korzysta worker i czy zapamiętanie urządzenia pozwoli uniknąć SMS przy każdym przebiegu. Wykonano odczyt istniejącej strony w działającym workerze; nie otwierano nowej strony portalu, nie wpisywano loginu, hasła ani kodu, nie klikano ponownej wysyłki.

### Bieżące zadania

Po wcześniejszej poprawce detektora w platformie powstał run `e8ccd6c3-3947-4599-afd5-3191313f9471` dla wiersza `18001`, utworzony `2026-10-18T13:49:49.327Z`. Osiągnął `waiting_for_sms` o `13:49:51.888Z`, a następnie został anulowany o `13:50:07.687Z`. Challenge unieważniono z `attempt_count=0`. To run odrębny od wcześniejszego 18031; w ramach obecnej diagnostyki nie utworzono ani nie wznowiono żadnego zadania.

Run 18031 nadal ma otwartą interwencję `SMS_DELIVERY_UNCERTAIN` z wcześniejszej próby. Nie zmieniano ani nie zamykano tej historii na podstawie nowego odczytu.

### Potwierdzenie z aktualnie otwartej strony

Odczyt `2026-10-18T13:57:41.691Z` potwierdził:

| Element | Odczyt |
| --- | --- |
| Strona główna karty | `https://zaloguj.pzu.pl/my.policy` |
| Ramka | Jedna widoczna `iframe#secfense_iframe` |
| Rzeczywista domena i ścieżka ramki | `https://zaloguj.pzu.pl/internalauth/authenticate/sms` |
| Pole kodu | Jedno widoczne `input#code[name="code"][type="text"]` |
| Zatwierdzenie | Jeden widoczny `form:has(input#code) .buttons > button.btn.btn-primary` |
| Treść strony zawiera SMS | Tak; treści ani numeru telefonu nie zapisywano |
| Checkbox zapamiętania urządzenia | Widoczny, niezaznaczony |
| Uwierzytelniona wyszukiwarka Everest | Niewidoczna |

Tym razem jest bezpośredni dowód formularza SMS na stronie logowania PZU, a nie tylko wniosek z kontenera ramki. Nie ustalono odbiorcy wiadomości ani faktu jej dostarczenia. To uwierzytelnianie konta portalowego przed wyszukaniem klienta. Odczyt nie rozstrzyga historycznej zawartości ramki ze starszej próby 18031.

Diagnostyka odczytała wyłącznie metadane i widoczność kontrolek z istniejącej instancji Playwright. Tymczasowy interfejs diagnostyczny działał na loopback wewnątrz kontenera, nie był publikowany i został zamknięty po odczycie; plik pomocniczy z `/tmp` usunięto. Raport bez kodów, cookies, danych logowania, numeru telefonu i danych klienta znajduje się prywatnie w `pzu-current-frame-readonly.json` w katalogu aktywacji.

### Przeglądarka i zapamiętanie

- Działający worker używa Chromium `153.0.8010.12` z Playwright `1.63.0`, w Linuksie w Dockerze, `headless=1`, sandbox włączony. Nie ustawiono kanału Windows Chrome ani Edge.
- Profil `/home/pwuser/goldis-profile` jest montowany z trwałego wolumenu `goldis-local_worker_profile`. Istnieje baza cookies `Default/Cookies`; wartości cookies nie były odczytywane ani kopiowane. Profil pozostaje po odtworzeniu kontenera i jest ponownie używany przez `launchPersistentContext`.
- Sesja Chrome/Edge użytkownika w Windows i wcześniejsze oddzielne profile odbiorowe nie są tym profilem. Zapamiętanie jednej przeglądarki nie ustanawia zaufania do drugiej.
- Kod najpierw rozpoznaje istniejącą sesję; przy poprawnie uwierzytelnionym ekranie wyszukiwania nie wysyła ponownie loginu ani hasła. Checkbox zapamiętania PZU jest zaznaczany w obsłudze kodu dostarczonego przez operatora. Zapisane próby głównej instalacji nie zawierają skutecznie podanego kodu.
- Dokumentacja Secfense opisuje zaufanie do przeglądarki ustanawiane przy drugim składniku, konfigurowalny `Fingerprint TTL` i czas ważności cookies. Nie ustalono rzeczywistych wartości stosowanych przez PZU, więc nie obiecywać konkretnej liczby dni ani trwałego braku MFA. Źródło: https://docs.secfense.com/guides/configuring-local-applications/ (sekcja Other).

Oczekiwane dalsze sprawdzenie, kiedy operator będzie miał dostęp do właściwego drugiego składnika: jedno poprawne MFA z zapamiętaniem tego profilu, następnie kontrola ponownego użycia sesji oraz zachowania po restarcie. Nie wykonywano tego w obecnej diagnostyce. Nie potwierdzono jeszcze całego ciągu Everest → Compensa → UFG → XLSX w głównej instalacji.

## 14. Potwierdzenie możliwości wpisania SMS w platformie — 18 października 2026

Na prośbę operatora sprawdzono istniejącą obsługę formularza SMS. Test przeglądarkowy na aktualnie działającym webie `127.0.0.1:3000`, z pełnym przechwyceniem API na syntetyczne odpowiedzi, zakończył się `W3_SMS_UI_SMOKE_PASS`: **Sprawy wymagające uwagi → Wpisz kod → Kod weryfikacyjny → Przekaż kod** otwiera okno, przesyła kod z właściwym runem i CSRF, czyści pole oraz obsługuje wygaśnięcie. Kod wpisuje użytkownik, który uruchomił zadanie i ma dostęp do wykonania narzędzia.

Przeszły 32 testy API/challenge/odbiornika workera oraz 22 testy sesji PZU i detektora SMS w Chromium, bez pominięć. Potwierdzono na formularzu testowym wysłanie kodu do ramki PZU i zaznaczenie zapamiętania urządzenia. Rzeczywiste połączenie z kontenera API do workera i uwierzytelnienie usługi potwierdzono nieskutkującym zmianą stanu GET do nieistniejącej ścieżki odbiornika. Nie tworzono zadania, nie logowano do portalu, nie przesyłano kodu i nie żądano SMS.

Odczyt bazy `2026-10-18T14:11:14.878Z`: zero aktywnych, niewygasłych challenge. Stare zgłoszenia są unieważnione; wpisanie starego kodu nie jest możliwe. Formularz będzie dostępny przy nowym aktywnym żądaniu. Nie była potrzebna poprawka kodu aplikacji; to sprawdzenie istniejącego kanału i formularza. Potwierdzenie przekazania kodu do workera nie jest potwierdzeniem jego zaakceptowania przez PZU. Pierwsze rzeczywiste MFA i odbiór dalszego ciągu nadal pozostają do wykonania. Szczegóły operatora i zakres kontroli zapisano w sekcji 5 dokumentu flow.
