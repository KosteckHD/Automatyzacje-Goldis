# Audyt wykonania: Everest, Compensa i platforma Goldis

Data: 5 października 2026. Zakres: bieżące pliki robocze, plany, historia deklarowanych odbiorów, testy modułowe, Chromium, build i testy interfejsu. Audyt nie zmieniał kodu aplikacji, konfiguracji prywatnej ani istniejącej bazy. Nie wykonywano działań w prawdziwych portalach.

## 1. Ocena wykonanej pracy

**Powstała zaawansowana implementacja z dobrze zaprojektowanymi zabezpieczeniami, ale nie ma jeszcze podstaw do uznania całej automatyzacji za skończoną ani gotową do pracy bez nadzoru.** Główne braki dotyczą odbioru całego procesu, konfiguracji prawdziwych ekranów, zachowania przy awariach oraz przygotowania eksploatacji. Platforma jest bardziej zaawansowana funkcjonalnie, lecz ma również konkretne błędy i niedokończone przepływy.

Oceny są oceną audytora, nie procentem wykonania ani miarą pokrycia testami. 10/10 oznacza kompletny zakres, spójne dowody odbioru i potwierdzenie działania w docelowych warunkach; około 7/10 oznacza rozbudowany kod i przechodzące testy z nadal istotnymi lukami.

| Obszar | Ocena wykonania | Ocena stanu |
| --- | --- | --- |
| Everest/PZU | 7/10 | Adapter, sesja i SMS istnieją; brak pełnego aktualnego odbioru przez platformę na prawdziwym portalu |
| Compensa i UFG | 7/10 | Formularz, zapis i kompletny odczyt OC mają testy; odporność całego procesu na restart i niepewny zapis wymaga odbioru |
| Platforma automatyzacji | 7/10 | Duży zakres API i UI działa syntetycznie; luki w terminach, paginacji, roli audytora i odbiorze administracji |
| Gotowość do regularnej pracy bez nadzoru / VPS | 3/10 | Otwarte bramki integracji, live i eksploatacji; aktualnie usługi nie są uruchomione jako pełny zestaw |

Najmocniejsze elementy pracy: rozdzielenie panelu, API i workera; trwały outbox i blokady wykonania; kontrola tożsamości; checkpointy przed akcjami portalowymi; szyfrowanie PESEL i stagingu; prywatny eksport; odwoływane sesje i granty; odróżnienie dostępności usług od gotowości portali. To wartościowy fundament, którego nie trzeba pisać od początku.

Najsłabszy element: brak jednej aktualnej, odtwarzalnej macierzy odbioru całości. Liczne plany opisują te same zadania w różnych stanach, a testy poszczególnych warstw nie potwierdzają jeszcze wszystkich zachowań systemu połączonego.

## 2. Co zostało sprawdzone w tym audycie

| Sprawdzenie | Wynik 05.10.2026 | Znaczenie |
| --- | --- | --- |
| `npm test` | PASS: core 13, API 93, worker 66, preflight 3; 37 testów workera pominiętych | 175 testów zaliczonych; zwykła komenda nie odbiera Chromium |
| `npm run test:playwright -w @goldis/worker` | PASS: 103/103, 0 pominiętych | Te same testy workera, w tym 37 wcześniej pominiętych; nie należy sumować ich jako niezależnego zestawu |
| Kompilacje core/API/worker | PASS w komendach testowych | Bieżące źródła kompilują się |
| `npm run build -w @goldis/web` | PASS | Produkcyjny build panelu; strony `/`, `/admin`, `/account` |
| `test:admin-ui-smoke` | PASS | Granty/CAS, przydziały, ustawienia, audyt, raporty, CSRF, rozmiary 320–1920 |
| `test:tool-grants-ui-smoke` | PASS | Rozdzielenie praw, menu mobilne, fokus, responsywność |
| `test:w3-sms-ui-smoke` | PASS | Modal, terminy, błędny kod, resend, czyszczenie kodu, operator bez wyników |
| `test:w4-enrichment-ui-smoke` | PASS | Korekty, pochodzenie danych i wersjonowanie |
| `npm run test:db-integration` | BLOCKED, exit 2: `GOLDIS_TEST_DATABASE_ADMIN_URL_REQUIRED` | Nie nawiązano połączenia i nie wykonano migracji |
| Docker Engine | Niedostępny: brak pipe `dockerDesktopLinuxEngine` | Runner automatyzacji wymagający kontenerów nie został uruchomiony |
| `npm audit --json` | 3 wpisy moderate; 0 high/critical | Wpisy dotyczą `uuid` oraz zależnych `exceljs` i `sequelize`; nie są trzema niezależnymi podatnościami |

