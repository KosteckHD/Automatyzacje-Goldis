# Plan napraw luk po pentestach Goldis

Data: **17.10.2026**. Status: **SEC-01 i SEC-02 wdrożone; PT12-04 rozstrzygnięty poprawionym testem fixture; pełny odbiór środowiskowy pozostaje otwarty**. Szczegóły i dowody: [raport implementacji](security/remediation-2026-10-17/IMPLEMENTATION_REPORT.md).

Punkt wyjścia: [raport pentestu](security/pentest-2026-10-17/PENTEST_REPORT.md), [macierz 80 scenariuszy](security/pentest-2026-10-17/scenarios.json) i [audyt persystencji i kontroli dostępu](AUDYT_PERSYSTENCJI_I_KONTROLI_DOSTEPU_2026-10-17.md). Wynik dotychczasowego przebiegu: 17 PASS, 3 FAIL, 9 BLOCKED i 51 INCONCLUSIVE. Są to statusy scenariuszy, a nie liczby podatności. Metodykę testów zachować zgodną z [planem pentestów](PLAN_PENTESTOW_CALEJ_APLIKACJI_2026-10-17.md), w tym wskazaną tam rewizją biblioteki cybersecurity skills.

## 1. Cel i zakres

Zamknąć dwa potwierdzone wycieki metadanych SEC-01/SEC-02, rozstrzygnąć przyczynę niezaliczonego testu popupu PT12-04 i przygotować brakujące środowisko do dalszego odbioru. Każda naprawa ma mieć test wykazujący błąd przed zmianą i poprawne zachowanie po zmianie.

Zachować obecne współdzielenie wyników OC przez operatora/managera, granicę tenanta, zasady administratora i dostęp do zachowanych leadów wynikający z niezależnego snapshotu. Wyjątki autora runu i obsługi SMS mają osobne kontrakty; nie mogą być zastępowane ogólnym wyjątkiem własności importu.

51 nierozstrzygniętych scenariuszy jest zakresem dalszej weryfikacji. Zmiany w implementacji wynikające z nich wprowadzać dopiero po potwierdzeniu konkretnego błędu albo po jawnej decyzji o dodatkowym zabezpieczeniu. Dla obecnych dwóch wycieków nie ma wykazanej potrzeby migracji schematu ani wdrażania RLS.

## 2. Priorytety i kolejność

| Etap | Zakres | Priorytet | Warunek zakończenia |
|---|---|---|---|
| A | Kontrakt uprawnień i regresje SEC-01/02 | P2, przed uruchomieniem kolejnego narzędzia | Testy wykazują wycieki i mają dodatnią kontrolę |
| B | SEC-01: listy, historia, zastosowania wspólnego predykatu | P2 | Brak ujawnienia bez prawa odczytu, także po cofnięciu grantu |
| C | SEC-02: projekcje dashboardu | P2 | Dashboard OC nie zwraca operacji innego narzędzia ani ich pochodnych |
| D | PT12-04: wiarygodny test popupu i ewentualna naprawa | Triage w pierwszej kolejności; wpływ ustalić z dowodu | Znana przyczyna i deterministycznie poprawna kontrola dalszych działań |
| E | PostgreSQL 17, Redis, HTTPS/proxy i dalsze testy | Warunek pełnego odbioru | Brakujące granice sprawdzone dynamicznie |
| F | Zależności, sekrety, obrazy i CI | Według potwierdzonego wpływu | Każdy kandydat ma decyzję i dowód |

Etapy B i C wdrażać po A. Etap D można opracować niezależnie. Odbiór końcowy zależy od E; brak środowiska nie oznacza zaliczenia testu.

## 3. Etap A — kontrakt i testy przed naprawą

### 3.1. Utrwalić badaną wersję

- Zapisać commit, zastany diff i wersje komponentów. Repozytorium ma istniejące zmiany refaktoryzacji, których nie wolno resetować podczas naprawy.
- Utworzyć nowy katalog dowodów retestu z własnym manifestem. Zachować pierwotny raport i logi pentestu jako historię; nie nadpisywać wyników z dnia wykrycia.
- Bazę zasilać jako migrator, żądania aplikacyjne wykonywać pod ograniczoną tożsamością API. PostgreSQL 18 może służyć pomocniczo; końcowy odbiór wykonać na docelowym PostgreSQL 17.

### 3.2. Ujednolicić znaczenie odczytu

