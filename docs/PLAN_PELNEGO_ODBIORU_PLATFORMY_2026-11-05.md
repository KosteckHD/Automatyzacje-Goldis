# Goldis — pełny plan odbioru działania i cyberbezpieczeństwa

Data: **5 listopada 2026**. Status: **PLAN PRZYGOTOWANY — ODBIÓR NIEZAKOŃCZONY**. Zakres klienta: jedna firma, 2–5 pracowników. Ten dokument jest główną kolejnością odbioru platformy; łączy działanie produktu, testy backendu/frontendu/automatyzacji, cyberbezpieczeństwo, konfigurację serwera, kopie, odtwarzanie i utrzymanie.

**Przygotowanie planu nie oznacza wykonania testów, pentestu ani wdrożenia.** Wszystkie nowe przypadki zaczynają od `NOT_RUN`. Wyniki wcześniejszych audytów służą do wyznaczenia regresji; nie są przepisywane jako PASS nowego wydania.

**Wykonanie 6 listopada:** poprawki i lokalne dowody opisuje [raport realizacji](REALIZACJA_ODBIORU_2026-11-06.md). Bieżące statusy są w wyniki.csv; pełny odbiór nadal niezakończony.

**Nowy etap audytu 6 listopada:** [skille cybersec i nowe znaleziska](security/audit-2026-11-06-skills/README.md). COM02/SEC09 w fazie A mają FAIL do naprawy i retestu; wcześniejsze zielone suite nie zamykają tych znalezisk.

## 1. Zakres i aktualny punkt wyjścia

Odbieramy identyfikowalne wydanie aplikacji, a następnie konkretną instalację tego wydania. Odbiór nie wymaga przebudowy platformy na mikroserwisy ani ogólny silnik pluginów.

W obecnym drzewie są już **dwa rzeczywiste narzędzia**:

- `oc-policy-verification` — przygotowanie danych, PZU/Everest, Compensa/UFG, wyniki OC i praca z leadami;
- `commission-comparison` — upload danych i słownika, wersjonowane reguły, zlecenia, silnik Python, porównanie i raporty prowizyjne.

Aktualna konfiguracja wskazuje **migrację 066**, **6 obrazów** i **12 usług**, w tym 9 długotrwałych i 3 administracyjne. Commission-worker używa obrazu API; szóstym obrazem jest silnik prowizyjny. G0 musi potwierdzić stan końcowego kandydata, ponieważ kod jest rozwijany równolegle.

**Domyślnie pełny odbiór obejmuje obydwa narzędzia.** Ograniczone wydanie OC-only jest możliwe po jawnym określeniu zakresu i sprawdzeniu skutecznego wyłączenia pozostałej funkcji. Samo ukrycie karty nie wystarcza: moduł prowizyjny jest podłączony w API, migracja rejestruje narzędzie jako available, a Compose uruchamia jego usługi. Zmiany migracji, uprawnień, sieci i backupu trzeba zbadać również wtedy, gdy użytkownicy jeszcze nie otrzymają dostępu do prowizji.

Dotychczasowe kontrole tego dnia dotyczyły różnych snapshotów. Wcześniejszy build OC/API/web/workera przechodził, ale testy miały przerwany runner API, 6 błędów workera wymagających rozstrzygnięcia i czerwony gate architektury leadów. Status prowizji opisuje własne buildy i testy jednostkowe oraz brak pełnego DB/Redis/UI/restore. **Żaden z tych zapisów nie zastępuje jednego końcowego odbioru wspólnego wydania.**

## 2. Dokumenty i rejestry do pracy

| Plik | Zastosowanie |
| --- | --- |
| [Macierz przypadków — Markdown](acceptance/2026-11-05/CHECKLISTA.md) | Wykonywalna lista: zakres, kroki, PASS, wymagane dowody i istniejące wejścia testowe. |
| [Macierz przypadków — JSON](acceptance/2026-11-05/przypadki.json) | Źródło rejestru przypadków; wymagania i miejsce na kolejne wykonania/retesty. |
| [Rejestr wyników — CSV](acceptance/2026-11-05/wyniki.csv) | Arkusz do zapisu wykonawcy, wersji, środowiska, actual, statusu, dowodu i usterek. |
| [Protokół końcowy](acceptance/2026-11-05/PROTOKOL_ODBIORU.md) | Decyzja o zakresie udostępnienia, podpisy/akceptacja, ograniczenia i przekazanie. |
| [Przykład manifestu przebiegu](acceptance/2026-11-05/manifest.example.json) | Niesekretne pola wersji, celów, danych, narzędzi testowych i konfiguracji. |
| [Rejestr usterek — CSV](acceptance/2026-11-05/usterki.csv) | Powiązanie znaleziska, wpływu, właściciela, poprawki i retestu. |

