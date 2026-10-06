# Plan 2 — bezpieczeństwo danych i wdrożenie po odbiorze automatyzacji

Data: 2 października 2026. Dokument wykonawczy dla agenta kodującego.

## 1. Cel i zależność od planu 1

Celem jest przygotowanie platformy i działającej automatyzacji do bezpiecznej eksploatacji na docelowym VPS. Wykonywać po domknięciu funkcjonalnym planu 1. Odbiór lokalnego Playwright nie oznacza gotowości do publicznego wdrożenia.

Poprawki wznowienia SMS, walidacji tożsamości, świeżości wyszukiwania i kontroli aktywnego workera przy wyniku należą już do planu 1. Ten dokument ich nie powtarza; w B4 sprawdza ich integrację z uprawnieniami i współbieżnością.

## 2. Etapy, testy i warunki odbioru

### B0. Inwentaryzacja danych i konfiguracji

**Wykonać:** spisać miejsca przechowywania danych: import, DB, staging, XLSX, profil przeglądarki, logi, audit, backupy. Dla każdego określić właściciela, dostęp, szyfrowanie, czas przechowywania i sposób usunięcia. Odczytać bieżącą konfigurację w sposób nieujawniający sekretów. Zweryfikować kopię bazy oraz aktualną historię migracji; nie opierać się na historycznych opisach.

**Odbiór:** kompletna mapa danych i zależności kluczy. Jasno zaznaczone, że szyfrowanie PESEL w DB nie szyfruje eksportu, pozostałych pól źródłowych ani cookies profilu.

### B1. Sekrety, eksporty i profil przeglądarki

**Pliki/obszary:** `pesel-crypto.ts`, `result-staging.ts`, `private-artifact-store.ts`, konfiguracja wolumenów i backupów, `.gitignore`, `.dockerignore`, Dockerfile.

**Wykonać:**

- Wykluczyć z kontekstu budowania obrazu profile (`worker-profiles`, `playwright/.auth` i wszystkie rzeczywiste lokalizacje), prywatne konfiguracje, `.docker-config`, staging, eksporty, screenshoty, trace i raporty z danymi. Zapewnić Git ignore i odrębny katalog prywatny. Nie usuwać istniejących profili.
- Sprawdzić skład zbudowanego obrazu i historię repozytorium pod kątem przypadkowo opublikowanych sekretów. Rotacja jest wymagana, jeśli wykryto ujawnienie; sam brak reguły ignore nie jest dowodem ujawnienia.
- Zapewnić szyfrowanie docelowego dysku/wolumenów z importami, wynikami i profilami oraz szyfrowanie kopii. Jeśli środowisko nie zapewnia tej ochrony, przed wdrożeniem wdrożyć szyfrowanie odpowiednich plików z wersjonowaniem klucza. Sam tryb pliku 0600 nie zastępuje szyfrowania.
- Sekrety podawać z prywatnego mechanizmu konfiguracji hosta, z minimalnym dostępem. Klucze przechowywać i archiwizować oddzielnie od backupu danych. Zachować starsze wersje kluczy potrzebne do odszyfrowania istniejących danych.
- Profil traktować jako dostęp do konta: jeden właściciel, brak współdzielenia między klientami/kontami, brak publicznych downloadów. Backup wykonywać po kontrolowanym zamknięciu przeglądarki lub metodą zapewniającą spójność.

**Testy:** brak prywatnych plików w obrazie i artefaktach CI; poprawne odszyfrowanie po rotacji; brak klucza i zły klucz kończą się bezpiecznym błędem; nieuprawniony proces/użytkownik nie czyta wolumenów. Na Windows sprawdzić ACL, bo samo POSIX 0600 nie zapewnia tego samego zachowania.

**Odbiór:** udokumentowana ochrona każdego magazynu i działające odtworzenie kluczy bez ujawniania ich w raporcie.

### B2. Konfiguracja VPS i sieci

**Pliki:** `compose.yaml`, `apps/api/src/main.ts`, `session.ts`, konfiguracja reverse proxy i środowiska.

**Wykonać:**

- Ustawić API/worker w trybie produkcyjnym, rzeczywiste `PUBLIC_APP_ORIGIN` HTTPS i reverse proxy z aktualnym TLS. Cookies sesji muszą mieć `Secure`, `HttpOnly` i właściwe `SameSite`; origin/CSRF sprawdzać dla docelowej domeny.
- Zastąpić bezwarunkowe `trust proxy=1` konfiguracją odpowiadającą rzeczywistej, ograniczonej ścieżce proxy. Bezpośredni dostęp do API z zewnątrz zablokować.
- Publicznie udostępnić wyłącznie wejście WWW przez proxy. PostgreSQL, Redis, odbiorca SMS, port debugowania przeglądarki i administracja kontenerów pozostają prywatne. Endpointy `/internal/*` blokować na publicznym proxy także przy poprawnym formacie żądania.
- Rozdzielić sieci usług według koniecznych połączeń. Ograniczyć wyjście workera i kontrolować dozwolone domeny portalowe. Nie blokować niezbędnych domen SSO/zasobów bez sprawdzenia przepływu.
- Nie wyłączać walidacji TLS, origin ani zabezpieczeń Chromium w celu naprawienia problemu z logowaniem. Nie wystawiać lokalnego pliku `.env.compose.local` w panelu ani statycznych plikach.

**Testy:** logowanie/pobranie z docelowej domeny; cookies; żądania CSRF/cross-origin; spoofing `X-Forwarded-For`; niedostępność prywatnych portów i endpointów z zewnątrz. Awaria Redis limitera logowania powoduje kontrolowane odrzucenie, a nie pominięcie limitów.

**Odbiór:** poprawne HTTPS i prywatne usługi, działający login przez proxy oraz wiarygodny adres klienta dla limitera.