Dla nieuprzywilejowanego odczytu stosować łącznie: zgodny tenant, zakres roli do zasobu i prawo odczytu danego narzędzia. Własność rekordu nie zastępuje `view_results` dla narzędzia spoza OC.

| Aktor / stan | Oczekiwanie dla importu narzędzia innego niż OC |
|---|---|
| Operator, własny import, brak grantu albo grant cofnięty | Brak rekordu na liście; szczegół pozostaje ukryty |
| Operator, własny import, samo discover lub execute | Brak odczytu metadanych wynikowych |
| Operator, własny import i view_results | Rekord widoczny, o ile stan narzędzia i pozostałe reguły pozwalają |
| Operator, cudzy import i view_results | Grant nie rozszerza samodzielnie zakresu roli; zachować kontrakt szczegółu i sprawdzić zgodność listy |
| Manager/reviewer | Zakres tenanta oraz właściwe prawo narzędzia i roli |
| Auditor | Dostęp do audytu zgodnie z rolą; bez nadawania dostępu do importów |
| Admin | Zachować obecny wyjątek administracyjny w obrębie własnego tenanta |
| Dowolny aktor, obcy tenant | Brak odczytu niezależnie od identyfikatora/grantu |

Stany `available`, `maintenance`, `disabled` oraz wyjątek historycznych wyników OC sprawdzić względem `toolAccessFromRecords` i guardów. Uprawnienia execute/download nie mogą przypadkiem stać się prawem do każdej projekcji. Ewentualne rozbieżności polityk udokumentować przed ich ujednoliceniem.

### 3.3. Poprawne regresje

Istniejący [security-persistence-audit-2026-10-17.cjs](../scripts/security-persistence-audit-2026-10-17.cjs) celowo zalicza przebieg, gdy wyciek występuje. Nie używać jego zielonego wyniku jako akceptacji naprawy.

Dodać osobny test regresyjny w module raportów/DB, wykorzystując syntetyczne fixture z sondy. Dla odmowy oczekiwać pustej listy bez nazwy pliku, UUID i kursora pochodzącego z ukrytych danych; dla dozwolonej kontroli oczekiwać konkretnego rekordu. Testować brak grantu i jego cofnięcie po wcześniejszym poprawnym odczycie, z zachowaniem tej samej sesji.

## 4. Etap B — SEC-01: uszczelnienie list i historii

### Miejsca implementacji

- [authorization/resource-scope.ts](../apps/api/src/features/authorization/resource-scope.ts): `operationalCollectionScope`.
- [authorization/tool-access.ts](../apps/api/src/features/authorization/tool-access.ts): punkt odniesienia dla zdolności narzędzia.
- [reports/history.repository.ts](../apps/api/src/features/reports/history.repository.ts): importy, runy i wyniki.
- [reports/history.service.ts](../apps/api/src/features/reports/history.service.ts): serializacja, `limit + 1`, kursor.
- [review/review.repository.ts](../apps/api/src/features/review/review.repository.ts): dwa dalsze zastosowania wspólnego predykatu.

### Zmiana

1. Usunąć obejście wynikające z alternatywy `owner OR grant` dla odczytu prywatnego narzędzia. Dla własnego importu operatora wymagane jest również prawo narzędzia. Zachować udokumentowaną gałąź współdzielenia OC.
2. Utrzymać warunek tenanta na każdej gałęzi alternatywy. Scope roli i capability narzędzia mają być oceniane łącznie; refaktoryzacja nie może poszerzyć zakresu operatora na cudze zasoby.
3. Stosować ograniczenie w SQL przed obliczeniem liczników, sortowaniem, `LIMIT` i kursorem. Filtrowanie gotowej tablicy w usłudze nie stanowi naprawy.
4. Sprawdzać bieżący grant w bazie; stara sesja, zapamiętany filtr lub poprawnie podpisany kursor nie upoważniają do cofniętego odczytu. Awaria rozstrzygnięcia uprawnień ma kończyć się kontrolowanym błędem, bez szerokiego fallbacku.
5. Sprawdzić wszystkie zastosowania helpera w historii i review. Jeśli zasób wymaga odmiennego zakresu, nadać mu jawny kontrakt zamiast dopisywać szeroki wyjątek do wspólnej funkcji.

### Kryteria odbioru

