# Plan przebudowy backendu Goldis i weryfikacji jego działania

Data: 15 października 2026. Status: realizacja w toku. Stan wykonania i dowody testów są w [raporcie etapu](backend-refactor/phase-status-2026-10-15.md). Plan nie jest ukończony.

## 1. Cel i zakres

Przebudować backend do czytelnej struktury NestJS organizowanej według funkcji biznesowych. Każda funkcja ma własny moduł, jawny interfejs dla innych modułów, kontrolery, serwisy, DTO i testy obok kodu. Przebudowa obejmuje `apps/api`, backendowe procesy pomocnicze w tym pakiecie, `apps/worker`, odpowiednie kontrakty `packages/core` oraz skrypty uruchamiania, testowania i wdrażania.

W tym planie „feature-driven” oznacza organizację kodu według funkcji i odpowiedzialności biznesowych. Nie wprowadza dodatkowego procesu zarządzania projektem FDD.

Wynikiem mają być działające moduły z rozdzielonymi odpowiedzialnościami. Samo przeniesienie dużych plików do katalogów nie spełnia celu. Refaktor zachowuje dotychczasowe kontrakty HTTP, reguły produktu, strukturę danych i kolejki; każda uzasadniona zmiana zachowania otrzymuje osobne zadanie, test i opis.

Przyjęte decyzje:

- NestJS pozostaje frameworkiem API. Sequelize i Umzug pozostają warstwą dostępu do danych i migracji.
- Nie wprowadzać równocześnie Prisma, innego ORM, mikroserwisów, CQRS ani nowego brokera.
- Zachować osobne procesy API, parsera XLSX, portali Playwright i enrichment. Ich konfiguracja, uprawnienia i cykl życia pozostają odrębne.
- Przyjąć nazwy `*.controller.ts`, `*.service.ts`, `*.module.ts`, `*.dto.ts`, `*.repository.ts`, `*.spec.ts`, `*.http.spec.ts` i `*.integration.spec.ts`, stosownie do odpowiedzialności.
- Pozostawić runner `node:test`; rozszerzenie `.spec.ts` nie wymaga Jest. Najpierw zapewnić prawidłowe wyszukiwanie i uruchamianie testów.
- Wprowadzić granice modułów i dependency injection. Duże serwisy dzielić według operacji i odpowiedzialności, a repozytoria według rzeczywistych potrzeb dostępu do danych.
- Zmiany dotyczące uprawnień PostgreSQL prowadzić jako jawny etap bezpieczeństwa, z własną weryfikacją.

## 2. Fakty z aktualnego repozytorium

Odczyt wykonany podczas przygotowania planu; stan może zmienić się przed realizacją:

| Obszar | Stan zastany | Znaczenie dla przebudowy |
| --- | --- | --- |
| API | 180 plików bezpośrednio w `apps/api/src`, w tym 70 plików `.test.ts`; jedyny podkatalog na tym poziomie to `migrations` | Potrzebna pełna mapa własności plików i testów |
| Worker portali | 60 plików bezpośrednio w `apps/worker/src`, w tym 27 plików `.test.ts` | Osobny zakres porządkowania z testami fixture |
| AppModule | Centralna rejestracja kontrolerów, serwisów i globalnych zabezpieczeń w `apps/api/src/module.ts` | Przejście na importy modułów funkcjonalnych |
| Baza | `db.ts` ma około 1582 wierszy i tworzy obiekt Sequelize podczas importowania modułu | Rozdzielenie konfiguracji, rejestracji modeli i operacji na danych; usunięcie skutków ubocznych importu |
| Duże obszary | `admin.ts` około 1110 wierszy, `runs.ts` 842, `run-submissions.ts` 803, `business-leads.ts` 731 | Potrzebny podział obowiązków wewnątrz funkcji |
| Migracje | 61 plików, do `061-optional-run-contact-person.ts` | Weryfikować aktualny zestaw, nie historyczną stałą 051, 058 lub 060 |
| Testy API | `node --test dist/*.test.js` w `apps/api/package.json` | Obecne polecenie nie obejmie docelowej struktury i nazw |
| Runner modułowy | `scripts/test-module.cjs` zawiera jawne listy płaskich ścieżek testów | Każda relokacja wymaga aktualizacji manifestu |
| Punkty startowe | `main`, `migrate`, `apply-runtime-grants`, `bootstrap-admin-main`, `import-parser-main`, `import-parser-child`, `enrichment-worker`, `run-worker` | Trzeba zachować wszystkie sposoby uruchomienia, nie tylko HTTP |
| Git | 427 zmienionych lub nieśledzonych pozycji w momencie odczytu | HEAD nie jest pełnym punktem odniesienia dla obecnej aplikacji |

Źródła: [API AppModule](../apps/api/src/module.ts), [model bazy](../apps/api/src/db.ts), [skrypty API](../apps/api/package.json), [runner modułów](../scripts/test-module.cjs), [lokalny start](../scripts/Start-GoldisLocal.ps1).

Istotne ograniczenia dowodów:

- Raport [gotowości z 15.10.2026](AUDYT_GOTOWOSCI_DLA_KLIENTA_2026-10-15.md) opisuje historyczne PASS, FAIL i SKIP. Nie są one wynikiem uruchomienia testów dla niniejszego planu.
- Raport wymienia m.in. niezaliczone `security-db`, backup/restore i fixture Everest. Przygotowanie punktu odniesienia musi ustalić ich aktualny stan i przyczynę.
- Wcześniejszy odczyt lokalnej konfiguracji wskazywał użytkownika `goldis` w `.env.local`, a w działającym kontenerze rolę `goldis` z `rolsuper=true`. Porty tych profili były różne. Nie dowodzi to, z jakim kontem pracuje każda uruchomiona instancja API.
- Kod zawiera już obsługę rozdzielonych ról oraz kontrakt [praw runtime](DB_RUNTIME_PERMISSIONS.md). Trzeba zweryfikować faktyczne połączenia procesów i wdrożenie tych mechanizmów.

## 3. Docelowa struktura

Przykład pokazuje konwencję. Listę wszystkich plików ustali manifest migracji z etapu P0.

```text
apps/api/src/
  main.ts
  app.module.ts
  composition/
    persistence-models.ts
  infrastructure/
    config/
      config.module.ts
      runtime-config.service.ts
      runtime-config.service.spec.ts
    database/
      database.module.ts
      database.providers.ts
      database-lifecycle.service.ts
    redis/
    queue/
    storage/
    crypto/
    http/
  shared/
    types/
    errors/
    pagination/
    time/
  features/
    health/
      health.module.ts
      health.controller.ts
      health.service.ts
      health.http.spec.ts
    identity/
      identity.module.ts
      identity.service.ts
      identity.repository.ts
      persistence/
    auth/
      auth.module.ts
      auth.controller.ts
      auth.service.ts
      auth.service.spec.ts
      auth.http.spec.ts
      session.service.ts
      session.guard.ts
      dto/
    account-recovery/
    authorization/
    administration/
    teams/
    tools/
    audit/
    imports/
      imports.module.ts
      imports.controller.ts
      imports.service.ts
      imports.repository.ts
      imports.service.spec.ts
      imports.http.spec.ts
      imports.integration.spec.ts
      dto/
      persistence/
    preparations/
    grouping/
    review/
    enrichment/
    runs/
    submissions/
    interventions/
    results/
    leads/
    notifications/
    reporting/
    deletions/
  processes/
    enrichment/
    import-parser/
  migrations/                 # zachować ścieżkę i historyczne pliki
  migrate.ts                  # mały punkt startowy
  apply-runtime-grants.ts
  bootstrap-admin-main.ts
  import-parser-main.ts
  import-parser-child.ts
  enrichment-worker.ts

apps/worker/src/
  run-worker.ts               # mały punkt startowy
  application/
    worker-runtime.ts
    worker-runtime.spec.ts
  infrastructure/
    database/
    queue/
    browser/
    staging/
  features/
    execution/
    authentication/
    results/
    identity/
  portals/
    shared/
    pzu/
    compensa/
  testing/
    fixtures/

packages/core/src/
  contracts/
  domain/
  index.ts
```

Punkty startowe w katalogu głównym zachowują dotychczasowe ścieżki wynikowe `dist/*.js` używane przez Compose i PowerShell. Delegują do kodu funkcji lub procesów i nie przechowują reguł biznesowych. Dodatkowe zmiany nazw tych punktów startowych można wykonać dopiero w osobnym zadaniu obejmującym wszystkich konsumentów.

## 4. Reguły pisania i zależności

1. Kontroler odpowiada za transport HTTP: odebranie danych, powiązanie aktora z żądaniem, uruchomienie operacji i odpowiedź. Zapytania SQL, transakcje i złożone reguły biznesowe trafiają do serwisów oraz repozytoriów.
2. Serwis reprezentuje operację biznesową. Przyjmuje typowane wejście i kontekst użytkownika; nie przekazuje `Request` ani `Response` przez kolejne warstwy. Strumieniowanie plików jest obsługiwane na granicy HTTP.
3. Repozytorium zawiera SQL lub Sequelize i mapowanie danych. Serwis ustala granicę transakcji i przekazuje jej kontekst do współpracujących repozytoriów oraz zapisu audytu. Refaktor nie może rozbić dotychczasowego atomowego zapisu.
4. DTO rozróżniają dane transportowe od modeli bazy. Zachować istniejące reguły walidacji, odrzucanie dodatkowych pól, limity i kody błędów. Samo nazwanie typu `Dto` nie zapewnia walidacji danych w runtime.
5. Zależności wstrzykiwać przez Nest; zasoby procesowe tworzyć w providerach lub jawnych fabrykach. Unikać ręcznego `new Service()` w kontrolerach i odczytu zmiennych środowiskowych w przypadkowych funkcjach.
6. Czyste funkcje domenowe mogą pozostać funkcjami. Nie opakowywać każdej funkcji pomocniczej w serwis ani każdej tabeli w osobny moduł.
7. Moduł eksportuje tylko kontrakty potrzebne innym funkcjom. Importy do wewnętrznych plików innej funkcji podlegają kontroli architektury. Zależności transportowe nie mogą przechodzić z kontrolera do innego modułu.
8. `AppModule` składa aplikację przez `imports`. Globalne guardy, filtr i interceptor mają pojedynczą, świadomą rejestrację; nie rejestrować ich ponownie w każdym module.
9. Nie używać `forwardRef()` do rutynowego obchodzenia cykli. Cykl oznacza konieczność wydzielenia kontraktu, odczytu lub serwisu o niższej odpowiedzialności.
10. `shared` zawiera współdzielone typy i czyste narzędzia; `infrastructure` zawiera adaptery techniczne. Reguły SMS, grantów, eksportu i kasowania pozostają w funkcjach biznesowych.
11. `packages/core` przechowuje kontrakty i reguły używane przez wiele procesów. Nie importuje Nest, Sequelize, Playwright ani zmiennych środowiskowych.
12. Każdy feature ma jasną własność danych. Przekrojowe zapytania odczytowe, np. rozstrzyganie zakresu uprawnień i raporty, otrzymują jawny kontrakt projekcji i testy. Nie wymuszać zależności `AuthorizationModule -> RunsModule -> AuthorizationModule`.
13. Modele danych, tabele, kolumny i nazwy migracji nie zmieniają się w wyniku podziału plików. Zabronić `sync({ force: true })` i automatycznej przebudowy schematu przy starcie API.
14. Zachować parametryzację wartości SQL. Dynamiczne nazwy kolumn i kierunki sortowania muszą pochodzić z zamkniętych list. Przegląd bezpieczeństwa obejmuje także surowe zapytania w workerach.
15. Zasoby mają jawny cykl życia: inicjalizacja, readiness, zatrzymanie przyjmowania pracy, zwolnienie połączeń i zakończenie procesu.
16. Utrzymywać bieżące ustawienie TypeScript `strict`. Nowe wyjątki typu `any`, globalne wyciszenia reguł i szerokie `catch` wymagają konkretnego uzasadnienia w przeglądzie zmiany.

