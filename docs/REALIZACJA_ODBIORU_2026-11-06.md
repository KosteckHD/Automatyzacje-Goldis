# Goldis — wykonanie przygotowania do odbioru, 6 listopada 2026

**Wynik: poprawki i lokalna regresja wykonane. Pełny odbiór produkcyjny pozostaje niezakończony.** Zakres: jedna firma, 2–5 pracowników, OC i porównywarka prowizji. Prace wykonano w istniejącym, wcześniej zmodyfikowanym drzewie projektu; nie powstał zatwierdzony release ani wdrożenie klienta.

Nie używano bazy klienta, kont portali, prawdziwych kodów SMS ani wysyłki maili. Bazy integracyjne były osobnymi, tymczasowymi bazami lokalnego klastra PostgreSQL 18, usuwanymi przez runner po testach. Testy portali korzystały z lokalnych stron fixture.

## Co zmieniono

| Obszar | Rezultat |
| --- | --- |
| Logowanie i prowizje | Powrót do submissions i prowizji korzysta ze wspólnej walidacji adresu. Błąd zasobu 503 nie wylogowuje. Ponowienie Start z tymi samymi danymi zachowuje klucz idempotencji w bieżącym widoku. |
| Aktualizacja list | Wyniki i lista submission ponownie pobierają załadowane strony podczas odświeżania; usunięto zamrożenie raz pobranych elementów. Pełny test tego zachowania w połączonym stosie pozostaje do wykonania. |
| Przerwy automatyzacji | Compensa przekazuje brakujące pole do interwencji. Niepewny zapis i niepewne UFG zatrzymują sprawę do weryfikacji. Nie wprowadzono automatycznego ponawiania niepotwierdzonego skutku. |
| Uprawnienia | Metadane zespołu pokazują rzeczywisty grant pobierania. Wspólny odczyt OC nie oznacza automatycznego prawa eksportu. Poprawiono nieaktualne oczekiwania macierzy grantów w testach integracyjnych. |
| Backend | Wydzielono małe repozytorium rekordów leadów z zachowaniem transakcji i blokad. Gate architektury przechodzi bez podnoszenia limitu wyjątków. |
| Zależności Node | Next 16.4.5, body-parser 2.4.0, qs 6.17.1 i obie kopie Multer 2.5.0. Instalacja z package-lock została odtworzona przez npm ci. |
| Zależności Python | FastAPI 0.162.0, Starlette 1.3.1, AnyIO 4.14.2, IDNA 3.15; uzupełniony kompletny zestaw pinów, zgodność sprawdzona przez pip check. |
| Linux i recovery | Standardowe nazwy sekretów portali z opcją wskazania nazw historycznych; skrypt praw root:1000/0640 dla procesów non-root; dodatkowa grupa silnika Python. Restore ponawia nadanie ownership po imporcie, kopiuje pliki jako root do wolumenów i wymaga oddzielnej sieci frontendu. Worker ma 60 s na zamknięcie. |
| Minimalne sekrety | Import-parser nie montuje tokena silnika prowizji. Token lokalnego podglądu, katalog output i lokalne kopie Git są wykluczone z repozytorium i obrazów. |
| Powtarzalność | Uaktualnione inwentarze, listy testów i pięć ról w harnessie DB. Do fixture’ów dołączono brakujące testy wyboru klienta Compensy i rozpoznawania SMS. |
| CI i utrzymanie | Dodano zadania audytu Node/Python, testów silnika i przeglądarki. Przygotowano lokalny checker usług/kopii/dysku i szablony systemd w deploy/monitoring. Nie aktywowano ich na hoście klienta. |

Kontrola stylu wymagała uporządkowania formatowania i importów w plikach backendu. Zachowano odrzucanie znaków sterujących w wyszukiwaniu; zapisano je predykatem kodów znaków. Pozostało 48 ostrzeżeń lint, bez błędów.

## Wykonane kontrole i dowody