- `GET /api/imports?toolId=<private-tool>` dla operatora bez view_results zwraca pusty dozwolony wynik kolekcji; szczegół nadal zwraca 404.
- Brak UUID, nazwy pliku, czasu utworzenia, liczników i kursora wynikających z niedozwolonych rekordów, także bez filtra toolId.
- Cofnięcie grantu blokuje następny nowy odczyt tą samą sesją i starym kursorem.
- Dozwolone rekordy wypełniają stronę zgodnie z limitem mimo wielu ukrytych rekordów nowszych od nich.
- Pozytywne scenariusze OC, administratora, review i obcego tenanta zachowują uzgodnioną politykę.

## 5. Etap C — SEC-02: spójny zakres dashboardu

### Miejsca implementacji

- [reports/dashboard.service.ts](../apps/api/src/features/reports/dashboard.service.ts).
- [reports/dashboard.repository.ts](../apps/api/src/features/reports/dashboard.repository.ts).
- [reports/dashboard.repository.spec.ts](../apps/api/src/features/reports/dashboard.repository.spec.ts) oraz integracyjny test HTTP z DB.

### Wybrany zakres naprawy

Obecna usługa warunkuje operacje dostępem do OC, a licznik operacji już filtruje OC. Najmniejszą spójną zmianą jest **jawnie OC-owy zakres projekcji operacji dashboardu**. Dodać filtr narzędzia w zapytaniu `operations`, przed grupowaniem i `LIMIT 8`. Dzięki temu `operations`, `actionRequired` i liczniki operacji opisują ten sam zbiór.

Nie rozszerzać tej naprawy automatycznie do dashboardu wielonarzędziowego. Jeśli taki produkt będzie potrzebny, osobny etap musi przekazywać aktualny zakres dozwolonych narzędzi do każdej projekcji przed agregacją; pusty zakres ma oznaczać brak wyników.

Osobno przejrzeć `ownLeadMetrics`, `teamLeadMetrics` i `unreadNotifications`. Liczniki OC ograniczyć do OC, jeśli taki jest ich kontrakt. Globalny licznik powiadomień ma przestrzegać własnej polityki powiadomień, a zachowane leady — swojej niezależnej polityki snapshotu. Nie usuwać tych praw ubocznie przez jeden globalny filtr.

### Kryteria odbioru

- Syntetyczna operacja prywatnego narzędzia nie występuje w `operations` ani `actionRequired`; jej metadane nie zasilają liczników operacji OC.
- Także narzędzie inne niż OC z poprawnym grantem nie trafia do projekcji OC. Lista `tools` nadal odzwierciedla własny kontrakt uprawnień.
- Dozwolona operacja OC jest widoczna jako kontrola dodatnia.
- Co najmniej dziewięć nowszych niedozwolonych operacji nie wypycha dozwolonych operacji z limitu ośmiu.
- Pozytywne testy leadów zachowanych po usunięciu importu i powiadomień nie tracą dostępu przypadkowo.

## 6. Etap D — PT12-04: popup i dalsze działania workera

### Najpierw rozstrzygnąć wiarygodność testu

W [portal-navigation.spec.ts](../apps/worker/src/portals/shared/portal-navigation.spec.ts) wywołanie `window.open` jest wykonywane przez `page.evaluate`, następnie test czeka 200 ms i porównuje liczbę stron. Nie dowodzi to jednoznacznie, że popup został utworzony. Brak strony może wynikać także z blokady samej przeglądarki.

1. Utworzyć fixture z przyciskiem uruchamianym przez rzeczywisty `page.click` oraz kontrolą, że próba popupu nastąpiła.
2. Zarejestrować zdarzenia strony/kontekstu, opener, żądanie nawigacji, zamknięcie oraz wynik blokady dalszej akcji. Nie zapisywać cookie, SMS, treści profilu ani danych logowania.
3. Zastąpić arbitralne 200 ms synchronizacją zdarzeń z ograniczonym timeoutem i jawną kontrolą końca blokowania/zamykania.
4. Jeśli popup w pierwotnym teście nie powstawał, poprawić fixture i ponownie ocenić aplikację. Historyczny FAIL pozostawić w raporcie z nowym wynikiem triage; nie przedstawiać go jako dowiedzionego wycieku.

### Warunkowa zmiana implementacji

Jeśli rzeczywista próba popupu jest abortowana, lecz nie oznacza właściciela jako zablokowanego, poprawić [BrowserSession](../apps/worker/src/infrastructure/browser/browser.ts). Obecne `page.on('popup')` i `context.route` mogą obserwować różne etapy powstania strony; sam późny handler popupu nie wystarcza do dowodu poprawności.

