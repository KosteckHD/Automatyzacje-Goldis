# Szczegółowy plan implementacji — każde znalezisko osobno

Podstawa: [audyt](../AUDYT_BEZPIECZENSTWA_2026-11-06.md) i [plan zbiorczy](../PLAN_NAPRAW_BEZPIECZENSTWA_2026-11-06.md). To karty projektowe przygotowane przed wdrożeniem. Zaimplementowane zmiany i rzeczywiste wyniki odbioru opisuje [status wdrożenia](../IMPLEMENTATION_STATUS_2026-11-06.md). Daty, numery migracji i propozycje nazw nowych testów trzeba zweryfikować przy rozpoczęciu implementacji. Plan przygotowano na podstawie ponownego odczytu źródeł, bez wykonywania nowych prób bezpieczeństwa w tym etapie.

## Karty do implementacji

| Karta | Zakres | Zależności | Wymagany końcowy dowód |
|---|---|---|---|
| [CYB-001](CYB-001.md) | Walidacja agent i ochrona prototypu | Brak | Realny serwis + HTTP, brak zmiany prototypu |
| [CYB-002](CYB-002.md) | Rewizje i równoczesna edycja | CYB-001 | Dwa połączenia PostgreSQL, jeden sukces i jeden konflikt |
| [CYB-003](CYB-003.md) | Atomowy zapis i audyt | Wspólny commit z CYB-002 zalecany | Błąd audytu wycofuje zmianę DB |
| [CYB-004](CYB-004.md) | Limity parsera XLSX | Brak | Odrzucenie przed alokacją + test obrazu silnika |
| [CYB-005](CYB-005.md) | Idempotencja i przejęcie zadania | Wspólny protokół z CYB-006 | Replay, retry i odzyskiwanie na PostgreSQL/Redis |
| [CYB-006](CYB-006.md) | Publikacja kontra anulowanie | Protokół CYB-005 | Obie kolejności wyścigu i rollback całej publikacji |
| [CYB-007](CYB-007.md) | Spójna polityka roli auditor | Wybór opisanego kontraktu | Macierz rola × grant na rzeczywistym serwisie/HTTP |
| [DEP-001](DEP-001.md) | Zgłoszenie uuid i utrzymanie zależności | Brak | Aktualny skan + osiągalność + zgodność wersji |

CYB-001–006 są ustaleniami technicznymi odtworzonymi w granicach opisanych w audycie. Testy PostgreSQL/Redis dla CYB-002/003/005/006 przeszły na usługach jednorazowych. CYB-004 nie był testem OOM. CYB-007 to konflikt kontraktu dostępu, a DEP-001 to zgłoszenie zależności bez wykazanego podatnego wywołania aplikacji. Nie sumować ich jako ośmiu potwierdzonych exploitów.

## Kolejność realizacji

1. CYB-001 jako mała, samodzielna poprawka wejścia.
2. CYB-004: najpierw preflight parsera, potem ograniczenia procesów. Może być realizowany niezależnie od transakcji API.
3. CYB-002 i CYB-003 w jednym spójnym pakiecie transakcyjnym, z oddzielnymi kryteriami odbioru.
4. CYB-005 i CYB-006 we wspólnym pakiecie sterowania zadaniami. Nie wdrażać tylko połowy protokołu blokad.
5. CYB-007 według wybranego kontraktu roli; ustalenie kontraktu może nastąpić wcześniej.
6. DEP-001, pełna regresja i bramki infrastrukturalne planu zbiorczego.

## Zasady wspólne

- Istniejące niezacommitowane zmiany zachować. Każdy pakiet musi mieć przeglądalny diff ograniczony do swojej odpowiedzialności.
- Nazwy plików oznaczone „nowy” są propozycjami. Zmiany backendu zachowują granice feature-driven i istniejące publiczne eksporty modułów.
- W testach HTTP nie zastępować badanego serwisu stubem. Zastępować wolno integracje zewnętrzne; przy testach wyścigów potrzebna jest prawdziwa baza.
- Dane syntetyczne, izolowany projekt DB/Redis, brak portali LIVE. Nie używać sekretów, sesji lub danych klientów do fixture.
- Nie edytować wykonanej migracji `066-commission-comparison.ts`. Kolejne migracje są addytywne; numer ustalić z aktualnego drzewa.
- Nie uruchamiać zadań DB-integration bez potwierdzenia, że wskazują wyłącznie bazę testową. Dwa procesy/połączenia i bariery sterują wyścigiem; przypadkowe opóźnienia nie stanowią dowodu.
- Sukces testu jednostkowego nie zamyka warunku PostgreSQL, Redis, obrazu Linux ani HTTPS.

## Jak dokumentować odbiór

Dla każdej karty utworzyć rekord z polami: identyfikator znaleziska, commit i hashe zmienionych plików, wersje Node/Python/DB/Redis, nazwa obrazu i digest, środowisko testowe, identyfikatory testów z karty, rzeczywisty wynik, exit code, pominięcia i ich przyczyna, pozostałe ryzyko. Dowody zapisać w nowym katalogu datowanego retestu, bez nadpisywania historycznych reprodukcji.

Statusy: `PLAN` → `IMPLEMENTED` → `UNIT_HTTP_VERIFIED` → `INTEGRATION_VERIFIED` → `RELEASE_VERIFIED`. CYB-007 wymaga ponadto zapisanego kontraktu. DEP-001 może zostać `RISK_ACCEPTED` wyłącznie przez wskazanego właściciela ryzyka, z terminem przeglądu; agent nie przyjmuje ryzyka za użytkownika.

## Weryfikacja i wydanie

Istniejące punkty wejścia do kontroli to build API/core, testy Node w odpowiednich feature, Python unittest, `npm run test:db-integration` i syntetyczne testy przeglądarkowe bezpieczeństwa. Nowe pliki testów trzeba jawnie dołączyć do runnerów i CI; samo ich utworzenie nie gwarantuje uruchamiania. Sprawdzić to celowo uszkadzając jedną asercję w roboczym teście, a następnie ją przywracając.

Wydanie dopiero po zamknięciu kryteriów odpowiednich kart i bramek SEC-G planu zbiorczego: realne ACL, proxy/HTTPS, izolacja procesów, cold restore i dziennik kasowań. Każdy rollback najpierw zatrzymuje komponenty zapisujące. Wycofanie aplikacji nie oznacza odtwarzania całej bazy ani automatycznego przywracania usuniętych grantów.