| Kontrola | Wynik i granica dowodu |
| --- | --- |
| Pełne npm test | **PASS**, końcowe ponowienie: [checks](acceptance/2026-11-06-npm-retest/checks.json), [log](acceptance/2026-11-06-npm-retest/npm-test.log). Core 22, API 386, worker 128 zaliczonych. Pozostałe bramki skryptów zawiera pełny log. |
| Domyślne SKIP workera | 85 pominięć opt-in; wszystkie rozliczone osobnym PASS lokalnych fixture’ów: [mapowanie tytułów](acceptance/2026-11-06-final/skip-reconciliation.json). To nie jest dowód działania aktualnych portali LIVE. |
| Browser fixtures | Everest 29/29, Compensa 48/48, UFG 15/15 i dodatkowe 9/9. [Pierwsze pakiety](acceptance/2026-11-06-extra/checks.json), [dodatkowe testy](acceptance/2026-11-06-browser-coverage/checks.json). W pierwszym rejestrze nieudana wcześniejsza próba DB jest zachowana; końcowy DB ma własny retest poniżej. |
| Build, styl i Compose | **PASS**: [checks](acceptance/2026-11-06-final/checks.json). Compose sprawdzono na syntetycznych sekretach i digestach fixture; nie zbudowano ani nie uruchomiono obrazów produkcyjnych. Pierwszy npm-test w tym rejestrze jest FAIL i został zastąpiony jawnym retestem, nie usunięty. |
| Migracje i bezpieczeństwo DB | **PASS na PostgreSQL 18**: users, tenant-scope, runtime-roles oraz commission, migracje 001–066. [Końcowy retest](acceptance/2026-11-06-extra-native-retest3/checks.json). Sprawdzono m.in. cofanie grantów, sesje, audyt/rollback, tenant scope, rzeczywiste ACL i brak podwyższonych praw wszystkich pięciu ról. Nie zastępuje PostgreSQL 17/Redis/Compose. |
| Python | **15/15 PASS** w osobnym venv odtworzonym z nowego lockfile: [checks](acceptance/2026-11-06-python-final/checks.json), [log](acceptance/2026-11-06-python-final/commission-python.log). Testy HTTP obejmują gotowość, brak publicznej dokumentacji, token, ścisłe DTO, limit 4096/4097 bajtów i wymagany Content-Length. |
| Przeglądarka aplikacji | **PASS** dla CSP/nonce, no-store, anti-frame, aktywności sesji, recovery, weryfikacji maila oraz błędu sesji/routingu/idempotentnego retry prowizji. Mock API; bez połączonego backendu. [Log](acceptance/2026-11-06-final/security-browser.log). |
| Audyt zależności | Node: **0 critical, 0 high, 3 moderate**. Python: **brak znanych podatności** według pip-audit. [Audyt Node](acceptance/2026-11-06-final/dependency-audit-node.json), [audyt Python](acceptance/2026-11-06-final/dependency-audit-python.json). Nie obejmuje systemu bazowych obrazów. |
| Sekrety | Gitleaks 8.30.1 z oficjalnego archiwum zweryfikowanego SHA256. Historia: 4 commity, 8 wskazań syntetycznych wartości testowych. Końcowy snapshot kodu: 937 plików, 5 wskazań testowych kluczy idempotencji. Początkowy szerszy skan znalazł też sumy kontrolne i metadane lokalnego podglądu UI. [Triage bez wartości sekretów](acceptance/2026-11-06-final/secret-scan-triage.json). Brak potwierdzonego sekretu produkcyjnego w zbadanym zakresie. |
| Skrypty hosta | Składnia Bash restore, przygotowania uprawnień i monitoringu przechodzi. Wykonanie Linux, bind mounts i alarmy wymagają osobnego testu. |

Wcześniejsze błędy nie zostały ukryte. Przebiegi w sandboxie z EACCES na 127.0.0.1 są nieważne jako ocena HTTP. Jeden równoległy przebieg API unieważniono z powodu czyszczenia dist przez test integracyjny. Końcowe sprawdzenie npm wykonano sekwencyjnie. Naprawiono też stare wywołanie rows bez argumentu wyszukiwania, brak trybu commission w runnerze DB, brak piątej roli w fixture oraz nieaktualne listy tras/modeli/testów. Zachowane logi pokazują kolejne próby.