- Powiązać dodatkową stronę/żądanie z właścicielem przez rejestr stron i opener. Nieznanej strony nie dopuścić do pierwszego obcego żądania w oczekiwaniu na ustalenie właściciela.
- Zatrzask blokady ustawić przed asynchronicznym zamykaniem strony. Obsłużyć kolejność zdarzeń route/page/popup, także pierwszy request nowego okna.
- Dla jednoznacznego właściciela blokować odpowiedni portal; gdy właściciela nie można bezpiecznie ustalić, przyjąć udokumentowane zatrzymanie aktywnego zadania w tym kontekście.
- Nie otwierać automatycznie nowej strony po blokadzie i nie zerować jej przy zwykłym retry. Odblokowanie wymaga nowego, jawnie utworzonego kontekstu wykonania zgodnego z cyklem runu.
- Sprawdzić propagację przez `beforePortalAction` w [live-run.ts](../apps/worker/src/features/execution/live-run.ts). Po blokadzie nie może nastąpić następne wpisanie danych, wysłanie SMS, Save ani UFG. Stan błędu/przerwania zapisać przez istniejący kontrakt runu; nie wykonywać automatycznego ponowienia niepewnej akcji.

### Kryteria odbioru

Rzeczywista próba popupu jest udowodniona przez fixture; obcy odbiornik otrzymuje zero żądań; popup jest zamknięty; następna kontrola właściciela odrzuca działanie; licznik dalszych akcji wynosi zero. Dozwolone logowanie/SSO oraz drugi niezależny portal zachowują swój kontrakt. Testy nie mogą przechodzić wyłącznie dlatego, że przeglądarka nie utworzyła popupu.

## 7. Etap E — środowisko i brakujące dowody

Przygotować osobny projekt Compose, wolumeny, syntetyczne konta/dane, PostgreSQL 17, Redis ACL i testowe HTTPS z proxy. Przed resetem lub kasowaniem sprawdzać identyfikator właściciela kontenera/wolumenu i nazwę bazy. Nie używać danych ani backupów użytkowych.

| Kolejność | Sprawdzenie | Wynik oczekiwany |
|---|---|---|
| E1 | Powtórzenie SEC-01/02 na PG17 i roli API | Wszystkie nowe odmowy i dodatnie kontrole działają |
| E2 | Publiczny Next/nginx i wewnętrzny API | Prywatne endpointy niedostępne przez publiczną ścieżkę; autoryzacja pozostaje także wewnątrz |
| E3 | Rzeczywisty Redis | Rozdział kont/prefixów, brak nieuprawnionych komend administracyjnych i danych obcej usługi |
| E4 | Browser CORS/CSRF/cookies/cache przez HTTPS | Pozostałe warianty origin null/subdomain, poprawne cookies i brak odczytu po cofnięciu dostępu |
| E5 | Parser, pliki, backup/restore, sandbox | Limity, cleanup, canary, tombstone/journal i izolacja mają dynamiczny dowód |
| E6 | Pozostałe INCONCLUSIVE i łańcuchy CH-01–06 | Każdy scenariusz ma indywidualny test albo dokładnie opisaną przeszkodę |

Moduł `registry-jobs` ponowić w obsługiwanym kontenerowym harnessie. Nie usuwać ochrony `OWNED_DISPOSABLE_POSTGRES_REQUIRED_FOR_RUNTIME_ROLE_SMOKE`, aby uzyskać zielony wynik na natywnej bazie.

Zewnętrzne portale, MF/GUS i pocztę zastąpić lokalnymi fixture. Nadal wyłączone są `test:automation-e2e`, `test:platform-e2e` i live portals. Pełne łańcuchy odtwarzać na granicach modułów z kontrolowanym odbiornikiem.

## 8. Etap F — kandydaci skanerów i dodatkowe zabezpieczenia

### Zależność uuid

Na podstawie zgłoszenia z raportu ustalić pełne drzewo zależności i osiągalność wywołań. Przy implementacji sprawdzić aktualny advisory oraz kompatybilną wersję pakietu nadrzędnego. Preferować aktualizację biblioteki wprowadzającej zależność; nie wymuszać globalnie nowej głównej wersji uuid bez testów zgodności. Ponowić SCA dla lockfile i rzeczywistego obrazu. Jeśli brak osiągalności uzasadnia wyjątek, zapisać zakres, właściciela i termin przeglądu.

### Kandydaci Gitleaks