## 5. Mapa istniejącego kodu na funkcje

Tabela wyznacza własność najważniejszych grup. P0 musi przypisać wszystkie 110 nietestowych plików API i 33 nietestowe pliki workera, a także pliki testów i konsumentów skryptowych. Liczby należy odświeżyć przed startem.

| Docelowy obszar | Obecne źródła i odpowiedzialność |
| --- | --- |
| `infrastructure/config`, `infrastructure/http`, `health` | `runtime-startup-config`, `http-bootstrap`, `public-output`, `request-metadata`, `runtime-manifest`, `health*` |
| `infrastructure/database`, `composition`, modele funkcji | `db.ts`, rejestracja Sequelize, inicjalizacja modeli, zamykanie połączenia |
| `infrastructure/redis`, `infrastructure/queue` | Klienci techniczni; reguły dispatchu z `run-queue` pozostają własnością runs/submissions |
| `identity` | Modele i repozytoria użytkowników, tenantów, członkostw i sesji wyodrębnione z `db.ts` i `session.ts`; niski poziom zależności bez importowania kontrolerów auth lub administracji |
| `auth` | `session`, `password-change`, `password-hash`, `password-policy`, `login-rate-limiter`, `bootstrap-admin`; logowanie, sesje, zmiana hasła |
| `account-recovery` | `auth-recovery`, `account-recovery-tokens`, `recovery-email`, `auth-mail-*`, `resend-mail-provider`; tokeny, potwierdzenie adresu, outbox poczty |
| `authorization` | `authorization-policy`, `authorization-guard`, `resource-scope`, `request-protection`, `tool-access`; polityki i ochrona żądań |
| `administration`, `teams`, `tools` | Podział `admin.ts` na zarządzanie kontami, grantami i ustawieniami; `team.ts`; katalog narzędzi; `user-serialization`; jawna współpraca z identity/auth |
| `audit` | `audit.ts`, wyszukiwanie audytu z `admin-reports`; zapis przyjmuje kontekst transakcji i aktora, bez zależności od kontrolerów auth |
| `imports` | `imports`, `workbook`, `workbook-archive`, `import-parser-client`; import i korekty danych źródłowych |
| `processes/import-parser` | `import-parser-main`, `import-parser-child`; limitowany proces HTTP i dziecko parsujące XLSX |
| `preparations` | `import-preparations`, `preparation-analysis`, `preparation-export`, `preparation-workflows`; przygotowanie i rewizje zestawów |
| `grouping`, `review` | `entity-grouping`, `entity-grouping-service`, `canonical-run-service`, `review`, `review-service`, `portal-review-contract`; przyporządkowanie i rozstrzyganie konfliktów |
| `enrichment`, `processes/enrichment` | `enrichment-jobs`, `enrichment-worker*`, `registry-*`, `mf-vat-provider`, `gus-bir-provider`; kontrakty dostawców, limity, cache, kolejka i heartbeat |
| `runs` | `runs`, `run-evaluation`, `run-queue`, `worker-execution`; runy, zmiany stanu, lease, fencing, dispatch |
| `submissions` | `run-submissions`, `prepared-set-executions`; zlecenia zbiorcze, paczki, admission i pauzowanie zestawów |
| `interventions` | `auth-challenges`, `interventions`, `manual-data`, `manual-data-contract`, `sms-retry-policy`; SMS i obsługa ręczna |
| `results` | `worker-results`, `oc-snapshot-store`, `run-export*`, `export*`, `artifact-download*`; checkpointy, wyniki, finalizacja, pobieranie |
| `infrastructure/storage`, `infrastructure/crypto` | `private-artifact-store`, `artifact-crypto`, `pesel-crypto`, `canonical-json`; adaptery plików i szyfrowania, bez przenoszenia tu reguł uprawnień |
| `leads`, `notifications`, `reporting` | `business-leads`, `lead-result-snapshots`, `notifications`, `dashboard`, `contact-reports`, `history`; raporty administracyjne wyodrębnione z `admin-reports` |
| `deletions` | `deletions`, `deletion-jobs`, `deletion-barrier`, `deletion-journal*`, `deletion-restore`, `lead-import-deletion`; graf kasowania i odtwarzanie journal |
| `privileged-actions` w granicy bezpieczeństwa | `privileged-actions`, `deletion-step-up`; wspólny kontrakt potwierdzeń, adaptery operacji w odpowiednich funkcjach |
| Narzędzia wspólne | `list-query`, `warsaw-time`; po weryfikacji zależności czyste narzędzia w `shared` lub `core` |

Worker portali otrzymuje własną mapę:

- `application`: składanie procesu, obsługa sygnałów i readiness z `run-worker` oraz `api-readiness`.
- `features/execution`: `execution-lease`, `live-run`, `pipeline`, kontrakty `ports` i `ports.contract`.
- `features/authentication`: `auth-challenges`, `code-inbox` i koordynacja sesji portali.
- `features/identity`: reguły `identity`; dane `identity-fixtures` trafiają do zasobów testowych, po sprawdzeniu konsumentów.
- `features/results`: `oc`, `result-forwarder`, `result-staging-checkpoint`; `oc-fixtures` do zasobów testowych.
- `infrastructure`: `pg-run-repository`, `browser`, techniczny `result-staging`, połączenia i klienci.
- `portals/shared`: `portal-session`, `portal-action-gate`, `portal-action-pacer`, `portal-locator`, `portal-navigation`, `portal-runtime-config`.
- `portals/pzu`: `pzu-session`, `everest-identity-provider`.
- `portals/compensa`: `compensa-*`, w tym formularze, UFG, wybór klienta i checkpoint zapisu oferty.
- `index.ts`: zweryfikowane publiczne eksporty; bez uruchamiania procesu przy imporcie.

## 6. Etapy realizacji

Każdy etap ma osobny, czytelny diff i zapis wyniku testów. Etapy dotyczące funkcji mogą mieć kilka małych zmian. Nie przenosić kilku dużych domen w jednej zmianie bez osobnych punktów odbioru.

### P0 — Punkt odniesienia i pełna inwentaryzacja

- [x] Sprawdzić instrukcje repozytorium i aktualny Git status. Rozpoznać zmiany użytkownika, istniejące nieśledzone implementacje, migracje i artefakty.
- [x] Utrwalić odtwarzalny stan kodu obejmujący istotne pliki nieśledzone. Przejrzeć zawartość pod kątem sekretów i danych klientów; wykluczyć `.env`, profile, eksporty, staging i dane portalowe. Nie używać bezkrytycznego `git add .` ani resetu katalogu.
- [x] Utworzyć gałąź `codex/backend-feature-modules` z odtwarzalnego stanu. Przy użyciu worktree zapewnić, że zawiera ten sam punkt odniesienia; worktree utworzony wyłącznie z obecnego HEAD byłby niepełny.
- [x] Zapisać manifest: stary plik, nowy plik lub pliki, właściciel funkcji, publiczne eksporty, konsumenci, testy i etap. Każdy plik źródłowy ma przypisanie, także bez kontrolera HTTP. Bieżący `inventory.json` obejmuje 601 plików źródłowych i testowych, 130 tras API, zero nierozpoznanych właścicieli i zero kolizji proponowanych ścieżek; importy, eksporty i pokrycie testami opisuje manifest.
- [x] Zinwentaryzować wszystkie trasy z rzeczywistej aplikacji: metoda, ścieżka, status, DTO, cookies, nagłówki, guardy, uprawnienie i zakres danych. `route-contract-review.json` obejmuje 12/12 tras bez `SessionGuard` i 118/118 chronionych tras (130/130), a test sprawdza zgodność z inwentarzem. To przegląd źródeł z jawnymi lukami zachowania, nie dowód pełnego wykonania wszystkich tras.
- [x] Zinwentaryzować entrypointy, zadania cykliczne, timery, procesy potomne, kolejki, nazwy jobów, payloady, wersje kontraktów, lease i polityki ponowień. (Manifest `inventory.json` zawiera source-reviewed mapę 8 entrypointów i 9 pollerów/jobów wraz z konsumentami Compose/npm/PowerShell, wartościami retry/lease, payloadem kolejki i statusem dowodu runtime. BullMQ ma jawnie odnotowany payload bez numeru wersji; aktywne procesy wdrożenia nie były obserwowane.)
- [x] Zapisać graf importów i zależności funkcji; wyszukać importy powodujące odczyt env, tworzenie klientów, start timera lub procesu. Bieżący `inventory.json` rejestruje rozwiązywalne wewnętrzne krawędzie importów. Skan 368 plików API/workera znalazł 2 jawne kandydaty import-time w jednym pliku; oba są pod `require.main`. Skutki pośrednich importów i runtime są jawnie wskazane jako pozostała niepewność.
- [x] Utworzyć powtarzalne środowisko testowe z syntetycznymi danymi: tenant A/B, konta aktualnych ról, różne granty i przydziały. Jawne tryby DB tworzą własny oznakowany kontener i bazę; `teams-db`, `tenant-scope` oraz pozostałe smoke używają fikcyjnych tenantów i kont.
- [x] Uruchomić aktualne buildy oraz odpowiednie istniejące testy bez zmiany architektury. Zapisać wersje Node/npm/PostgreSQL/Redis/Chromium i identyfikatory obrazów. Zebrano Node 24.11.1, npm 11.6.2, PostgreSQL 17.11, Redis 7.4.9, Docker 29.2.0/Compose 5.0.2 i ID obrazów w raporcie etapu. Chromium nie znaleziono; 70 browser fixture pozostaje SKIP z jawnym warunkiem.
- [x] Każdy FAIL rozdzielić na błąd produktu, błąd testu, błąd runnera lub brak środowiska. Końcowe `npm test` i DB smoke nie mają nierozstrzygniętych FAIL; historyczne 70 SKIP ma zapisane warunki fixture i właściciela domknięcia.
- [x] Rozstrzygnąć historyczne problemy `security-db`, backup/restore i Everest na aktualnym kodzie. Ewentualne poprawki wykonać w oddzielnych zmianach z testem regresji.

**Odbiór P0:** da się odtworzyć całą ocenianą aplikację; manifest obejmuje cały zakres; istnieje aktualny raport PASS/FAIL/SKIP i znane są kryteria zachowania dla każdej trasy i procesu. Nierozstrzygnięte awarie krytycznych scenariuszy blokują migrację zależnego obszaru.

### P1 — Narzędzia testowe i reguły architektury

- [x] Wprowadzić kontrolowane, rekurencyjne wyszukiwanie skompilowanych testów `.test.js` i `.spec.js` na okres przejściowy.
- [x] Rozróżnić testy jednostkowe, HTTP, integracyjne i fixture. Utrzymać jawne listy scenariuszy wymagających PostgreSQL, Redis i przeglądarki; szeroki glob nie może przypadkiem uruchomić testów live.
- [x] Zaktualizować `scripts/test-module.cjs` i skrypty API/workera. Brak pliku z manifestu ma powodować FAIL; zero znalezionych testów również powoduje FAIL.
- [x] Dodać kompletną, stabilną mapę ID stary przypadek -> nowy przypadek i pilnować pokrycia scenariuszy po relokacji. Bieżący `test-scenarios.json` obejmuje 588 rzeczywistych przypadków w 177 plikach; parser rozpoznaje API `node:test`, a test porównuje oba kierunki mapowania z plikami źródłowymi. `runtime-test-scenarios.json` przechodzi kontrolę 1/1; warunki pominięcia są jawnie zapisane.
- [x] Zapewnić czyszczenie własnych katalogów `dist` przed buildem. Usuwanie weryfikuje absolutną ścieżkę i ogranicza się do artefaktów danego workspace. Chroni to przed pozornym PASS ze starych plików JS.
- [x] Skonfigurować kontrolę formatowania, lint i granic importów dla migrowanego kodu. Biome 2.5.15 obejmuje 292 pliki; format i lint przechodzą bez wyjątków. Kontrola granic importów/cykli pozostaje aktywna.
- [x] Dodać kontrolę cykli i regułę zabraniającą importów kontrolerów lub prywatnych plików innych funkcji.
- [x] Zdefiniować i podpiąć testy do CI. `.github/workflows/backend-checks.yml` uruchamia lint/format, `npm test`, pełny build oraz macierz DB przez oznakowany wrapper PowerShell. Lokalne fixture browser pozostają osobnym opt-in; GitHub Actions nie zostało jeszcze uruchomione zdalnie dla tej zmiany.

