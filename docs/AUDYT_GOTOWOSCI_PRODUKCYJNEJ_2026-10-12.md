# Audyt gotowości Goldis do produkcji — 12 października 2026

## Werdykt

**Nie uruchamiać obecnego drzewa jako publicznej usługi VPS z rzeczywistymi danymi.** Kod MVP platformy jest w większości gotowy, a automat OC ma potwierdzony pełny przebieg jednego rzeczywistego wiersza JDG. Brakuje jednak zamknięcia kilku wysokich ryzyk bezpieczeństwa, odbioru partii i awarii na docelowej topologii oraz procesu wdrożenia i odtworzenia. Druga automatyzacja nie ma zdefiniowanego procesu i pozostaje pozycją katalogu.

Orientacyjna ocena ukończenia, według bramek wydania, nie według liczby plików: **funkcje platformy MVP 85–90%; automat OC w zakresie potwierdzonej JDG 70–80%; gotowość operacyjna i bezpieczeństwo produkcyjne 40–50%**. Te przedziały są oceną audytową, nie metryką testową. Pełnego zakresu podmiotów i drugiej automatyzacji nie da się uczciwie ująć jednym procentem bez decyzji produktowych i dostępu do portali.

## Zakres i dowody

- Oceniono bieżące pliki robocze wraz z niezatwierdzonymi zmianami. `HEAD` to `e3a507e` z 6 października; obecnego stanu nie reprezentuje commit ani zestaw obrazów z identyfikatorami wydania.
- `npm run build`: **PASS** (core, API, worker, Next.js).
- `npm test`: **314 PASS, 54 SKIP, 0 FAIL**. Pominięte testy workera obejmują scenariusze przeglądarkowe uruchamiane osobno.
- `test:module:everest-browser`: **8/8 PASS**; `test:module:compensa-browser`: **29/29 PASS**; `test:module:ufg-browser`: **13/13 PASS**. Testy używają lokalnych fixture, nie rzeczywistych portali.
- `test:lead-ui-smoke`: **PASS**, z syntetycznym API.
- `test:module:reports`: **PASS**, jednorazowa baza PostgreSQL, migracje 001–053 i ponowienie bez duplikatów; przydziały, raporty i powiadomienia.
- `test:module:migrations`: **FAIL** na `MANAGER_MEMBERSHIP_GRANT_OR_ADMIN_BOUNDARY_MISMATCH` w `users_schema_seed`. Asercja w `apps/api/scripts/migration-smoke.cjs` oczekuje, że manager z grantem execute nie ma odczytu OC, podczas gdy obecna polityka `tool-access.ts` zapewnia wspólny odczyt managerom. To wskazuje na nieaktualny test, ale bramka jest czerwona do czasu poprawy i ponownego uruchomienia.
- `npm audit --omit=dev`: **0 critical, 0 high, 7 moderate**. Pozostałe zgłoszenia są opisane w `docs/security/DEPENDENCY_DECISIONS_2026_10_08.md`; przed wydaniem wymagają ponownej oceny.
- `docker ps` nie wykazał uruchomionych usług Goldis. Nie testowano obecnej lokalnej instalacji ani VPS, nie uruchamiano portali live, nie odczytywano sekretów ani danych klientów.

## Stan funkcji

| Obszar | Stan | Dowód i granica |
| --- | --- | --- |
| Import, analiza, deduplikacja, korekty, częściowy start, wyniki | Zaimplementowane | Build i testy API; odbiór na bazie jednorazowej. Parser XLSX ma otwartą lukę opisaną niżej. |
| Role, sesje, granty, administracja, audyt, leady, przydziały, raporty, powiadomienia | Zaimplementowane w MVP | Testy kontraktowe, izolowany DB smoke i wybrane smoke UI. Nie ma odbioru wszystkich 38 stanów produktu ani pełnej macierzy na docelowej instalacji. |
| NIP → REGON | Adaptery i kolejka gotowe | Testy fixture, limitowanie i cache; lokalnie provider jest wyłączony. Brak odbioru rzeczywistych lookupów na docelowym środowisku i konfiguracji GUS. |
| PZU → Everest → Compensa → UFG → XLSX | Przebieg potwierdzony dla jednego wiersza | `docs/TEST_CALEGO_FLOW_LIVE_2026-10-10.md`: 49 polis w snapshot, 3 w XLSX, dane porównane z DB. To dowód historycznej próby z 10 października; bieżącego drzewa nie sprawdzono ponownie live. Nie jest to odbiór dużej partii ani wszystkich wyjątków. |
| Drugi wiersz tej samej kolejki | Kontrolowane zatrzymanie | `docs/TEST_DWOCH_WIERSZY_LIVE_2026-10-10.md`: `IDENTITY_NOT_FOUND`, bez błędnego użycia tożsamości poprzedniej firmy. Nie potwierdzono jego ścieżki Compensa/XLSX. |
| Pozostałe typy podmiotów | Niezaimplementowane jako pełny automat | `identity.ts` rozwiązuje wyłącznie potwierdzoną JDG; inne typy trafiają do review. Potrzebna decyzja, czy produkcja ma obejmować tylko JDG. |
| Druga automatyzacja | Bez specyfikacji i wykonania | Katalog może ją kontrolować uprawnieniami, lecz nie ma osobnego procesu automatyzacji. |

