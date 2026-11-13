# Status implementacji porównywarki prowizji

Stan na 5 listopada 2026. Kod i konfiguracja są przygotowane w repozytorium. Nie wykonano wdrożenia na VPS ani lokalnego pełnego przebiegu z bazą i Redisem.

## Etapy

| Etap | Stan | Wykonane | Pozostałe do odbioru |
| --- | --- | --- | --- |
| P01 — kontrakt i wzorzec Python | Gotowy w kodzie | Silnik Python, kontrakt JSON, bezpieczny proces obliczeń, import słownika i eksport XLSX. Zachowany wynik referencyjny v7 oraz testy mapowania/stawek. | Ponowić parytet na zatwierdzonym środowisku odbiorowym i zapisać wynik po uruchomieniu lokalnego stacku. |
| P02 — moduł platformy i dane | Kod gotowy; smoke migracji przygotowany | Migracja 066, modele tenantowe, agenci, uprawnienia narzędzia, audyt, grant edycji słownika nadawany przez administratora z potwierdzeniem, zaszyfrowany magazyn i prywatne tabele. Dodano tryb `commission` do migracyjnego smoke testu. | Uruchomić test na pustej i aktualizowanej, izolowanej bazie. Docker Desktop nie działał podczas tej sesji. |
| P03 — import plików | Częściowo gotowy | Upload CRM/ASF/Warta, ograniczenia rozmiaru, szyfrowanie, hashe, usuwanie nieużytych plików oraz walidacja wejścia przez silnik. Raport wskazuje źródła wierszy. | Brakuje osobnego podglądu jakości i zakresu po samym wgraniu; `row_count` pozostaje `null` do czasu analizy. Dodać go przed pełnym odbiorem P03. |
| P04 — słownik | Kod gotowy; odbiór produkcyjny otwarty | Import `.xlsx`/`.xlsm` do wersji roboczej, edycja stawki i statusu dla Oli/Maćka, rewizje, publikacja, aktywacja poprzedniej wersji i przypięcie wersji do analizy. Pusta stawka nie jest zerem. | Przejść import uzupełnionego pliku klienta w Goldis i porównać wszystkie pozycje z wersją referencyjną. |
| P05 — reguły porównania | Gotowy w Pythonie | Reguły normalizacji TU/numeru, OFWCA, wariantów PZU, braków w obu kierunkach, niepewnych dopasowań, statusów bez oceny i śladu pochodzenia. | Odbiór biznesowy na nowym przebiegu; niejednoznaczne reguły i brakujące raporty pozostają jawnie nierozstrzygnięte. |
| P06 — zadania i komunikacja | Kod gotowy; test awarii do wykonania | Trwałe zlecenie/outbox, osobny worker, prywatna usługa FastAPI, idempotencja, próby wykonania, anulowanie, retry oraz zapis snapshotu. Python dostaje ograniczone środowisko bez danych dostępowych Goldis. | Zweryfikować integrację na działających PostgreSQL/Redis: restart workera, ponowną dostawę, anulowanie i spóźniony wynik. |
| P07 — panel i raporty | Kod gotowy; przebieg ręczny otwarty | Katalog narzędzi, upload, wybór dat, tabela i historia słownika, stan zadań, wyniki, odwrotny audyt i eksport Excel. | Ręcznie przejść upload → publikacja słownika → analiza → szczegóły → eksport na uruchomionej instancji. |
| P08 — lokalny odbiór i VPS | Konfiguracja przygotowana; niewdrożone | Skrypty lokalnego startu, role DB/Redis, Docker Compose dla silnika i workera, prywatna sieć, sekrety, manifesty release/backup/restore i dokumentacja wycofania. | Brak działającego Docker Desktop w tej sesji i brak dostępu do VPS. Zbudować/pobrać obrazy, wykonać backup/restore w izolacji, ustawić sekrety i przeprowadzić odbiór na VPS. |

## Weryfikacja wykonana

- `npm run build -w @goldis/api` — PASS po wydzieleniu repozytorium i publicznego kontraktu modułu.
- `npm run build -w @goldis/web` — PASS; statyczny build zawiera `/tools/commission-comparison`.
- 11 testów jednostkowych Python silnika — PASS.
- 10 testów modułów admin/prowizje i potwierdzeń administracyjnych — PASS.
- Testy kontraktu preflight (12), konfiguracji API (9) i manifestów backup/release (6) — PASS.
- Walidacja statyczna Compose produkcyjnego — PASS.
- Biome dla 14 plików modułu/UI — PASS.
- Kontrola granic: brak zależności cyklicznych, błędnych eksportów, zależności między modułami i naruszeń warstw dla prowizji. Cały repozytoryjny gate nadal zgłasza istniejący, niezwiązany z prowizjami `leads/business-leads.service.ts` (42 wywołania przy limicie 36).
- Kompilacja Python (`compileall`) — PASS.
- `apps/api/scripts/migration-smoke.cjs commission` — NIEURUCHOMIONY: wymaga odrębnej bazy PostgreSQL. Smoke obejmuje teraz migrację 066 i sprawdza tabele, agentów, rejestr narzędzia, ustawienia i akcje audytu.
- Docker live stack, pełne UI/API, backup/restore z plikami i wdrożenie VPS — NIEZWERYFIKOWANE.

## Uruchomienie lokalne po zapewnieniu zależności

1. Przygotować lokalny plik `.env.local` i sekrety skryptami repozytorium; nie umieszczać rzeczywistych plików klienta w Git.
2. Zainstalować Python 3.12 i zależności z `services/commission-engine/requirements.lock` w środowisku lokalnym.
3. Uruchomić `scripts/Initialize-GoldisLocal.ps1`, a następnie `scripts/Start-GoldisLocal.ps1`.
4. Otworzyć lokalny Goldis, nadać uprawnienie do narzędzia i wgrać zatwierdzony słownik oraz pliki wejściowe.
5. Wykonać testy P01–P08 i zapisać expected/actual bez publikowania danych klientów.

Uruchomienie kroków 1–3 wymaga dostępnego Docker Desktop dla PostgreSQL/Redis. Nie uruchamiać na wspólnej/produkcyjnej bazie migracyjnego smoke testu; skrypt wymaga oddzielnej bazy `goldis_migration_smoke_*`.

## Granica wdrożenia

Repozytorium zawiera kod i przygotowane konfiguracje, ale nie ma tu potwierdzonego obrazu z registry, konfiguracji konkretnego VPS, kompletu sekretów serwerowych ani zatwierdzonego okna wdrożenia. Dlatego status VPS to „nie wdrożono”, a nie „gotowe produkcyjnie”.