Szczegółowe materiały pomocnicze: [plan VPS](PLAN_VPS_I_UTRZYMANIA_KLIENTA_2026-11-05.md), [audyt biznesowy i U01–U18](AUDYT_ODBIORU_BIZNESOWEGO_I_ROZWOJU_PLATFORMY_2026-11-05.md), [plan PT00–PT15 i CH-01–06](PLAN_PENTESTOW_CALEJ_APLIKACJI_2026-10-17.md), [stan prowizji](porownywarka-prowizji/IMPLEMENTATION_STATUS.md), [P08 prowizji](porownywarka-prowizji/08-ODBIOR-I-WDROZENIE-VPS.md). Historyczne raporty pozostają niezmienionymi dowodami ich własnych przebiegów.

## 3. Ustalenia obowiązujące i decyzje przed wykonaniem

Zachować zapisane ustalenia biznesowe: jedna organizacja, wspólny sekwencyjny automat OC, obsługa SMS/korekty przez startera runu, filtr końca ochrony `coverageTo >= referenceDate`, osobna operacja przy nowym zaakceptowanym imporcie, ochrona leadów przydzielonych innym oraz brak automatycznego wygaśnięcia importów/wyników/kopii do uprawnionego usunięcia. **RPO ≤24 h, RTO ≤8 h** — wymagają pomiaru, nie wyłącznie zapisu w instrukcji.

| Decyzja | Co wpisać do manifestu / protokołu | Odpowiedzialny |
| --- | --- | --- |
| Zakres wydania | OC, prowizje, mail recovery, MF VAT, portale off/live, dane do migracji | Właściciel produktu |
| Kandydat release | Pełny SHA, wszystkie potrzebne pliki, 6 prawdziwych digestów, migracje i wersje kontraktów | Programista / operator |
| Środowiska A/B/LIVE | Dokładne hosty, porty, adresy, projekt Compose, wolumeny, własność i czas testu | Operator |
| Dostępy | Konta admin/manager/A/B/reviewer/auditor, dodatkowy admin; granty OC/prowizje/słownik | Właściciel + QA |
| Wynik referencyjny | Syntetyczne dane i expected; dla prowizji zatwierdzona referencja v7 z identyfikatorem/hashami | Właściciel + QA |
| Wolumen | Dzienna liczba firm/analiz, maksymalny plik/partia, godziny szczytu | Klient / właściciel |
| Dostępność i awarie | Początek pomiaru RTO, okno kopii, nadzór SMS, zastępstwo, operator i eskalacja | Klient + operator |
| Bezpieczeństwo | Zakres ręcznego pentestu, odbiorcy raportu, rejestr ryzyka; MFA platformy pozostaje odrębną decyzją produktu | Osoba od bezpieczeństwa + właściciel |
| Offsite | Magazyn, konta recovery, escrow kluczy, polityka journala i brak automatycznego purge kopii | Operator |

Brak VPS/domeny nie blokuje testów A. Nie rozstrzygać brakujących wartości przez odczyt sekretów z `.env` klienta ani użycie jego działającej bazy.

## 4. Środowiska i granice testowania

**A — izolowany odbiór techniczny.** Linux x86_64, Docker Engine/Compose, PostgreSQL 17, własny Redis z ACL, pełny stos aplikacji i prywatny Python engine. Syntetyczne konta/dane, oddzielne wolumeny i porty. Produkcyjne ustawienia bezpieczeństwa, testowa nazwa HTTPS ze zaufanym lokalnym CA, ta sama topologia i digesty co kandydat produkcyjny. W tej fazie wykonuje się wstrzykiwanie błędów, testy limitów, restartów i ataków na własną aplikację.

**B — finalny odbiór instalacji.** Kupiony VPS, właściwa domena, certyfikat, firewall, rzeczywiste pliki sekretów, offsite i alerty. Powtórzyć kontrole zależne od hosta/originu i bezpieczny smoke na kontrolnych danych. Nie przenosić automatycznie PASS certyfikatu testowego na domenę klienta.