**Testy P1:** runner na zagnieżdżonej próbie, brakującym pliku, pustej liście i duplikacie; odtworzenie całego dotychczasowego zestawu; brak uruchomień live. **Odbiór:** zmiana ścieżki lub rozszerzenia testu nie może dać fałszywego zielonego wyniku.

### P2 — Konfiguracja, transport HTTP i pilotaż HealthModule

- [x] Utworzyć typowaną konfigurację dla każdego rodzaju procesu. Kontrolować wymagane sekrety i dopuszczalne role; nie logować wartości. API i worker mają snapshot startowy; typowane loadery obejmują też migrator, grants, bootstrap admina, enrichment worker i import parser. API rozdziela bezpieczne ustawienia od sekretów (w tym Redis i Resend) i ładuje konfigurację poczty oraz sekrety parsera z nieruchomych snapshotów. Sprawdzono wszystkie produkcyjne entrypointy; pozostałe bezpośrednie odczyty `process.env` są granicą ładowania konfiguracji, adapterem zgodności DB lub flagami testowymi.
- [x] Wyodrębnić techniczny bootstrap HTTP, publiczne błędy, nagłówki i limity; zachować kolejność middleware, prefix `/api`, trust proxy oraz osobny limit body dla wewnętrznego workera.
- [x] Przenieść health do `HealthModule`, rozdzielając kontroler od sond infrastruktury.
- [x] Sprawdzić importy modułów i pojedynczą rejestrację providerów. Przenieść testy pilotażowej funkcji do `.spec.ts` i zaktualizować wszystkie ścieżki konsumentów.
- [x] Uruchomić API z nowym HealthModule wewnątrz rzeczywistego AppModule na jednorazowym PostgreSQL i Redis, rolą `goldis_api`, z kontrolą `/api/health/live` i `/api/health/ready`; powtórzyć z niedostępnym Redisem i PostgreSQL (liveness 200, readiness 503 bez szczegółów infrastruktury). Wszystkie trzy warianty kończą się z zerem socketów aplikacji. Klient BullMQ jest tworzony dopiero przy pierwszym zadaniu, aby brak Redis/DB nie uruchamiał niepotrzebnego połączenia kolejki.

**Testy P2:** liveness/readiness przy działających i niedostępnych zależnościach; błędna konfiguracja; prefix, nagłówki, IP klienta, limity requestów i body; brak szczegółów infrastruktury w odpowiedzi publicznej. **Odbiór:** pierwsza kompletna funkcja wyznacza wzorzec kolejnych migracji.

### P3 — Połączenia, modele i transakcje

- [x] Zastąpić tworzenie Sequelize podczas importu fabryką i providerem `DatabaseModule`, z jawnym otwarciem i zamknięciem połączenia.
- [x] Zachować centralny rejestr modeli za adapterem i przenieść wszystkie 48 definicji do funkcji bez zmiany migracji. Modele są własnością `notifications` (1), `account-recovery` (2), `identity` (4), `tools` (3), `audit` (1), `imports` (8), `enrichment` (5), `grouping` (3), `runs` (6), `interventions` (4), `results` (5), `submissions` (3) i `leads` (3). `db.ts` zachowuje eksporty zgodności oraz leniwe proxy; nie definiuje już modeli. `composition/persistence-models.ts` ładuje bezpośrednie pliki modeli, rejestruje 44 dotychczasowe relacje i jednokrotnie wiąże registry.
- [x] Składanie definicji modeli umieścić w `composition/persistence-models.ts`. Techniczny DatabaseModule nie importuje całej aplikacji ani modułów HTTP.
- [x] Dopilnować jednokrotnej rejestracji modeli, nazw tabel/kolumn, indeksów, typów, nullability i relacji. Smoke potwierdza 48 modeli/595 mapowanych kolumn, dwie instancje Nest współdzielące jedno połączenie, 48 relacji Sequelize i dokładną zgodność katalogu po migracjach (58 tabel, 712 kolumn, 458 constraintów, 210 indeksów, 18 triggerów i 3 funkcje). [Kontrakt schematu](backend-refactor/schema-catalog-2026-10-16.json) jest sprawdzany przez każdy pełny smoke AppModule. Nie ma wcześniejszego schema-only dumpu z tego checkoutu, więc porównanie historycznej bazy sprzed refaktoru pozostaje osobną otwartą bramką.
- [x] Sprawdzić przekazywanie jawnego `Transaction` w operacjach DB i audycie. `npm run test:transaction-audit` analizuje 337 produkcyjnych plików TypeScript i 101 granic transakcji: w zagnieżdżonym scope wymaga opcji `transaction` dla bezpośrednich zapytań Sequelize/modeli i zapisu audytu oraz odrzuca niezależną transakcję Sequelize wewnątrz operacji. Aktualny wynik: zero naruszeń. Testy disposable DB dodatkowo potwierdzają rollback audytu dla Team, korekty review, run submission, enrichment, importu XLSX i tworzenia konta admina. Pełny rollback każdego wieloetapowego use case pozostaje częścią odbioru konkretnych feature’ów.
- [x] Przystosować CLI migracji, bootstrap administratora, runtime grants, enrichment i narzędzia offline do jawnego wyboru konfiguracji procesu. Migrator, grants i bootstrap pobierają typową konfigurację z rolą `goldis_migrator`; enrichment i parser mają własne allowlisty i walidację. Inwentaryzacja nie wykazała dodatkowego produkcyjnego narzędzia offline — pozostałe skrypty CLI są jawnie opt-in smoke/test harnessami.
- [x] Usunąć wymaganie `DATABASE_URL` przy samym imporcie czystych reguł i testów jednostkowych.
- [x] Porównać historyczną listę i treść migracji z bieżącą. Odzyskana wyłącznie odczytowo lokalna migawka sprzed refaktoru zawiera migracje 001–061; nazwy i kolejność są identyczne, a treść jest identyczna poza dostosowaną ścieżką importu w `058-preserved-lead-results.ts`. Migracja 062 jest jedyną nową.
- [ ] Porównać schema-only dump oraz dane z rzeczywistą bazą sprzed refaktoru i po zmianie. Brak kopii/dumpu tamtej bazy uniemożliwia potwierdzenie jej dokładnego katalogu i zachowania danych; snapshot z pustej bazy potwierdza działanie obecnego łańcucha, nie stan wcześniejszej instalacji.

**Testy P3:** unit bez DB/env; rzeczywista instancja Nest z DB; dwie izolowane instancje; commit/rollback między repozytoriami; kolejność inicjalizacji; zamykanie puli; migracje od pustej bazy i ponowny start. **Odbiór:** nie ma globalnego klienta tworzonego przy imporcie, a wszystkie procesy korzystają z właściwej fabryki i roli.

### P4 — Rzeczywiste uprawnienia PostgreSQL

- [ ] Ustalić aktywny profil, port i `current_user` dla API, migratora, portali i enrichment, przez ich rzeczywiste połączenia.
- [ ] Dla używanego lokalnego profilu zastosować istniejące mechanizmy podziału ról, po rozpoznaniu właściciela bazy, danych i sekretów. Rozbieżności między `.env.local` i Compose rozstrzygnąć jawnie.
- [x] Migracje i bootstrap uruchamiać rolą migratora; trwałe procesy odpowiednio `goldis_api`, `goldis_worker`, `goldis_enrichment`. Izolowany test runtime ról wykonał migracje i grants jako `goldis_migrator`, a osobne połączenia procesów potwierdziły `goldis_api`, `goldis_worker` i `goldis_enrichment`; produkcyjny Compose przeszedł migrację i bootstrap na syntetycznej bazie.
- [x] Sprawdzić faktyczne flagi ról, członkostwa, właścicieli obiektów, prawa `PUBLIC`, funkcji i schematu. `npm run test:module:runtime-roles` potwierdził 4 role `NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS/NOINHERIT`, brak dziedziczonych członkostw, brak DDL dla ról runtime oraz brak praw `PUBLIC` do bazy, schematu, tabel/sekwencji i funkcji; właścicielem bazy, schematu `public` i wszystkich obiektów aplikacyjnych jest `goldis_migrator`.
- [x] Uzupełnić zabezpieczenie startu API i obu workerów o kontrolę rzeczywistej roli i zabronionych uprawnień przez ich własne połączenie. Nadmiarowe prawa lub niemożność wykonania kontroli mają blokować gotowość procesu; nie zastępować tej kontroli porównaniem nazwy użytkownika w URL. (Kontrola API, workera portali i enrichment jest wpięta w start procesu; smoke czterech ról korzysta z adapterów Sequelize/pg Pool. Rzeczywisty start kompletnego AppModule w aktywnym profilu pozostaje osobną bramką.)
- [x] Utrzymać kontrakt `docker/postgres/apply-runtime-grants.sql` i istniejący smoke uprawnień. Uzupełnić asercje flag, członkostw i dostępu do uprzywilejowanych ról systemowych, jeśli aktualne testy mają luki.
- [x] Uruchomić rzeczywiste operacje aplikacji rolami runtime; wykryć brakujące granty bez nadawania szerokich praw jako obejścia. Disposable smoke potwierdza login/logout HTTP z sesją i audytem, import XLSX pod `goldis_api`, utworzenie pracy przez `POST /api/imports/:id/enrichment-jobs`, publikację dispatchu do BullMQ z payloadem ograniczonym do `runId`, checkpoint/event pod `goldis_worker` (w tym odmowę replay) oraz wykonanie zadania przez rzeczywisty `RegistryEnrichmentJobRunner` pod `goldis_enrichment`. Syntetyczny provider nie używa sieci; sprawdzenie obejmuje zakończony job, wynik `matched`, zmianę SourceRow, audyt enrichment i końcowy audit event. Smoke wykrył brak rejestracji `EnrichmentJobController` w AppModule; poprawiono i ponownie zaliczono test.
- [ ] Przypisać `current_user` do aktywnego lokalnego profilu API/workera przez jego rzeczywiste połączenie. Odczyt hosta wykazał wcześniej brak aktywnego procesu API i listenerów Goldis; ponownie sprawdzić przed domknięciem P4. Nie odczytywać ani nie zmieniać sekretów/profili.

**Testy P4:** `npm run test:module:runtime-roles` oraz `npm run test:module:app-module` PASS na disposable PostgreSQL/Redis i migracjach 001–062. Pierwszy test sprawdza flagi/członkostwa/ACL/właścicieli oraz sondy połączeń; drugi login/logout i import `goldis_api`, BullMQ dispatch, worker checkpoint oraz enrichment `goldis_enrichment`. Bazy i własne kontenery testowe usunięto przez harness. `current_user` aktywnej, używanej lokalnej instalacji nadal wymaga osobnego odczytu, gdy jej proces API działa. **Odbiór P4 pozostaje otwarty** do tego odczytu.

