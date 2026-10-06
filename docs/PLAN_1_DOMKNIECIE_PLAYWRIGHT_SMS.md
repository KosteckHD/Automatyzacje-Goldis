# Plan 1 — domknięcie Playwright, SMS PZU i pełnego przebiegu

Data: 2 października 2026. Dokument wykonawczy dla agenta kodującego.

## 1. Cel i punkt startowy

Celem jest sprawdzony przebieg platforma → API → PostgreSQL/outbox → BullMQ → produkcyjny `LiveRunProcessor` → PZU → Compensa Komunikacja → UFG → zapis wyniku → XLSX. Obsługa SMS odbywa się przez powiadomienie i modal platformy. Zwykły przebieg nie wymaga ręcznego sterowania przeglądarką; żądanie MFA lub niejednoznaczna sytuacja zatrzymuje pracę i wymaga jasno opisanej interwencji.

Stan początkowy: moduły istnieją; nie pisać ich ponownie. Health sprawdzony 2 października: `servicesReady=true`, worker online, `automationReady=false`, `portalMode=off`, `portalConfig=unavailable`. Historyczne testy modułów, smoke UI i migracji nie zastępują testu całego procesora. Starsze dokumenty zawierają historyczne bramki i liczby; przed pracą odczytać aktualny kod oraz stan migracji.

Nie ma obecnie dostępnego prawdziwego kodu SMS PZU. Etapy A0–A8 wykonać na danych syntetycznych. A9 jest oddzielnym odbiorem live po uzyskaniu dostępu do kodu. Nie oznaczać A9 jako ukończonego na podstawie fixture.

Z poprzedniego przeglądu do tego planu należą: błąd `resume_auth`, brak kontroli aktywnego wykonania przy zapisie wyniku, walidacja PESEL i ryzyko odczytu poprzednich wyników. Ich odłożenie uniemożliwia rzetelny odbiór automatyzacji. Pozostałe kwestie bezpieczeństwa znajdują się w `PLAN_2_BEZPIECZENSTWO_I_WDROZENIE.md`.

## 2. Obowiązujące zasady przebiegu

1. PZU: korzystać z trwałego profilu, najpierw sprawdzać sesję. Wejście do Everest: `https://everest.pzu.pl/pc/PolicyCenter.do`. Po SSO obsłużyć Strefę Agenta i wejście do usługi Everest zgodnie z zaobserwowanymi elementami.
2. Po wyszukaniu REGON pobierać PESEL z kolumny `PESEL/REGON` w wierszu typu dokładnie `Osoba fizyczna`. Nie zmieniać tej reguły na pobieranie z wiersza działalności. Przy kilku pasujących osobach nie wybierać pierwszej.
3. Compensa: strona główna → kafelek `Compensa Komunikacja` → `Ubezpieczający` → PESEL z PZU i rejestracja `RST22339` → przewidziane formularze/zapis → UFG. Rejestracja jest jawnym ustawieniem automatyzacji z tym domyślnym numerem, a nie wartością ukrytą w selektorach.
4. Dla jednego profilu i konta portalu może działać tylko jedna sekwencja portalowa. Oczekiwanie na SMS blokuje przejęcie tego samego kontekstu przez inne zadanie. Lease zadania oraz blokada profilu/konta to odrębne zabezpieczenia.
5. Brak danych, niejednoznaczna tożsamość i nieznany ekran oznaczają zatrzymanie oraz zgłoszenie. Nie zgadywać selektorów, danych, osoby ani skutku zapisu.
6. Oddzielić: próby podania kodu, żądania nowego SMS i techniczne ponowienia joba. Automatyczne retry nie może samo wysyłać SMS ani powtarzać startu oferty, zapisu lub zapytania UFG.
7. Kod SMS nie trafia do DB, Redis, jobów, localStorage, logów, trace, screenshotów ani raportu. Powiadomienie i audit zawierają identyfikatory i stan, bez kodu oraz pełnego PESEL. Job pozostaje `{ runId }`.

## 3. Kolejność implementacji i testy etapów

