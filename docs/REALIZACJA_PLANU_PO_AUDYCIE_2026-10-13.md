# Realizacja planu produkcyjnego — 13.10.2026

Ten rejestr oddziela gotowy kod od odbiorów wymagających działających usług i hosta. Plan źródłowy znajduje się w [`PLAN_IMPLEMENTACJI_PO_AUDYCIE_2026-10-13.md`](PLAN_IMPLEMENTACJI_PO_AUDYCIE_2026-10-13.md). Status „kod gotowy” sam w sobie nie oznacza produkcji.

## Postęp krok po kroku

| Krok | Zakres | Status teraz | Dowód / co jeszcze trzeba zrobić |
| --- | --- | --- | --- |
| 0 | Punkt odniesienia i rejestr testów | **Gotowy lokalnie** | Zwykła regresja obejmuje core, API, workera, preflight, izolowany runner testów, kryptografię backupu, manifest backupu, runtime-check i manifest wydania. |
| 1 | Granice XLSX przed ExcelJS | **Kod i regresje gotowe** | Limity kontenera/arkusza i kontrakty parsowania są w zwykłej regresji. Nadal potrzebny pomiar legalnych arkuszy na finalnym VPS. |
| 2 | Parser poza API | **Kod gotowy; odbiór izolacji zablokowany środowiskiem** | Osobny proces, limit czasu/pamięci kontenera, limit równoległości, kontrakt HTTP i health są zaimplementowane. Brak działającego Docker Engine uniemożliwia test OOM/crash całego stosu i potwierdzenie limitu cgroup. |
| 3 | Brak osoby/PESEL i ciąg dalszy kolejki | **Kod i testy jednostkowe gotowe** | Stabilne powody terminalne, brak fałszywego sukcesu/leada oraz kontynuacja kolejnych runów mają testy. Pozostaje izolowany odbiór bazy dla paczek i istniejących zadań. |
| 4 | Uprawnienia PostgreSQL | **Kod gotowy; smoke bazy zablokowany** | Wersjonowana macierz grantów i rozdzielone role są w kodzie. Trzeba uruchomić disposable PostgreSQL, wykonać wszystkie migracje i `runtime-permissions-smoke.cjs`. |
| 5 | Migrator, sekrety i Redis ACL | **Konfiguracja gotowa; test usług zablokowany** | Konta runtime, pliki sekretów, ACL Redis oraz smoke są przygotowane. Docker Engine na tym stanowisku zwraca brak `dockerDesktopLinuxEngine`; nie potwierdzono odmowy komend ACL ani działania BullMQ na żywych usługach. |
| 6 | Produkcyjne ustawienia i szyfrowanie | **Walidacja syntetyczna zaliczona** | Kontrakt fail-closed, klucze, HTTPS, wersja/commit/digest API, Docker secrets oraz overlay produkcyjny są sprawdzane fixture bez sekretów. Test nie oznacza live TLS ani uruchomionej domeny. |
| 7 | Ponowne hasło dla wrażliwych zmian | **Kod, buildy, testy i smoke UI zaliczone** | Jednorazowy token jest związany z aktorem/sesją, operacją, celem, payloadem i kluczem idempotencji; wynik operacji jest odtwarzany przy retry. MFA/TOTP pozostaje odłożone zgodnie z decyzją użytkownika. |
| 8 | MF VAT | **Kod i testy konfiguracji gotowe** | Produkcja dopuszcza MF VAT, ogranicza budżet i pacing, a nie przełącza w tle na GUS. GUS BIR jest poza pierwszym zakresem. Zewnętrzny odbiór na produkcyjnym wyjściu sieciowym wymaga VPS. |
| 9 | Regresja wydania | **Testy lokalne zaliczone z oznaczonymi pominięciami** | `npm test` przechodzi, pełny build przechodzi, a smoki admina i menedżera przechodzą. Z testów workera 54 scenariusze fixture są celowo `SKIP` w zwykłej regresji; dedykowany browser/portal fixture run nadal trzeba wykonać. |
| 10 | Domena, HTTPS i sieci | **Pakiet gotowy; hostowy odbiór zablokowany** | Nginx, production Compose, walidator topologii i instrukcja wdrożenia są gotowe. Syntetyczna konfiguracja przeszła. Nie ma VPS, DNS, certyfikatu ani testu publicznego ruchu. |
| 11 | Health i procedury awarii | **Podstawy gotowe; monitoring operacyjny częściowy** | Health endpointy, JSON runtime-check bez treści błędów i runbook są gotowe. Nie skonfigurowano zewnętrznego alert sinka, progi kolejek/dysku trzeba dostroić pomiarem, a fault tests wymagają izolowanego Engine. |
| 12 | Backup i restore | **Kod skryptów przygotowany; pełny odbiór zablokowany** | Dodano Linux `backup.sh`, `verify.sh`, `restore.sh`, manifest/checksumy, osobny aktualny journal i kwarantannę w nowych wolumenach. Testy kryptografii/manifestu oraz `bash -n` przechodzą. Nie wykonano prawdziwego dumpu ani restore; Docker jest niedostępny. Zewnętrzny storage, harmonogram, klucz poza hostem i retencja pozostają odłożone. |
| 13 | Release manifest i rollback | **Mechanizm gotowy; brak release do opublikowania** | Generator wymaga czystego commita, pełnego SHA i prawdziwych digestów; manifest zawiera checksums konfiguracji/migracji/grantów. Testy logiki przechodzą. Generator celowo nie utworzył manifestu, bo workspace nie jest czystym, zatwierdzonym release. |
| 14 | VPS i live acceptance | **Zablokowany decyzją/środowiskiem** | VPS jeszcze nie ma. Po jego wyborze dochodzą DNS/firewall/TLS, registry, zewnętrzny backup/cold restore, odbiór kont portalowych i ograniczony test live. Live pozostaje wyłączone do odbioru. |