### P5 — Identity, auth i authorization

- [x] Wydzielić IdentityModule z operacjami kont, członkostw i sesji potrzebnymi auth; zachować jednokierunkowe zależności.
- [x] Rozdzielić `session.ts` na kontroler logowania, serwis auth, serwis sesji, repozytoria, guard i typy principal.
- [x] Przenieść hasła, zmianę hasła, unieważnianie sesji i limiter; zachować parametry scrypt, rewizje poświadczeń i brak wydłużania sesji przez sam polling.
- [x] Wydzielić AuthorizationModule z polityką, resolverem zakresu i ochroną żądań. Właściciela, tenanta i rolę ustalać z zaufanych źródeł, nie z body klienta.
- [x] Dla przekrojowego resolvera zasobów zdefiniować odczytową projekcję i repozytorium; wyeliminować zależność od kontrolerów i serwisów runów.
- [x] Zachować globalną ochronę Origin/CSRF, metadane uprawnień, kolejność guardów i ustalone odpowiedzi 401/403/404.

**Testy P5:** `test:module:auth` 72/72 i `test:module:security` 73/73 przeszły; AppModule smoke wykonuje HTTP login/logout z rzeczywistą sesją, wpisem audytu i cofnięciem sesji. Pełna macierz HTTP kontraktów oraz wszystkie awarie DB nie są jeszcze odebrane. Login/logout, błędne dane, bezczynność, rotacja, CSRF/Origin, limiter Redis i tenant/role są objęte istniejącymi testami. **Odbiór P5 pozostaje otwarty** do zakończenia brakujących kontraktów.

**Stan implementacji:** istnieją `IdentityModule`/`IdentityRepository`, `AuthModule` z `AuthController`, `AuthService`, `AuthenticationRepository`, `SessionService`, limiterem i guardem oraz `AuthorizationModule` z repozytorium zakresów. `session.ts` jest fasadą zgodności; kontroler i use case’y znajdują się w `features/auth`. Zachowano ochronę Origin/CSRF i dotychczasowe odpowiedzi. Testy auth/security, rzeczywistego loginu w disposable PostgreSQL i odmowy readiness przy niedostępnym Redisie przechodzą. Pełne pokrycie HTTP wszystkich tras i pełna macierz awarii DB pozostają bramką odbioru etapu.

### P6 — Odzyskiwanie konta, administracja, zespoły, narzędzia i audyt

- [x] Wyodrębnić AccountRecoveryModule oraz adapter poczty za istniejącym kontraktem dostawcy. Zachować szyfrowany outbox, TTL, jednorazowość i wiązanie tokenów z rewizją konta/adresu.
- [x] Rozdzielić `admin.ts` na kontrolery i serwisy kont, grantów oraz ustawień. Zbudować TeamsModule i ToolsModule z jawną granicą administracji i operacji zwykłego użytkownika. `AdminModule` rejestruje cztery kontrolery; konta/granty i narzędzia mają własne serwisy/repozytoria, a operacyjne odczyty SQL są w `AdminOperationsRepository`.
- [x] Wydzielić potwierdzenia operacji uprzywilejowanych. Zachować wiązanie z celem, payloadem, rewizją i idempotency key.
- [x] Wydzielić AuditModule; operacje biznesowe przekazują zaufany kontekst i transakcję do zapisu audytu. Moduł używa `AuditService`; recovery, auth, zespoły, konta/granty admina, narzędzia, interwencje i workflow przygotowania przekazują actor context oraz transakcję. Funkcja zgodności zostaje dla jeszcze niemigrowanych feature’ów.
- [x] Przenieść wyszukiwanie audytu i raporty administracyjne do właściwych modułów, z zachowaniem odrębnych uprawnień. Search, dashboard, historia i raport kontaktów należą teraz do `features/reports`; endpoint audytu nadal zachowuje osobną politykę `audit:read`.
- [x] Zachować możliwość odzyskania konta offline przez osobny punkt startowy i właściwą rolę DB.

**Stan implementacji:** `AccountRecoveryModule` z kontrolerem, serwisem i adapterem Resend jest w `features/account-recovery`; zachowano szyfrowany outbox i semantykę tokenów. Istnieją `TeamModule`, `ToolsModule`, `AuditModule`, `AdminModule` i `ReportsModule`; moduły są podpięte do `AppModule`. Trasy admina są rozdzielone na overview, użytkowników, narzędzia i operacje; odczyty operacyjne SQL mają repozytorium, a kontrolery nie wykonują zapytań. `AuditService` jest wstrzyknięty w operacje P6 i zachowuje transakcję. Testy DB i HTTP obejmują reset/verification, jednorazowy token, sesje, idempotentne tworzenie kont, scope tenanta, granty, rollback po błędzie audytu, paginację, ustawienia i operacje zespołu. **P6 jest lokalnie zaimplementowany i sprawdzony**; stare fasady API pozostają do usunięcia w P14.

**Testy P6:** równoległy reset i potwierdzenie adresu, retry outbox bez podwójnej wysyłki, wygasłe tokeny, unieważnianie sesji, ukrywanie istnienia konta, uprawnienia admin/manager/operator/reviewer/auditor, cofnięcie grantu i zmiana przydziału. Sprawdzić legalny i zabroniony zapis audytu oraz rollback operacji przy błędzie audytu. Poczta używa testowego adaptera. **Odbiór:** brak sekretów w serializacji i logach oraz brak niezamierzonej zmiany polityki produktu.

### P7 — Import XLSX, przygotowanie, grupowanie i review

- [x] Podzielić ImportController/ImportService/ImportsRepository i DTO; parser oraz operacje archiwum umieścić w jednoznacznych komponentach.
- [x] Zachować izolację parsera: sekret wewnętrzny, limity wejścia/wyjścia, timeout, ograniczenie równoległości i obsługę zakończenia procesu potomnego.
- [x] Wydzielić PreparationsModule z analizą, rewizjami, eksportem i workflow przygotowania. Moduł rejestruje oba kontrolery i serwisy; analiza, eksport oraz workflow mają pliki i testy `.spec.ts` w `features/preparations`. `EnrichmentModule` udostępnia workflow kontrakt zlecania jobów.
- [x] Wydzielić GroupingModule i ReviewModule. Jawnie ustalić własność canonical entities oraz operacji przejścia od korekty do gotowości runu.
- [x] Oddzielić surowe dane źródłowe od wartości zatwierdzonych i snapshotów. Zachować znaczenie `regonRaw` i wartości operacyjnej.

**Testy P7:** lokalne zestawy review/parser/preparation sprawdzają HTTP/timeout, limity ZIP/arkusza, workbook, DTO, analizę, logiczny workbook export, sesję/CSRF/role. Disposable PostgreSQL smoke dla AppModule importu potwierdza rollback batcha i wierszy po awarii audytu; testy workflow sprawdzają reanalysis/cancel. Serwisy preparation/workflow delegują persistence do repozytoriów. **Odbiór P7 nadal wymaga** pełnej macierzy rollbacku i konkurencji workflow na DB oraz porównania wszystkich wymaganych wariantów eksportu. Eksport jest sprawdzany logicznie (arkusze, wiersze, mapowanie), a nie hashem binarnym XLSX.

**Stan implementacji:** `ImportsModule` ma kontroler, serwis, repozytorium i DTO; parser pozostaje izolowanym procesem. `PreparationsModule` rejestruje import preparation oraz workflow, z kontrolerami, serwisami, DTO, analizą i eksportem. `GroupingModule` i `ReviewModule` są wydzielone, a korekty zachowują granicę transakcji/audytu. Serwisy preparation/workflow korzystają z repozytoriów; `prepared-set-executions.ts` należy do P9 zgodnie z mapą domeny. Pozostają pełna macierz rollbacku/konkurencji workflow na DB oraz odbiór wszystkich wariantów eksportu.

### P8 — Enrichment i jego osobny proces

**Stan implementacji:** `EnrichmentModule` rejestruje kontroler, serwis, repozytorium oraz kontrolowane fabryki providerów MF/GUS. Runner i jego persistence są w `features/enrichment`; pętla procesu jest w `processes/enrichment`, a `enrichment-worker.ts` pozostaje punktem startowym. Publiczny kontrakt serwisu jest używany przez przygotowania. Zachowano batching, request pacing, dzienny budżet, HMAC cache, klasy błędów, claim/heartbeat, restart i zachowanie wyłączonego providera.

- [x] Wydzielić EnrichmentModule: kontroler jobów, serwis zlecania, repozytoria, runner i adaptery MF/GUS.
- [x] Umieścić wspólny kontrakt providerów i bezpieczną fabrykę w tej funkcji. Zachować batchowanie, pacing, dzienne budżety, HMAC-cache i klasyfikację błędów.
- [x] Przenieść pętlę enrichment do `processes/enrichment`; entrypoint pozostaje mały i niezależny od startu HTTP API.
- [x] Zachować polling, heartbeat, claim zadań, zamykanie połączeń i zachowanie dostawcy wyłączonego.

**Testy P8:** testy providerów obejmują błędy, 429/Retry-After, timeouty, częściowe wyniki, batching i cache. Disposable PostgreSQL smoke obejmuje tenant/owner isolation, cofnięcie grantu przed i w trakcie lookup, wyłączenie konta, konkurujące workery, odzyskanie starego lease, brak zapisu ze starego workera, rollback audytu, restart/cache persistence, pacing i disabled provider. AppModule smoke uruchamia `RegistryEnrichmentJobRunner` pod `goldis_enrichment` z syntetycznym providerem, zapisuje wynik/audyt i nie wykonuje zewnętrznych wywołań. **P8 jest zaimplementowany i lokalnie sprawdzony**; nie jest to test produkcyjnych rejestrów.

### P9 — Runy, submission i wykonywanie zestawów

- [x] Podzielić start, odczyt, anulowanie, pauzę i wznowienie runu na use case’y; kontroler pozostaje cienki. Pause/resume deleguje `RunControlService`, a transakcyjne zapisy obsługuje `RunControlRepository`.
- [x] Oddzielić repozytoria runów i kolejki od reguł admission oraz harmonogramu. `RunSubmissionAdmissionService` zachowuje politykę i scheduler, a `RunSubmissionAdmissionRepository` obsługuje claim, blokady, odczyty oraz zapis admission; `PreparedSetExecutionRepository` i `PreparedSetExecutionControlRepository` przejęły persistence runnera i sterowania. Nazwy kolejek, jobów i payloady zachowano.
- [x] Wydzielić SubmissionsModule i operacje zestawów z `run-submissions.ts` i `prepared-set-executions.ts`. Kontrolery/serwisy i walidator wejścia są w `features/submissions`; stare ścieżki są fasadami zgodności.
- [x] Zachować atomowość zapisu runu/outbox/audytu, fencing token, lease i oczekiwaną rewizję sterowania. Kontrola transakcji nie wykrywa brakujących przekazań ani niezależnych transakcji zagnieżdżonych; DB smoke run-control potwierdza stale revision, idempotent replay, safe ACK, lease release oraz wyścig anulowania SMS.
- [x] Zdefiniować publiczne operacje między submissions a runs, z kontekstem transakcji. `SubmissionsModule` używa eksportowanego kontraktu `RunsModule`; nie ma cyklu modułów.