### A0. Odtwarzalne środowisko i macierz zachowań

**Wykonać:**

- Sprawdzić instrukcje repozytorium, bieżące kontenery, wersję konfiguracji, ostatnią migrację oraz skrypty testowe. Nie przepisywać zastosowanych migracji; nowe przygotowywać addytywnie.
- Przygotować osobną bazę, Redis, profil Chromium i katalog wyników dla integracji. W testach fixture przerwać wszystkie żądania przeglądarki poza jawnie dozwolonymi syntetycznymi hostami.
- Zdefiniować mapowanie zdarzenie → status runu → kod przyczyny → interwencja → dozwolone wznowienie. Wykorzystać obecne statusy, np. `waiting_for_manual_data`, `identity_review`, `failed`, `no_matching_policies`; nowe dodawać tylko, gdy obecny model nie wyraża potrzebnego rozróżnienia.
- Rozróżnić „PZU nie znalazło osoby”, „UFG zwróciło zero polis” i „UFG nie dało się odczytać”. Brak odczytu nigdy nie jest zerowym wynikiem.
- Ustalić budżety: dla bezpiecznych odczytów najwyżej 2 dodatkowe próby z opóźnieniem 2 s i 5 s; dla jawnego 429 respektować `Retry-After`, a termin przekraczający budżet kroku kończy się interwencją. Stan MFA, zapis i niepewna akcja zewnętrzna nie korzystają z tego retry. Uzgodnić te budżety z istniejącym licznikiem recovery, aby nie mnożyły się.

**Odbiór:** start fixture nie łączy się z portalami; testy są odizolowane; każda kategoria błędu ma jednoznaczny dalszy krok. Niedostępne usługi kończą zestaw integracyjny błędem, nie zielonym wynikiem z pominiętymi testami.

### A1. Poprawna kontynuacja i granica zapisu wyniku

**Pliki:** `apps/worker/src/live-run.ts`, `execution-lease.ts`, `result-forwarder.ts`; `apps/api/src/worker-results.ts`, `oc-snapshot-store.ts`, `run-evaluation.ts`, `export-finalizer.ts`.

**Wykonać:**

- Usunąć ograniczenie `resume_auth` sprawdzane na każdym obrocie pętli. Sprawdzić dopuszczalny stan wejściowy raz, następnie prowadzić wykonanie przez normalne dozwolone przejścia aż do wyniku albo interwencji. Nie resetować checkpointów ani liczników.
- Przeanalizować osobno `result_delivery`: może dostarczać zapisany wynik i eksportować; nie może wracać do akcji portalowych.
- Przekazywać identyfikatory aktualnego wykonania i sesji workera przy dostarczaniu/finalizacji wyniku, obok istniejącego uwierzytelnienia. Zaktualizować walidację kontraktu.
- W transakcjach zapisujących snapshot, zmianę statusu i finalizację sprawdzać stan runu, anulowanie, właściciela oraz niewygasłą blokadę. Sprawdzenie wyłącznie w kontrolerze przed transakcją jest niewystarczające. Dłuższe przygotowanie pliku wymaga odnowienia blokady i ponownego sprawdzenia przed zatwierdzeniem.
- Zachować idempotencję identycznego wyniku i eksportu. Recovery otrzymuje nową blokadę; stare wykonanie nie odzyskuje prawa zapisu. Powtórna odpowiedź dla gotowego wyniku nie może ponownie zapisywać danych.

**Testy:** wznowienie PZU i Compensy dochodzi do eksportu bez uruchamiania recovery; wygasły/zastąpiony worker i anulowany run nie zapisują nowych danych; dwa dostarczenia tego samego snapshotu nie tworzą duplikatów; inny snapshot jest odrzucany; awaria po zatwierdzeniu API i przed odpowiedzią daje bezpieczne ponowienie.

### A2. Sesja PZU, SSO i rozpoznawanie ekranów

**Pliki:** `browser.ts`, `portal-session.ts`, `pzu-session.ts`, `portal-runtime-config.ts` i konfiguracja adapterów.

**Wykonać:**