### B3. Kontenery i zależności

**Wykonać:** API i web uruchamiać jako użytkownik bez roota; obecnie Dockerfile nie deklarują `USER`. Przygotować build wieloetapowy z minimalnym zestawem plików runtime. Ustawić konieczne prawa wolumenów, limity CPU/pamięci, bezpieczny restart i minimalne capabilities; zachować wymagania Chromium. Profile/staging/eksporty i katalogi tymczasowe to jawnie wskazane miejsca zapisu.

Sprawdzić zależności aplikacji i obrazy skanerem podatności. Każdy istotny wynik ocenić pod kątem używanej wersji, realnej ścieżki ataku i poprawki. Aktualizacje wykonywać z pełnym testem planu 1; nie zmieniać wersji Playwright/browsera bez sprawdzenia kompatybilności i portalowych selektorów.

**Testy:** faktyczne UID procesów, możliwość uruchomienia browsera i zapis tylko do właściwych katalogów; restart; raport zależności oraz regresja pełnego flow po zmianie obrazów.

**Odbiór:** brak zbędnych uprawnień i prywatnych danych w obrazach; brak niezaakceptowanych podatności o istotnym wpływie na tę konfigurację.

### B4. Uprawnienia i równoległość platformy

**Wykonać:** odbiór przez rzeczywiste HTTP i DB, bez mockowania guardów. Sprawdzić operatora, admina i użytkownika bez grantu dla uruchamiania, SMS, interwencji, podglądu i pobierania eksportu; dodatkowo dostęp do cudzego batcha/runu. Nie polegać na ukryciu przycisku w UI.

Domknąć testy równoległych nowych uruchomień na granicy limitu godzinowego; obecny smoke pojedynczego uruchomienia i CAS ustawień nie dowodzi tego przypadku. Sprawdzić równoległe przydzielenie interwencji i odebranie grantu podczas zapisu. Ustawienia, zmiana stanu, outbox i wymagany audit mają zatwierdzać się atomowo; zasymulować błąd zapisu audytu i rollback.

**Testy:** prawidłowy użytkownik, cudzy identyfikator, odwołana sesja/grant, dwie równoległe akcje, nieaktualna rewizja, próba wywołania wewnętrznego endpointu przez użytkownika platformy. Stary worker jest odrzucany według kontraktu A1.

**Odbiór:** brak odczytu/zapisu cudzych danych i brak przekroczenia limitu przez wyścig; jednoznaczny audit decyzji bez sekretów.

### B5. Retencja i usuwanie

**Wykonać:** właściciel systemu zatwierdza osobne terminy dla importów, wyników, XLSX, stagingu, logów, audytu oraz kopii zapasowych. Nie wpisywać arbitralnego wspólnego czasu. Agent może przygotować mechanizm i testy z krótkim syntetycznym okresem przed zatwierdzeniem polityki.

Zaimplementować kontrolowane czyszczenie plików i odpowiadających rekordów, osieroconych plików po rollbacku oraz wygasłego stagingu. Nie usuwać danych aktywnego zadania ani materiału wymagającego rozstrzygnięcia interwencji. Dla profili przygotować osobną procedurę wyłączenia/zmiany konta, a nie okresowe kasowanie profilu burzące zapamiętanie urządzenia. Uwzględnić cykl wygaszania backupów oraz przerwane czyszczenie.

**Testy:** wygasły/aktywny/objęty interwencją rekord; równoległy eksport/pobranie; przerwanie i ponowienie czyszczenia; ścieżka spoza dozwolonego katalogu; próba usunięcia pliku innego zadania. Raport usuwania nie zawiera PESEL.

**Odbiór:** zaakceptowana polityka, działający harmonogram i bezpieczne, powtarzalne czyszczenie.

### B6. Monitoring, backup i odbiór VPS

**Wykonać:** alerty dla offline workera, zaległego outboxa, zadań bez aktywnego wykonania, nieobsłużonych interwencji/SMS, kończącego się dysku i błędów backupu. Samo działanie kontenera nie oznacza gotowości portali. Alerty deduplikować; nie generować nieograniczonej liczby powiadomień.

Przygotować procedury: restart, wyłączenie automatyzacji, rozstrzygnięcie szkicu Compensy, zmiana sekretów, utrata profilu oraz odzyskanie DB/kluczy/eksportów. Zweryfikować migracje na kopii aktualnej bazy przed wdrożeniem; określić rollback aplikacji i kompatybilność schematu.

**Testy:** pełne odtworzenie w izolacji, kontrolowana awaria API/worker/DB/Redis, brak miejsca, wygaśnięta sesja PZU; na docelowym VPS nadzorowany przebieg z SMS i profil po restarcie. Pierwsze logowanie na nowym VPS może wymagać ponownego MFA niezależnie od lokalnego profilu.

**Odbiór:** backup jest faktycznie odtwarzalny; osoba obsługująca otrzymuje działający alert i instrukcję; pełny przebieg oraz restart są potwierdzone w docelowym środowisku. Dopiero ten etap pozwala oznaczyć wersję jako odebraną do eksploatacji w sprawdzonym zakresie.

## 3. Kolejność i dowody

B0 → B1 → B2 → B3 → B4 → B5 → B6. Po każdym etapie dopisać dowody do `STAN_IMPLEMENTACJI.md` i `POSTEP_IMPLEMENTACJI.md`: zmienione pliki, testy, wyniki oraz ograniczenia, bez sekretów. Ujednolicić bieżące podsumowanie dokumentacji; starsze wyniki pozostawić jako datowaną historię. Nie używać stwierdzenia „całkowicie bezpieczne”; raport wymienia sprawdzone zagrożenia, otwarte ryzyka i warunki działania.
