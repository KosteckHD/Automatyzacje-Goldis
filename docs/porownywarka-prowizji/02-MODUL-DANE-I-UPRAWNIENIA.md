# P02 — moduł Goldis, dane i uprawnienia

Zależności: kontrakt P01; model komunikacji z P06. Efekt: nowy moduł ma bezpieczne miejsce w platformie i trwałe dane, zanim zostanie podłączony interfejs uruchamiania analiz.

## 1. Miejsca integracji

- `apps/api/src/features/commissions/`: kontrolery, DTO, serwisy aplikacyjne, repozytoria i publiczne kontrakty.
- `apps/api/src/features/tools/`: wpis `commission-comparison`, dostępność i ustawienia.
- `apps/api/src/features/authorization/`: granty, uprawnienia do zasobów i pobierania.
- `apps/api/src/composition/`: rejestracja modułu i modeli.
- `apps/api/src/infrastructure/database/migrations/`: kolejne migracje według aktualnej numeracji.
- `apps/api/src/infrastructure/artifacts/`: kontrolowany magazyn źródeł prowizyjnych i adapter do istniejącego szyfrowania.
- `apps/web/app/tools/tool-catalog.tsx`: nawigacja obecnie zależna od narzędzia OC.

Kontrolery i repozytoria innych modułów nie stają się publicznym API przez przypadkowe re-eksporty. Zachować kontrole granic funkcji w repozytorium.

## 2. Model danych

Projekt fizyczny uszczegółowić z kontraktem P01; proponowane tabele:

| Tabela | Dane i niezmienniki |
| --- | --- |
| `commission_agents` | ID osoby prowizyjnej, tenant, nazwa i aliasy/identyfikatory OFWCA. Brak zależności od loginu. |
| `commission_files` | Tenant, typ źródła, hash, nazwa prezentowana, klucz magazynu, stan importu i wersja parsera. |
| `commission_source_rows` | Znormalizowane wiersze CRM/rozliczenia z pochodzeniem i zachowanymi polami surowymi potrzebnymi do audytu. |
| `commission_dictionary_versions` | Wersja robocza/opublikowana, poprzednik, autor, czas, rewizja i hash. |
| `commission_dictionary_entries` | Ryzyko, wariant, warunki, status i procent dla każdej osoby. |
| `commission_rule_versions` | Jawne, wersjonowane aliasy, przypisania i reguły numerów. Bez wykonywania kodu użytkownika. |
| `commission_runs` | Zakres dat, właściciel, stan, przypięte wersje, snapshot i jednostki liczników. |
| `commission_run_files` | Powiązanie analizy z konkretnymi, niezmiennymi importami. |
| `commission_findings` | Wynik dla polisy albo pozycji, typ jednostki, dopasowanie, ocena, kierunek braku i dowód źródłowy. |
| `commission_resolutions` | Wyjaśnienia i decyzje z autorem; nie nadpisują wyniku historycznej analizy. |
| `commission_dispatches` | Trwałe zlecenie, typ operacji, próba wykonania, aktualny token, terminy i stan publikacji do kolejki. |

Eksporty podłączyć do istniejącego modelu artefaktów przez jawny kontrakt; jeżeli model jest związany wyłącznie z runem OC, wprowadzić poprawne powiązanie prowizyjne zamiast podstawiać fikcyjny run OC.

Każda relacja użytkowego zasobu ma `tenant_id`. Gdzie potrzebne, stosować złożone klucze obce obejmujące tenant, aby błędne połączenie zasobów nie omijało zakresu. Procenty przechowywać w `NUMERIC` o precyzji zgodnej z P01. Surowe numery i znormalizowane klucze to tekst, nie liczby.

## 3. Migracje i rejestracja