- Rozpoznawać na dozwolonych domenach: Everest, Strefę Agenta, formularz loginu, ramkę MFA, 403/brak uprawnień, błąd techniczny i ekran nieznany. Używać pozytywnych znaczników, a nie samego URL lub braku formularza.
- Po Strefie Agenta wejść do Everest przez zweryfikowaną usługę; uwzględnić nawigację w tej samej karcie lub popup, jeśli portal rzeczywiście tak działa. Nie tworzyć nowego kontekstu przy każdej nawigacji.
- Login wysyłać tylko po jednoznacznym wykryciu formularza i raz na autoryzowaną próbę. Błędne dane, blokada konta lub 403 tworzą interwencję bez pętli logowania.
- Zapewnić przerwanie oczekiwania przy anulowaniu, utracie blokady i zamknięciu przeglądarki.

**Testy:** aktywna sesja nie wysyła loginu ani SMS; SSO przechodzi przez Strefę Agenta; redirect loop zatrzymuje się w ograniczonym czasie; 403, 5xx, niedozwolona domena, zerwany transport i nieznany ekran kończą się właściwym stanem. Restart zachowuje profil, lecz nie zakłada automatycznie, że portal nadal ufa urządzeniu.

### A3. Cykl SMS PZU i modal platformy

**Pliki:** worker `live-run.ts`, `auth-challenges.ts`, `portal-session.ts`, jednorazowy inbox/receiver; API `auth-challenges.ts`, endpoint wznowienia w `runs.ts`; web `app/workspace.tsx` i aktualny modal/powiadomienia.

**Wykonać:**

- Powiązać cykl MFA z runem, portalem, kontem i aktualną sesją przeglądarki. Tylko jedno aktualne wyzwanie; challenge końcowego nie reaktywować.
- Termin PZU: maksymalnie 300 s od wykrycia konkretnego cyklu. Jeśli portal podaje krótszy pozostały czas, użyć wcześniejszego terminu. Marker wygaśnięcia portalu kończy oczekiwanie od razu. Odnowienie formularza/modalu ani błędny wpis nie przedłużają terminu. Compensa zachowuje własną konfigurację czasu, nie dziedziczy automatycznie 300 s.
- Powiadomienie otwiera modal z portalem, zadaniem, terminem, stanem wysyłania i inputem. Licznik liczyć z czasu serwera; po odświeżeniu i w drugiej karcie odczytać ten sam challenge. Po timeoutcie wyłączyć wysłanie i wyczyścić input.
- API w transakcji sprawdza sesję, uprawnienia do runu, CSRF, challenge, termin i limit; kod zajmuje jednorazowo. Worker przed kliknięciem ponownie sprawdza wyzwanie, aktualny ekran, termin oraz blokadę.
- „Przyjęto do przekazania” nie oznacza „PZU zaakceptowało”. Dopiero znacznik aplikacji/SSO potwierdza sukces. Jednoznacznie błędny kod pozwala poprawić wpis w ramach pierwotnego terminu i istniejącego limitu; niepewna odpowiedź zatrzymuje zadanie bez ponownego użycia kodu.
- Opcję „zapamiętaj urządzenie” zaznaczyć, jeśli zweryfikowany checkbox jest widoczny, jednoznaczny i nie jest zaznaczony. Nie używać `toggle`. Brak checkboxa nie blokuje prawidłowego MFA; zapamiętanie nie jest gwarancją braku przyszłych SMS.
- Wygaśnięcie tworzy jedną interwencję. Jawna akcja administratora może uruchomić najwyżej jedną dodatkową próbę PZU na run. W transakcji zarezerwować tę próbę przed akcją portalu; równoległe kliknięcia nie wysyłają dwóch SMS. Kliknąć resend tylko po jednoznacznym wykryciu dostępnego przycisku; otwarcie nowego logowania także zużywa ten sam budżet.
- Gdy nie wiadomo, czy portal wysłał nowy SMS, zatrzymać zadanie z wynikiem niepewnym. Nie ponawiać resend automatycznie. Limit prób wpisania kodu, limit resend i retry techniczne pozostają osobne.
- Po restarcie workera unieważnić challenge przypisany do utraconej sesji; nie przekazywać starego kodu nowemu procesowi. Ponownie rozpoznać portal i zaoferować tylko dozwoloną interwencję.