## Blokery wydania

1. **P0 — import XLSX może wyczerpać pamięć API.** Walidator liczy fizyczne `row`/`c`, nie rozmiar scalonych zakresów; późniejszy ExcelJS je rozwija. Luka została odtworzona w `docs/AUDYT_BEZPIECZENSTWA_CALEJ_APLIKACJI_2026-10-09.md`. Trzeba ograniczyć/odrzucić scalenia i sprawdzić pozostałe struktury o dużej ekspansji, najlepiej izolując parser zasobowo.
2. **P0 — granica proxy i limiter IP.** `apps/web/next.config.ts` przekazuje `/api` przez rewrite, `apps/web/proxy.ts` nie normalizuje nagłówków forwarding, a API ufa IP z ustawionego proxy. Poprzedni audyt odtworzył obejście budżetu po zmianie `X-Forwarded-For`. Wymagana brama usuwająca wejściowe nagłówki i test na docelowym łańcuchu HTTPS/proxy.
3. **P0 — poufność i prawa usług.** Eksport z PESEL trafia jako jawny XLSX do trwałego magazynu; źródłowe dane i snapshoty są jawne w PostgreSQL. Compose używa jednego konta DB dla migracji i runtime, które było superuserem w audytowanym wariancie. Worker nie włącza jawnie sandboxu Chromium. Wymagana decyzja o zakresie danych eksportu, ochrona magazynów i backupów, rozdzielenie kont/sekretów oraz test skutecznej izolacji.
4. **P0 — publiczna topologia i konta uprzywilejowane.** Compose publikuje web/API na loopback bez dostarczonej bramy HTTPS, Redis nie ma ACL, a reset haseł/granty/role nie wymagają świeżego step-up/MFA. Przed publicznym dostępem potrzebne są HTTPS, poprawne cookie/origin/proxy, ochrona administracji i testy black-box staging.
5. **P1 — wydanie, odtworzenie i obserwowalność.** Brak odebranego cold restore DB+eksporty+klucze+dziennik kasowania na drugiej instalacji VPS, ustalonego RPO/RTO, alertów i scenariuszy disk-full/reboot/awaria workerów. Lokalny skrypt backupu i test kryptografii nie zastępują tej bramki. Migracje muszą przejść od aktualnej kopii schematu, a release powinien mieć commit, digest obrazów i procedurę rollbacku.
6. **P1 — odbiór automatyzacji na docelowym środowisku.** Sprawdzić headless Chromium, SSO/SMS, restarty, wznowienie niepewnej akcji bez drugiej oferty/UFG, brak polis, większą partię, pięciu użytkowników, poprawność snapshotów/XLSX i czas wykonania. Dotychczasowy live test jednego ukończonego wiersza jest ważnym dowodem, lecz nie pokrywa tych warunków.
7. **P1 — czerwony test migracji i końcowe QA.** Uzgodnić `users_schema_seed` z nową regułą wspólnego odczytu OC, uruchomić całą macierz migracji, a następnie odbiór 38 stanów i błędów UI oraz pełnej macierzy ról na stagingu.

## Szacunek pozostałej pracy

Zakładam **pierwszą produkcję dla jednej organizacji i wyłącznie potwierdzonych JDG**, do pięciu użytkowników, z dostępem do VPS, kont testowych portali i osobą podejmującą decyzje o danych. Dla jednego doświadczonego wykonawcy to orientacyjnie **45–75 osobodni, czyli około 9–15 tygodni kalendarzowych**; równoległa praca backendu, bezpieczeństwa i infrastruktury może skrócić kalendarz, ale nie usuwa czasu odbioru portali.

| Pakiet | Osobodni |
| --- | ---: |
| Parser XLSX, proxy/IP, czerwone testy migracji i regresja | 6–10 |
| Poufność danych, role DB, sandbox, MFA/step-up, HTTPS/Redis | 16–27 |
| Backup i restore VPS, monitoring, alerty, release/rollback | 10–17 |
| Odbiór automatu JDG, partii, restartów i błędów na staging/live | 8–14 |
| Pełne QA ról, 38 stanów UI, benchmark i przekazanie | 5–7 |
| **Razem, bez drugiej automatyzacji i nowych typów podmiotów** | **45–75** |

Obsługa spółek i innych typów firm wymaga osobnej analizy ścieżek PZU/Compensy oraz decyzji o wymaganym pokryciu. Druga automatyzacja nie ma jeszcze specyfikacji, więc **nie jest ujęta w szacunku**. Rzeczywisty termin zależy też od dostępności środowiska i dostawców portali.

## Warunek decyzji go-live

Zamknąć P0, uzyskać zielone testy migracji i security na docelowej topologii, odtworzyć kopię na drugim środowisku, przejść scenariusze partii i awarii oraz zatwierdzić protokół biznesowy dla jawnie ograniczonego zakresu podmiotów. Dopiero wtedy wydać obrazy z identyfikowalnego commita i włączyć przyjmowanie zadań.
