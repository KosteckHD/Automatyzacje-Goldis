# Audyt persystencji, CORS i kontroli dostępu — 17.10.2026

Audyt dotyczy bieżącego drzewa roboczego Goldis, łącznie z zastaną refaktoryzacją backendu. Nie zmieniałem kodu aplikacji, konfiguracji ani danych użytkowych. Dodałem sondy i dowody. Identyfikator bazowego commita i sumy plików dowodowych zawiera [manifest](security/audit-2026-10-17/manifest.json).

**Wynik:** nie potwierdzono dostępu anonimowego do chronionych funkcji, przełamania granicy tenanta, eskalacji badanych ról, SQL injection ani nadmiarowych uprawnień kont runtime DB. Potwierdzono **dwie niespójności odczytu metadanych bez grantu do narzędzia**, odtworzone przez HTTP z rzeczywistym PostgreSQL. Obie dotyczą scenariusza dodatkowego narzędzia poza OC; seed obecnego systemu zawiera jedno narzędzie OC. To warunkowe problemy o średniej wadze, które należy zamknąć przed rozszerzeniem platformy o kolejne narzędzie.

Sukces istniejących testów nie wyklucza tych niespójności. Nie jest to certyfikat bezpieczeństwa wdrożenia produkcyjnego.

## Zakres i metodologia