**Testy:** kod prawidłowy, odrzucony, wygasły przed przyjęciem/przed kliknięciem; timeout bez kodu; opóźniona odpowiedź API; awaria odbiorcy; utrata odpowiedzi po przekazaniu; podwójne wysłanie; dwie karty; cofnięte uprawnienia; restart; checkbox obecny/nieobecny/zaznaczony; jeden resend i wyczerpany limit. Zliczać prawdziwe wywołania formularza/resend w fixture. Sprawdzić brak kodu w trwałych magazynach i telemetrii.

### A4. Reklamy i inne przeszkody na ekranie

**Wykonać:** dodać obsługę zaobserwowanych reklam do konfiguracji adaptera: jednoznaczny kontener i przycisk zamknięcia. Przed wyszukiwaniem/formularzem rozpoznać nakładkę, zamknąć ją i potwierdzić zniknięcie. Maksymalnie dwa zamknięcia znanej nakładki na krok; nawracanie, brak przycisku lub wiele pasujących przycisków tworzy interwencję. Nie używać Escape ani klikania współrzędnych jako uniwersalnego sposobu. Odróżnić reklamę od regulaminu, zgody lub komunikatu wpływającego na działanie usługi; ich akceptacja wymaga osobnej reguły.

**Testy:** brak reklamy, reklama po SSO, opóźniona reklama, ponowne pojawienie, nieskuteczne zamknięcie, nieznany modal. Żaden nieznany element nie jest klikany.

### A5. REGON → właściwa osoba → poprawny PESEL

**Pliki:** `everest-identity-provider.ts`, kontrakty `packages/core/src/index.ts`, wspólna walidacja danych i testy.

**Wykonać:**

- Po Enter oczekiwać na zakończenie konkretnego wyszukiwania, nie tylko na widoczność istniejących wierszy. Użyć potwierdzonego mechanizmu portalu: zakończenie loading, odpowiedź powiązana z zapytaniem albo wymiana kontenera/tabeli. Nie zakładać, że wyniki kolejnego zapytania zawsze różnią się treścią.
- Zdefiniować dowody związku wyniku z podanym REGON i osobą. Obecna reguła słów firmy w nazwie osoby wymaga sprawdzenia na prawdziwym widoku; nie luzować jej do „jedyny widoczny wiersz”. Brak danych osoby w imporcie wymaga uzupełnienia albo osobno uzgodnionej reguły jednoznacznego dopasowania.
- Odczytać numer z wiersza `Osoba fizyczna`; sprawdzić dokładnie 11 cyfr, sumę kontrolną i rzeczywistą datę urodzenia wraz z kodowaniem wieku/stulecia. Nie tracić zer wiodących. Walidacja na adapterze oraz granicy API ma być spójna.
- Nie przekazywać danych do Compensy przy braku wyników, brakującym numerze, wielu pasujących osobach, rozbieżności tożsamości czy niepoprawnym PESEL. Zgłoszenie określa potrzebną korektę; po zmianie REGON/danych wyczyścić tylko zależne checkpointy zgodnie z historią akcji, bez utraty informacji o istniejącej sprawie Compensy.

**Testy:** dwa kolejne REGON-y w jednym profilu; opóźniona tabela; identyczne wyniki dwóch zapytań; brak wyników; osoba i działalność; kilku imienników; brak osoby oczekiwanej; błędny PESEL o długości 11; poprawne numery dla różnych stuleci; literówki i niejednoznaczne dane firmy. Dla błędnych danych liczba startów Compensy wynosi zero.

### A6. Compensa i UFG bez powielania spraw

**Pliki:** `compensa-session.ts`, `compensa-form.ts`, `compensa-offer-checkpoint.ts`, `compensa-offer-saver.ts`, `compensa-ufg.ts`, checkpointy startu/UFG w repozytorium runów.