Przeglądać lokalnie wyłącznie zredagowane lokalizacje/typy. Rozróżnić fixture, build/cache oraz rzeczywiste sekrety i profile sesji. Dla potwierdzonego aktywnego ujawnienia rotować właściwy sekret lub unieważnić sesję i usunąć drogę dystrybucji; nie rotować wszystkich sekretów na podstawie samego dopasowania regex. Ignorowanie pliku przez Git nie chroni backupu, obrazu ani artefaktu CI — sprawdzić także ich zawartość. Nie dodawać rzeczywistych wartości do testów i raportów.

### Redis, obrazy i CI

Zweryfikować rzeczywisty UID procesu Redis po `su-exec`, potrzebę inicjalizacji z wyższym uprawnieniem, prawa plików ACL i gotowość serwisu. Ostrzeżenie Dockerfile nie dowodzi uruchomienia demona Redis jako root. HEALTHCHECK ocenić razem z istniejącym healthcheck Compose, aby nie tworzyć sprzecznych sond. Skanować dokładne digesty obrazów wydania.

Zachować minimalne uprawnienia workflow i rozważyć przypięcie używanych actions do zweryfikowanych SHA. RLS traktować jako osobny projekt ograniczenia skutków przejęcia konta API, z testami sesji DB i migracji, nie jako warunek naprawienia dwóch obecnych projekcji.

## 9. Testy i podział zmian

| Zmiana | Minimalne testy regresyjne | Odbiór integracyjny |
|---|---|---|
| Uprawnienia kolekcji | Rola, własność, grant, stan narzędzia, brak grantu i jego cofnięcie | HTTP + PG17, historia/review, paginacja i stary cursor |
| Dashboard OC | Dozwolone OC oraz syntetyczny drugi tool, liczniki i actionRequired | HTTP + PG17; niedozwolone rekordy przed limitem |
| Popup | Kontrola rzeczywistej próby, zero obcej nawigacji i zero następnych akcji | Playwright fixture; PZU/Everest, Compensa i UFG |
| Całość | Granice architektury, transakcje i kontrakt HTTP | Rzeczywiste role DB, Redis i testowe proxy |

Proponowany podział na małe zestawy zmian: (1) regresje i SEC-01, (2) regresje i SEC-02, (3) triage/test/ewentualna naprawa popupu, (4) środowisko i dalsza weryfikacja, (5) potwierdzone poprawki zależności/sekretów/obrazów. Każdy zestaw opisuje własny wpływ i ograniczenia, a nie powołuje się tylko na wynik całego skanera.

Istniejące komendy pomocne przy odbiorze, po przygotowaniu odpowiedniego środowiska:

```powershell
npm run test:architecture
npm run test:transaction-audit
npm run test:module:reports
npm run test:module:security-db
npm run test:module:everest-browser
npm run test:module:compensa-browser
npm run test:module:ufg-browser
```

Nowe testy uprawnień muszą zostać dołączone do właściwego manifestu modułu, aby powyższe komendy je wykonywały. Jednorazowe uruchomienie starej sondy reprodukującej błąd nie wystarcza. Po zmianie wspólnego helpera sprawdzić wszystkie zależne moduły; szerszy zestaw uruchamiać raz po połączeniu zmian, bez portali live.

## 10. Warunki zamknięcia

1. SEC-01/02 mają dodatnie i ujemne testy na realnej bazie; brak niedozwolonych metadanych i pochodnych liczników, także po cofnięciu grantu.
2. PT12-04 ma wyjaśnioną przyczynę. Test potwierdza rzeczywistą próbę popupu i właściwą reakcję, a nie tylko brak okna.
3. Zachowano działające scenariusze OC, role/tenanty, leady zachowane, tombstone i historię usuwania.
4. Dowody retestu odnoszą się do konkretnego commita/diffu i obrazu; historyczne raporty pozostają niezmienione.
5. BLOCKED/INCONCLUSIVE otrzymują aktualny, indywidualny status z dowodem. Zaliczenie trzech obecnych FAIL nie zamyka automatycznie całego pentestu.
6. Wydanie przechodzi odbiór na PG17/Redis/HTTPS i rzeczywistych obrazach. Każdy świadomie pozostawiony brak ma zakres wpływu, właściciela i termin ponownej oceny.

Orientacyjny nakład dla A–D: 2–4 dni robocze wraz z testami, zależnie od triage popupu i zgodności polityk review. Przygotowanie środowiska E i pełne zamknięcie 51 nierozstrzygniętych scenariuszy wymagają osobnej estymacji po ich rozpisaniu; nie są wliczone do tego przedziału.
