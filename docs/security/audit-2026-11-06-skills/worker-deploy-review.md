# Przegląd workera, wdrożenia i backupu — 2026-11-06

Zakres: źródła `apps/worker`, `deploy`, `docker`, Compose, Dockerfiles i `.github/workflows/backend-checks.yml`. Metoda: odpowiednie części lokalnego `performing-web-application-penetration-test/SKILL.md` z biblioteki wskazanej przez użytkownika; przegląd granic zaufania, SSRF/nawigacji, sekretów, logowania, plików i izolacji procesów. Nie uruchamiano portali ani Docker, nie czytano plików sekretów i nie zmieniano kodu aplikacji. Bieżący working tree zawiera istniejące zmiany; wynik dotyczy przeczytanych źródeł, a nie samego HEAD.

**W tym podzakresie nie potwierdzono nowej podatności pozwalającej na atak przez wejście aplikacji.** Nie oznacza to odbioru runtime ani pełnego pokrycia testami. Kontrole opisane niżej są obserwacjami kodu, jeśli nie podano wprost wyniku testu.

## Zaobserwowane zabezpieczenia

| Granica | Dowód w źródle | Co ogranicza / granica wniosku |
|---|---|---|
| Akcje portali | `apps/worker/src/features/execution/live-run.ts:139–150`, `features/execution/execution-lease.ts:105–113` | Sprawdzanie aktualnego fencing tokenu, ważności lease i terminalnego stanu runu przed akcją. Anulowany lub zastąpiony run nie powinien wykonywać kolejnych kontrolowanych akcji. Nie testowano rzeczywistego wyścigu DB/Playwright. |
| Nawigacja | `apps/worker/src/infrastructure/browser/browser.ts:137–152`, `portals/shared/portal-navigation.ts:4–11` | HTTPS, jawna lista originów i dokładna ścieżka aplikacji dla głównej ramki. Polityka nie jest firewallem całego ruchu: subresources i ramki podrzędne przechodzą dalej. Bez wykazanego źródła URL kontrolowanego przez użytkownika nie kwalifikowano tego jako SSRF. |
| Profil przeglądarki | `browser.ts:68–89`, `browser.ts:124–130`, `compose.yaml:365–376` | Atomowa blokada profilu przez `wx`, prawa `0600`, wyłączone downloady, sandbox w konfiguracji Compose, nonroot i seccomp. Sama klasa domyślnie ustawia sandbox=false; na Linuxie należy zweryfikować efektywne ustawienie procesu. Nie przenoszono tego ustawienia na ocenę Windows. |
| Staging wyników | `apps/worker/src/infrastructure/staging/result-staging.ts:41–73`, `:78–108`, `:123–150` | AES-256-GCM, AAD zależne od runId/sourceRowId, losowy identyfikator pliku, kontrola UUID, zapis `wx`/`0600`, wykrywanie symlinku katalogu. Nie znaleziono wejścia użytkownika umożliwiającego traversal. |
| Prywatny inbox SMS | `apps/worker/src/features/authentication/code-inbox.ts:144–148`, `:165–198`, `:242–247` | Bearer secret min. 32 znaki, stałoczasowe porównanie hashy, limit 1 KiB i krótkotrwały jednorazowy bufor. Przejrzany kod produkcyjny nie zapisuje kodu SMS do logu/kolejki/pliku. Nie jest to pomiar retencji całego środowiska. |
| Przesyłanie wyników | `apps/worker/src/features/results/result-forwarder.ts:42–58` | Stała ścieżka wewnętrzna, Bearer, `redirect: error`, timeout; przekierowanie nie wynosi tokena do innego hosta. Host pochodzi z konfiguracji operatora, nie ze zwykłego żądania użytkownika. |
| PostgreSQL | `docker/postgres/apply-runtime-grants.sql:4–8`, `:34–48`, `packages/core/src/runtime-database-role.ts:60–72` | Odrębne role, odebranie uprawnień domyślnych, append-only audyt, odrzucenie superuser/CREATE/BYPASSRLS/membership przy starcie. Portalowy worker nie ma dostępu do tabel sesji i uprawnień. Nie przeprowadzono świeżego testu negatywnych grantów na DB. |
| Redis | `docker/redis/start-with-acl.sh:25–28` | Default user wyłączony, odrębne konta, ograniczenia kluczy i kanałów, brak komend admin/dangerous. Listy są szerokie w obrębie kategorii; zgodność faktycznej wersji Redis/BullMQ i brak dostępu pomiędzy namespace wymaga testu runtime. |
| Proxy/HTTPS | `deploy/nginx/goldis.conf.example:29–54`, `compose.production.yaml:102` | TLS1.2/1.3, HSTS, zastępowanie nagłówków forwarded adresem klienta, blokada `/api/internal/`, publikacja web na loopback. To plik przykładowy; nie dowodzi efektywnego nginx ani zamknięcia portów hosta. |
| Backup/restore | `deploy/backup/backup.sh:28–32`, `:126–141`, `:180–188`, `restore.sh:25–35`, `:61–85`, `:95–97`, `:121–152` | Prywatne pliki, blokada backupu, zatrzymanie usług zapisujących, szyfrowanie z weryfikacją, odrzucenie niebezpiecznych ścieżek/linków, nowy projekt/wolumeny, ciągłość dziennika kasowań, unieważnienie odzyskiwania kont po restore. Nie wykonano cold restore Linux/Docker. |
| CI | `.github/workflows/backend-checks.yml:8`, `:47`, `:64` | Token contents:read, npm audit produkcyjnych zależności i pip-audit. Obecność zadań nie jest dowodem ich przejścia dla aktualnego working tree. |