**Wykonać:**

- Potwierdzać każdy ekran przepływu z sekcji 2, unikalność elementów i wymagane dane. Po wypełnieniu odczytać wartości i sprawdzić, że w formularzu są PESEL tego runu oraz skonfigurowana rejestracja.
- Przy utracie sesji zachować tożsamość i numer istniejącej sprawy. Po ponownym uwierzytelnieniu wracać do tej sprawy, a nie zawsze do tworzenia nowej.
- Trwale zapisywać zamiar startu, numer szkicu, zamiar zapisu, potwierdzenie zapisu i zamiar UFG. Sprawdzać blokadę przed akcją. Sam brak odpowiedzi nie jest dowodem, że akcja nie zaszła.
- Dodać zweryfikowane odnalezienie/otwarcie istniejącej sprawy po numerze, jeżeli portal udostępnia taki przebieg. Jeśli nie da się jednoznacznie rozstrzygnąć skutku, pozostawić interwencję z referencją i konkretną instrukcją dla admina. Wznowienie nie omija tego rozstrzygnięcia.
- Parser UFG musi potwierdzić kompletność tabeli, liczbę pozycji, wymagane pola, brak duplikatów i poprawność dat. Obsłużyć wirtualizację/paginację zgodnie z zaobserwowanym portalem. Zero polis wymaga jawnego pustego wyniku po zakończeniu zapytania.

**Testy:** normalny przebieg; login/MFA Compensy; brak pól; nieaktywna usługa; podwójny job; awarie przed/po starcie, zapisie i UFG; restart z istniejącym szkicem; utrata blokady/anulowanie; zero polis; ucięta tabela; zmiana nagłówków; duplikaty; błędne daty. Fixture zlicza wszystkie akcje zmieniające stan i wykazuje brak drugiego startu/zapisu w niepewnym przypadku.

### A7. Interwencje, recovery i eksport

**Wykonać:**

- Dla każdej awarii zapewnić jeden aktualny komunikat: portal, etap, bezpieczna przyczyna, co ma zrobić administrator i jakie wznowienie jest dozwolone. Wznowienie wymaga ponownego sprawdzenia uprawnień i aktualnego stanu, także z nieaktualnego okna UI.
- Niedostępność API/DB/Redis, utrata lease i zamknięcie przeglądarki przerywają akcje portalowe. Recovery wraca do trwałego bezpiecznego kroku; nie resetuje intencji zewnętrznych.
- Po odczycie pełnego wyniku zachować szyfrowany staging. Awaria API lub eksportu powoduje ponowienie dostarczenia/eksportu bez nowego zapytania UFG i bez MFA.
- `completed` ustawić dopiero po trwałym pliku i zatwierdzonej metadanej; brak miejsca, uszkodzony staging lub brak klucza tworzą rozróżnione błędy. Pobranie wymaga aktualnych uprawnień do danych.

**Testy:** restart na każdym trwałym etapie; odcięcie DB/Redis/API; odwołanie grantu; anulowanie; wyczerpanie technicznego retry; błąd pliku/klucza; eksport po utracie odpowiedzi. Sprawdzić zawartość XLSX, liczbę i daty polis, zachowanie tekstowego PESEL oraz zgodność z zapisanym wynikiem. Nie wystarcza sprawdzenie HTTP 200 i rozszerzenia pliku.

### A8. Pełny odbiór syntetyczny — bez SMS PZU

**Wykonać:** dodać dedykowany runner pełnej integracji, proponowana komenda główna `npm run test:automation-e2e`. Komenda jest do utworzenia. Używać rzeczywistego logowania platformy, guardów, PostgreSQL, outboxa, Redis/BullMQ, produkcyjnego `LiveRunProcessor`, odbiorcy SMS, Chromium oraz rzeczywistego eksportera. Portale zastępują kontrolowane strony. Nie podstawiać osobnego uproszczonego procesora ani mocków uprawnień w tym odbiorze.

**Minimum scenariuszy odbiorczych:**