**LIVE — uzgodniony odbiór portali.** Osoba uprawniona, zaakceptowany przypadek, aktualne selektory i prywatny profil danej instalacji. Brak ataków na PZU, Compensę, UFG, MF VAT, dostawcę maila lub ich infrastrukturę. Awarii zapisu nie wywoływać na przypadkowych sprawach klienta.

**UAT — zadania pracowników na zaakceptowanej instalacji.** Oddzielne konta 2–5 osób, kontrolowane dane i zapis expected/actual. Część UAT można wykonać w A; końcowy odbiór obejmuje docelową konfigurację B i osobno zadeklarowany zakres LIVE.

W testach bezpieczeństwa stosować listę dozwolonych własnych celów, kontrolowany HTTP/DNS/mail canary, limity RAM/CPU/czasu oraz mały budżet ruchu. Punktem startu jest 2 req/s i do 4 requestów równoległych; wyścigi najpierw parą żądań. Nie wykonywać floodingu, nieograniczonych archive bombs ani skanowania cudzej sieci. Przerwać pakiet po ruchu poza zakresem, nieoczekiwanym użyciu danych rzeczywistych lub niekontrolowanym zużyciu zasobów.

Przed wykonaniem istniejącego skryptu sprawdzić jego obecną treść i flagi. Nie uruchamiać automatycznie `test:automation-e2e`, `test:platform-e2e` ani pełnych skryptów historycznych tylko na podstawie nazwy. Wspólny proces A powinien używać produkcyjnej orkiestracji z adapterami fixture; przygotowanie tego harnessu jest częścią G3, jeśli go brakuje. Planowanie nie uruchamia LIVE ani wysyłki wiadomości.

## 5. Kolejność odbioru i bramki

| Bramka | Kolejność i praca | Co musi być gotowe przy wyjściu |
| --- | --- | --- |
| **G0 — zakres i powtarzalność** | Zidentyfikować obecny kod, moduły, trasy, migracje, obrazy, dane i role. Utworzyć manifest oraz izolowane środowisko. | Jedna kompletna paczka, kontrolowane fixture, scope OC/prowizji/mail/LIVE, bez odziedziczonych sekretów klienta. |
| **G1 — naprawy przed odbiorem** | Ponownie sprawdzić wcześniejsze ustalenia A1–A7/VPS-01–14 na aktualnym kodzie; odtworzyć istotne rozbieżności i naprawić. | Krytyczne ścieżki mają poprawki i testy regresji. Nie poprawiać automatycznie problemu, który został już zamknięty w innym snapshotcie. |
| **G2 — kod, kontrakty i DB** | Czyste `npm ci`, build/style/test; Python unit, kontrakt Node/Python; świeża i aktualizowana DB do 066; Redis i rzeczywiste role. | Wymagane suite kończą się wynikiem; SKIP rozliczone; 066 i granty sprawdzone na PG17, bez mylenia testu 061→062 z odbiorem całej aktualizacji. |
| **G3 — spójny proces A** | UI → realne API → DB/outbox/Redis → produkcyjny procesor/engine fixture → utrwalony wynik → UI/download; normalne i awaryjne warianty. | Oba narzędzia w zakresie mają prawidłowy wynik i odzyskiwanie; dwa konta i idempotencja; bez pozornego sukcesu. |
| **G4 — cyberbezpieczeństwo A** | Ręczna macierz ról/zasobów, przeglądarka/inputs/parser, izolacja usług i kolejki; skany i łańcuchy ataku. | Przypadki SEC rozstrzygnięte dowodem; istotne luki poprawione i ponownie sprawdzone. |
| **G5 — runtime, awarie i odzyskiwanie A** | Kontenery, sieci, role, sandbox, restart, offsite, integralność kopii, cold restore, journal i rollback; obciążenie współdzielone. | Odzyskanie z kopii w celach RPO/RTO; brak duplikatów/skasowanych danych; alarmy działają; pojemność zmierzona. |
| **G6 — instalacja B** | Wdrożyć zatwierdzoną paczkę, sprawdzić DNS/TLS/proxy/sekrety/porty, role, dane, backup i operatora. | Ten sam release działa na wskazanym VPS; certyfikat odnawia się, usługi prywatne są prywatne. |
| **G7 — LIVE i UAT** | Nadzorowany odbiór OC na uprawnionym koncie; odbiór prowizji na zatwierdzonej referencji; zadania pracowników i menedżera. | Zgodne wyniki, wykonalna obsługa wyjątków, świadome ograniczenia i wyniki pilota. |
| **G8 — decyzja i przekazanie** | Zamknąć rejestr testów/usterek, wskazać zakres i operatora, instrukcje, monitoring, odzyskiwanie i harmonogram. | Wypełniony protokół. Brak wymaganych niewykonanych prób ukrytych pod ogólnym PASS. |