Testy UI podstawiają odpowiedzi API przez Playwright routing. Potwierdzają działanie interfejsu, lecz nie jego integrację z prawdziwym Nest/PostgreSQL/Redis. Zrzuty po testach obejrzano; oryginalne ilustracje dokumentacyjne przywrócono po wykonaniu smoke.

Logi audytu znajdują się w ignorowanym katalogu `.npm-cache`, pod nazwami zaczynającymi się od `audit-2026-10-05-`. Nie dodawano logów ani sekretów do repozytorium.

Na hoście wykryto nasłuch PostgreSQL na 5432. Nie uznano tej instancji za bazę testową i nie modyfikowano jej. Panel/API/Redis/odbiorca workera nie nasłuchiwały na standardowych portach 3000/3001/6379/3022 podczas sprawdzenia. Prywatna konfiguracja Compose pozostawia portale wyłączone i nie wskazuje dedykowanej pełnej konfiguracji selektorów. `.env.local` dla startu Windows nie istnieje. Sprawdzenie nie potwierdza poprawności poświadczeń portalowych.

## 3. Everest/PZU — wykonanie i pozostałe prace

Potwierdzone w kodzie i testach:

- Jeden trwały profil Chromium, ponowne używanie sesji, rozpoznawanie loginu, MFA, odmowy i nieznanego ekranu.
- Wyszukiwanie REGON, oczekiwanie na świeży render, odczyt PESEL z wiersza „Osoba fizyczna”, walidacja daty i sumy kontrolnej PESEL.
- Sprawdzanie osoby i członów nazwy firmy; brak albo niejednoznaczność wyniku zatrzymują przejście do Compensy.
- SMS przez platformę, kod w jednorazowym buforze, ograniczone próby, timeout, jawny resend, obsługa utraty uprawnienia/anulowania.
- Fragment selektorów rzeczywistej ramki SMS i wygasłego kodu w `config/pzu-sms.observed.json`.

Otwarte: pełny plik runtime, marker rzeczywiście odrzuconego kodu, przejście przez modal platformy do realnego wyniku, trwałość sesji po restarcie i odbiór nieznanych ekranów. Fragment SMS nie zastępuje konfiguracji całego PZU i Compensy. `config/portal-selectors.example.json` nadal zawiera `UNVERIFIED_*`, a loader prawidłowo odmawia jego użycia live.

Przed przyjęciem większej bazy trzeba również sprawdzić reprezentatywne nazwy i osoby. Obecna reguła wymaga osoby decyzyjnej i obecności wszystkich członów nazwy firmy o długości co najmniej czterech znaków w nazwie wyniku. Jest ostrożna, ale może kierować poprawne, inaczej zapisane rekordy do interwencji. Nie potwierdzono jej skuteczności na różnorodnej partii.

Dowód zakończenia: zatwierdzony rekord przechodzi z panelu przez właściwą tożsamość do wyniku; brak/konflikt nie otwiera oferty; MFA przechodzi przez platformę; restart nie tworzy nowego zadania ani nadmiarowej próby logowania.

## 4. Compensa/UFG — wykonanie i pozostałe prace

Potwierdzone w kodzie i testach:

- Wejście od kafelka Compensa Komunikacja, właściwa rola, PESEL i wymagany numer wejściowy; kontrola danych osoby uzupełnionych przez portal.
- Uzupełnianie brakujących pól, jawne zatrzymanie przy konflikcie i brakach, wybór powiatu po dokładnej opcji.
- Trwały identyfikator sprawy i zamiar zapisu przed kliknięciem; brak ślepego ponowienia po niepewnym rezultacie.
- Osobny zamiar UFG; kontrola numeru sprawy; parser pełnej tabeli, w tym wierszy ładowanych przy przewijaniu, liczników, nagłówków i dat.
- Szyfrowany staging i ponowne dostarczenie wyniku; API sprawdza aktualne wykonanie workera; eksport jest prywatny i idempotentny.

Ograniczenie recovery: produkcyjne `lookupSave` w `live-run.ts:95` sprawdza potwierdzenie na bieżącym ekranie tej samej sprawy. Przy braku potwierdzenia zwraca `unknown`. To bezpieczne zatrzymanie, ale nie pełne automatyczne odnalezienie zapisanej sprawy po restarcie/nawigacji. Należy odebrać procedurę odnalezienia sprawy albo jasno przyjąć interwencję jako wymagany sposób rozstrzygnięcia.

Dokumentacja z 1 października opisuje pilotaż live: 49/49 polis OC i 3 po filtrze dla 2026-10-01. To historyczny dowód nawigacji i odczytu, nie ponownie wykonany w tym audycie dowód pełnego jobu platformy. Liczba 3 nie jest stałym kryterium dla kolejnej daty.