1. Oba portale zalogowane → wynik i zgodny XLSX, bez SMS.
2. PZU żąda SMS → powiadomienie → modal → kod → Everest → Compensa → UFG → XLSX.
3. PZU timeout → jedna jawna dodatkowa próba → SMS → pełny wynik.
4. Błędny kod, niepewne dostarczenie i restart w MFA → bezpieczne zatrzymanie/limitowane wznowienie.
5. Reklama, brak wyników PZU, brak PESEL, błędne dane, 403 i awaria usługi → odpowiednie interwencje bez startu niepowiązanej oferty.
6. Awaria po zapisie Compensy → rozstrzygnięcie istniejącej sprawy lub interwencja, bez duplikatu.
7. UFG zero polis versus niepełny wynik → różne, prawidłowe stany.
8. Restart, utrata blokady i stary worker → brak obcych zapisów i nieuprawnionych akcji.
9. Wynik odczytany, API/eksport niedostępne → wznowienie kończy XLSX bez portali.

**Odbiór A8:** wszystkie scenariusze wymagane dla danego etapu przechodzą bez pominięć; raport podaje stan DB, outboxa, zgłoszeń oraz liczbę rzeczywistych akcji fixture. Dokumentować zakres testu i ograniczenia. Potwierdzić również, że logi/Redis/DB/pliki raportu nie zawierają syntetycznego kodu SMS. W zwykłym `npm test` testy Chromium mogą być pomijane — to nie zalicza A8.

Istniejące komendy pomocnicze: `npm test`, `npm run build`, `npm run test:playwright -w @goldis/worker`, `npm run test:db-integration`, `npm run test:w3-sms-ui-smoke -w @goldis/web`, `npm run test:w3-sms-redis-smoke -w @goldis/api`. Sprawdzić ich wymagania środowiska; stare smoke nie zastępują powyższego runnera.

### A9. Odbiór na prawdziwych portalach

**Warunki wejścia:** A8 zaliczony, aktualne selektory, dostęp uprawnionej osoby do SMS, prywatne lokalne środowisko. Publiczny VPS wymaga również planu 2.

- Przed nowym pilotem rozliczyć wcześniej utworzone szkice Compensy; nie tworzyć kolejnych dla sprawdzenia nawigacji.
- Użyć zatwierdzonego rekordu 18001. Sprawdzić REGON → PESEL w wierszu osoby fizycznej → Compensa Komunikacja → rejestracja → UFG → zapis/eksport. Dane porównać prywatnie; do raportu tylko wynik zgodności i liczniki.
- Potwierdzić prawdziwe selektory MFA, checkboxa, błędnego/wygaśniętego kodu, reklamy i Strefy Agenta. Nieobserwowany wariant oznaczyć jako potwierdzony syntetycznie, oczekujący na weryfikację live.
- Test braku zapamiętanego urządzenia wykonywać w osobnym zatwierdzonym profilu, zachowując działający profil. Użytkownik przekazuje SMS przez platformę, nie ręcznie przez przeglądarkę. Nie powodować celowo wielokrotnych błędnych logowań ani blokady konta; takie warianty odbierać w fixture.
- Zamknąć i uruchomić worker ponownie; sprawdzić zachowanie profilu i dalsze działanie. Zaufanie PZU na nowym VPS/IP wymaga osobnego sprawdzenia w docelowym środowisku.

**Odbiór A9:** poprawny pełny wynik, brak duplikatu Compensy, obsłużone MFA przez platformę i zgodny XLSX. Jeżeli brak kodu/okazji do zaobserwowania ekranu, raport pozostawia daną bramkę otwartą.

## 4. Dokumentowanie wykonania

Kolejność: A0 → A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9. Fixture i test regresji powstają razem z poprawką. Po każdym etapie aktualizować `STAN_IMPLEMENTACJI.md` i `POSTEP_IMPLEMENTACJI.md`: ID, pliki, komendy, wyniki, ograniczenia, dalsza bramka. Nie wpisywać wartości sekretów ani danych klienta. Rozróżniać: kod wykonany, test modułu, odbiór syntetyczny, odbiór live oraz gotowość VPS.
