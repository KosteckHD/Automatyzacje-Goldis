# 1. Plan implementacji i odbioru fundamentów technicznych

Data: 8 października 2026. Obowiązują [wspólne zasady](README.md). Odpowiada punktowi 1 poprzedniego podsumowania oraz P00 planu nadrzędnego.

## Cel i założenia

Zbudować wiarygodną bazę dla nowych funkcji: kod kompiluje się, migracje wykonują się na realnym PostgreSQL, Redis działa zgodnie z kontraktem, sesje/uprawnienia są aktualne i testy nie dotykają cudzych zasobów. Ten punkt nie jest zakupem VPS ani pełnym odbiorem produkcji.

Stan wejściowy tego planu: build i testy syntetyczne zaliczono w audycie 8 października; wówczas migracje kończyły się na 033, a odbiór bazy na 030. Po przygotowaniu planu dodano migrację 034 i użytkownik uruchomił lokalny Docker Linux Engine. Bieżące odbiory świeżej bazy, upgrade tenant-scope oraz Redis opisuje [raport wdrożenia](../STATUS_WDROZENIA_PLANOW_1-7_2026-10-08.md). Istniejącego PostgreSQL na 5432 nadal nie używać do testów.

Nie nadpisywać obecnych zmian użytkownika. Nie wykonywać `reset`, automatycznego czyszczenia repozytorium ani migracji działającej instalacji w celu uzyskania PASS.

## Mapa implementacji

| Istniejący obszar | Punkt startowy |
| --- | --- |
| Izolacja modułów | [test-module.cjs](C:/Users/micha/Desktop/Goldis-Automatyzacje/scripts/test-module.cjs), [test-module.test.cjs](C:/Users/micha/Desktop/Goldis-Automatyzacje/scripts/test-module.test.cjs) |
| Baza testowa | [Test-GoldisDatabase.ps1](C:/Users/micha/Desktop/Goldis-Automatyzacje/scripts/Test-GoldisDatabase.ps1), [run-db-integration.cjs](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/scripts/run-db-integration.cjs) |
| Redis testowy | [Test-GoldisSecurityRedis.ps1](C:/Users/micha/Desktop/Goldis-Automatyzacje/scripts/Test-GoldisSecurityRedis.ps1) |
| Modele / migracje | [db.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/db.ts), katalog `apps/api/src/migrations` |
| Sesja i blokady | [session.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/session.ts), [user-serialization.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/user-serialization.ts) |
| HTTP i preflight | [http-bootstrap.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/http-bootstrap.ts), [local-preflight.cjs](C:/Users/micha/Desktop/Goldis-Automatyzacje/scripts/local-preflight.cjs) |

## Kontrakty i wynik prac

- Jawny manifest testów: wybrany moduł, pliki, wymagane usługi, syntetyczne dane, dopuszczalne hosty i zasoby cleanup.
- Osobne scenariusze DB: nowa instalacja 001→aktualna oraz upgrade 030→aktualna. Schemat 030 tworzyć migracjami na tymczasowej DB; nie pobierać danych klientów do fixture.
- Weryfikacja zgodności sesji: zmiana hasła/reset/blokada konta/grantu i aktywność użytkownika dają przewidywalny efekt w już istniejącej sesji.
- Raport techniczny rozdziela build, unit/HTTP, PostgreSQL, Redis i fixture browser. Nie sumuje tych dowodów w deklarację odbioru live.
- Nie jest potrzebna nowa tabela domenowa tylko dla raportu testu; pliki wynikowe wersjonować jako dowody bez sekretów.

## Implementacja krok po kroku