**Stan częściowy:** `RunsModule`, `RunController`, DTO sterowania oraz podział odczytu na `RunsReadService`/`RunsReadRepository` są w `features/runs`; kontroler deleguje operacje do serwisów. `RunAdmissionService` wydziela start, `RunDispatchService` obsługuje publikację/recovery outbox i lifecycle BullMQ, `RunCancellationService` z `RunCancellationRepository` realizuje anulowanie, `RunControlService`/`RunControlRepository` pause/resume z idempotencją, a `RunResumeService`/`RunResumeRepository` retry SMS i wznowienie po interwencji. `RunRecoveryService`/`RunRecoveryRepository` obsługują orphan recovery i result-only dispatchy. W submissions `RunSubmissionAdmissionService` przechowuje reguły admission i scheduler, a repozytoria admission, access, create, preview, read i cancellation wykonują persistence. `PreparedSetExecutionRepository` obsługuje start/odczyt, lease claim, chunkowanie, release i pracę runnera; `PreparedSetExecutionControlRepository` obsługuje sterowanie. Use case’y przekazują transakcję do integracji Leads/Notifications. Pozostaje pełny Playwright flow i odbiór scenariuszy współbieżności/retry na DB.

**Testy P9:** submission/DTO/module suite 5/5 i runs suite 20/20; tenant-scope disposable PostgreSQL sprawdza submission preview, fingerprint CAS, idempotencję, limit runów, cancellation, rollback audytu, odmowę admission po cofnięciu grantu oraz zestaw 1201 wierszy w chunkach 500/500/201, idempotent replay, pause/resume/cancel CAS i niezmienność wejścia workera. Run-control DB smoke sprawdza stale revision, replay, safe ACK, retry SMS, resume review, lease, recovery, eskalację do operatora i wyścig anulowania SMS. Po przeniesieniu persistence `npm run test:module:submission` przechodzi 5/5, a `npm run test:module:tenant-scope` przechodzi na disposable PostgreSQL (migracje 001–062; baza usunięta). AppModule smoke potwierdza kompozycję nowych providerów i zamknięcie zasobów. Nie uruchomiono pełnego Playwright platform flow. **Odbiór lokalnej części kodu:** use case’y i persistence są rozdzielone, a smoke DB potwierdza zachowanie CAS, idempotencji i chunkowania; przeglądarkowy end-to-end pozostaje otwarty.

### P10 — SMS, interwencje i dane ręczne

- [x] Wydzielić InterventionsModule: kontrolery, usługi SMS, wyzwania, ręczne dane i repozytoria. `AuthChallengeRepository` przejmuje zapytania, blokady, zapisy wyzwania/runu, zdarzenia i audyt; serwis zachowuje walidację oraz reguły workflow.
- [x] Zachować wiązanie wyzwania z runem, sesją przeglądarki, execution ID, inicjatorem i istniejącą polityką produktu.
- [x] Utrzymać retry limits, terminy ważności, claim/consume, lease i atomowość stanu interwencji.
- [x] Oddzielić klienta przekazania kodu do workera od logiki autoryzacji.

**Testy P10:** `npm run test:module:interventions` przechodzi 21/21, w tym aktor, termin, limit, jednorazowe przekazanie, brak kodu w zdarzeniach i fail-closed przy niepewnej dostawie. `npm run test:module:run-control` przechodzi na disposable PostgreSQL po ekstrakcji repozytorium; sprawdza retry SMS, anulowanie w trakcie claim, blokadę replay i resume. Smoke `migration-smoke.cjs` sprawdza równoległy claim, restart/invalidation, wygaśnięcie i brak kodu w persistent data/logach. **Odbiór P10:** kod nie trafia do logów, audytu ani odpowiedzi i nie jest używany ponownie.

**Stan implementacji:** `InterventionsModule` rejestruje kontrolery interwencji, SMS i ręcznych poprawek. `InterventionService` korzysta z `InterventionRepository`, `ManualDataService` z `ManualDataRepository`, a `AuthChallengeService` z `AuthChallengeRepository`. Repozytoria utrzymują transakcje, blokady, CAS oraz audyt; `WorkerCodeForwarder` pozostaje osobnym adapterem. `test:module:interventions` 21/21 i `test:module:run-control` wraz z disposable DB smoke przechodzą po ekstrakcji. Pełny front-to-back odbiór jest częścią P15.

### P11 — Wyniki, eksporty, leady, powiadomienia i raporty

**Stan implementacji:** `ResultsModule` ma kontroler checkpointów, `ResultsService`, repozytorium odczytu runu, persistence snapshotu, ocenę wyniku, finalizację i serwis/repozytorium pobierania artefaktów. Pliki snapshotu, ewaluacji i finalizacji są pod `features/results`; rootowe ścieżki eksportują je przez fasady zgodności. `LeadsModule` ma osobny kontroler, serwis i test modułu; Notifications ma repository/service, a dashboard, historia, kontaktowe raporty i przekrojowe projekcje należą do `ReportsModule`. Pobieranie pozostaje w publicznym kontrakcie Results, z tenant scope, tombstone, ścieżką wyliczaną z storage key i weryfikacją integralności. Test Results ma teraz 31 przypadków, a `test:module:reports` przechodzi disposable DB smoke dla dwóch tenantów, grantów, przydziałów, zwolnienia i historycznych wyników.

- [x] Wydzielić ResultsModule z przyjmowaniem checkpointów, snapshotami, finalizacją i pobieraniem artefaktów.
- [x] Rozdzielić uprawnienia do wyniku od adaptera plikowego i szyfrowania. Utrzymać zaufane źródło nazwy/ścieżki artefaktu oraz weryfikację integralności.
- [x] Wydzielić LeadsModule i operacje przydziału, zwolnienia, statusu kontaktu oraz zachowania historycznych wyników.
- [x] Wydzielić NotificationsModule oraz ReportingModule obejmujący dashboard, raporty kontaktów i odczyty historii. Polityka dostępu do audytu pozostaje odrębna.
- [x] Dla zapytań przekrojowych zdefiniować projekcje raportowe. Zachować zakres tenanta, aktualne reguły grantów, przydziałów, paginację i czas Europe/Warsaw.

**Testy P11:** `npm run test:module:results` 31/31 obejmuje integrity/encryption, utratę pliku i błędy zapisu/rename, export i download. `npm run test:module:leads` przechodzi HTTP i składanie modułu; `npm run test:module:reports` przechodzi disposable DB dla tenant A/B, filtrów, paginacji, grantów, alokacji, zwolnienia i zachowania wyniku. `npm run test:module:app-module` przechodzi po wpięciu `ResultsService` i struktury leads: role DB, HTTP import/login, enrichment runner, outbox, readiness awaryjne i shutdown bez socketów. **Odbiór lokalnej struktury P11:** PASS; pełny frontendowy E2E pozostaje częścią P15.

### P12 — Kasowanie, tombstones i odtwarzanie

- [x] Wydzielić DeletionsModule z preview, potwierdzeniem, runnerem, barierami oraz journal. Zachować kompletny graf zależności danych i plików.
- [x] Zapewnić wywołanie barier kasowania z runs, results, leadów i workerów przez mały kontrakt; unikać zależności całego modułu kasowania od wszystkich modułów operacyjnych.
- [x] Zachować kolejność trwałego journal, transakcji, usuwania plików i checkpointów. Refaktor nie może umożliwić odtworzenia usuniętych danych przez spóźnioną dostawę.
- [x] Utrzymać osobne narzędzie replay dziennika po odtworzeniu backupu i kontrolę admission przy starcie.

**Testy P12:** preview/confirm, stara rewizja, aktywny run, dostawa równoczesna z kasowaniem, awaria między DB a plikiem, ponowienie joba, restart po tombstone, restore starej kopii i replay journal. **Odbiór:** usunięte dane nie wracają, a częściowy błąd ma trwały i wznowalny stan.

**Stan lokalnej implementacji:** `DeletionsModule` składa preview, potwierdzenie joba, repozytoria, lifecycle runnera i adapter plików. `DeletionJobController` deleguje do `DeletionJobsService`; odczyt, atomowe utworzenie joba, tombstones, audyt, write-ahead journal oraz runner persistence są w `DeletionJobsRepository`. Bariera jest małym kontraktem `src/contracts/deletion-barrier.ts`, używanym przez runs, imports, results, leads, notifications i authorization bez importowania całego modułu deletions. Adapter bezpiecznego usuwania artefaktów ma osobny plik. `test:module:deletion-jobs` przechodzi 3/3; `test:module:deletion` przechodzi na disposable PostgreSQL z migracjami 001–062, obejmując idempotencję, tombstones, late-write barrier, błędy unlink/journal, wznowienie i replay starego snapshotu. Narzędzie `restore:deletion-journal` oraz admission przy starcie zachowują dotychczasową ścieżkę. **Odbiór lokalnego P12: PASS**; pełny odbiór całej przebudowy pozostaje w P15.

### P13 — Worker portali i wspólne kontrakty

- [x] Uporządkować workera według mapy z rozdziału 5. Rozdzielić składanie procesu, wykonanie zlecenia, adapter bazy, przeglądarkę i adaptery portali.
- [x] Zachować osobny proces Node/BullMQ/Playwright. Konwersja do Nest application context nie jest potrzebna do osiągnięcia struktury funkcjonalnej i wymagałaby osobnego uzasadnienia.
- [x] Przenieść czyste kontrakty API-worker do `packages/core`, po sprawdzeniu zgodności obu konsumentów. Zmiana struktury nie może zmienić znaczenia payloadu ani numeracji rewizji.
- [x] Usunąć uruchamianie workerów, timerów i połączeń przy imporcie pliku używanego w testach. Pozostawić jawny start procesu.
- [x] Zachować izolację profili i staging, allowlisty domen/nawigacji, pacing i sprawdzanie aktualnego lease przed akcją.
- [x] Zweryfikować SIGTERM/SIGINT: zatrzymanie przyjmowania pracy, zapis bezpiecznego stanu, zwolnienie zasobów i ograniczony czas zamknięcia.

**Testy P13:** fixture PZU/Everest/Compensa/UFG, wygasła sesja, SMS, utrata sieci, awaria przeglądarki, utrata lease, stale worker, wznowienie staging i ponowna dostawa wyniku. Testy przeglądarkowe pracują z lokalnymi fixture; wymagane scenariusze nie mogą pozostać SKIP. **Odbiór:** worker i API przechodzą wspólny przepływ z prawdziwą DB i Redis.

**Stan P13, 16.10.2026:** worker ma podział `application`, `features`, `infrastructure`, `portals` i `testing`; `dist/run-worker.js` pozostał cienkim launcherem. Typ i allowlista intentów dispatchu są wspólnym kontraktem `@goldis/core`. Zamknięcie procesu ma wspólny deadline 30 s i test kolejności cleanup. `test:module:worker-lifecycle` 7/7, `test:e2e:fixture` — Everest 9/9, Compensa 39/39, UFG 14/14 oraz security browser smoke. `test:module:app-module`, `run-control`, `results`, `interventions`, `sms` przechodzą. Izolowany scenariusz `test:automation-e2e` z `GOLDIS_TEST_DB_MODES=users` zaliczył wszystkie siedem wariantów przez HTTP, PostgreSQL, Redis/BullMQ, produkcyjny processor i lokalne fixture, z wysyłką portali zewnętrznych wyłączoną. **Odbiór P13: PASS lokalnie.**

### P14 — Integracja uruchomienia i usunięcie warstwy przejściowej

- [x] Uprościć `AppModule` do modułów i konfiguracji globalnej. Usunąć stare połączone pliki i tymczasowe re-eksporty, po aktualizacji wszystkich konsumentów.
- [x] Sprawdzić importy w `apps/api/scripts`, `apps/worker/scripts`, `scripts`, narzędziach offline i testach archiwalnych, które nadal są aktywne.
- [x] Zweryfikować lokalny PowerShell, Compose, Dockerfile, loader sekretów, healthchecki, migracje, bootstrap, parser i enrichment na czystym buildzie.
- [x] Zakończyć zmianę nazw testów na `.spec.ts`; usunąć obsługę starych nazw po potwierdzeniu mapy scenariuszy.
- [x] Uaktualnić instrukcję startu, architekturę, manifest funkcji, manifest wydania i procedurę rollbacku.