1. Sprawdzić najnowszą numerację i stan schematu; nie modyfikować zastosowanych migracji.
2. Utworzyć struktury, indeksy tenant/data/status, ograniczenia słownika i relacje pochodzenia.
3. Dodać katalog narzędzia z domyślnym brakiem dostępu dla zwykłego użytkownika.
4. Nie dodawać rzeczywistych klientów, plików i stawek w migracji. Słownik v7 trafia jako prywatny import startowy.
5. Zarejestrować modele i moduł, aktualizując inwentarze oraz testy architektury.
6. Sprawdzić migrację pustej bazy i uaktualnienie kopii izolowanego schematu.

## 4. Dostęp

Wykorzystać istniejące prawa `discover`, `execute`, `view_results`, `download_results`. Dodać odrębny grant zarządzania słownikiem, np. `canManageCommissionDictionary`; samo uruchamianie analiz go nie nadaje.

Przykładowy rozdział:

- Odczyt: lista wyników i użytej wersji słownika.
- Wykonanie: import, przygotowanie zestawu i utworzenie analizy.
- Zarządzanie słownikiem: robocza edycja, import zmian i publikacja wersji.
- Pobieranie: każde pobranie źródła/raportu sprawdzane po stronie API; dostęp do źródeł można ograniczyć osobniej niż do wyników.

Tenant i użytkownik pochodzą wyłącznie z sesji. Weryfikować grant przed paginacją/liczeniem, przed odczytem pliku i ponownie przed wykonaniem lub publikacją wyniku zadania. Wyjątki wspólnego dostępu do OC nie obejmują automatycznie prowizji. Brak parametru nie może w tym module kierować zapytania do domyślnego identyfikatora OC.

## 5. Pliki i szyfrowanie

1. Wprowadzić klucze źródeł w rodzaju `commission-inputs/<uuid>.xlsx` lub `.xlsm`, z zamkniętą listą formatów. Nigdy nie składać ścieżki z nazwy przesłanej przez klienta.
2. Zachować hash oryginału i zaszyfrowaną kopię. Przetwarzanie nie nadpisuje oryginału.
3. Użyć istniejącego mechanizmu szyfrowania po stronie Node przez jawny adapter. Python dostaje dane konkretnego zadania w połączeniu wewnętrznym; nie dostaje keyringu.
4. Powiązać plik, normalizację, run i eksport. Usuwanie oraz istniejący deletion journal obejmują cały ten zakres i blokują spóźniony zapis.
5. Rozdzielić retencję danych biznesowych od sprzątania tymczasowych plików i sierot po awarii.

## 6. Proponowane publiczne API

Prefiks: `/api/tools/commission-comparison`.

- `POST /files`, `GET /files/:id`: przyjęcie dokumentu i stan parsowania.
- `POST /input-preview`: zakres, manifest plików i jakość danych.
- `GET /dictionary/versions`, operacje draft/import/diff/publish opisane w P04.
- `POST /runs`, `GET /runs`, `GET /runs/:id`, `POST /runs/:id/cancel`.
- `GET /runs/:id/findings`, `POST /runs/:id/resolutions`.
- `POST /runs/:id/exports`, `GET /exports/:id/download`.

Tworzenie i publikacja wymagają idempotency key, a edycja oczekiwanej rewizji. Walidacja DTO nie dopuszcza dowolnych ścieżek, nazw funkcji ani fragmentów kodu Python.

## 7. Testy i kryteria zakończenia

- Tenant A nie odczyta, nie policzy, nie zmieni i nie pobierze zasobu tenant B, także po ręcznej zmianie ID.
- Każdy grant ma przypadek dozwolony i odmowę. Odebranie prawa unieważnia również możliwość skorzystania ze starego URL.
- Równoczesna edycja i podwójne żądanie nie tworzą cichego nadpisania ani drugiego zadania.
- Dane domenowe i audyt są zapisywane atomowo; błąd audytu nie zostawia opublikowanej zmiany.
- Źródło `.xlsm` ma własny bezpieczny typ magazynu; nie obchodzimy regexu magazynu `.xlsx` dowolną ścieżką.
- Istniejące katalog, granty, pobieranie i kontrakty OC nadal przechodzą testy regresji.
- Skończone są migracje, role i kontrakty potrzebne P03/P04/P06. Python nadal nie wymaga poświadczeń bazy.