## Świeżo wykonana weryfikacja lokalna

Komenda, exit code 0:

```powershell
node --test --test-reporter=spec scripts/goldis-backup-crypto.test.cjs deploy/backup/manifest.test.cjs scripts/runtime-check.test.cjs
```

**8/8 testów PASS, 0 pominiętych.** Sprawdzono round-trip backupu oraz odmowę dla złego hasła/modyfikacji, checksums plików i head dziennika, odrzucenie mutacji/starej historii, wymaganie digestów obrazów, fail-closed kontroli runtime bez ujawniania odpowiedzi oraz HTTPS dla zdalnego hosta. Testy używają danych syntetycznych i adapterów; nie potwierdzają dostępności usług, ACL ani cold restore. Nie przebudowano i nie uruchamiano testów z istniejącego `apps/worker/dist`, aby nie przypisywać aktualnym źródłom wyniku starszego builda.

## Otwarte warunki i plan domknięcia

### W1 — kontrakt cofania dostępu do wcześniej przyjętych zadań

`admin-users.service.ts:310–349` usuwa grant i przydziały, a `:491–543` wyłącza konto i cofa sesje. Te operacje nie anulują `automation_runs`. `acquireRunExecution` i `ownsRunExecution` sprawdzają stan zadania/lease, ale nie bieżące konto/grant. Instrukcja administratora (`docs/INSTRUKCJA_ADMINA.md:48`) obiecuje cofnięcie sesji/przydziałów, nie anulowanie przyjętej pracy. Z tego powodu jest to **pytanie o kontrakt biznesowy, nie potwierdzona luka**.

Plan: ustalić, czy revoke ma zatrzymać kolejkę i kolejną akcję aktywnego zadania, czy przyjęta praca działa jako zatwierdzona operacja organizacji. W pierwszym wariancie atomowo unieważniać dopuszczenie/fencing przy revoke/disable i sprawdzać je przed akcjami; nie przyznawać workerowi całej tabeli użytkowników tylko dla tej kontroli. W drugim wariancie jawnie opisać zachowanie i zapewnić odrębne anulowanie. Test DB: grant revoke przed pobraniem, w trakcie oczekiwania i po odzyskaniu lease; dokładnie ustalony skutek, zdarzenie audytowe i brak nowej akcji po potwierdzonej granicy zatrzymania. Sprawdzić osobno po zmianie roli i wyłączeniu narzędzia.

### W2 — odbiór efektywnej izolacji produkcyjnej (bramka przed publicznym wdrożeniem)

Plan: uruchomić zatwierdzone digesty na izolowanym Linuxie, zebrać zredagowane dowody nonroot/read-only/capabilities/seccomp, zweryfikować uruchomiony sandbox i osobne negatywne próby PostgreSQL/Redis. Testy: portal worker nie czyta sesji ani cudzej kolejki prowizji; API nie może modyfikować/usunąć audytu; użytkownik Redis nie wykonuje FLUSH/CONFIG ani odczytu obcych namespace; DB/Redis/API prywatne porty nie są dostępne z hosta zewnętrznego; spoofowany X-Forwarded-For nie omija ograniczeń. Kontrola TLS, HSTS, secure cookies i `/api/internal/` przez rzeczywisty proxy. Wynik statyczny Compose nie zamyka tej bramki.

### W3 — odbiór odporności i odzyskiwania (bramka operacyjna)

Plan: pełny cold restore dwóch zaszyfrowanych archiwów do nowego projektu na drugim hoście, replay dziennika kasowań, weryfikacja braku odtworzonych usuniętych danych i tokenów odzyskiwania. Zmierzyć RPO/RTO; dodać uzgodnione offsite, harmonogram, retencję i alarm braku backupu/hosta. Nie deklarować wdrożonych tych funkcji na podstawie samych skryptów. Test przerwania backupu: wracają wyłącznie wcześniej działające usługi; worker nie startuje, gdy API nie odzyska health. Brak testu restore oznacza otwartą bramkę, nie dowód awarii procedury.

### W4 — dalsze ograniczanie skutków kompromitacji (hardening)

Po zinwentaryzowaniu rzeczywistych hostów zasobów portali rozważyć egress firewall i politykę requestów obejmującą subresources/ramki, z wyjątkiem zweryfikowanych SSO/CDN. Przypiąć Actions do zatwierdzonych SHA i obrazy bazowe do digestów w procesie budowania, z regularną aktualizacją. Są to usprawnienia ochrony, bez wykazanej w tym przeglądzie ścieżki ataku przez aplikację; nie zwiększają liczby potwierdzonych luk.
