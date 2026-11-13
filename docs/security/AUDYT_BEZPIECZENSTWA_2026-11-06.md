# Audyt bezpieczeństwa Goldis — 6 listopada 2026

Status: zakończony przegląd kodu i ograniczone testy lokalne; poprawki nie zostały wdrożone. Sześć ustaleń technicznych odtworzono na poziomie serwisu, parsera lub sterowania workerem. Osobno wykazano konflikt polityki roli auditor. Nie wykonano pełnego pentestu ani odbioru produkcyjnego.

## Zakres i metoda

Badano bieżące, zmienione drzewo robocze o bazowym commicie `af512e9502218d336b4b73df0c5f612905c6ac7b`, nie wyłącznie stan HEAD. Repozytorium zawiera wiele wcześniejszych zmian; w tym etapie nie zmieniono źródeł aplikacji ani konfiguracji wdrożenia. Przebudowano core/API, wykonano testy syntetyczne i zapisano dokumentację oraz dowody. Nie odczytywano plików sekretów, nie uruchamiano portali, usług klienta ani pełnego procesu.

Zastosowano cztery już zainstalowane instrukcje ze wskazanej przez użytkownika [biblioteki mukul975](https://github.com/mukul975/anthropic-cybersecurity-skills), z wersji zapisanej w historycznym [manifeście](audit-2026-11-06-skills/manifest.json): `performing-web-application-penetration-test`, `conducting-api-security-testing`, `detecting-broken-object-property-level-authorization`, `performing-web-application-vulnerability-triage`. Metody: analiza powierzchni wejść, granic uprawnień i pól, sesji, walidacji oraz triage dowodów. Przykładowych poleceń ofensywnych nie uruchamiano. Zastosowano przegląd kodu i lokalne harnessy zamiast Burp/DAST.

Pokrycie: głębszy przegląd modułu prowizji, wybrane rzeczywiste mechanizmy auth/autoryzacji, parser Python, frontendowe CSP i potencjalne miejsca XSS, worker OC oraz konfiguracja wdrożenia i backupu. [Inwentarz 159 tras](audit-2026-11-06-skills/route-review.csv) jest listą dalszych testów, a nie deklaracją zaliczenia każdej trasy. Raporty szczegółowe: [auth/API](audit-2026-11-06-skills/auth-api-review.md), [worker i wdrożenie](audit-2026-11-06-skills/worker-deploy-review.md), [pierwszy etap prowizji](audit-2026-11-06-skills/README.md). Niniejszy raport scala te ustalenia i wyniki ponownej weryfikacji.

Priorytet P1 oznacza naprawę lub rozstrzygnięcie przed publicznym wydaniem; P2 — zaplanowany hardening lub utrzymanie zależności. Waga opisuje wpływ, a status dowodu jego pewność. Nie nadano pozornie precyzyjnych ocen CVSS dla scenariuszy bez potwierdzenia runtime.

## Rejestr ustaleń

| ID | Ustalenie | Waga / priorytet | Poziom dowodu |
|---|---|---|---|
| CYB-001 | Modyfikacja wspólnego prototypu przez pole agent | Średnia / P1 | Rzeczywisty skompilowany serwis, syntetyczne adaptery |
| CYB-002 | Edycje tej samej rewizji przyjmowane równolegle | Średnia wstępna / P1 | Dwa przyjęte wywołania serwisu; PostgreSQL do retestu |
| CYB-003 | Zapis słownika przed oddzielnym audytem | Średnia wstępna / P1 | Błąd adaptera audytu po save; trwałość DB do retestu |
| CYB-004 | Rozwijanie scalonych komórek przed limitem parsera | Wysoka potencjalna dostępność / P1 | Instrumentowany parser; rzeczywistego OOM nie wywoływano |
| CYB-005 | Ponowne wykonanie zakończonego zadania prowizji | Średnia wstępna / P1 | Rzeczywisty kod workera, syntetyczny harmonogram SQL |
| CYB-006 | Publikacja snapshotu mimo przegranego wyścigu z anulowaniem | Średnia wstępna / P1 | Rzeczywisty kod workera, syntetyczny harmonogram SQL |
| CYB-007 | Auditor z grantem widzi leady wbrew instrukcji roli | Warunkowa średnia / P1 | Odtworzony odczyt; obowiązujący kontrakt wymaga ujednolicenia |
| DEP-001 | Advisory uuid w ścieżkach ExcelJS/Sequelize | Moderate skanera / P2 | Advisory obecne; podatne wywołanie aplikacji niewykazane |

### CYB-001 — prototype pollution (CWE-1321)

`apps/api/src/features/commissions/commissions.service.ts:387–445`, zwłaszcza lookup `entry.agents[person]` na linii 408. Kontroler przyjmuje agent jako unię TypeScript, bez walidacji tej wartości w runtime. Użytkownik musi mieć sesję, execute narzędzia, CSRF oraz prawo edycji słownika lub rolę admin.

Wywołanie rzeczywistego serwisu z kluczem prototypu zmieniło status i rate w Object.prototype; niezwiązany obiekt dziedziczył zmienioną stawkę. Serwis zapisał rekord i audyt. Test działał w jednorazowym procesie i przywrócił prototyp. Potwierdzono naruszenie izolacji stanu procesu. Nie wykazano wykonania kodu, przejęcia administratora ani przekroczenia granicy tenantów.

Naprawa: ścisła walidacja runtime całego body, zamknięty zbiór agentów, kontrola własnego klucza oraz poprawnej struktury komórki przed mutacją. Dowód: [service-reproductions.json](audit-2026-11-06-skills/service-reproductions.json).

### CYB-002 — nieatomowa rewizja (CWE-362)

`commissions.service.ts:398–435`: odczyt rewizji, porównanie i save są oddzielone, bez blokady lub CAS. Model nie włącza optimistic locking. Dwa syntetyczne odczyty rewizji 1 zakończyły się dwoma sukcesami i rewizją 2. Potencjalny skutek: utrata jednej ze zmian zaszyfrowanego słownika, także podczas zwykłej pracy dwóch uprawnionych osób.

To dowód zachowania serwisu z adapterami pamięciowymi, nie wykonanego wyścigu na PostgreSQL. Naprawa: transakcja z blokadą rekordu albo warunkowy UPDATE po tenantId, id, status=draft i expectedRevision; sprawdzić liczbę zmienionych rekordów. Ten sam protokół blokowania musi obejmować publikację i edycję.

### CYB-003 — niespójność zmiany i audytu (CWE-778)

`commissions.service.ts:435–444`: save poprzedza audit.record bez wspólnej transakcji. Syntetyczna awaria audytu nastąpiła po zakończonym zapisie adaptera. Użytkownik dostaje błąd, chociaż zmiana mogła zostać utrwalona, a odpowiadającego zdarzenia brakuje. Nie wykazano, że zwykły użytkownik może wymusić awarię audytu.

Naprawa: jedna transakcja przekazywana do repozytorium i audytu. Osobno przejrzeć import, kasowanie plików, anulowanie, rozstrzygnięcia i eksport pod kątem podobnej kolejności; nie uznawać ich automatycznie za odrębne potwierdzone luki.

### CYB-004 — limity XLSX po alokacji (CWE-400)

`services/commission-engine/src/goldis_commissions/client_dictionary.py:100–106` ładuje openpyxl w trybie read_only=False, zanim sprawdzi wymiary i liczbę arkuszy. `importers/workbook.py:18–45` ogranicza ZIP, ale nie sumę ekspansji scalonych komórek. W API `commissions.service.ts:846–856` sprawdza rozszerzenie, wielkość i początek ZIP; nie stosuje zabezpieczeń istniejącego parsera importów OC.

Syntetyczny plik około 4,9 KB przeszedł validate_workbook i dotarł przez rzeczywistą funkcję import_dictionary do operacji, która rozwija zakres obejmujący ponad 17 miliardów komórek. Guard testowy zatrzymał tę operację przed alokacją. Kontrola z małym zakresem rzeczywiście utworzyła ponad 10 tysięcy komórek. Dowód: [python-merge-reverified.json](audit-2026-11-06-skills/python-merge-reverified.json).

Wymagane są uprawnienia importu słownika albo dostęp z tokenem do prywatnego silnika. To ryzyko wyczerpania zasobów silnika, nie wykazana awaria całej platformy. Limity pamięci/CPU/PID w Compose ograniczają zasięg, lecz nie zapobiegają zabiciu procesu lub kontenera. Brak testu OOM jest celowy. Naprawa: strumieniowy preflight XML przed load_workbook, limity łącznej ekspansji, wymiarów, tekstu i liczby węzłów oraz kontrola współbieżności i czasu procesów.

### CYB-005 — odtworzenie terminalnego zadania (CWE-841)

`apps/api/src/commission-worker.ts:83–103` dopuszcza dispatch completed w readRunInput. Przejście do running na linii 135 nie wymaga poprzedniego stanu queued i nie sprawdza liczby zmienionych rekordów. Wstrzyknięte ponowne dostarczenie zakończonego zadania wywołało silnik, zapisało snapshot i zdarzenie sukcesu.

Nie wykazano możliwości wysłania dowolnego zadania przez anonimowe HTTP. Redis/BullMQ używa stałego jobId i zachowuje completed, co ogranicza zwykłe duplikaty publikacji; nie zastępuje to idempotencji konsumenta w razie odzyskiwania lub ponownego dostarczenia. Naprawa: atomowe przejęcie dozwolonego stanu, fencing próby i brak efektów przy replay terminalnym. Dowód: [worker-state-reproductions.json](audit-2026-11-06-skills/worker-state-reproductions.json); realne ponowne dostarczenie Redis/DB pozostaje do odbioru.

### CYB-006 — anulowanie nie blokuje atomowo publikacji (CWE-362)

`commission-worker.ts:155–181`: sprawdzenie cancel_requested jest przed transakcją publikującą. W niej snapshot jest zapisywany przed warunkowym UPDATE runu. Wynik UPDATE nie jest sprawdzany. Po anulowaniu między sprawdzeniem a publikacją UPDATE zmienił zero rekordów, ale snapshot, dispatch completed i audyt sukcesu powstały.

To niespójność stanu i integralności wyników, a nie wykazany odczyt anulowanego wyniku przez użytkownika: serwis eksportu osobno sprawdza terminalny status. Naprawa: w jednej transakcji blokować run, sprawdzać aktualny stan i token, dopiero wtedy publikować wynik i audyt. Wszystkie ścieżki cancel/failure/retry muszą respektować ten sam protokół i token. Testy DB powinny objąć obie kolejności zatwierdzenia, nie tylko jedną stronę wyścigu.

### CYB-007 — konflikt polityki roli (warunkowo CWE-863)

`apps/api/src/features/leads/business-leads.service.ts:57–58` dopuszcza auditor do odczytu z grantem view_results. Instrukcja administratora mówi, że auditor nie czyta danych operacyjnych, a centralna polityka daje mu audit:read. Rzeczywisty serwis zwrócił syntetyczny lead z kontaktem dla auditor z grantem; bez grantu odmówił. Nie wykazano przekroczenia tenanta ani samodzielnego nadania grantu.

Jawny wyjątek w leadach może być zamierzony. Dlatego raport potwierdza konflikt kontraktu, a nie bezwarunkową eskalację. Rekomendowana podstawa planu: auditor ograniczony do dziennika, zgodnie z instrukcją administratora. Jeśli wyjątek ma być zachowany, należy uzgodnić jego zakres i zmienić centralny kontrakt oraz dokumentację. Dowód i szczegółowe warunki: [auth-api-review.md](audit-2026-11-06-skills/auth-api-review.md), [reprodukcja](audit-2026-11-06-skills/auditor-leads-reproduction.json).

## Zależności i dodatkowe ryzyka

Świeże `npm audit --omit=dev --json` zgłosiło 3 moderate, 0 high i 0 critical. Są to uuid oraz dwie ścieżki rodziców ExcelJS/Sequelize, a nie trzy niezależne exploity. [Advisory uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq) dotyczy v3/v5/v6 z buforem i offsetem; przejrzane miejsca w zainstalowanych rodzicach używają v1/v4. Nie wykazano osiągalnego podatnego wywołania z HTTP. Nie zastosowano proponowanych przez npm niezgodnych downgrade. [Wynik skanu](audit-2026-11-06-skills/npm-audit-production-reverified.json).

Świeży OSV querybatch dla 17 przypiętych pakietów Python nie zwrócił advisory. To wynik dla requirements.lock, nie dla całego środowiska ani obrazów. `pyproject.toml` nadal deklaruje FastAPI 0.116.1, podczas gdy lock ma 0.162.0; Docker instaluje lock. Trzeba ujednolicić źródło zależności przed poleganiem na skanie przy innej metodzie instalacji. [Wynik OSV](audit-2026-11-06-skills/python-lock-osv-current.json).

Dodatkowy hardening: supervisor Python nie ma globalnego budżetu równoległych executionId, a timeout nie obejmuje całego cyklu od utworzenia procesu i wysyłki wejścia. Ograniczyć liczbę procesów i pamięć/rozmiar odpowiedzi klienta API, zapewnić kill oraz sprzątanie readerów w każdej ścieżce błędu. Nie przeprowadzono testu obciążeniowego i nie liczymy tego jako kolejnej odtworzonej luki.

## Wyniki ponownej weryfikacji

| Kontrola | Wynik i granica |
|---|---|
| Build core/API | Exit 0; świeży dist do reprodukcji |
| Wybrane auth/autoryzacja/odzyskiwanie/CSRF/result-set | 63 unikalne testy PASS po retestach HTTP; w sandboxie 59 PASS i 4 błędy EACCES, następnie 7/7 PASS w czterech plikach HTTP (3 powtórzone sukcesy nie zwiększają sumy) |
| Backup crypto / manifest / runtime-check | 8/8 PASS; adaptery i dane syntetyczne |
| Python unit | 11/11 PASS; nie obejmują pełnego scenariusza dostępności |
| Reprodukcje audytu | Trzy scenariusze słownika, dwa workera, jeden roli i jedna ograniczona próba parsera odtworzone; to dowody błędów, nie PASS zabezpieczeń |
| npm / OSV | Wyniki opisane wyżej; pierwszy dostęp sieciowy sandboxa nie powiódł się, powtórka z dostępem do publicznych rejestrów zakończona |

Logi: [auth](audit-2026-11-06-skills/auth-reverified.log), [HTTP retest](audit-2026-11-06-skills/http-reverified.log), [backup](audit-2026-11-06-skills/backup-reverified.log), [Python](audit-2026-11-06-skills/python-unit-reverified.log). Pierwsza ponowna próba harnessu słownika przekroczyła timeout procesu w sandboxie; ten sam skrypt poza nim odtworzył trzy scenariusze. Nie zmieniono limitu ani kodu reprodukcji, żeby wymusić wynik.

W sprawdzonym kodzie istnieją: trwałe sesje z cofnięciem, kontrola członkostwa i tenanta, CSRF/Origin, odrębne granty, szyfrowanie artefaktów, ograniczenie nawigacji workera, role DB i Redis ACL, CSP z nonce. Wybrane testy tych mechanizmów przechodzą. To nie dowodzi ich poprawności na każdej ścieżce lub w każdej konfiguracji wdrożenia.

## Otwarty zakres i ocena wydania

Do odbioru pozostają: macierz ról i tenantów wszystkich tras z prawdziwym serwisem/DB; wyścigi PostgreSQL i dostarczanie BullMQ; skuteczne ACL Redis/DB; HTTPS i spoofing IP przez rzeczywisty proxy; izolacja Linux/sandbox przeglądarki; cold restore wraz z dziennikiem kasowań. Pełnego skanu sekretów, wszystkich obrazów i całej historii Git w tej powtórce nie wykonano. Nie należy przenosić wcześniejszych wyników na zmienione źródła bez kontroli manifestu.

Przegląd frontendowy nie znalazł oczywistego użycia dangerouslySetInnerHTML/eval jako sinka wejścia; nie jest to pełny test XSS w przeglądarce. Nie potwierdzono nowego obejścia sesji, CSRF, administratora ani granicy tenantów w przejrzanych ścieżkach. Cofnięcie grantu a dalsze wykonanie wcześniej przyjętego zadania wymaga jawnego kontraktu — szczegóły w raporcie workera.

**Decyzja techniczna: nie zamykać odbioru bezpieczeństwa przed poprawkami P1 i ich retestem.** To ocena ryzyka na podstawie dostępnych dowodów, nie gwarancja bezpieczeństwa aplikacji. Wykonalna kolejność zmian, testy i rollback: [plan implementacji](PLAN_NAPRAW_BEZPIECZENSTWA_2026-11-06.md).