1. **Zamrozić stan odniesienia.** Zapisać HEAD, `git status`, wersje runtime i lockfile oraz listę lokalnych zmian objętych testem. Przypisać dowody do rzeczywistej wersji, nie tylko HEAD, jeśli drzewo jest brudne. Wynik: manifest bazowy bez sekretów.
2. **Rozrysować granice runnera.** Sprawdzić wszystkie procesy potomne i przełączniki dziedziczone z env. Dodać brakujące testy: moduł submission nie uruchamia workera, results nie robi lookup, obcy host/profile/DB odrzucony przed mutacją.
3. **Zapewnić izolowany runtime.** Uruchomić własny PostgreSQL i Redis na wolnych portach, z losowymi nazwami i identyfikatorem właściciela. Jeśli lokalny runtime nie działa, przygotować osobne środowisko testowe; brak środowiska raportować jako BLOCKED, bez użycia istniejącej DB.
4. **Sprawdzić cleanup.** Sprzątanie po sukcesie, błędzie i przerwaniu. Przed usunięciem sprawdzić identyfikator zasobu i absolutną ścieżkę. Test pozostawia obcy kontener/katalog bez zmian. Wynik: powtarzalny start i koniec modułu.
5. **Zaliczyć nową instalację.** Migracje od 001 do bieżącej; porównać kolumny, FK, indeksy i constrainty z modelami. Drugie uruchomienie migratora nie zmienia danych ani schematu. Błąd migracji pozostawia rozpoznawalny stan do naprawy.
6. **Zaliczyć upgrade z 030.** Wprowadzić syntetyczne konta, sesje, granty i runy, następnie 031–033 i późniejsze wymagane migracje. Sprawdzić backfill credential revisions, nowe zasady download oraz idle activity bez utraty powiązań. Zachować dowód poprzedniego i nowego schematu.
7. **Sprawdzić konkurencję sesji.** Równoległy login/reset/change-password oraz disable użytkownika podczas operacji. Sprawdzenie roli/grantu musi korzystać z aktualnego członkostwa; stara sesja nie odzyskuje praw. Utrzymać jedną kolejność blokad; deadlock nie może prowadzić do częściowego sukcesu.
8. **Sprawdzić granty i scope.** Niezależność podglądu, wykonania i pobrania; lista/count/detail/download stosują zgodne zasady. Fixture z dwiema organizacjami i czterema istniejącymi rolami stanowi bazę regresji dla punktu 2.
9. **Zaliczyć Redis.** Rzeczywisty współdzielony limit logowania dla dwóch procesów; wygaśnięcie, reset i awaria połączenia. Potwierdzić istniejącą politykę fallback i brak nieograniczonego dostępu po awarii. Nowy provider limiter jest pracą punktu 3.
10. **Potwierdzić HTTP i konfigurację.** Ta sama fabryka HTTP dla testu/produkcji; prefiksy API, limity body/upload, błędy publiczne, CSRF i zaufanie proxy zgodne z konfiguracją. Niewłaściwa konfiguracja musi dać preflight/readiness błąd, nie udawaną gotowość.
11. **Zaliczyć build i właściwe zestawy.** Uruchomić istniejące moduły runner/migrations/auth/security-db/security-redis i pozostałe dotknięte zmianami. Build wszystkich workspace. Nie uruchamiać komend pełnego flow.
12. **Wydać bazowy protokół.** Osobne wyniki, wersja schematu, lista ustaleń i znanych ograniczeń, potwierdzenie cleanup. Otwarty błąd krytyczny sesji/migracji blokuje start nowych funkcji zależnych od tego mechanizmu.

## Punkty odbioru

| ID | Kryterium |
| --- | --- |
| F01 | Test nie zapisuje do istniejącej DB/Redis/profilu, także przy odziedziczonych flagach. |
| F02 | Nowa instalacja i upgrade 030→bieżąca mają PASS; modele i schemat zgodne. |
| F03 | Powtórny migrator jest idempotentny; awaria ma diagnostykę bez sekretów. |
| F04 | Równoczesna zmiana uprawnień/hasła nie daje starym sesjom niedozwolonych skutków. |
| F05 | Grant pobrania jest niezależny; scope zgodny w list/count/detail/download. |
| F06 | Redis testowany rzeczywiście, awaria zgodna z kontraktem; brak ukrytego fail-open. |
| F07 | Build i wymagane moduły PASS, SKIP/BLOCKED wymienione oddzielnie. |
| F08 | Cleanup po przerwaniu działa tylko na zasobach testu; protokół identyfikuje badaną wersję. |

## Testy i przekazanie

Uruchomić jawnie `npm run test:module:runner`, `test:module:migrations`, `test:module:auth`, `test:module:security-db`, `test:module:security-redis`, `test:preflight` oraz `npm run build`. Dodać scenariusze izolacji/upgrade, jeśli obecne testy ich nie obejmują. Wszystkie skrócone nazwy komend w tym akapicie wymagają `npm run`.

Przekazać raport bazowy, schema manifest i instrukcję uruchamiania odizolowanych testów. Odbiór tego punktu oznacza gotową bazę implementacji; nie oznacza wdrożenia HTTPS/MFA na VPS ani odbioru całej automatyzacji.