**Testy P14:** czysty checkout z utrwalonego stanu + `npm ci`, pełny build, kontrola architektury i brak starych artefaktów; rzeczywisty start każdego entrypointu w izolowanym stosie, z potwierdzeniem konta DB. **Odbiór:** aplikacja działa bez plików pozostałych po poprzednim układzie.

**Wykonanie lokalne, 16.10.2026:** przeniesienie i aktualizacja aktywnych ścieżek zostały sprawdzone przez pełny build, kontrolę architektury (272 pliki produkcyjne API, zero naruszeń i cykli), audyt transakcji (317 plików, 98 granic, zero błędów), testy release manifestu oraz testy uruchomieniowe API/workera. Wygenerowano ponownie inventory (593 pliki, 130 tras, zero nierozpoznanych właścicieli i kolizji), import-effects (354 plików, zero kandydatów) i scenariusze (186 plików, 609 przypadków). Izolowany snapshot bieżących źródeł, bez node_modules, lokalnych sekretów i artefaktów, przeszedł npm ci, pełny build i npm test; następnie obrazy API, workera, web i Redis uruchomiono w osobnym produkcyjnym Compose z syntetycznymi sekretami i pustą bazą. Role DB, migracje i bootstrap zakończyły się kodem 0; API, parser, enrichment, worker, web, Redis i PostgreSQL przeszły healthchecki; API readiness i web root zwróciły 200. Testowy projekt wraz z kontenerami, sieciami i wolumenami usunięto. Próba ujawniła CRLF w sześciu skryptach .sh; skrypty znormalizowano do LF i dodano .gitattributes (*.sh text eol=lf), po czym powtórny start przeszedł. npm run check:backend:style kończy się kodem 0, ale zgłasza 47 ostrzeżeń. Snapshot testowy nie zawierał metadanych Git, więc wykonania zdalnego CI nadal nie dowodzi; working tree pozostaje niecommitowany.

### P15 — Odbiór całej przebudowy i przygotowanie wydania

- [ ] Wykonać pełną macierz z rozdziałów 7–9, z dowodami i wersją kodu.
- [ ] Porównać kontrakty, schemat i zachowanie z P0; każda różnica ma wyjaśnienie i akceptowane zadanie.
- [ ] Sprawdzić aktualizację z kopii poprzedniego stanu, ponowny start i powrót do poprzednich obrazów na syntetycznych danych.
- [ ] Zamknąć wszystkie blokujące FAIL i wymagane SKIP. Odnotować otwarte ograniczenia zewnętrznych dostawców.
- [ ] Przygotować paczkę wydania: identyfikator kodu i obrazów, zgodne wersje API/workera/core, manifest migracji, konfiguracja bez sekretów, raport testów i instrukcja operatora.

**Odbiór P15:** spełniona definicja ukończenia z rozdziału 11. Wdrożenie na używaną instalację jest osobną operacją po zakończeniu odbioru.

**Wykonanie lokalne, 16.10.2026:** pełny npm run build oraz npm test przeszły: core 18/18, API 368/368, worker 115 PASS/70 SKIP w domyślnym przebiegu (te fixture zostały osobno uruchomione poniżej), manifest scenariuszy obejmuje 609 przypadków. Pełna macierz scripts/Test-GoldisDatabase.ps1 przeszła w 13 trybach na jednorazowych bazach; test:module:app-module oraz test:automation-e2e dla siedmiu scenariuszy przeszły z PostgreSQL, Redis/BullMQ i wyłączonymi portalami live. `npm run test:module:runtime-roles` dodatkowo zweryfikował właścicieli obiektów, ACL `PUBLIC`, flagi i członkostwa czterech ról na disposable PostgreSQL. `refs/stash` dostarczył pełną historyczną listę migracji 001–061; nazwy/kolejność zgadzają się z obecną, a treść różni się wyłącznie ścieżką importu w przeniesionej migracji 058. Migracja 062 jest nowa. Nadal brak dumpu i kopii danych z rzeczywistej bazy sprzed refaktoru, więc dokładne porównanie jej katalogu i zachowania danych pozostaje otwarte. npm run test:e2e:fixture zaliczył browser security smoke i fixture Everest 9/9, Compensa 39/39 oraz UFG 14/14 bez pominięć. Wszystkie 11 istniejących UI smoke testów Playwright przeszło na lokalnym Next.js z syntetycznymi odpowiedziami API; w tym checkpointcie brakowało realnego przepływu z API, który dodano w aktualizacji P15 poniżej. Izolowany snapshot przeszedł czyste npm ci, build i pełne npm test; produkcyjny Compose na jednorazowej bazie przeszedł wszystkie healthchecki, readiness API i root web zwróciły 200, a własne zasoby testu usunięto. W tym checkpointcie brakowało jeszcze realnego E2E istniejącego frontendu; późniejszy test browser→API opisano poniżej. Nadal otwarte są pełna macierz ról w UI, zdalne GitHub Actions i upgrade/rollback wobec potwierdzonej poprzedniej paczki. npm ci wykazał 7 umiarkowanych advisories zależności. Portali live nie testowano.

**Dodatkowa weryfikacja po naprawie grantów, 16.10.2026:** na izolowanym, jednorazowym stosie istniejący frontend Next.js przeszedł przez prawdziwe API i PostgreSQL: bootstrap-admin zalogował się (201), UI wymusiło zmianę hasła (201), widoki admin overview oraz operations summary zwróciły 200, logout wywołany z kontekstu przeglądarki zwrócił 201, a kolejny chroniony odczyt zwrócił 401. Cookie sesji miało `HttpOnly` i `SameSite=Strict`; nie było żądań do usług zewnętrznych ani błędów strony. Logout wywołano bezpośrednio przez endpoint API, ponieważ strona admina/dashboardu nie udostępniała kontrolki wylogowania. Test ujawnił brak `SELECT` dla roli `goldis_api` na `registry_provider_daily_budgets`; dodano tylko ten grant i regresję sprawdzającą, że API nie może tabeli aktualizować. `npm run test:module:runtime-roles` przeszedł na świeżej bazie, a ponowiony browser E2E zweryfikował operations summary 200. Testowy worker nie był uruchomiony, więc jego widget poprawnie zgłosił brak dostępności. To zamyka auth/admin smoke; pełny workflow importu i uruchomienia przez UI opisano w aktualizacji P15 poniżej.

## 7. Jak testować: przed, w trakcie i po przebudowie

Testy rozpoczynają się przed przenoszeniem kodu. Pozwala to rozdzielić istniejące błędy od regresji wprowadzonych przez refaktor.

| Poziom | Co rzeczywiście sprawdza | Środowisko | Kiedy |
| --- | --- | --- | --- |
| Architektura i build | Typy, poprawność importów, cykle, granice modułów, eksporty, brak nieaktywnych starych artefaktów | Czyste `dist`, przypięty lockfile | Każda zmiana |
| Jednostkowe `.spec.ts` | Reguły, przejścia stanu, walidacja, obsługa błędów i decyzje uprawnień | Kontrolowany zegar/ID; bez DB, Redis i sieci | Każdy migrowany feature |
| Składanie Nest | Widoczność i pojedyncze instancje providerów, import/export modułu, lifecycle | Rzeczywisty moduł funkcji i AppModule | Każda zmiana modułów/DI |
| HTTP `.http.spec.ts` | Routing, prefix, walidacja, guardy, nagłówki, cookies, limity, kody i odpowiedzi | Rzeczywisty bootstrap Nest; adaptery testowe albo jawnie DB | Każdy zmieniony kontroler i zabezpieczenie |
| Integracja PostgreSQL | SQL, ORM, constrainty, FK, transakcje, blokady, role, migracje | Jednorazowa PostgreSQL 17 z rzeczywistymi rolami | Każda zmiana repozytorium/modelu/transakcji i odbiór etapu |
| Integracja Redis/BullMQ | Limiter, ACL, publikacja, retry, deduplikacja, lease i odzyskiwanie | Jednorazowy Redis, osobne prefiksy i kolejki | Zmiany auth, kolejki i wykonania |
| Fixture przeglądarki | Zachowanie adapterów portali i mechaniki Playwright | Lokalna strona fixture + Chromium | Zmiany workerów i kontraktów |
| E2E backendu | API -> DB/outbox -> Redis -> worker -> checkpoint -> wynik/eksport | Cały izolowany stos; fixture portali i poczty/rejestrów | Po pionowych etapach i na końcu |
| Zgodność z frontendem | Rzeczywiste formularze, cookies/CSRF, polling i pobieranie | Istniejący Next.js + prawdziwe API/DB/Redis; syntetyczne dane | Po auth/import/run/results i finalnie |
| Bezpieczeństwo | Dostęp, tenant, SQL, sekrety, uprawnienia runtime, pliki i sieć | Połączenie przeglądu kodu i prób runtime | P4–P6 i finalnie |
| Niezawodność i wydajność | Restart, przerwana praca, brak wycieków i porównanie z punktem odniesienia | Kontrolowane awarie i stałe dane/zasoby | Przed odbiorem |
| Instalacja/upgrade/rollback | Działanie wydanej paczki i odzyskanie poprzedniej wersji | Nowe wolumeny oraz kopia syntetycznej poprzedniej instalacji | Finalnie |

Zasady pisania testów:

- Sprawdzać wynik biznesowy i skutki uboczne, a nie tylko liczbę wywołań prywatnej metody.
- Dla nowej granicy repozytorium używać atrap w unitach i rzeczywistego PostgreSQL w integracji. Zielona atrapa nie dowodzi poprawności SQL lub FK.
- Dla zabezpieczeń sprawdzać zarówno odmowę, jak i dozwolone działanie. Same testy 401/403 mogą przejść także wtedy, gdy cały endpoint jest zepsuty.
- Porównania przed/po normalizują wyłącznie zmienne pola: losowe ID, zegar i nieistotną kolejność. Nie normalizować zakresu danych, uprawnień i efektów zapisu.
- Zamrozić i opisać istniejącą politykę grantów/wspólnych wyników. Refaktor nie stanowi zgody na zmianę produktu.
- Rozdzielać błąd asercji od błędu produktu na podstawie kontraktu. Nie obniżać wymagań tylko po to, żeby uzyskać PASS.
- Raportować rzeczywiście uruchomione scenariusze. Test pominięty lub zatrzymany przed asercjami nie jest zaliczony.

## 8. Obowiązkowe scenariusze odbioru