- NestJS API, Sequelize/PostgreSQL, role i granty DB, migracje, transakcje, repozytoria, sesje, role aplikacyjne, listy, dashboard, interwencje, administracja, usuwanie i raporty.
- Przegląd granicy Next.js → API oraz konfiguracji Compose i przykładowego nginx.
- Wykorzystane wskazówki z biblioteki użytkownika: [testing-cors-misconfiguration](https://github.com/mukul975/anthropic-cybersecurity-skills/blob/main/skills/testing-cors-misconfiguration/SKILL.md) i [testing-api-for-broken-object-level-authorization](https://github.com/mukul975/anthropic-cybersecurity-skills/blob/main/skills/testing-api-for-broken-object-level-authorization/SKILL.md). Zastosowano inwentaryzację tras, podmianę identyfikatorów, kontekstów sesji i ról oraz sprawdzanie Origin i preflight. Nie instalowano całej biblioteki ani nie uruchamiano jej przykładowych exploitów.
- Nowe testy HTTP używają prawdziwych kontrolerów, guards i HTTP bootstrapu, syntetycznych adapterów sesji/storage oraz atrap usług biznesowych. Osobne testy DB używają rzeczywistych repozytoriów i usług. Zewnętrzne portale i dostawcy pozostawały wyłączone.
- Testy PostgreSQL wykonano na osobnych, tymczasowych klastrach PostgreSQL **18**, na losowych portach **127.0.0.1**, z danymi syntetycznymi. Bazy i klastry posprzątano po testach. Compose docelowo wskazuje PostgreSQL 17; zgodność z tą wersją wymaga odrębnego odbioru.

## Ustalenia wymagające poprawy

### SEC-01 — właściciel importu omija grant odczytu na liście

**Waga: średnia / P2, warunkowa dla narzędzia innego niż OC.**

**Endpoint potwierdzony:** `GET /api/imports?toolId=synthetic-confidential-tool`.

Predykat operatora w [resource-scope.ts](../apps/api/src/features/authorization/resource-scope.ts:21) dopuszcza rekord, gdy `b.owner_user_id = :userId`, niezależnie od `can_view_results`. Kontroler listy przechodzi bramkę `collection`, która nie wskazuje konkretnego narzędzia. Endpoint szczegółów weryfikuje grant narzędzia przez `PermissionGuard` i odmawia odczytu tego samego importu.

**Odtworzenie:** w izolowanej bazie utworzono aktywne syntetyczne narzędzie, operatora, własny import i brak grantu do tego narzędzia. Rzeczywiste `canAccessTool(..., "view_results")` zwróciło `false`.

| Żądanie tej samej sesji | Wynik |
|---|---|
| `GET /api/imports?toolId=synthetic-confidential-tool` | `200`; odpowiedź zawiera nazwę pliku importu |
| `GET /api/imports/:id` | `404`; usługa szczegółów nie została wywołana |

**Skutek:** właściciel nadal odczytuje identyfikator importu, nazwę pliku, liczniki i czas utworzenia po utracie prawa odczytu narzędzia. Nie wykazano w tym scenariuszu odczytu wierszy, eksportu, mutacji ani dostępu do innego tenanta. Nazwa pliku może ujawniać informacje biznesowe.

**Zalecenie:** w SQL wymagać uprawnienia do narzędzia niezależnie od warunku własności, zachowując świadomy wyjątek współdzielonych wyników OC. Ujednolicić politykę list i szczegółów. Ten sam helper wykorzystuje historia runów/wyników i kolejki review; sprawdzić te zastosowania podczas naprawy. Test odbiorczy: operator bez grantu nie dostaje metadanych dodatkowego narzędzia ani przez listę importów, ani historię, także po cofnięciu wcześniej posiadanego grantu.

### SEC-02 — dashboard odczytuje operacje narzędzia bez uprawnienia

**Waga: średnia / P2, warunkowa dla dodatkowego narzędzia.**

**Endpoint potwierdzony:** `GET /api/dashboard`.

[DashboardService](../apps/api/src/features/reports/dashboard.service.ts:16) uruchamia projekcję operacji po sprawdzeniu możliwości odczytu **OC**. Zapytanie [DashboardRepository.operations](../apps/api/src/features/reports/dashboard.repository.ts:38) ogranicza tenant i autora operacji, lecz nie ogranicza `tool_id` ani nie weryfikuje grantu dla każdego zwracanego narzędzia.

**Odtworzenie:** operator bez grantu do syntetycznego narzędzia miał własną operację i import tego narzędzia. Odczyt OC wynikał z istniejącej polityki współdzielenia. `GET /api/dashboard` zwrócił `200`; `tools[]` nie zawierało syntetycznego narzędzia, a `operations[]` zawierało jego identyfikator, nazwę pliku, status i metadane operacji.

**Skutek:** niespójne cofanie dostępu do metadanych operacji. Wykazano wyciek własnych metadanych w obrębie tego samego tenanta, bez uzyskania dostępu do szczegółów cudzych danych. Strukturalnie również `ownLeadMetrics` nie zawiera ograniczenia narzędzia; to miejsce do sprawdzenia przy naprawie, a nie osobno potwierdzony wyciek leadów.

**Zalecenie:** jeżeli dashboard obsługuje wyłącznie OC, dodać jawny filtr OC do odpowiednich projekcji. Jeżeli ma obejmować wiele narzędzi, stosować ograniczenie do narzędzi aktualnie czytelnych dla użytkownika przed agregacją, sortowaniem i `LIMIT`. Test odbiorczy: brak pozycji i liczników pochodzących z narzędzia bez uprawnienia, przy zachowaniu widoczności dozwolonych operacji.

Dowody obu ustaleń: [persistence-probes.json](security/audit-2026-10-17/persistence-probes.json), [log sond](security/audit-2026-10-17/persistence-probes.log), [kod odtworzenia](../scripts/security-persistence-audit-2026-10-17.cjs).

**Istotne ograniczenie oceny:** nie traktuję współdzielonego odczytu wyników OC przez operatora/menedżera jako luki. Tę regułę kod realizuje jawnie w `tool-access.ts` i `resource-scope.ts`. Problemy powyżej dotyczą dodatkowego narzędzia, dla którego taki wyjątek nie obowiązuje. Nie wykazano ich wykorzystania w istniejącej instalacji z jednym narzędziem OC.

## CORS i ochrona żądań

**Wynik badanego układu: poprawny.** Produkcyjny bootstrap ustawia [`cors: false`](../apps/api/src/composition/main.ts:16). Panel przekazuje `/api/*` przez [Next.js rewrite](../apps/web/next.config.ts:5), więc przeglądarka korzysta ze wspólnego originu.

Nowe sondy wykonały 18 sprawdzeń dla obcego originu, `null`, domeny z doklejonym sufiksem, subdomeny, zmiany HTTPS → HTTP i localhost:

- GET/OPTIONS nie zwracały `Access-Control-Allow-Origin` ani `Access-Control-Allow-Credentials` dla tych originów.
- Mutacje z tymi originami zwracały `403`.
- Istniejące testy potwierdziły wymaganie Origin, odrzucanie `Sec-Fetch-Site: cross-site` oraz brakującego/błędnego CSRF przy sesji cookie.

GET ze sztucznie podanym obcym Origin i poprawną sesją może zwrócić `200` w kliencie HTTP. Przy braku nagłówków zezwalających CORS nie oznacza to odczytu przez skrypt obcej witryny. CORS nie zastępuje kontroli sesji ani ról. Testowano odpowiedzi HTTP; nie wykonano nowego testu CORS w rzeczywistej przeglądarce.

Nie zalecam włączania `origin: *` ani automatycznego odbijania Origin. Przy przyszłym rozdzieleniu domen panelu i API trzeba zaprojektować jawny allowlist i ponownie odebrać sesje/CSRF.

## Autoryzacja endpointów i sesji

Inwentaryzacja obejmuje **130 tras**, z czego **119** ma ochronę sesji lub sekretu workera. Pozostałe to logowanie, wylogowanie, publiczne ścieżki odzyskiwania konta/statusu i health. Publiczność tych tras wynika z ich przeznaczenia; nie badano ich poprzez wpuszczenie atrapowych danych biznesowych.

Nowa macierz potwierdziła **1501 odmów** bez wejścia do atrap usług biznesowych:

| Zestaw | Sprawdzenia | Wynik |
|---|---:|---|
| 8 wariantów braku prawidłowej sesji/sekretu na 119 trasach | 952 | `401/403` |
| HEAD odpowiadające chronionym GET | 61 | `401/403` |
| Manager do tras wymagających wyższej roli | 26 | `403/404` |
| Operator do niedozwolonych funkcji | 45 | `403/404` |
| Reviewer do niedozwolonych funkcji | 68 | `403/404` |
| Auditor do niedozwolonych funkcji | 91 | `403/404` |
| Obcy tenant: po 43 ścieżki zasobowe dla 5 ról, także admina | 215 | `404` |
| Obcy właściciel zasobu dodatkowego narzędzia: operator | 43 | `403/404` |

Warianty obejmowały pustą/uszkodzoną cookie, zmieniony podpis, wygasły token, nieistniejącą/cofniętą sesję, legacy token bez rejestru sesji i fałszywe nagłówki tożsamości. Kontrola dodatnia: dozwolony odczyt importu zwrócił `200` i trafił do usługi; po unieważnieniu sesji zwrócił `401`.

Ta macierz potwierdza działanie kontrolerów/guards w opisanych kontekstach. Nie jest kompletnym testem wszystkich dodatnich przepływów usług ani wszystkich kombinacji przydziałów, grantów i stanów procesów. Testy usług i smokes DB uzupełniają ją m.in. o zarządzanie zespołem, step-up usuwania, przydziały leadów i izolację agregacji raportów. Sam brak `PermissionGuard` na kontrolerze nie jest dowodem luki: część funkcji sprawdza role i zakres w usługach.

Dowody: [macierz i inwentarz tras](security/audit-2026-10-17/http-boundaries.json), [kod sond HTTP](../scripts/security-boundary-audit-2026-10-17.cjs).

## Persystencja i dostęp do bazy

**Potwierdzone na izolowanym PostgreSQL:**

- Migracje do 062 oraz stabilne ponowne uruchomienie; przejście 061 → 062 z zachowaniem danych, rollback i ponowne zastosowanie.
- Izolacja tenantów w encjach kanonicznych, powiązaniach, konfliktach i raportach; odmowa powiązania niewłaściwego tenanta.
- Scenariusze zapisów z audytem i rollbackiem oraz trwałość idempotencji przydziałów leadów i usuwania.
- Dziennik usuwania, tombstone, odrzucanie późnych zapisów, ukrycie usuwanego importu/runu i wznowienie po częściowym postępie.
- Dedykowane konta `goldis_api`, `goldis_worker`, `goldis_enrichment`, `goldis_migrator`; role runtime bez superusera, tworzenia baz/ról, bypass RLS, dziedziczenia i członkostw. Sprawdzone dozwolone i zabronione operacje oraz zapis checkpointu workera z rzeczywistej ograniczonej roli.
- Właścicielstwo schematu/relacji/funkcji po stronie migratora i brak badanych grantów PUBLIC. Logi `audit_events`/`run_events` mają dla API SELECT/INSERT, bez UPDATE/DELETE.

**Injection:** przeglądane zapytania wykorzystują `bind`, `replacements`, API Sequelize oraz stałe fragmenty SQL. Nie znalazłem potwierdzonego przepływu niezweryfikowanego wejścia użytkownika do składni SQL. Dodatkowa sonda rzeczywistego repozytorium z filtrem `x' OR 1=1--` zwróciła zero wierszy; wartość pozostała parametrem. Nie jest to wyczerpujące fuzzowanie każdego parametru.

**Zakres gwarancji transakcji:** statyczny audyt zgłosił 96 granic transakcyjnych bez wykrytych brakujących przekazań transakcji i bez zagnieżdżeń w badanym zakresie. To heurystyka, nie dowód pełnej atomowości. Testy DB dodatkowo potwierdziły rollback aplikacyjnych operacji po błędzie audytu/dziennika; nowa sonda potwierdziła rollback wcześniejszego INSERT po wymuszonym błędzie transakcji.

**Granica bezpieczeństwa DB:** jedno konto API celowo ma szerokie prawa DML do tabel domenowych. Role użytkowników i tenanty ogranicza aplikacja. Nie wdrożono polityk RLS jako dodatkowej granicy między tenantami. Nie jest to wykazany bypass; przejęcie konta API lub przyszły błąd SQL może jednak objąć wszystkie dane dostępne temu kontu. Zachować ograniczenia sieciowe i rozdział sekretów, a przed rozbudową modelu wielotenantowego rozważyć RLS jako osobny projekt.

**Konfiguracja sieci:** bazowy Compose nie publikuje portów PostgreSQL/Redis; wariant lokalny publikuje je na loopback. Przykładowy nginx blokuje `/api/internal/` i nadpisuje nagłówki przekazywania adresu klienta. Nie sprawdzano działającego serwera VPS, firewalla ani konfiguracji TLS PostgreSQL poza lokalnym testem. Nie należy utożsamiać poprawnego pliku Compose z potwierdzonym brakiem ekspozycji w docelowej sieci.

**Konfiguracja lokalna wymaga uporządkowania:** zapisane `.env` i `.env.local` wskazują starą tożsamość DB `goldis`; `.env.acceptance.local` ma rozdzielone role. Bieżący entrypoint API oczekuje `goldis_api` i odrzuci niezgodną tożsamość przed rozpoczęciem nasłuchu. Jedna próba odczytu metadanych przez lokalny adres z `.env` została odrzucona przez PostgreSQL (`28P01`); nie pobrano danych aplikacyjnych. Nie naprawiano konfiguracji ani nie podejmowano kolejnych prób hasła. To problem uruchomieniowy, nie dowód nieautoryzowanego dostępu.

## Wykonane sprawdzenia

| Sprawdzenie | Wynik / dowód |
|---|---|
| Build API i core | PASS |
| Wszystkie testy API | **376/376**, 0 pominiętych — [log](security/audit-2026-10-17/api-tests.log) |
| Macierz HTTP | **1501 odmów**, kontrola dodatnia `200`, cofnięta sesja `401` |
| CORS/Origin | **18 sprawdzeń** — w JSON macierzy HTTP |
| DB: users, tenant-scope, runtime-roles | PASS — [log](security/audit-2026-10-17/security-db.log) |
| DB: reports, deletion, upgrade-061-062 | PASS — [log](security/audit-2026-10-17/db-smokes.log) |
| Nowe sondy DB/HTTP | SEC-01 i SEC-02 odtworzone, sonda SQLi odparta, rollback PASS |
| Statyczny audyt transakcji | PASS — [log](security/audit-2026-10-17/transactions.log) |
| Granice architektury | PASS w ramach istniejących wyjątków — [log](security/audit-2026-10-17/architecture.log) |

Pierwszy przebieg nowych sond zatrzymał się na błędnym hashu w syntetycznym fixture, odrzuconym przez constraint DB. Poprawiono wyłącznie fixture, używając rzeczywistego hashowania; ponowny przebieg samych sond przeszedł. Zestawy reports/deletion/upgrade przeszły już przed tym błędem fixture. Dla przejrzystości zachowano [pierwotny log](security/audit-2026-10-17/initial-fixture-run.log).

Odtworzenie po zbudowaniu API:

```powershell
npm run build -w @goldis/api
node scripts/run-node-tests.cjs apps/api/dist
node scripts/security-boundary-audit-2026-10-17.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Test-GoldisDatabase.ps1 -NativePostgres -Module security-db
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Invoke-SecurityPersistenceAudit-2026-10-17.ps1
```

Wrapper PostgreSQL wymaga lokalnych binariów PostgreSQL; domyślnie `C:\Program Files\PostgreSQL\18\bin`. Parametr `-PostgresBin` pozwala wybrać inną instalację, a `-ProbesOnly` uruchamia same nowe sondy. Sondy zapisują wyniki do katalogu tego audytu. Ich sukces oznacza odtworzenie opisanego obecnego zachowania; przed użyciem jako bramki CI trzeba odwrócić asercje ujawnienia danych po naprawieniu SEC-01/02.

## Ograniczenia i kolejność domknięcia

1. Naprawić SEC-01 i SEC-02, dodać trwałe testy odmowy dla dodatkowego narzędzia bez grantu oraz kontroli po cofnięciu grantu. Sprawdzić współdzielone helpery list i liczników; zachować uzgodnione współdzielenie OC.
2. Uporządkować używane lokalnie pliki środowiska i odebrać start z rozdzielonymi rolami, bez zastępowania kont runtime administratorem DB.
3. Wykonać odbiór na docelowym PostgreSQL 17 oraz Redis i uruchomionym całym `AppModule` z rzeczywistymi zależnościami. Docker/Redis były niedostępne w tym przebiegu; testy Redis i całego procesu AppModule nie zostały ponownie wykonane.
4. Na docelowym środowisku sprawdzić HTTPS, reverse proxy, zewnętrzną niedostępność DB/Redis/API wewnętrznego i zachowanie przeglądarki. Nie wykonano testu produkcyjnego VPS, portali, wydajności, cold restore ani audytu zależności npm.

Audyt dostarcza bieżące dowody wskazanych granic bezpieczeństwa. Ograniczenia środowiska i dwa warunkowe problemy pozostają jawne; nie oznaczono ich jako naprawionych.