Dowód zakończenia: jedna sprawa i jedna weryfikacja dla jednego runu; restart przed/po zapisie i UFG nie tworzy duplikatu; pełny zestaw albo jawne zero; zgodny XLSX z zapisanej daty odniesienia; awaria API po odczycie nie powoduje ponownej akcji portalowej. Przed kolejnym pilotem rozliczyć dwa szkice opisane w dokumentacji historycznej.

## 5. Platforma — konkretne ustalenia

P1 oznacza poprawkę potrzebną przed odbiorem regularnej pracy; P2 oznacza pracę do domknięcia obsługi lub eksploatacji. Blokady odbioru zewnętrznych integracji są opisane osobno.

| Priorytet | Lokalizacja | Ustalenie i skutek | Wymagany krok |
| --- | --- | --- | --- |
| P1 | `apps/web/app/admin/page.tsx:288`, `:291`, `:389` | UTC jest obcinane i przekazywane do `datetime-local`, następnie interpretowane jako czas lokalny. Niezmieniony termin `2026-10-05T12:00:00Z` zapisuje się w Warszawie jako `10:00:00Z`. Potwierdzono reprodukcją Node z `TZ=Europe/Warsaw`. | Poprawna konwersja UTC ↔ czas formularza; test niezmienionego terminu i zmiany czasu letniego/zimowego. |
| P1 | `apps/web/app/admin/page.tsx:119`, `:220`, `:228`; `apps/api/src/admin.ts:458`, `:489` | UI pobiera tylko pierwszych 100 użytkowników i pierwszych 50 zadań/interwencji; ignoruje kursor użytkowników i nie ma przejścia na dalsze strony. Starsze konta lub zgłoszenia są niedostępne w tych widokach. | Paginacja i właściwe limity/filtry; odbiór na co najmniej 101 użytkownikach i 51 zgłoszeniach. |
| P2 | `apps/web/app/admin/page.tsx:116`; `apps/web/app/workspace.tsx:894`; `apps/api/src/admin-reports.ts:119` | Audytor ma prawo czytać dziennik przez API, ale `/admin` odrzuca tę rolę, a nawigacja nie udostępnia innego ekranu audytu. | Oddzielny ekran dziennika lub ograniczona ścieżka audytora, bez funkcji administracyjnych. |
| P2 | `apps/web/app/admin/page.tsx:355`, `:374`, `:376` | Cofnięcie dostępu, wyłączenie konta i cofnięcie wszystkich sesji wykonują się natychmiast; potwierdzenie istnieje tylko dla wybranej sesji. | Spójne potwierdzenie działań przerywających dostęp użytkownika. |
| P1 przed wydaniem | Git | `git ls-files` pokazuje wyłącznie README. Kod, plany, migracje i konfiguracja przykładowa są nieśledzone. Nie ma zapisanej wersji aplikacji do odtworzenia/wycofania. | Przejrzeć ignorowane pliki i sekrety, utrwalić źródła/lockfile/migracje w commitach, oznaczyć sprawdzone wydanie; bez prywatnych danych i profili. |
| P2 / zakres dodatkowy | `apps/api/src/registry-provider.ts`, `registry-lookup.ts`, `module.ts` | NIP → REGON ma kontrakty, walidację, cache i zapis rezultatu, ale nie znaleziono produkcyjnego providera ani podłączenia `RegistryLookupService` do wykonania aplikacji. | Jeśli automatyczne uzupełnianie należy do końcowego zakresu, podłączyć rzeczywisty rejestr i test odbiorczy. Nie blokuje pilota z już poprawnym REGON. |

Interfejs ma lokalne fonty, spójny motyw, widoczne stany fokusu, etykiety formularzy i obsługę klawiatury w modalach. Smoke potwierdza responsywność. Przegląd nie zastępuje pełnego pomiaru kontrastu i audytu dostępności; nie przyznaje certyfikacji WCAG. Przegląd UX pomocniczo korzystał z [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).

## 6. Integracja, dokumentacja i bezpieczeństwo wdrożenia

Obecny `automation-flow-smoke.cjs:122` obejmuje siedem scenariuszy: aktywna sesja, SMS, ponowne wpisanie po odrzuceniu, resend po odrzuceniu, timeout, limit resend i brak wyników. Wprost raportuje `livePortals=false` i `modalUI=false`. Dokumentacja opisuje ich wcześniejsze zaliczenie 2 października. W tym audycie nie udało się ich ponownie uruchomić.

**A8 pozostaje częściowo odebrane, A9 pozostaje otwarte.** Do A8 brakuje wspólnego przebiegu modalu z rzeczywistym API/DB/Redis, pełnej macierzy awarii usług, restartów w MFA/zapisie/UFG, niepewnego dostarczenia oraz wyniku zerowego i niekompletnego w tym samym pełnym procesorze. Testy modułów dla części tych sytuacji już istnieją; trzeba wykorzystać je jako podstawę rozszerzenia harnessu.