G4 i przygotowanie G5 mogą postępować równolegle po stabilnym G2/G3. Testy destrukcyjne i aktywny pentest pozostają w A. W B nie wykonywać ich na używanej bazie klienta.

Każde wykonanie ma osobną fazę i bramkę w `phaseGates` oraz kolumnie `phase_gate` CSV. **Kontrole B z grup INF/DR/SEC zaliczają G6**, nawet gdy ich grupa powstała w G4/G5; UAT zalicza G7, a przekazanie OPS02 — G8. Próba odzyskania konta OPS03 odbywa się w A; B potwierdza wykonalność procedury bez resetowania aktywnego konta. Nie agregować odbioru tylko po bazowym polu `gate`, pomijając fazy.

## 6. Pierwszy backlog napraw do ponownej weryfikacji

To lista kandydatów z audytów, nie potwierdzenie ich aktualnego stanu po równoległych zmianach:

| Grupa | Co ponownie odtworzyć i zamknąć | Właściwe przypadki |
| --- | --- | --- |
| Produkcyjna orkiestracja OC | Manual data/fieldCode/interwencja, niepewny zapis i różnice fixture pipeline vs LiveRunProcessor | FUN06–FUN10, E2E01/E2E03, SEC18–SEC22 |
| Panel OC i sesje | Spójność summary/rows, `/submissions/:id` po loginie, 401/503, retry | FUN01/FUN05/FUN17, SEC03/SEC11 |
| Uprawnienia wyników | Tekst panelu, Team API i rzeczywisty grant download; nowe konto i cofnięty grant | FUN01/FUN14, SEC06–SEC08 |
| Build/testy | Gate leadów 42/36, nieukończone API, błędy stagingu i ograniczenia środowiska, mapowanie 85 SKIP | REL03, REL06, SEC22 |
| Linux/sekrety/restore | Prawa non-root, zgodność nazw, minimalne mounty, stale lock, shutdown, ownership po pg_restore, subnet/trust-proxy | INF03/INF07, DR01–DR06 |
| Prowizje | `/login` i returnTo, 503 udające wylogowanie, nowy klucz przy niepewnym ponowieniu; brak preview jakości pliku; pełność list/raportu | COM01–COM08, E2E02, SEC05–SEC14 |
| Nowa powierzchnia runtime | Role goldis_commission, prywatny engine/token, niepotrzebny sekret silnika w parserze, backup danych prowizyjnych | INF03–INF08, SEC14–SEC25, DR01/DR04/DR06 |

Nie maskować problemów przez podnoszenie limitu testu, wyłączenie asercji, oznaczenie INCONCLUSIVE jako PASS lub ręczne ustawienie completed. Poprawki otrzymują odrębny identyfikator i wymagany retest.

## 7. Pokrycie wszystkich wymaganych obszarów

| Wymaganie z rozmowy | Przypadki i wykonanie | Dowód końcowy |
| --- | --- | --- |
| Zakończone testy jednej wersji | REL01–REL07, G2, E2E01–E2E04 | Logi z kodami wyjścia i pass/fail/skip, CI, migracje, role, zakres retestów. |
| Cały proces aplikacji | FUN01–FUN18, COM01–COM08, E2E01–E2E04, LIVE01–LIVE04 | Przejścia UI/API/DB/worker, wynik referencyjny i odebrany XLSX, UAT pracowników. |
| Testy dostępu i próby obejścia | SEC01–SEC24, E2E04 | Ręczna macierz ról/zasobów/stanów, kontrole dodatnie i negatywne, brak niedozwolonych skutków. |
| Rzeczywista konfiguracja serwera | INF01–INF08, SEC14/SEC15/SEC19/SEC24 | Obrazy/UID/prawa/sieci, PG17/ACL, TLS/origin/proxy, sandbox i test publicznej granicy. |
| Zależności, sekrety i końcowe obrazy | SEC25, REL01/REL03, INF01/INF03 | Aktualne raporty SCA/secret/image/CI z triage, SHA/digestami i datą bazy podatności. |
| Odtworzenie i monitoring | DR01–DR06, OPS01–OPS02, LOAD01–LOAD02 | Udany cold restore, replay kasowań, RPO/RTO, odebrane alarmy i instrukcja operatora. |