| ID | Przepływ lub ryzyko | Oczekiwany wynik i dowód |
| --- | --- | --- |
| T01 | Świeża instalacja | Migracje 001–061 lub aktualny manifest, runtime grants, bootstrap, wszystkie procesy gotowe; ponowny start nie tworzy drugiego administratora |
| T02 | Aktualizacja istniejącej instalacji | Kopia syntetycznej bazy sprzed refaktoru zachowuje konta, identyfikatory, przydziały, historię, pliki i zaszyfrowane dane |
| T03 | Logowanie i sesje | Poprawne/błędne hasło, CSRF, wygaśnięcie bezczynności, polling bez aktywności, zmiana hasła i cofnięcie sesji zgodne z kontraktem |
| T04 | Dostęp do danych | Tenant A/B, role, własny/cudzy zasób, przydział, brak i cofnięcie grantu; oczekiwane 401/403/404 i brak wycieku danych |
| T05 | Administracja | Dozwolone zmiany kont/grantów/ustawień, potwierdzenia uprzywilejowane, rewizje, idempotencja, audyt i cofnięcie dostępu podczas pracy |
| T06 | Odzyskiwanie konta | Token jednorazowy, TTL, równoległe użycie, zmiana adresu i rewizji, unieważnienie sesji, testowy outbox bez realnej wysyłki |
| T07 | Import i przygotowanie | XLSX -> dane źródłowe -> korekty -> grupowanie -> gotowy zestaw; limity, izolacja parsera i poprawny rollback |
| T08 | Enrichment | MF/GUS fixture, batching, pacing, Retry-After, budżet dzienny, cache, częściowa awaria i restart joba |
| T09 | Start automatyzacji | Uprawniony start -> trwały outbox -> kolejka -> aktualny worker; powtórzenie żądania nie dubluje pracy |
| T10 | Sterowanie runem/zestawem | Pauza, ACK, resume i cancel; konflikt rewizji; równoległe polecenia; stan trwały po restarcie |
| T11 | SMS i ręczna interwencja | Właściwy aktor i sesja, TTL, claim/consume, retry, korekta; brak ponownego użycia kodu i brak sekretów w logach |
| T12 | Wynik i eksport | Snapshot -> finalizacja -> zaszyfrowany artefakt -> dozwolone pobranie; zgodna zawartość i odmowa obcego pobrania |
| T13 | Leady i raportowanie | Przydział, zwolnienie, historyczny wynik, status kontaktu, powiadomienie, filtry i liczniki z poprawną strefą czasu |
| T14 | Awaria workera | Kill/restart na granicach claim, przed/po akcji i przed/po zapisie; stary lease nie umożliwia zapisu lub kolejnej kontrolowanej akcji |
| T15 | Awaria DB/Redis/parsera | Kontrolowany błąd, brak przyjęcia niewykonalnej operacji, poprawna readiness i recovery po powrocie zależności |
| T16 | Awaria magazynu | Brak miejsca, brak uprawnień, uszkodzony plik, błąd rename i utrata odpowiedzi; stan pozwala na kontrolowane ponowienie |
| T17 | Kasowanie | Preview i potwierdzenie, wyścig z wynikiem, tombstone, restart joba; brak powrotu danych przez spóźnioną dostawę |
| T18 | Backup/restore | Dump i pliki czytelne; odtworzenie do kwarantanny; po replay journal usunięte dane nie wracają; klucze pozwalają czytać zachowane dane |
| T19 | Uprawnienia bazy | Każdy proces ma właściwy `current_user`; runtime nie ma superuser/DDL/uprzywilejowanych członkostw; legalny przepływ nadal działa |
| T20 | Bezpieczne SQL | Przegląd wszystkich dynamicznych zapytań i próbki wejść ze znakami SQL traktowane jako dane; brak zmiany zakresu zapytania; bez wykonywania poleceń systemowych |
| T21 | HTTP i pliki | Origin, CORS według istniejącej polityki, proxy, limity body, brak path traversal, brak downloadu `.env`, profilu lub staging przez publiczne HTTP |
| T22 | Uruchomienie i zamknięcie | Każdy entrypoint działa z czystej paczki; sygnał stop zwalnia porty, połączenia i przeglądarkę w ustalonym czasie |
| T23 | Stary frontend + nowy backend | Istniejący panel wykonuje login, import, start, interwencję, polling, pobranie i operacje ról z rzeczywistym API |
| T24 | Rollback wersji | Powrót zgodnego zestawu obrazów API/workera przy zachowanym schemacie i danych; brak odtwarzania starej bazy jako domyślnej metody rollbacku |

W T14 nie zakładać ogólnej gwarancji exactly-once dla akcji na obcym portalu. Awaria po wysłaniu żądania, a przed zapisaniem wyniku może wymagać uzgodnienia stanu lub interwencji. Odbiór wymaga wykrywania tego stanu i bezpiecznej obsługi ponowienia zgodnie z istniejącym kontraktem.

Testy portali produkcyjnych stanowią osobny, nadzorowany odbiór po fixture. Wymagają ustalonego konta, zakresu danych i dozwolonych operacji; ich brak zapisuje się jako otwarte ograniczenie odbioru integracji z portalem. Niniejszy plan nie uruchamia operacji live.

## 9. Istniejące polecenia i ich zastosowanie

Poniższe polecenia istnieją obecnie. Ich implementacje należy zaktualizować przy zmianie ścieżek, a wynik zawsze oceniać na aktualnym kodzie. Dokument nie uruchamiał tych poleceń.

| Kontrola | Obecne wejście | Uwaga |
| --- | --- | --- |
| Cały build | `npm run build` | Obejmuje core, API, worker i web; wcześniej wyczyścić własne artefakty |
| Regresja podstawowa | `npm test` | Nie zastępuje pełnej DB/Redis/przeglądarki; P0 zapewnia izolowaną konfigurację i identyfikuje SKIP |
| Moduły auth/security | `npm run test:module:auth`, `npm run test:module:security` | Aktualizować jawne ścieżki w `test-module.cjs` |
| DB migracje/uprawnienia | `npm run test:module:migrations`, `npm run test:module:security-db`, `npm run test:module:tenant-scope` | Sprawdzić faktyczną granicę dowodu; nie zakładać, że te moduły uruchamiają także smoke ról |
| Rzeczywiste role | `node apps/api/scripts/runtime-permissions-smoke.cjs` | Wymaga przygotowanej jednorazowej bazy i wszystkich czterech URL ról; migracje i grants przed testem |
| Konto i mail | `npm run test:module:password-recovery` | Testowy provider; brak prawdziwej wysyłki |
| Przygotowanie i zlecenia | `npm run test:module:review`, `npm run test:module:grouping`, `npm run test:module:submission`, `npm run test:module:run-control` | Poziom zależy od runnera; wypełnić brakujące integracje |
| Rejestry | `npm run test:module:registry`, `npm run test:module:registry-jobs` | Czyste testy providerów oraz DB jobów to różne dowody |
| Wyniki i SMS | `npm run test:module:results`, `npm run test:module:sms` | Dopilnować rzeczywistego procesu i trwałości poza atrapami |
| Leady i raporty | `npm run test:module:leads`, `npm run test:module:reports`, `npm run test:module:audit-reports` | Osobno testy zakresu danych i rzeczywistego SQL |
| Kasowanie/restore | `npm run test:module:deletion`, `npm run test:module:deletion-step-up`, `npm run test:module:backup-restore` | Historyczne problemy asercji wymagają rozstrzygnięcia przed uznaniem PASS |
| Redis | `npm run test:module:security-redis` | Jednorazowy Redis; rozszerzyć o kolejki i ACL, jeśli moduł ich nie pokrywa |
| Fixture portali | `npm run test:module:everest-browser`, `npm run test:module:compensa-browser`, `npm run test:module:ufg-browser` | Lokalne fixture, nie portale live |
| Zabezpieczenia panelu | `npm run test:module:security-browser` | Istniejący smoke może używać atrap API; uzupełnić realny przepływ |
| Składanie produkcyjne | `npm run validate:production-compose`, `npm run test:production-compose` | Walidacja konfiguracji nie zastępuje uruchomienia obrazów |
| Istniejący flow | `npm run test:platform-e2e`, `npm run test:automation-e2e` | Najpierw sprawdzić skrypt i wymagane flagi; nazwa nie gwarantuje pełnego E2E. Brakujące odcinki uzupełnić dedykowanym harness |

Dla komend wymagających DB użyć istniejącego mechanizmu tworzenia jednorazowych kontenerów, po jego przeglądzie. Sam `localhost` nie jest wystarczającą ochroną: test nie może wskazać lokalnej bazy klienta.

### Warunki środowiska testowego

- Osobny identyfikator przebiegu, nazwa bazy/Compose, etykieta właściciela kontenera, losowe porty loopback oraz osobne katalogi plików i profili.
- Osobna rola administracyjna wyłącznie do przygotowania testowej bazy; próby funkcjonalne działają kontami runtime.
- Kontenery, pliki i klucze testowe są tworzone przez harness. Sprzątanie dotyczy wyłącznie zasobów, których właściciela i ścieżkę harness zweryfikował.
- Domyślnie `WORKER_LIVE_PORTALS=0`, dostawcy rejestrów i poczty wyłączeni lub zastąpieni fixture; usunięte odziedziczone flagi testów live.
- Dane syntetyczne obejmują dozwolone i zabronione kombinacje ról, grantów, przydziałów oraz dwa tenanty. Nie kopiować danych klientów jako zwykłych fixture.
- Każdy test zamyka pulę, klienta Redis, kolejkę, serwer i przeglądarkę. Awaria testu nie może pozostawić procesu z dostępem do realnego portalu.

## 10. Wydajność, bezpieczeństwo, CI i dowody

### Wydajność i niezawodność

W P0 zapisać czas startu, RSS i liczbę połączeń dla każdego procesu, p50/p95 dla login/list/detail, czas importu i eksportu, liczbę zapytań SQL oraz throughput kolejki. Użyć stałego zestawu danych, tego samego sprzętu i konfiguracji; po rozgrzewce wykonać przynajmniej trzy porównywalne przebiegi.

Przed refaktorem ustalić tolerancje pomiarowe i limity pamięci/czasu. Proponowany próg do oceny to wzrost mediany p95 lub pamięci o ponad 10% przy małym rozrzucie punktu odniesienia; taki wynik wymaga analizy i uzasadnienia przed odbiorem. Nie traktować pojedynczego pomiaru na obciążonym komputerze jako dowodu regresji. Wykryć nowe N+1, wycieki połączeń oraz nadmiarowe instancje providerów.

Przeprowadzić serię uruchomień/zatrzymań oraz dłuższą próbę kolejki z restartami workerów. Sprawdzać liczby rekordów, stany końcowe, oczekujące outboxy, pliki osierocone i brak nieograniczonego wzrostu pamięci.

### Kontrole bezpieczeństwa

- Skan zależności, SAST kodu, skan obrazów i kontrola sekretów uzupełniają ręczny przegląd zmienianych granic autoryzacji, SQL i plików. Snyk można włączyć do tych kontroli, z uwzględnieniem zasad udostępniania kodu i metadanych zewnętrznej usłudze.
- Wyniki skanerów mają triage: podatny komponent, rzeczywista ścieżka użycia, możliwość aktualizacji, właściciel i termin. Skan bez zgłoszeń nie zastępuje T03–T06 i T19–T21.
- Zweryfikować logi błędów, audyt, odpowiedzi HTTP i artefakty testowe pod kątem tokenów, URL z hasłem, kodów SMS, kluczy oraz danych osobowych.
- Role runtime mają minimalne potrzebne uprawnienia. Testy SQLi nie uruchamiają poleceń systemowych i nie wymagają demonstracji RCE.

### Proponowane zadania CI

1. **Każda zmiana:** czysty build, lint/format, kontrola architektury, unit, HTTP z właściwą konfiguracją i kontrola kompletności manifestu testów.
2. **Zmiana funkcji korzystającej z danych:** dedykowane testy PostgreSQL/Redis, rzeczywiste role i jej scenariusze kontraktowe.
3. **Zmiana workera lub kontraktu API-worker:** fixture przeglądarki oraz E2E dla dotkniętego przepływu.
4. **Scalenie etapu i kandydat wydania:** pełna macierz, obrazy z czystego checkoutu, instalacja/upgrade, awarie, backup/restore i rollback.

Pełne zestawy nie muszą być powtarzane po każdej kosmetycznej zmianie. Zakres rośnie, gdy zmiana dotyka wspólnej infrastruktury, kontraktu lub wykryto nieprzewidziane zależności.

### Zawartość raportu etapu

- ID etapu i identyfikator odtwarzalnego kodu, wraz z opisem zmian względem P0.
- Lista przeniesionych odpowiedzialności i aktualna mapa plików/testów.
- Polecenia, wersje narzędzi, ID kontenerów i typ danych testowych, bez sekretów.
- Liczba wykonanych prób oraz PASS/FAIL/SKIP/BLOCKED z przyczynami i logami.
- Wynik porównania kontraktów HTTP, schematu, jobów i plików, jeśli etap ich dotyczy.
- Potwierdzenie uruchomienia odpowiednich procesów z właściwym `current_user`.
- Otwarte ryzyka i konkretne kryteria kolejnego etapu; osobna decyzja, czy etap spełnia odbiór.