## Wyniki wykonanych kontroli

- `npm run build` — **PASS** dla core, API, worker i Next.js web.
- `npm test` — **PASS**. Ostatni pełny przebieg: core 14/14, API 216/216, worker 106 PASS, 0 FAIL, 54 SKIP; preflight 12/12; runner modułów 12/12; backup crypto 1/1; manifest backupu 4/4; runtime-check 3/3; generator release manifestu 2/2.
- `node scripts/test-production-compose.cjs` / `npm run test:production-compose` — **PASS** z syntetycznymi digestami/plikami sekretów; walidator sprawdził rzeczywisty wynik `docker compose config` bez łączenia z daemonem.
- `bash -n deploy/backup/backup.sh`, `verify.sh`, `restore.sh` — **PASS**.
- `node apps/web/scripts/admin-ui-smoke.cjs` oraz `manager-ui-smoke.cjs` — **PASS**.
- `docker version` — **BLOCKED_ENVIRONMENT**: Docker CLI działa, ale lokalny Linux Engine nie odpowiada na `npipe:////./pipe/dockerDesktopLinuxEngine`.

## Blokady przed produkcją

1. Uruchomić Docker Engine i dedykowane testy PostgreSQL, grantów/Redis ACL, migracji, parser fault/OOM, backupu i kwarantannowego restore. Sam test fixture Compose nie zastępuje testu działających kontenerów.
2. Odpalić dedykowane testy przeglądarkowe z fixture; rozstrzygnąć każdy wymagany `SKIP` jako zaliczony scenariusz albo świadomie wyłączony zakres.
3. Przejrzeć i zatwierdzić czysty zestaw zmian. Obecny workspace zawiera rozległe modyfikacje i pliki nieśledzone z wcześniejszej pracy; nie utworzyłem commita ani taga, które mogłyby przypadkowo wciągnąć taki zakres.
4. Wybrać VPS, domenę i registry; wstawić prawdziwe digesty z jednego commita; uruchomić hostowy firewall/Nginx/TLS i zewnętrzny smoke.
5. Później ustalić lokalizację kopii poza hostem, synchronizację aktualnego journala, posiadacza klucza/hasła, harmonogram, retencję i kanał alarmów. Wykonać cold restore na innym hoście oraz zmierzyć RPO/RTO.
6. MFA jest odłożone; nie jest wliczone w bieżący zakres. Portal-workera nie uruchamiać live przed ręcznym odbiorem przypadków i checkpointów.

Na obecnym etapie platforma ma przygotowany znaczny pakiet produkcyjny, ale **nie jest jeszcze gotowa do uruchomienia produkcyjnego**. Najbliższym technicznym krokiem jest uruchomienie Docker Engine i wykonanie blokowanych smoke DB/Redis/restore; niezależnie od tego do publicznego go-live potrzebny będzie VPS i wskazane decyzje operacyjne.