Macierz SEC01–SEC25 jest grupowaniem zakresu, nie 25 pojedynczymi requestami ani zamiennikiem 80 szczegółowych pozycji wcześniejszego planu. Każdy przypadek rozwinąć na **aktualne** endpointy, role, zasoby, granty i istotne stany. Zapisać identyfikatory wariantów w wykonaniu, np. `SEC06/lead/cross-tenant/download`. PASS grupy wymaga zaliczenia wszystkich jej obowiązkowych wariantów.

W grupie `common` wyłączenie prowizji może wyłączyć tylko dodatni wariant funkcjonalny/obliczeniowy, np. w E2E04/LOAD01/LOAD02. **Cała grupa nie staje się N/A**: obowiązkowe pozostają techniczna blokada niedopuszczonego API, izolacja i skutki wspólnych migracji, sekretów, sieci, pamięci i backupu. Takie rozbicie wariantów zapisać w wynikach wraz ze scope z G0.

### Szczególny zakres bezpieczeństwa

- **Logowanie i sesje:** fałszowanie/uszkodzenie cookie, idle/absolute timeout, logout/revoke, wymuszona zmiana hasła, wyłączone konto i role, enumeracja oraz limiter przez rzeczywiste proxy.
- **Reset i e-mail:** jednorazowość i współbieżne użycie tokenu, właściwy odbiorca/origin, Host poisoning, brak tokenu w logach/referer/cache. Gdy recovery off, SEC04/MAIL01 mogą być N/A dopiero z dowodem OPS03: rzeczywisty uprawniony reset kontrolnego administratora w A, nowe logowanie, revokacja starych sesji/linków i audyt oraz potwierdzona procedura w B. Wspólny SEC03 nadal sprawdza, że wyłączone publiczne i administracyjne akcje inicjujące link recovery nie wydają skutecznego tokenu, nie wysyłają maila i nie tworzą aktywnego outboxu. Dozwolony bezpośredni reset administracyjny pozostaje dostępny; ogólna odpowiedź API nie przesądza wyniku bez kontroli skutków.
- **Prawa i poufność:** IDOR/BOLA, A/B i drugi syntetyczny tenant, OC-only/prowizje-only, grant słownika, cofnięcie prawa w tej samej sesji i na starym kursorze, filtrowanie przed count/paginacją, brak nadmiarowych danych w odpowiedziach.
- **Przeglądarka i wejścia:** rzeczywista próba CSRF/CORS z obcego originu i null, XSS w danych importu/błędach, CSP/nonce/framing, SQL/command/path/header injection, mass assignment, błędny JSON/XML/multipart oraz formuły/linki w XLSX.
- **Parser i Python:** kontrolowane archiwa graniczne, DTD/XXE/traversal, timeout i zabicie procesu, ograniczony tmp/RAM/CPU; walidacja kontraktu i wersji Node/Python; brak DB/Redis/portal credentials w Pythonie i brak niepotrzebnego sekretu engine w parserze.
- **Zlecenia i skutki:** replay/idempotencja, lease/fencing, stary attempt/wynik, wyścigi cofnięcia prawa/usunięcia, step-up i ochrona ostatniego admina, prywatne endpointy wyników/SMS/parsera/engine.
- **Integracje:** lokalny canary dla SSRF, DNS/redirect/schemes, wyjściowa sieć workera i brak przenoszenia credentials między hostami; popup nie tylko zamknięty, ale dalsza akcja odcięta. Nie testować ataków na dostawców.
- **Dane i operacje:** integralność ciphertext/tag/AAD/key versions, stare legalne dane po rotacji, brak plaintext fallback, prywatny download, właściwe usuwanie i restore, supply chain/sekrety w Git/bundle/obrazach/kopiach/logach.