## 11. Definicja ukończenia

- [ ] Każdy plik z manifestu P0 ma docelową lokalizację i właściciela albo udokumentowaną przyczynę usunięcia.
- [ ] Funkcje HTTP mają własne moduły; AppModule składa aplikację przez importy, a kontrolery wywołują typowane operacje serwisów.
- [ ] Logika biznesowa, persistence i adaptery techniczne są rozdzielone; nie ma zbiorczego `db.ts` z definicjami całej aplikacji i inicjalizacją przy imporcie.
- [ ] Nie ma nieuzasadnionych cykli, importów kontrolerów innych funkcji, stałych re-eksportów starej struktury i resztek starego builda.
- [ ] Wszystkie wymagane testy są wykrywane i uruchamiane z nowej struktury; dawne scenariusze mają pokrycie, a krytyczne nowe granice mają testy.
- [ ] Pełna macierz bezpieczeństwa, PostgreSQL/Redis, HTTP, fixture, E2E i awarii jest zaliczona; wymagane próby nie pozostają SKIP/BLOCKED.
- [ ] Schemat i dane z punktu odniesienia są zgodne, a migracje nie zostały przepisane ani ponumerowane ponownie.
- [ ] Konta runtime nie są superuserami i mają zweryfikowane prawa. Wszystkie legalne przepływy działają na tych kontach.
- [ ] Istniejący frontend działa z nowym backendem; potwierdzono kompletne przepływy, nie tylko atrapy API.
- [ ] Każdy proces startuje z czystej paczki i poprawnie się zamyka; lokalny start i Compose są sprawdzone.
- [ ] Wydajność i zasoby mieszczą się w ustalonych granicach; nie ma nowych N+1 i wycieków.
- [ ] Aktualizacja, backup/restore i rollback zostały odtworzone na izolowanym środowisku.
- [ ] Dokumentacja architektury, instrukcja startu i raport odbioru odpowiadają finalnemu kodowi.

Odbiór przebudowy i gotowość do publicznej produkcji to dwa osobne statusy. Otwarte bramki wdrożenia, integracji live lub polityki produktu z wcześniejszych audytów pozostają jawnie rozliczone.

## 12. Kolejność i sposób wycofania zmian

Zależności realizacyjne: **P0 -> P1 -> P2 -> P3 -> P4 -> P5 -> P6 -> P7 -> P8 -> P9 -> P10 -> P11 -> P12 -> P13 -> P14 -> P15**. Wcześniej wdrożony wzorzec modułu i persistence stosuje się do kolejnych funkcji. Nie przesuwać trudnych testów na sam koniec.

Po pilotażu P2/P3 oszacować rzeczywistą liczbę zmian i czas kolejnych etapów na podstawie liczby zależności, dużych plików i długości testów. Na etapie planu nie ma podstaw do obietnicy konkretnej liczby dni.

Każda zmiana ma być możliwa do cofnięcia bez usuwania danych. Dla problemu wykrytego podczas refaktoru zatrzymać migrację danej funkcji, odtworzyć przyczynę i cofnąć lub poprawić wyłącznie jej zmianę, zachowując pracę użytkownika. Unikać resetów całego repozytorium.

Dla kandydata wydania zachować poprzedni zgodny zestaw obrazów API, workerów i konfiguracji. Przed zmianą wersji zatrzymać przyjmowanie nowych zadań, osiągnąć bezpieczny stan workerów i zapisać rewizje/oczekujące zadania. Powrót obrazów musi respektować zgodność payloadów i schematu.

Backup jest zabezpieczeniem awaryjnym, a jego odtworzenie wymaga osobnej procedury. Nie odtwarzać automatycznie starej bazy w ramach zwykłego rollbacku kodu, ponieważ usunęłoby to nowsze operacje i mogłoby przywrócić dane objęte kasowaniem. Przy restore obowiązuje kwarantanna oraz replay deletion journal opisany w [procedurze wydania i rollbacku](RELEASE_AND_ROLLBACK.md).

## 13. Pierwszy pakiet prac do wykonania

1. Utrwalić bezpieczny punkt odniesienia bieżącego drzewa roboczego i utworzyć manifest migracji wszystkich plików.
2. Zarejestrować kontrakty HTTP/procesów i uruchomić aktualne testy w izolacji; rozstrzygnąć czerwone bramki.
3. Przygotować runner dla zagnieżdżonych `.spec.ts`, czysty build i kontrolę architektury.
4. Przeprowadzić pełny pilotaż HealthModule oraz konfiguracji i bootstrapu.
5. Przygotować adapter bazy i plan rozdzielenia modeli, potwierdzić transakcje i rzeczywiste role.

Ten pakiet daje sprawdzony wzorzec do przenoszenia kolejnych funkcji oraz pomiar kosztu i ryzyka dalszych etapów.

## Aktualizacja odbioru P15 — 16.10.2026

Zrealizowano i sprawdzono realny browser flow istniejącego Next.js przez prawdziwe API, PostgreSQL, Redis/BullMQ i produkcyjnego workera na fixture. `GOLDIS_TEST_DB_MODES=users npm run test:automation-e2e` PASS: login, upload syntetycznego XLSX, przygotowanie, start run, modal i przekazanie kodu SMS, polling do stanu końcowego, pobranie prawidłowego XLSX, admin operations summary oraz logout i odmowa po logout. Wszystkie siedem scenariuszy workera/API zaliczone. `modalUI=true`, żądania zewnętrzne 0, błędy strony 0; własne zasoby testu usunięte.

Formalny odbiór P15 pozostaje otwarty. Przeglądarkowa macierz potwierdza admina dozwolonego w pełnym flow oraz operatora, managera, reviewera i audytora odrzuconych w dostępie do funkcji admina (nawigacja, strona, API read i próba create); po każdej odmowie mutacji sprawdzono brak zapisu w PostgreSQL. Zbadano też audyt: operator otrzymuje 403, manager/reviewer/auditor 200, a reviewer widzi `run.created` tylko przy aktywnym `canViewResults`; próba startu runu na cudzym imporcie daje 404 dla operatora/managera i 403 dla reviewera/audytora bez rekordu w DB. Wspólna polityka ma teraz osobny test wszystkich 21 akcji dla pięciu ról, ale pozostałe akcje produktowe nie mają jeszcze pełnej macierzy HTTP/UI. Brakuje schema-only dumpu i kopii danych z historycznej bazy, przypisania `current_user` przy uruchomionym API w pierwotnym lokalnym profilu, porównywalnego baseline wydajności/pamięci, zdalnego workflow GitHub Actions dla commita oraz sprawdzenia rollbacku całej poprzedniej paczki. Osobny test migracji 061→062 zsyntetyzował użytkownika i członkostwo; upgrade, rollback migracji i ponowne zastosowanie zachowały rekordy bez zmian. Próba wyłącznie odczytowego `SELECT current_user` na `.env` nie połączyła się (`28P01`); `.env.local` wskazuje nieaktywny endpoint. Nie zmieniano haseł i nie uruchamiano aplikacji przeciw istniejącej bazie. Nie uruchomiono portali live ani wdrożenia.

### Uzupełnienie P15 — macierz UI ról dla funkcji admina, 16.10.2026

Ponowiony `GOLDIS_TEST_DB_MODES=users npm run test:automation-e2e` przeszedł z syntetycznymi kontami operatora, managera, reviewera i audytora w rzeczywistym Next.js → API → PostgreSQL. Każda rola zalogowała się formularzem; UI potwierdziło etykietę roli i dozwoloną nawigację, nie pokazało Administracji, odmówiło bezpośredniego wejścia do `/admin`, a endpoint admin read i próba `POST /api/admin/users` zwróciły 403. Zapytanie do bazy po każdej odmowie potwierdziło, że konto nie zostało utworzone. Admin zachował 200 dla operations summary; niezalogowany dostęp po logout zwrócił 401. Siedem scenariuszy workera/API zaliczone; żądania zewnętrzne 0, błędy przeglądarki 0. Harness usunął jednorazowe bazy, a testowy proces Next.js został zamknięty.

### Uzupełnienie P15 — audyt i odmowa startu runu, 16.10.2026

Ostatni `GOLDIS_TEST_DB_MODES=users npm run test:automation-e2e` PASS dodał sprawdzenie produktowej granicy narzędzia. Operator nie ma linku ani API audytu (403); manager, reviewer i auditor otwierają dziennik przez UI i dostają 200. Reviewer dostał wyłącznie grant `canViewResults` dla `oc-policy-verification`: widzi powiązane `run.created`, a odpowiedź nie zawiera zdarzeń konta. Próba startu runu na imporcie administratora została odrzucona: operator/manager 404 (ukrycie zasobu/grantu), reviewer/auditor 403 (brak uprawnienia); w każdym przypadku liczba runów w PostgreSQL pozostała bez zmian. Admin nadal uruchamia run 201. Wszystkie siedem scenariuszy workera/API zaliczone, żądania zewnętrzne 0, błędy strony 0, testowe bazy usunięte.

### Uzupełnienie P15 — pełna macierz polityki uprawnień, 16.10.2026

Test polityki przechodzi teraz po wszystkich 21 akcjach i pięciu rolach (admin, manager, operator, reviewer, auditor), sprawdzając zasób własny, innego właściciela w tym samym tenancie, inny tenant i brak tenanta aktora. Pełny `npm run test -w @goldis/api` PASS: 369/369, 0 pominięć; runner wykrył 139 plików zbudowanych testów. To bezpośredni dowód dla wspólnej polityki autoryzacji, ale nie zastępuje pełnej macierzy HTTP/UI wszystkich tras produktowych.

### Uzupełnienie P15 — porównanie kontraktu tras z migawką sprzed refaktoru, 16.10.2026

Z migawki oznaczonej `codex baseline before backend feature refactor 2026-10-15` (`refs/stash`, commit `9c188aecaa289644e7f1fcb04102aa668f1add60`) zapisano 84 wcześniejsze trasy w `docs/backend-refactor/legacy-http-contract.json`. `npm run test:http-contract` weryfikuje zgodność metody, ścieżki, statusu, dekoratorów wejścia i guardów: 84/84 zachowane bez różnic; bieżąca inwentaryzacja ma 130 tras i raportuje osobno 46 dodatkowych. Kontrola nie porównuje schematów JSON odpowiedzi ani semantyki payloadów. Została dołączona do `npm test`.

### Uzupełnienie P15 — pełny przebieg testów po aktualizacji harnessu, 16.10.2026

Po dodaniu testu macierzy polityki, porównania historycznego kontraktu tras i izolowanego wrappera upgrade/rollback migracji ponownie uruchomiono `npm run test:scenarios` (2/2 PASS) oraz pełne `npm test` (PASS, exit 0). Wyniki pakietów: core 18/18, API 369/369, worker 115 PASS/70 SKIP w domyślnym przebiegu. Architektura: 272 pliki produkcyjne API, zero naruszeń/cykli; audyt transakcji: 317 plików, 98 granic, zero naruszeń; historyczny kontrakt HTTP: 84/84 zachowane, 46 tras dodatkowych; manifest scenariuszy: 187 plików i 616 przypadków. 70 fixture workera pomijanych w domyślnym uruchomieniu przeszło osobny wcześniejszy przebieg fixture bez pominięć. Upgrade/rollback/reapply 061→062 również przeszedł osobno na disposable PostgreSQL; żadne testy nie użyły istniejącej lokalnej ani produkcyjnej bazy.