## Co nadal blokuje pełny odbiór

1. **Działający Docker/Linux i prawdziwe obrazy.** Docker Desktop został uruchomiony, lecz daemon nie odpowiadał; ograniczone czasem próby version/status kończyły się timeoutem. Nie przeprowadzono startu pełnego stosu, skanu obrazów ani testów Redis ACL i izolacji sieci na docelowej topologii. Potrzebny działający Docker albo osobny serwer testowy Linux.
2. **Cold restore i offsite.** Zmiany recovery są przygotowane, ale nie zaliczają próby z rzeczywistą zaszyfrowaną kopią, nowszym journalem i sześcioma digestami. Brak pomiaru RPO ≤24 h/RTO ≤8 h, wybranego magazynu offsite i potwierdzenia odzyskania kluczy.
3. **Połączone E2E obu narzędzi.** Nie wykonano UI→API→Redis→worker→Python→XLSX, odświeżania wielu stron w działającym stosie, restartów na granicach zapisu ani testu 2–5 równoczesnych pracowników. Przejście osobnych suite nie zastępuje tych prób.
4. **Docelowy VPS i domena.** Brak hosta, dostępu operatora, DNS, certyfikatu i realnych digestów wydania. Nie odebrano firewalla, sekretów Linux, HTTPS/proxy, dostarczania alertów, recovery mailowego ani MF VAT z docelowego IP.
5. **LIVE i UAT.** Brak próby bieżących portali z uprawnionym operatorem oraz akceptacji pracowników i referencyjnego wyniku prowizji. Niepewny zapis lub niepoprawialne rozstrzygnięcie tożsamości nadal wymaga procedury ręcznej; nie otwarto dowolnej edycji PESEL ani ponownego automatycznego zapisu.
6. **Pełny przegląd bezpieczeństwa wydania.** Do wykonania ręczne testy całej macierzy API, plików/limitów, granic autoryzacji, wyścigów i sieci według planu. Nie deklarujemy ukończonego pentestu ani bezpieczeństwa wszystkich konfiguracji na podstawie skanera zależności.

Trzy zgłoszenia umiarkowane Node wynikają z UUID w ExcelJS/Sequelize. Zbadane wywołania korzystają z v1/v4, bez zewnętrznego bufora; zgłoszenie dotyczy v3/v5/v6 z buforem. To triage braku zaobserwowanej ścieżki wykorzystania, **nie formalna akceptacja ryzyka przez klienta**. [Advisory UUID](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq). Przy aktualizacji zależności powtórzyć ocenę.

Podstawy aktualizacji Pythona obejmują [advisory AnyIO](https://github.com/advisories/GHSA-82r6-8w77-94w6) i [advisory Starlette](https://github.com/advisories/GHSA-82w8-qh3p-5jfq). Wykrycie pakietu podatnego nie oznacza, że każda opisana ścieżka była osiągalna w prywatnym silniku; zaktualizowano zależności i sprawdzono istniejący kontrakt HTTP.

## Dalszy odbiór i źródło statusu

Aktualne wyniki przypadków przechowuje [wyniki.csv](acceptance/2026-11-05/wyniki.csv), a usterki i ograniczenia [usterki.csv](acceptance/2026-11-05/usterki.csv). Szerokie przypadki mają INCONCLUSIVE, jeżeli sprawdzono tylko ich część. Brak środowiska ma BLOCKED. Nie przepisano testów jednostkowych jako PASS całej fazy A/B.

[Manifest snapshotu i dowodów](acceptance/2026-11-06-final/manifest.json) identyfikuje bieżące źródła przez SHA256; bazowy commit z brudnym drzewem nie jest samodzielnym identyfikatorem wydania. Kolejność dalszych prac pozostaje w [pełnym planie odbioru](PLAN_PELNEGO_ODBIORU_PLATFORMY_2026-11-05.md): działające A → pełne E2E/bezpieczeństwo/DR → VPS B → LIVE/UAT → podpisanie protokołu. Nie podpisano odbioru w imieniu klienta.