Ręczne sprawdzenie logiki jest obowiązkowe: skaner nie rozstrzyga poprawności przydziału, zakresu tenanta, jednorazowego zapisu w portalu ani zgodności stawek prowizyjnych. Jako materiał wymagań użyć [OWASP ASVS](https://asvs.owasp.org/) i [OWASP WSTG](https://owasp.org/projects/web-security-testing-guide), zapisując wersję użytej listy w manifeście. Plan nie deklaruje certyfikacji ASVS ani niezależnego pentestu, którego nie wykonano.

Historyczne SEC-01/SEC-02 zostały naprawione i przetestowane ponownie; historyczny problem popupu rozstrzygnięto poprawionym fixture. Nowe **SEC01–SEC25 bez myślnika** są identyfikatorami przypadków odbiorowych. Powtórzyć regresje, nie przepisywać zamkniętych ustaleń jako nowych otwartych luk.

### Łańcuchy do sprawdzenia w A

1. Dane importu → bezpieczny marker XSS w panelu menedżera/admina → próba niedozwolonej mutacji: marker nie wykonuje się, brak eskalacji.
2. Lista/dashboard → poznany UUID → cudzy plik/edycja leada lub wynik prowizji: identyfikator nie daje dostępu.
3. Reset/e-mail/replay → próba przejęcia konta: właściwy cel, rewizja, jednorazowość i revokacja sesji.
4. Cofnięty grant → stara sesja/kursor/eksport/confirmation: brak nowego niedozwolonego skutku po punkcie serializacji.
5. Usunięcie → spóźniony worker/stary backup: brak ponownej publikacji skasowanych danych w OC i prowizjach.
6. Sekret jednej usługi → próba użycia innego API/DB/Redis/engine: zakres nie przekracza przydzielonych praw.

Dowód łańcucha łączy wykonania właściwych SEC, zamiast udawać dodatkowy sukces bez nowej obserwacji.

## 8. Istniejące wejścia testowe i brakujące harnessy

Poniższe komendy są mapą istniejących wejść, **nie poleceniem wykonania w tej chwili i nie dowodem ich pełnego pokrycia**. Sprawdzić aktualne package.json/skrypty po zamrożeniu release. Nie uruchamiać dwóch buildów jednocześnie: skrypty czyszczą wspólne dist.

```sh
npm ci
npm run check:backend:style
npm run build
npm test
npm run test:db-integration
npm run test:e2e:fixture
npm run test:production-compose
```

DB runner wymaga dedykowanego lokalnego testowego administratora PostgreSQL i tworzy własne disposable DB. Nie podstawiać produkcyjnego `DATABASE_URL`. `test:module:*` są częściowymi zestawami, m.in. `auth`, `password-recovery`, `security`, `security-db`, `security-redis`, `runtime-roles`, `teams-db`, `admin-users-db`, `results`, `submission`, `runs`, `run-control`, `interventions`, `deletion`, `deletion-jobs`, `backup-restore`, `reports`. Istnienie speców lub nazwy modułu nie daje automatycznie pełnego HTTP/DB testu.

Frontendowe smoke uruchamia się z `-w @goldis/web`, np. `test:oc-workspace-ui-smoke`, `test:run-submission-ui-smoke`, `test:manager-ui-smoke`, `test:lead-ui-smoke`, `test:tool-grants-ui-smoke`. Część podmienia API; oznaczyć taką granicę w dowodzie. Python: przygotowane venv3.12, `requirements.lock`, właściwy PYTHONPATH/instalacja pakietu i `python -m unittest discover -s services/commission-engine/tests -v`.

Przed wykonaniem `migration-smoke.cjs commission` potwierdzić kontrakt argumentów, nazwę disposable DB i rolę. To nie jest komenda do wskazania działającej bazy. Upgrade prowizji należy przetestować także z poprzedniego schematu, nie jedynie od zera.

Do przygotowania lub potwierdzenia: kontrolowany seed kont/zasobów; bieżąca inwentaryzacja tras; pełny E2E produkcyjnej orkiestracji z fixture; fault injection i wyścigi; przeglądarkowe 401/503 i returnTo dla obu narzędzi; test parytetu prowizji z hashami; canary i macierz wejść; raport obciążenia; finalny runtime/security/restore na Linux. W macierzy takie pozycje mają jawnie `NOWY HARNESS/PROCEDURA`, a nie nieistniejącą gotową komendę.

## 9. Backup, restore i obciążenie — wymagania końcowe

Odebrana kopia obejmuje DB, eksporty/staging, źródła i raporty prowizyjne, wersje słowników/snapshoty, stare i nowe keyringi, konfigurację oraz zgodną paczkę operatorską. Dokładny zakres wynika z aktualnych kodów backup/restore i jest potwierdzony odczytem po odtworzeniu. Nie zakładać, że nowa tabela/plik automatycznie weszły do starszego backupu.

Wymagane są archiwum platformy i **najnowszy zgodny dziennik usunięć**. Osobno sprawdzić jego aktualność poza VPS: nocny backup nie gwarantuje zachowania kasowań wykonanych później. Przy niepewnym stanie kasowań odtworzona instalacja pozostaje w kwarantannie.

Cold restore wykonać na drugim hoście, z tej samej paczki release co kopia, przed osobnym upgrade. Sprawdzić ownership po `pg_restore`, migratora i goldis_commission, uprawnienia plików, brak kolizji sieci, stare klucze oraz brak przywrócenia starych linków resetu i niepożądanej pracy outboxów. Portal/commission/enrichment workery nie dostają zgody na wykonywanie zadań tylko dlatego, że DB osiągnęła readiness. RTO panelu i czas ponownego MFA/automatyzacji mierzyć osobno.

**Bez automatycznego TTL/purge historii kopii.** Lokalny cache i retencja archiwum to odrębne decyzje; nie usuwać wymaganej historii po udanym uploadzie. Monitorować wzrost storage. Każde uprawnione usunięcie musi być zgodne z grafem danych, journalem i nadal przechowywanymi kopiami.

Obecny backup zatrzymuje aplikację, więc zmierzyć całą przerwę i zaakceptować okno. Nie obiecywać częstych kopii bez przerw przez samo zwiększenie liczby uruchomień skryptu. Odbiór obejmuje stop/start nowych usług prowizji i powrót po błędzie backupu.

Obciążenie: 5 pracowników w panelu, jedna praca OC fixture i jedno obliczenie prowizji równolegle, jeśli obydwa moduły są dopuszczone. Przy wyłączeniu prowizji ich dodatni wariant może mieć N/A, lecz wspólny runtime nadal podlega ocenie. Dzisiejsza suma limitów RAM to ok. 10,5 GiB; nie jest to pomiar RSS ani dowód wystarczalności VPS. Dane, rozgrzewka, liczba powtórzeń i cele p95/RAM/dysku muszą być zapisane przed pomiarem. Przy nieznanym wolumenie wyjściem testu jest także ustalony limit i uczciwa przepustowość, nie dowolna gwarancja liczby firm na dzień.

## 10. Zapis dowodów, wyników i retestów

Przebieg otrzymuje `runId`, np. `acceptance-<data>-<release>-<numer>`. Dowody przechowywać w prywatnym katalogu poza paczką produktu, z manifestem, logami suite, request/response po redakcji, syntetycznymi stanami before/after, trace browsera i raportami skanów. Do Git trafiają bezpieczne podsumowania i odnośniki, bez danych klienta, haseł, cookies, SMS, tokenów, kluczy i jawnych backupów.

Dla **każdego wykonania i fazy** zapisać: caseId i wariant, source SHA/digesty/config, środowisko, wykonawcę/czas, seed/hash, kroki/command, expected/actual, exit code, pass/fail/skip, kontrolę dodatnią, stan skutków, ścieżkę dowodu, findingId i retestOf. Wiersz A nie zalicza automatycznie B lub UAT. Dowód z mock API nie zalicza E2E DB/workera.

| Status | Interpretacja |
| --- | --- |
| NOT_RUN | Zdefiniowano przypadek; jeszcze go nie wykonano. |
| RUNNING | Jest aktywne wykonanie z właścicielem; nie jest wynikiem. |
| PASS | Expected potwierdzony odpowiednim wykonaniem, także kontrolą dodatnią i brakiem niedozwolonych skutków. |
| FAIL | Wykazano rozbieżność/naruszenie lub test nie spełnił oczekiwań; przyczynę środowiskową klasyfikuje się oddzielnie. |
| BLOCKED | Brakuje środowiska, dostępu, danych albo zależności; nie zastępuje PASS. |
| INCONCLUSIVE | Obserwacje nie rozstrzygają wymagania; potrzebny poprawny test lub dodatkowy dowód. |
| N/A | Wymaganie nie dotyczy jawnie wyłączonego zakresu; uzasadnienie i odbiorca decyzji obowiązkowi. |

Status usterki i zaakceptowane ryzyko są oddzielne od wyniku testu. Akceptacja ograniczenia nie zmienia FAIL w PASS. W CSV zapisywać oddzielny wiersz dla retestu i zachować wcześniejszą obserwację.

Po zmianie kodu/konfiguracji/selektorów/obrazu po testach zaktualizować manifest, ocenić wpływ i powtórzyć dotknięte przypadki oraz wspólny smoke. Zmiana sesji/auth wymaga retestu obu narzędzi; zmiana DB/restore obejmuje migracje i odzyskiwanie; zmiana routingu wymaga katalogu, returnTo, historii i powiadomień. Nie przedstawiać ostatniego SHA jako przetestowanego na podstawie wyników poprzedniego.

## 11. Kryteria dopuszczenia i obowiązki

Formalny odbiór całej zadeklarowanej platformy wymaga:

- wszystkich obowiązkowych przypadków i wariantów w wymaganych fazach PASS, a N/A uzasadnionego zakresem;
- braku niezamkniętych krytycznych/osiągalnych wysokich luk, utraty lub ujawnienia danych, błędnej tożsamości/wyniku prowizji oraz podwójnego skutku portalowego;
- zakończonych testów i retestów jednego wydania, w tym realnego PG17/Redis/Pythona/HTTPS;
- zgodności wyniku referencyjnego i plików, właściwych praw oraz wykonalnej obsługi istotnych wyjątków;
- działających alarmów, kompletnego offsite i udanego cold restore z nowszym journalem w ustalonych RPO/RTO;
- odebranej konfiguracji finalnego hosta, użytkowników, operatora, instrukcji i protokołu.

Niższe ryzyka można przyjąć wyłącznie jawnie: opis wpływu, właściciel, uzasadnienie, ograniczenie ekspozycji i termin powrotu do sprawy. Znalezisko skanera może być fałszywym alarmem lub nieosiągalne; wymaga analizy i dowodu, nie automatycznego uznania każdej wersji pakietu za exploitable. Brak rezultatu wymaganego badania nie jest zaakceptowanym ryzykiem „bezpieczeństwo potwierdzone”.

Jeśli zaakceptowana rozbieżność nadal oznacza FAIL obowiązkowego przypadku, nie daje pełnego odbioru tej funkcji. Potrzebny jest zakres ograniczony albo jawna zmiana kontraktu i adekwatny retest; wynik historyczny pozostaje zachowany.

Możliwe decyzje protokołu: **NO_GO**, **PILOT_NADZOROWANY**, **ODEBRANY_ZAKRES_OGRANICZONY**, **ODEBRANA_CALOSC_ZADEKLAROWANEGO_ZAKRESU**. Portale off nie mogą być opisane jako odebrana czynna automatyzacja OC; niewłączone prowizje nie oznaczają odbioru ich wyników. Ograniczenie zakresu wymaga poprawnych komunikatów i technicznej blokady niedopuszczonej funkcji.

| Rola | Zadanie |
| --- | --- |
| Programista | Poprawki, testy jednostkowe/integracyjne, kontrakty, migracje i identyfikowalne obrazy. |
| QA / prowadzący odbiór | Seed, przypadki, expected/actual, coverage/SKIP, E2E i rejestry. |
| Osoba od bezpieczeństwa | Ręczne testy granic i logiki, skany/triage, retest i zakres ryzyka; wskazany niezależny końcowy przegląd. |
| Operator / zastępca | Linux/VPS/sekrety/role, offsite/restore/rollback, monitoring i dostęp awaryjny. |
| Właściciel produktu / klient | Oczekiwany wynik, polityka praw, wolumen, LIVE, UAT i akceptacja ograniczeń. |

Prace rozpocząć od G0/G1 oraz uruchomienia A. Termin dalszego odbioru ustalić po zinwentaryzowaniu bieżącego scope i odtworzeniu problemów; nie sumować szacunków z historycznych planów jako gwarantowanego terminu. Pilota można zaplanować np. na 3–5 dni pracy po stabilnym G6, z zakresem i kryteriami zapisanymi wcześniej.

## 12. Czego nie wykonywano przy przygotowaniu tego planu

Nie uruchamiano aplikacji, pentestu, skanów, migracji, kopii/restore ani portali. Nie wprowadzano poprawek do kodu aplikacji i nie zmieniano jego równolegle rozwijanych funkcji. Przygotowano dokument, przypadki, wzory rejestrów i powiązania z wcześniejszymi ustaleniami; sprawdzenie tych artefaktów obejmuje poprawność JSON/CSV, identyfikatorów, zależności i odnośników.