Administracja E0–E6 wymaga spójnego odbioru na bazie: backfill/uprawnienia, odebranie grantu podczas sesji, wyścig ostatnich adminów, dwa przydziały, ustawienia/limit, agregaty i migracja kopii obecnej bazy. Historyczny smoke świeżej i legacy bazy nie zastępuje próby migracji tej kopii.

Przed VPS pozostają: konfiguracja HTTPS/proxy i zaufania do proxy (obecnie `main.ts` ustawia `trust proxy=1` bezwarunkowo), ograniczenie prywatnych endpointów, użytkownik bez roota dla API/web, minimalne obrazy, limity zasobów, uprawnienia wolumenów/Windows ACL, monitoring, backup z testem odtworzenia i retencja. Worker ma `USER pwuser`; API/web nie deklarują `USER`. Znaleziono usuwanie stagingu po sukcesie, ale nie pełny mechanizm okresowej retencji eksportów i osieroconych plików.

Audyt npm wskazuje jeden advisory `uuid` propagowany do dwóch bibliotek. Dotyczy granic zewnętrznego bufora w v3/v5/v6; wpływ na używane ścieżki trzeba osobno sprawdzić. Automatyczna sugestia npm obniża wersje głównych bibliotek, więc wymaga oceny kompatybilności i regresji, a nie bezrefleksyjnego `audit fix --force`. Źródło: [advisory GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

Dokumentację trzeba ujednolicić: starszy plan domknięcia wymaga wiersza działalności, aktualny kod i nowszy plan wskazują „Osoba fizyczna”; plan A8 nadal nazywa istniejącą komendę propozycją; README zawiera wcześniejszą informację o otwartym odbiorze migracji, choć nowsze wpisy opisują jego zaliczenie. Zachować historię, ale dodać jedno bieżące podsumowanie z dowodem i datą każdej bramki.

## 7. Kolejność prac do zakończenia

| Kolejność | Pakiet prac | Kryterium ukończenia |
| --- | --- | --- |
| 1 | Utrwalić wersję źródeł; uruchomić Docker i izolowane PostgreSQL/Redis; ustalić jeden profil uruchomienia | Wersja ma commit; testy mają własne bazy/kolejkę; usługi i worker mają potwierdzone statusy |
| 2 | Naprawić terminy, paginację, ścieżkę audytora i działania administracyjne; ujednolicić bieżący status dokumentacji | Reprodukcje błędów przestają występować; role, dalsze strony i terminy przechodzą odbiór |
| 3 | Ponowić migracje/DB/Redis i domknąć administrację E0–E6 | Świeża baza, legacy i kopia aktualnej bazy zgodne; testy HTTP i uprawnień, CAS/wyścigów oraz raportów przechodzą |
| 4 | Domknąć A8 na jednym pełnym harnessie, w tym modal UI | Wszystkie wymagane scenariusze z planu A8 przechodzą; liczniki akcji dowodzą braku duplikatów; artefakt pobieralny i zgodny |
| 5 | Zebrać pełną zweryfikowaną konfigurację live, rozliczyć szkice, wykonać A9 | Jeden zatwierdzony rekord przechodzi od panelu do zgodnego XLSX; SMS przez platformę; zgodna tożsamość i kompletność UFG |
| 6 | Mała seria i kontrolowany restart na lokalnym środowisku | Co najmniej trzy kolejne rekordy i następny po restarcie; brak utraty wyniku/duplikatu; sesje i interwencje zachowują się zgodnie z zasadami |
| 7 | Plan bezpieczeństwa i eksploatacji przed VPS | HTTPS, prywatne usługi, właściwe uprawnienia, retencja, rozpatrzone advisory, działające alerty oraz odtworzony backup z kluczami |

Pakiety 1–4 i większość 7 można wykonać bez prawdziwego SMS. Pakiet 5 wymaga uprawnionego dostępu do portali i udziału operatora, gdy portal zażąda kodu. Harmonogram zależy przede wszystkim od kompletności selektorów i wyników restartów; obecny audyt nie uzasadnia wiarygodnej obietnicy terminu w dniach.

**Warunek uznania pracy za skończoną lokalnie:** poprawki platformy, pełny syntetyczny odbiór, zatwierdzony live od kliknięcia do pliku, mała seria/restart, spójna dokumentacja i odtwarzalna wersja źródeł. **Warunek zakończenia wdrożenia na VPS:** dodatkowo odebrana konfiguracja docelowego hosta, sesja portali na nim oraz zabezpieczenia i procedury eksploatacji. Sam build, green health albo historyczny ręczny pilot nie spełniają tych warunków.
