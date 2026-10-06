# Plan przedimplementacyjny platformy Goldis i weryfikacji polis OC

**Stan:** plan pracy i odbioru, przygotowany na podstawie opisanego procesu, arkusza `BAZA TRANSPORTOWA.xlsx` i przekazanych zrzutów ekranu. Jednowierszowy pilotaż portali zakończył się eksportem 29.09.2026; otwarte decyzje P0 pozostają opisane poniżej.

Konkretna kolejność zmian w istniejącym kodzie, migracje, kontrakty usług i prace możliwe bez SMS są w [planie wykonawczym](PLAN_WYKONAWCZY_AUTOMATYZACJI.md). Ten dokument zachowuje kryteria P0–P9 i katalog testów.

## 0. Jak korzystać z tego planu

To jest kolejność wykonania, zestaw testów i kontrakt przekazania pracy agentom Codex. **Nie rozpoczynać masowego przetwarzania pliku źródłowego** po samym napisaniu selektorów. Każdy etap kończy się wskazaną bramką odbioru i dowodami: wynikiem testów, zanonimizowanym przykładem lub wpisem decyzji. Kolejny etap używa wyłącznie zatwierdzonych kontraktów poprzedniego.

Fakty z pliku i ekranów są opisane w sekcjach 1–5. Sekcje 10–12 zawierają wykonawczy backlog, przypadki testowe i bramki. Sekcja 13 jest pakietem kontekstu dla kolejnego agenta. Wymagania oznaczone `DECYZJA` nie mogą być zgadywane przez implementację.

**Stan implementacji:** bieżące wykonane prace i wyniki testów zapisano w [STAN_IMPLEMENTACJI.md](STAN_IMPLEMENTACJI.md). `.env` i źródłowy `.xlsx` są ignorowane przez Git. Nie otwierać ani nie wypisywać wartości sekretów podczas zwykłych prac kodowych.

## 1. Cel i granice pierwszego produktu

Pracownik wgrywa bazę firm, wybiera zakres wierszy i uruchamia narzędzie „Weryfikacja polis OC”. Narzędzie wyszukuje firmę w PZU Everest po REGON, ustala właściwą osobę fizyczną i jej PESEL, wykonuje weryfikację UFG przez Compensa Komunikacja, zapisuje polisy OC z datą `Okres ub. do` przypadającą dzisiaj lub później i udostępnia wynik w panelu. Dla każdego rekordu z co najmniej jedną pasującą polisą powstaje plik `{REGON}_{nazwa_dzialalnosci}_{imie_nazwisko_osoby_decyzyjnej}.xlsx`, gdy osoba decyzyjna jest podana, lub `{REGON}_{nazwa_dzialalnosci}.xlsx`, gdy jej brak.

Platforma ma obsługiwać także przyszłe narzędzia. Wspólne dla nich pozostają konta użytkowników, importy, kolejka, statusy, kody SMS, pliki wynikowe i audyt. Logika Everest → Compensa → UFG stanowi osobny moduł automatyzacji.

### Potwierdzone dane wejściowe

Arkusz `Realizacja` ma 30 229 wierszy danych. Potrzebne kolumny:

| Kolumna | Nagłówek | Zastosowanie |
| --- | --- | --- |
| B | `Nazwa` | Nazwa działalności, identyfikacja i część nazwy pliku wynikowego |
| C | `NIP` | Wyszukanie brakującego REGON po pilotażu; zachować jako tekst |
| D | `REGON` | Wyszukiwanie w Everest |
| I | `Osoba Decyzyjna` | Opcjonalne imię i nazwisko do porównania z Everest oraz część nazwy pliku wynikowego; brak pomija tę część nazwy |
| N–P | `Adres`, `Kod Pocztowy`, `Miasto` | Źródło danych przekazywanych do formularza Compensy według użytkownika; w pilotażu sprawdzić, czy odpowiadają wymaganym polom osoby |

W 287 wierszach REGON jest pusty. Część wartości zapisano jako liczby o ośmiu cyfrach, co może oznaczać utracone zero wiodące. Importer zachowuje oryginalną wartość i oznacza taki wiersz do sprawdzenia; nie dopisuje zera bez walidacji.

Spośród 287 wierszy bez REGON **241 ma NIP o dziesięciu cyfrach** (241 różnych wartości), a **46 nie ma NIP**. Implementacja kontroli NIP potwierdziła poprawną sumę kontrolną wszystkich 241 wartości; zgodność firmy z rejestrem pozostaje do sprawdzenia. Po pilotażu dodać wyszukiwanie NIP → REGON w zewnętrznym rejestrze, następnie ponownie deduplikować dane. Oryginalnego Excela nie nadpisywać.

Użytkownik potwierdził, że dane do uzupełnienia Compensy są przekazywane w Excelu, gdy występują. W aktualnym arkuszu **4 059 wierszy** ma pustą `Osoba Decyzyjna`; nie jest to błąd importu ani powód do pominięcia eksportu. Arkusz nie zawiera osobnej kolumny `Powiat`; w pilotażu portal wypełnił ją sam. Nie przypisywać danych firmy innej osobie tylko na podstawie podobieństwa nazwy.

Numer `RST22339` jest wartością podawaną w Compensie w opisanym procesie. Należy trzymać go w konfiguracji narzędzia, nie w kodzie. Zgodnie z doprecyzowaniem użytkownika numer rejestracyjny jest wymaganym polem formularza, ale nie służy do ograniczania ani filtrowania wyników UFG. Odczytać całą tabelę polis OC powiązanych z ustaloną osobą.

## 2. Kryteria ukończenia

1. Pracownik może wgrać `.xlsx`, zobaczyć liczbę poprawnych i wymagających sprawdzenia wierszy oraz uruchomić wybrany zakres.
2. Każdy wiersz ma jednoznaczny status i historię etapów. Awaria jednego wiersza nie zatrzymuje całej partii.
3. Kod SMS można podać w panelu tylko do aktywnej próby logowania. Kod nie trafia do bazy, trwałej kolejki ani logów.
4. Automatyzacja nie wybiera arbitralnie osoby, gdy Everest zwraca kilka wyników lub dane są sprzeczne.
5. Każda polisa OC z poprawną datą końca `>=` daty uruchomienia według `Europe/Warsaw` trafia do bazy i eksportu; starsze polisy nie trafiają do eksportu.
6. Odczyt obejmuje całą tabelę OC, również wiersze wymagające przewinięcia. Liczbę odczytanych pozycji porównuje się z liczbą polis OC w podsumowaniu UFG.
7. Eksport powstaje tylko przy co najmniej jednej pasującej polisie. Ponowienie zadania nie dubluje polis ani nie nadpisuje poprzedniego wyniku bez śladu.
8. Interfejs, API, worker, baza i kolejka działają na VPS; dostęp do PostgreSQL i Redis nie jest publiczny.
9. Wiersze bez REGON, ale z poprawnym NIP, są wzbogacane po kontrolowanym wyszukaniu w rejestrze; wynik niezgodny lub niejednoznaczny trafia do przeglądu. Powtórzone podmioty uruchamiają co najwyżej jedną weryfikację portalową, przy zachowaniu powiązania ze wszystkimi wierszami źródłowymi.

## 3. Stos i podział odpowiedzialności

```text
Przeglądarka pracownika
    │ HTTPS
    ▼
Reverse proxy (Caddy albo Nginx)
    ├── Next.js + React ── panel produktu
    └── NestJS API ────── autoryzacja, import, zadania, wyniki, eksport
             ├── PostgreSQL + Sequelize
             ├── Redis + BullMQ
             └── wewnętrzny kanał jednorazowych kodów SMS
                         │
                         ▼
                NestJS worker + Playwright
                PZU Everest → Compensa Komunikacja → UFG
```

**Node.js** uruchamia Next.js, API NestJS i worker; nie jest dodatkowym, czwartym backendem. Cały kod aplikacyjny powstaje w TypeScript.

Proponowany układ repozytorium:

```text
apps/web/                 panel Next.js
apps/api/                 publiczne API NestJS
apps/worker/              proces NestJS z Playwright
packages/contracts/       typy żądań, wyników i statusów
packages/automation-core/ wspólne interfejsy przyszłych narzędzi
infra/                    Docker Compose, reverse proxy, skrypty wdrożenia
docs/                     specyfikacje i instrukcje operacyjne
```

`automation-core` udostępnia kontrakt narzędzia: identyfikator, wersję, wymagane pola importu, etapy, format wyniku i metodę uruchomienia. Pierwsza implementacja to `oc-policy-verification`; przyszła automatyzacja korzysta z tego samego systemu zadań bez mieszania logiki portali.

## 4. Model danych i API

Tabele PostgreSQL, tworzone migracjami Sequelize:

| Tabela | Najważniejsze pola |
| --- | --- |
| `users` | identyfikator, rola, stan konta |
| `import_batches` | nazwa i skrót pliku, autor, data, liczby wierszy |
| `source_rows` | numer wiersza, oryginalna nazwa/NIP/REGON oraz pola do Compensy, znormalizowane identyfikatory, stan walidacji; oryginału nie nadpisywać |
| `regon_resolutions` | wiersz, NIP zapytania, znaleziony REGON, źródło, czas, wynik zgodności nazwy, status automatyczny lub do przeglądu; bez pełnej odpowiedzi rejestru w logach |
| `canonical_entities` / `source_row_links` | jeden uzgodniony podmiot i powiązania ze wszystkimi wierszami źródłowymi; stan konfliktu i decyzja operatora |
| `automation_runs` | narzędzie, wersja, partia, wiersz, status, bieżący krok, próby, czasy |
| `identity_matches` | powiązanie z wierszem, imię, nazwisko, zaszyfrowany PESEL, źródło, wynik kontroli zgodności |
| `oc_policies` | pola tabeli OC, daty jako daty, klucz deduplikacji, czas pobrania |
| `exports` | powiązane uruchomienie, nazwa użytkowa, prywatna ścieżka, skrót pliku, czas utworzenia |
| `auth_challenges` | identyfikator próby, portal, stan i termin ważności; **bez kodu SMS** |
| `audit_events` | kto uruchomił zadanie, zmienił status lub pobrał wynik; bez haseł i pełnego PESEL |

PESEL szyfrować po stronie aplikacji kluczem spoza bazy. W indeksach i logach używać identyfikatorów wewnętrznych lub skrótu HMAC, jeśli potrzebne jest wyszukiwanie po PESEL. Dane w zadaniach BullMQ ograniczyć do identyfikatorów rekordów; worker pobiera właściwe dane z bazy.

Pierwszy zestaw endpointów API:

```text
POST /imports                  wgranie i walidacja pliku
GET  /imports/:id              podsumowanie importu
GET  /imports/:id/rows         błędy i podgląd wierszy
POST /imports/:id/regon-enrichment  wyszukanie REGON dla kwalifikujących się NIP po pilotażu
GET  /imports/:id/regon-enrichment  liczniki i niejednoznaczne dopasowania
POST /source-rows/:id/resolve      zatwierdzenie lub odrzucenie korekty z audytem
POST /runs                     uruchomienie wybranych wierszy
GET  /runs                     lista i filtrowanie zadań
GET  /runs/:id                 status i wynik jednego wiersza
GET  /runs/:id/events          zdarzenia przez SSE albo odpytywanie
POST /auth-challenges/:id/code jednorazowe przekazanie kodu SMS
GET  /exports/:id/download     pobranie po sprawdzeniu uprawnień
```

Panel ma role co najmniej `operator` i `administrator`. Uprawnienia do danych i eksportów są sprawdzane w API, również gdy użytkownik wyszukuje rekord przez interfejs React. Nie umieszczać PESEL w URL ani w nazwach plików.

## 5. Przebieg automatyzacji jednego wiersza

Implementować jako jawny automat stanów; przed każdym krokiem zapisać stan i po nim zapisać wynik. Statusy: `queued`, `validating`, `pzu_login`, `waiting_for_sms`, `everest_search`, `identity_review`, `compensa_login`, `compensa_form`, `waiting_for_manual_data`, `ufg_verification`, `reading_oc`, `no_matching_policies`, `export_ready`, `completed`, `failed`.

### Krok A — przygotowanie danych

1. Odczytać `Nazwa`, `NIP`, `REGON` oraz pola potrzebne w Compensie z właściwego wiersza, zachowując numer wiersza źródłowego i pierwotne wartości.
2. Sprawdzić pusty REGON, długość, znaki, format liczbowy i duplikaty. REGON jako tekst przechowywać bez notacji naukowej i bez końcówki `.0`. Po pilotażu wiersz z pustym REGON i poprawnym NIP przechodzi najpierw przez etap wzbogacenia opisany w P0A.
3. Nie uruchamiać portali dla wiersza z niepewnym identyfikatorem. Pokazać w panelu przyczynę oraz możliwość ręcznej korekty z audytem.
4. Po wzbogaceniu grupować dokładne duplikaty i zlecać jedną weryfikację portalu dla jednego uzgodnionego podmiotu. Wiersze sprzeczne lub niejednoznaczne kierować do przeglądu; zachować powiązanie wyniku z każdym wierszem źródłowym.
5. Zamrozić datę odniesienia zadania w strefie `Europe/Warsaw`, aby wynik nie zmienił się podczas pracy przez północ.

### Krok B — PZU i Everest

1. Otworzyć adres logowania PZU z konfiguracji i zalogować się danymi wczytanymi przy uruchomieniu procesu z sekretów serwera.
2. Jeśli pojawi się SMS, wystawić w panelu aktywne żądanie kodu. Ograniczyć czas oczekiwania; przy wygaśnięciu sesji rozpocząć ponowne logowanie.
3. Otworzyć Everest, jeśli portal wymaga osobnego przycisku „ZALOGUJ”, nacisnąć go i potwierdzić, że widoczny jest ekran wyszukiwania.
4. Wyszukać REGON. Spośród wyników znaleźć właściwy rekord osoby fizycznej prowadzącej działalność gospodarczą. Potwierdzić zgodność REGON i nazwy działalności.
5. Odczytać PESEL właściwej osoby. Jeśli Excel zawiera `Osoba Decyzyjna`, porównać imię i nazwisko z osobą powiązaną w Everest z wybraną działalnością. Gdy kolumna jest pusta, można użyć imienia i nazwiska z Everest tylko wtedy, gdy dla potwierdzonych REGON i nazwy działalności portal jednoznacznie wskazuje jedną osobę wraz z PESEL. W przeciwnym razie zatrzymać wiersz na `identity_review`.
6. Brak wyniku, wiele pasujących wyników lub niezgodność danych → `identity_review`, bez wysyłania danych do Compensy.

### Krok C — CPortal i Compensa Komunikacja

1. Zalogować się do CPortal. Z ekranu głównego wybrać „Compensa Komunikacja”.
2. W oknie wyboru wskazać `Ubezpieczający`, wpisać PESEL i numer rejestracyjny `RST22339`, następnie uruchomić Compensa Komunikacja.
3. Przewinąć do „Dane ubezpieczonych”. Sprawdzić wszystkie wymagane pola poza „Nazwisko rodowe”, zgodnie z instrukcją użytkownika.
4. Puste imię i nazwisko uzupełnić potwierdzonymi wartościami z Everest; jeśli Excel zawiera `Osoba Decyzyjna`, najpierw potwierdzić zgodność. PESEL pobrać z Everest. Zgodnie z instrukcją użytkownika, jeśli wszystkie wymagane pola Compensy są już wypełnione, nie nadpisywać ich danymi z Excela i przejść do `Zapisz`; sama różnica kodu pocztowego między Excelem a wypełnionym portalem nie blokuje kroku. Tylko puste pola uzupełniać wartościami z przypisanego wiersza Excela. Arkusz nie ma `Powiatu`; jeśli portal go nie uzupełnia i nie ma pewnego źródła, przejść do `waiting_for_manual_data`.
5. Kliknąć „Zapisz” i zapisać identyfikator utworzonej oferty lub inny identyfikator sprawy widoczny w portalu. Dopiero potem uruchomić „Weryfikacja UFG” i „Szczegóły weryfikacji UFG”.
6. Nie ponawiać bezmyślnie kroków „Zapisz” i „Weryfikacja UFG” po timeout lub restarcie: sprawdzić istniejącą ofertę i stan weryfikacji, aby nie tworzyć duplikatów.

### Krok D — pełny odczyt tabeli OC

1. Rozwinąć „Szczegóły polis OC”. Nie pobierać sekcji AC, ASS ani szkód do pierwszej wersji produktu.
2. Ustalić, czy tabela ma przewijanie wewnętrzne, stronicowanie lub doczytywanie wierszy. Odczytać każdy wiersz, a nie tylko widoczną część pierwszego ekranu.
3. Zapisać pola w dokładnym porządku z widoku:

| Pole źródłowe | Pole systemowe | Uwagi |
| --- | --- | --- |
| `L.p.` | `source_ordinal` | Numer pozycji na ekranie, nie klucz polisy |
| `Ubezpieczony` | `insured_name` | Dane osobowe; kontrola dostępu |
| `Typ i nr polisy` | `policy_type_and_number` | Zachować pełny tekst; podział tylko po potwierdzeniu formatu |
| `Rodzaj umowy` | `contract_type` | Tekst z portalu |
| `Liczba szkód Ubezpieczonego` | `insured_claim_count` | Liczba albo jawny brak danych |
| `Nr rejestracyjny` | `vehicle_registration` | Numer pojazdu z wyniku UFG |
| `Grupa pojazdu` | `vehicle_group` | Tekst z portalu |
| `Marka` | `vehicle_make` | Tekst z portalu |
| `Model` | `vehicle_model` | Tekst z portalu |
| `ZU` | `insurer` | Zakład ubezpieczeń |
| `Okres ub. od` | `coverage_from` | Data |
| `Okres ub. do` | `coverage_to` | Data stosowana do filtra |

Kolumna `Akcje` jest kontrolką interfejsu, a nie danymi polisy. Jeśli kryje dalsze informacje potrzebne w eksporcie, ustalić to w pilotażu i rozszerzyć schemat.

4. Porównać liczbę odczytanych polis OC z liczbą w podsumowaniu UFG. Rozbieżność oznacza niepełny odczyt i wymaga ponowienia lub ręcznego sprawdzenia.
5. Każdą datę sparsować jawnie do typu daty. Rekord z pustą lub nierozpoznaną datą końca skierować do przeglądu; nie traktować jej jak daty przeszłej.
6. Zachować polisy, dla których `coverage_to >= data_odniesienia`, włącznie z dniem bieżącym. Deduplikować po stabilnej kombinacji numeru polisy, numeru rejestracyjnego, dat ochrony i osoby, po sprawdzeniu realnego formatu danych.

### Krok E — wynik i eksport

1. Zapisać pasujące polisy oraz metadane: REGON, nazwę działalności, PESEL, imię i nazwisko, czas pobrania, źródło i identyfikator uruchomienia.
2. Przy co najmniej jednym wyniku wygenerować `.xlsx` z jednym wierszem na polisę i kolumnami OC opisanymi wyżej. Identyfikatory traktować jako tekst, daty zapisać jako tekst ISO `RRRR-MM-DD`, aby podglądy nie pokazywały numerów seryjnych Excela; zabezpieczyć tekst źródłowy przed interpretacją jako formuła Excela.
3. Nazwa pobierana przez użytkownika: `{REGON}_{nazwa_dzialalnosci}_{imie_nazwisko_osoby_decyzyjnej}.xlsx` przy dostępnej osobie decyzyjnej, w przeciwnym razie `{REGON}_{nazwa_dzialalnosci}.xlsx`. Usuwać znaki niedozwolone i skracać nazwę do bezpiecznej długości. Puste pole `Osoba Decyzyjna` nie blokuje eksportu; tożsamość potrzebną do zapytania Compensy nadal należy ustalić w Everest. W prywatnym magazynie plików używać dodatkowo identyfikatora uruchomienia, by kolejne eksporty nie nadpisywały się.
4. Przy zerowej liczbie pasujących polis zapisać status `no_matching_policies` i nie tworzyć pustego Excela.

## 6. SMS, sesje i ponawianie

Kod SMS pracownik wpisuje w panelu dla konkretnego, aktywnego zadania. API sprawdza sesję pracownika, portal, identyfikator wyzwania i termin ważności. Następnie przekazuje kod jednorazowo do workera wewnętrznym kanałem; worker wprowadza go do otwartej sesji przeglądarki. Kod nie jest zapisywany w PostgreSQL, BullMQ, plikach ani logach. Po restarcie workera najpierw sprawdzić zapamiętaną sesję; ponowne logowanie i SMS uruchomić tylko wtedy, gdy portal tego wymaga.

Na początek jedna aktywna sesja na jedno konto portalu. Worker używa osobnego kontekstu przeglądarki dla konta, ogranicza tempo żądań i stosuje limit prób. Ponawia tylko kroki bezpieczne do powtórzenia. Dla zapisu oferty i weryfikacji UFG przed ponowieniem kontroluje stan sprawy w portalu. CAPTCHA lub dodatkowe wyzwanie przechodzi do operatora; automat nie obchodzi zabezpieczeń portalu.

Zapisany stan sesji Playwright może zawierać aktywne tokeny. Jeśli zostanie użyty, ma być szyfrowany, dostępny wyłącznie workerowi i usuwany po wygaśnięciu. Nie trafia do Git ani do kopii diagnostycznych.

Zapamiętana sesja na komputerze operatora jest wynikiem pilotażu, ale worker na VPS uruchomi osobny profil Chromium i może wymagać nowego logowania oraz SMS. Dla konta portalu użyć jednego trwałego, prywatnego profilu Playwright (`launchPersistentContext` z katalogiem na wolumenie workera), bez równoczesnego używania tego samego profilu przez kilka zadań. Nie zamykać i nie tworzyć profilu na nowo po każdym wierszu: kolejne rekordy partii korzystają z tej samej sesji, dopóki portal ją uznaje. Po starcie i przed pracą sprawdzić stan zalogowania; jeśli wygasł lub portal ponownie zażąda uwierzytelnienia, zgłosić w panelu żądanie kodu. Profil i tokeny chronić uprawnieniami systemowymi oraz szyfrowaniem nośnika, nie kopiować ich do logów ani repozytorium. Przed uruchomieniem partii przejść test pierwszego logowania, kilku kolejnych wierszy bez ponownego SMS, restartu workera i ponownego wejścia do obu portali na docelowym VPS. Nie kopiować profilu z komputera użytkownika jako założenia produkcyjnego.

## 7. Panel pracownika

1. **Katalog narzędzi:** kafel „Weryfikacja polis OC”, miejsce na kolejne narzędzia.
2. **Import:** przesłanie Excela, mapowanie kolumn, podgląd liczby wierszy i błędów, wybór zakresu do uruchomienia.
3. **Zadania:** liczba oczekujących, aktywnych, ukończonych, bez polis i wymagających uwagi; filtrowanie po REGON, nazwie, dacie i statusie.
4. **Szczegóły wiersza:** oś etapów, komunikat błędu bez danych wrażliwych, polisy, przycisk pobrania wyniku, kontrolowane ponowienie.
5. **Interwencje:** formularz SMS i osobny formularz dla brakujących danych ubezpieczonego, z informacją o źródle każdej wartości.
6. **Administracja:** użytkownicy i role, konfiguracja numeru rejestracyjnego, limity pracy, czas przechowywania danych, widok audytu.

Next.js odpowiada za interfejs React. Operacje biznesowe i wyszukiwanie w bazie wykonuje NestJS API; React nie otrzymuje pełnej bazy ani sekretów portali.

## 8. VPS i eksploatacja

1. Wybrać VPS w odpowiedniej lokalizacji i oszacować zasoby po pilotażu. Punkt startowy do testów: **4 vCPU, 8 GB RAM i dysk SSD**, z pomiarem zużycia Chromium oraz bazy przed zwiększeniem równoległości.
2. Przygotować Linux, aktualizacje, dostęp SSH kluczem, zaporę oraz domenę i certyfikat TLS.
3. Zbudować obrazy `web`, `api`, `worker`; uruchomić je przez Docker Compose z `postgres`, `redis` i reverse proxy. Publikować tylko porty HTTP/HTTPS; bazę, Redis i kanał kodów SMS zostawić w sieci wewnętrznej.
4. Trzymać sekrety serwera poza repozytorium, z ograniczonymi uprawnieniami plików. Lokalny `.env` służy rozwojowi; na VPS wprowadzić wartości osobno. `.env.example` zawiera tylko nazwy zmiennych i wartości przykładowe.
5. Wykonywać migracje bazy przed wdrożeniem nowej wersji. Kontenery otrzymują kontrole stanu i zasady restartu.
6. Zapewnić szyfrowane kopie PostgreSQL i plików wynikowych poza VPS oraz okresowy test odtworzenia. Ustalić retencję oryginalnych importów, wyników i logów.
7. Monitorować dostępność panelu, długość kolejki, błędy portali, czas zadań, wygaśnięcia sesji i brak miejsca na dysku. Logi bez PESEL, haseł, SMS oraz pełnych zrzutów ekranowych.
8. Dokumentować wdrożenie i rollback. Zmiany selektorów portali wydawać jako nową wersję adaptera, aby wcześniejsze uruchomienia zachowały informację, jaką wersją je wykonano.

## 9. Bezpieczeństwo danych i zasady dostępu do portali

Przed przetwarzaniem całej bazy potwierdzić uprawnienia firmy do pobierania tych danych oraz dopuszczony przez PZU i Compensę sposób automatyzacji. Jeżeli dostępna jest oficjalna integracja obejmująca te funkcje, porównać ją z obsługą UI. Ustalić podstawę, cel i okres przetwarzania PESEL oraz wyników UFG z osobą odpowiedzialną za ochronę danych w firmie.

Stosować najmniejsze konieczne uprawnienia, szyfrowanie połączeń i kopii, maskowanie PESEL w panelu oraz pełny audyt dostępu do eksportów. Nie umieszczać danych osobowych w nazwach zadań, komunikatach kolejki, metrykach ani adresach URL.

## 10. Kolejność prac, zadania i bramki odbioru

Etapy `P0`–`P9` są sekwencyjne tam, gdzie jeden zależy od wyniku drugiego. **P0A** jest dodatkowym etapem bezpośrednio po pilotażu P0 i korzysta z istniejącego fundamentu importu; prace P1–P2 można kontynuować równolegle, ale wzbogacenia nie uruchamiać przed bramką P0. Każdy agent może zmienić wewnętrzną technikę implementacji, jeśli utrzyma kontrakty danych, testy i bramkę. Zmianę założeń biznesowych zapisuje w sekcji 12 przed kodowaniem zależnego etapu.

### P0 — rozpoznanie portali i decyzje blokujące

**Zadania:** użytkownik wskazał **fizyczny wiersz arkusza 18001** jako rekord pilotażowy. Przejść na nim ścieżkę PZU → Everest → Compensa → UFG; zanotować URL i etykiety ekranów bez sekretów; ustalić sposób pobrania imienia, nazwiska i PESEL tej samej osoby; sprawdzić wpływ `RST22339`; sprawdzić mapowanie `Osoba Decyzyjna`, `Adres`, `Kod Pocztowy`, `Miasto` do pól Compensy oraz źródło powiatu; rozwinąć `Akcje` przy polisie OC; sprawdzić liczbę wierszy, przewijanie i ewentualne stronicowanie tabeli. Ustalić, czy portale oferują dopuszczoną integrację zamiast automatyzacji UI.

**Kontrola przed próbą:** wiersz 18001 istnieje w `Realizacja`; pola `Nazwa`, `NIP`, `REGON`, `Osoba Decyzyjna`, `Adres`, `Kod Pocztowy` i `Miasto` są niepuste. REGON ma dziewięć cyfr i parser importu nie zgłasza dla tego wiersza problemu. Ta kontrola **nie potwierdza** jeszcze działania PZU/Compensy ani wyniku UFG. Nie wpisywać rzeczywistych wartości identyfikatorów do protokołu.

**Próba LIVE-P0-18001:** (1) odszukać rekord po REGON i porównać nazwę z Excelem; (2) potwierdzić, że imię i nazwisko użyte w Compensie dotyczą osoby, której PESEL ujawnia Everest, oraz zanotować źródło każdego pola; (3) przejść logowanie i ewentualny SMS ręcznie w panelu; (4) użyć `RST22339`, zapisać dane ubezpieczonych, wykonać UFG; (5) odczytać wszystkie wiersze OC i porównać liczbę z podsumowaniem; (6) ręcznie porównać filtr daty i 12 pól jednego wyniku z eksportem albo potwierdzić poprawny stan bez pliku, gdy nie ma aktualnych polis. W razie sprzeczności osoby, brakującego powiatu lub niejasnego wpływu numeru rejestracyjnego zatrzymać próbę w stanie przeglądu.

**Przypadki:** jedna firma z jednoznaczną osobą i polisą; REGON bez wyniku; wynik z dwiema osobami; brak co najmniej jednego pola ubezpieczonego; co najmniej jedna polisa historyczna i jedna aktualna; tabela dłuższa niż widoczny obszar. Nie używać całej bazy jako testu rozpoznawczego.

**Bramka P0:** istnieje zanonimizowana mapa ekranów i pól, potwierdzony wpływ numeru rejestracyjnego na wyniki, źródło danych osoby oraz rozstrzygnięte `DECYZJA-01`–`04` i `DECYZJA-06`. Jeśli któregokolwiek z tych punktów nie potwierdzono, implementować wyłącznie fundament i symulowane adaptery; nie pisać produkcyjnych selektorów zależnych od zgadywania.

**Stan bramki:** test `LIVE-P0-18001` przeszedł ścieżkę Everest → Compensa → UFG → eksport i kontrolę pliku. Użytkownik potwierdził, że numer rejestracyjny nie jest filtrem wyniku; w pilotażu tabela zawierała wiele różnych numerów. Przed masowym uruchomieniem pozostaje potwierdzenie dopuszczonego sposobu integracji z portalami. Reguła pól Compensy wynika z instrukcji użytkownika: wypełnionych pól nie nadpisywać, puste uzupełniać z przypisanego wiersza.

**Wcześniejsza nieudana próba 29.09.2026:** formularz PZU otworzył się w izolowanej przeglądarce. Użytkownik sam wprowadził login, hasło i kod SMS; ekran potwierdził przyjęcie kodu. Po wybraniu „Kontynuuj” bramka wróciła do formularza z komunikatem o niepoprawnym loginie lub haśle oraz błędem `No such object`. Nie ponawiano logowania w ciemno. Osobny adres `EVEREST_URL` z lokalnej konfiguracji zwrócił w przeglądarce błąd certyfikatu `ERR_CERT_COMMON_NAME_INVALID`; nie obchodzono ostrzeżenia TLS. W tej próbie żaden REGON ani PESEL z wiersza 18001 nie został przesłany do portali. Późniejsza udana próba użyła wejścia do Everest z pulpitu PZU.

**Udany pilotaż 29.09.2026:** użytkownik zalogował się ręcznie w PZU i Compensie. Wejście do Everest przez pulpit PZU zadziałało. Po wyszukaniu REGON z fizycznego wiersza 18001 Everest zwrócił konto osoby fizycznej oraz konto jednoosobowej działalności; na szczegółach działalności potwierdzono REGON, nazwę, imię i nazwisko z arkusza oraz odczytano PESEL tej osoby. W Compensa Komunikacja podano ten PESEL i skonfigurowany numer rejestracyjny. Formularz `Dane ubezpieczonych` sam wypełnił wszystkie wymagane pola poza niewymaganym nazwiskiem rodowym; zapis i weryfikacja UFG zakończyły się powodzeniem. Podsumowanie pokazało 49 polis OC, a tabela OC miała dokładnie 49 wierszy i 49 poprawnych dat końca. Według daty 29.09.2026 w `Europe/Warsaw` 3 polisy spełniły `Okres ub. do >= dziś`, a 46 było starszych. Wygenerowano prywatny plik `.xlsx` w ignorowanym przez Git katalogu `exports/`; ponowny odczyt potwierdził 3 rekordy, wszystkie 12 pól danych OC, REGON, nazwę, PESEL i daty. W kolumnie `Akcje` wszystkie 49 komórek było pustych, więc nie znaleziono dodatkowego widocznego pola do eksportu. Dane identyfikujące osoby i treść polis nie są zapisane w tym protokole.

**Obserwacje do implementacji:** sam REGON zwraca dwa typy kont; wybierać działalność dopiero po porównaniu nazwy i osoby. Formularz Compensy ma własne dane adresowe; kod pocztowy z Excelu różnił się od wartości w portalu, dlatego w pilotażu nie nadpisano danych portalu. Powiat był już wypełniony przez portal. W 49 polisach OC wystąpiło 21 różnych numerów rejestracyjnych; zgodnie z regułą użytkownika cały wynik podlega odczytowi bez filtrowania po numerze podanym w formularzu.

**Ocena gotowości po pilotażu:** ścieżka danych, układ ekranu OC, filtr daty i format eksportu są wystarczająco poznane do implementacji workera i adapterów na małej próbce. Pusta `Osoba Decyzyjna` nie blokuje nazwy pliku; brak porównania z Excelem wymaga jednak jednoznacznego wskazania osoby w Everest. Przed uruchomieniem większej partii pozostało potwierdzenie dopuszczonego sposobu automatyzacji i zakresu uprawnień (`DECYZJA-06`). Zapamiętane logowanie na komputerze pilotażowym nie jest dowodem, że profil Chromium na VPS zachowa sesję; to osobny test bramki P9. Te niewiadome nie blokują budowy kolejek, ekranów interwencji, adapterów na testach syntetycznych ani jednowierszowego wdrożenia próbnego.

### P0A — uzupełnianie REGON z NIP i konsolidacja duplikatów, po pilotażu

**Źródło:** kandydatem jest oficjalne [API REGON GUS (BIR1)](https://api.stat.gov.pl/Home/RegonApi?lang=pl), które według dokumentacji pozwala wyszukiwać po NIP i wymaga uzyskania klucza do środowiska produkcyjnego. Przed implementacją sprawdzić aktualną dokumentację, warunki dostępu, limity, format odpowiedzi i sposób traktowania jednostek lokalnych; nie opierać produkcji na publicznym scraperze wyszukiwarki. Klucz trzymać w sekretach serwera.

**Kolejność:** (1) wybrać tylko wiersze z pustym REGON; (2) znormalizować NIP do tekstu i sprawdzić długość oraz sumę kontrolną; (3) dla poprawnego NIP zapytać rejestr jeden raz na unikalny NIP, z limitem równoległości, timeoutem, ponowieniem błędów przejściowych i cache; (4) zweryfikować otrzymany REGON oraz zgodność NIP i nazwy podmiotu z Excelem; (5) jednoznaczny wynik zapisać jako nową wartość pochodną wraz ze źródłem i datą, zachowując puste oryginalne pole; (6) brak wyniku, wiele podmiotów/jednostek, rozbieżność nazwy/NIP lub błąd trwały skierować do przeglądu, bez zgadywania; (7) ponownie wykryć duplikaty po NIP i uzupełnionym REGON, nadać kanoniczny identyfikator podmiotu i powiązać wszystkie wiersze źródłowe; (8) uruchamiać najwyżej jedno zadanie portalowe na kanoniczny podmiot w danej partii, chyba że operator świadomie rozdzieli rekordy z audytem.

**Zasada duplikatów:** identyczny NIP i REGON oraz zgodna nazwa → jedna grupa z listą wierszy źródłowych; ten sam NIP z różnymi REGON lub sprzecznymi nazwami → ręczna decyzja, z uwzględnieniem 9- i 14-cyfrowych jednostek; ten sam REGON z różnymi NIP → konflikt; podobna nazwa bez zgodnych identyfikatorów nie wystarcza do automatycznego scalenia. Ponowny import tego samego pliku i ponowienie zapytania nie mogą tworzyć dodatkowych zadań ani tracić informacji o pochodzeniu wyniku.

**Testy:** `T-REG-01`–`12` i `T-DUP-01`–`07` poniżej. **Bramka P0A:** raport dla 287 pustych REGON rozdziela wiersze na uzupełnione, wymagające przeglądu i bez NIP (46 według obecnego pliku); suma kategorii wynosi 287. Żaden niejednoznaczny wynik nie trafia do Everest. Oryginał Excela ma ten sam SHA-256. W próbce ręcznej każda automatyczna korekta zgadza się z oficjalną odpowiedzią rejestru, a każde scalenie ma widoczne powiązania źródłowe. Bramka wymaga klucza i testu dostępu do wybranego rejestru; same fixtury nie wystarczają.

### P1 — kontrakty, repozytorium i lokalna infrastruktura

**Zadania:** utworzyć workspace TypeScript; aplikacje `web`, `api`, `worker`; pakiety współdzielone; Compose z PostgreSQL i Redis; migracje Sequelize; wspólny typ `AutomationRun`, `SourceRow`, `IdentityMatch`, `OcPolicy`; jawne wersjonowanie schematu wyniku. Przygotować konfigurację `PZU_LOGIN_URL`, `EVEREST_URL`, `PZU_LOGIN`, `PZU_PASSWORD`, `COMPENSA_LOGIN_URL`, `COMPENSA_LOGIN`, `COMPENSA_PASSWORD` bez kopiowania wartości do kodu. Dopisać brakujące nazwy zmiennych do `.env.example` tylko z pustymi wartościami.

**Testy:** `T-PLAT-01`–`04`. **Bramka P1:** czysta instalacja i `docker compose up` uruchamiają usługi, health check API i połączenia wewnętrzne działają, migracje wykonują się na pustej bazie i ponowne uruchomienie nie zmienia schematu. Żaden sekret ani źródłowy Excel nie pojawia się w `git status` jako plik do dodania.

### P2 — import, walidacja i wybór partii

**Zadania:** parser `.xlsx` z limitem rozmiaru; wymagany arkusz `Realizacja`; mapowanie `Nazwa`, `NIP`, `REGON`, opcjonalnej `Osoba Decyzyjna` i pól do Compensy po nagłówkach, nie tylko pozycji; zapamiętanie numeru źródłowego wiersza; NIP i REGON jako tekst; raport walidacji; wstępna obsługa duplikatów i wybór pojedynczych wierszy lub zakresu. Po P0A wykonać ponowną deduplikację na wartościach pochodnych. Import jest odczytowy względem źródłowego pliku. Na etapie importu nie kontaktować się z portalami.

**Testy:** `T-IMP-01`–`08`. **Bramka P2:** wynik importu badanego pliku pokazuje 30 229 wierszy danych i 287 pustych REGON przy niezmienionym skrócie SHA-256 źródła (`4F34F98A7622C80090EC16D5A4282932F098B78DC56903B16AF5083C3B29E60C` dla obecnej kopii). Wiersze niepewne nie trafiają do kolejki bez decyzji operatora. Kontrola jakości bada także wartości z zerem wiodącym i osiem cyfr zapisanych liczbowo.

### P3 — panel, API i kontrola dostępu

**Zadania:** logowanie użytkowników panelu; role; import i podgląd; ekran statusów wzbogacenia REGON oraz konfliktów duplikatów; uruchamianie partii; lista zadań; statusy etapów; ekran interwencji i pobierania plików; audyt. API nie zwraca pełnego PESEL w listach. Identyfikatory zadań są losowe i niezależne od REGON/PESEL.

**Testy:** `T-UI-01`–`05`, `T-SEC-01`–`04`. **Bramka P3:** operator widzi tylko swoje uprawnione dane, użytkownik bez uprawnień otrzymuje odmowę również przy bezpośrednim wywołaniu API, a odświeżenie strony nie gubi stanu zadania.

### P4 — kolejka, stan zadania i SMS

**Zadania:** BullMQ uruchamia jeden rekord jako jednostkę pracy; zapisy checkpointów przed i po etapach; limit jednej sesji na konto; kontrola anulowania; mechanizm `waiting_for_sms` i jednorazowe przekazanie kodu; timeout, wygasła sesja i ponowienie. Kody nie wchodzą do danych zadania kolejki.

**Testy:** `T-JOB-01`–`07`, `T-SMS-01`–`08`. **Bramka P4:** symulowany worker odtwarza wszystkie przejścia stanów, SMS podany do niewłaściwego lub wygasłego zadania jest odrzucany, a po restarcie workera zadanie wraca do bezpiecznego kroku bez utraty śladu audytowego. Aktywna sesja jest współdzielona przez kolejne wiersze zamiast wymagać SMS dla każdego z nich.

### P5 — adapter PZU Everest

**Zadania:** login PZU, przejście do Everest, rozpoznanie istniejącej sesji, wyszukanie REGON, walidacja typu i tożsamości rekordu, odczyt PESEL oraz kontrola zgodności osoby z imieniem i nazwiskiem przekazanym w Excelu, jeśli podano je w arkuszu. Przy pustej kolumnie wymagać jednoznacznego powiązania osoby z działalnością na ekranie Everest. Selektory opierać na widocznych etykietach i strukturze udokumentowanej w P0. Logować nazwę kroku i typ błędu, nie treść pól.

**Testy:** `T-PZU-01`–`09`. **Bramka P5:** na zanonimizowanych przykładach oraz jednym uprawnionym rekordzie adapter zwraca poprawny kontrakt `IdentityMatch`; przypadki niejednoznaczne nie przechodzą do Compensy. Potwierdzenie ręczne musi dotyczyć tej samej osoby, REGON i nazwy działalności.

### P6 — adapter CPortal i weryfikacja UFG

**Zadania:** login CPortal, Compensa Komunikacja, wybór `Ubezpieczający`, PESEL i `RST22339`, sprawdzenie pól ubezpieczonego, zapis oferty, uruchomienie UFG i otwarcie szczegółów. Przed `Zapisz` sprawdzić zgodność imienia, nazwiska i PESEL z ustaloną osobą oraz obecność pozostałych wymaganych pól. Wypełnionych pól adresowych nie nadpisywać Excelem; puste uzupełnić z przypisanego wiersza, o ile formularz przyjmuje te wartości. Zapisać identyfikator oferty, jeśli dostępny.

**Testy:** `T-COM-01`–`10`. **Bramka P6:** jeden uprawniony przypadek przechodzi cały formularz; niezgodność danych lub brak powiatu prowadzi do interwencji, a symulowane przerwanie po `Zapisz` nie tworzy drugiej oferty przy wznowieniu. Weryfikację UFG uruchamia się tylko raz na potwierdzoną sprawę.

### P7 — ekstrakcja OC, filtr i eksport

**Zadania:** odczytać 12 pól danych tabeli OC; obsłużyć wewnętrzny scroll, ewentualne strony i doczytywanie; porównać liczność z podsumowaniem; sparsować daty; zastosować filtr włączny; deduplikować; zapisać do bazy; wygenerować plik przy dodatnim wyniku. `Akcje` nie jest polem eksportu, chyba że P0 wykaże potrzebne dodatkowe dane.

**Testy:** `T-OC-01`–`12`, `T-XLS-01`–`07`. **Bramka P7:** testowe 158 wierszy OC jest w całości odczytane w symulowanym widoku z przewijaniem; niezgodność z liczbą w podsumowaniu blokuje status `completed`. Daty graniczne i struktura gotowego Excela są potwierdzone automatycznie i ręcznie.

### P8 — odporność i bezpieczeństwo

**Zadania:** przetestować restart workera w każdym punkcie zapisu, utratę sieci, timeout portalu, odmowę logowania, limit żądań, niepełną odpowiedź UFG, brak miejsca na dysku i awarię Redis/PostgreSQL. Wprowadzić ograniczone ponawianie, status ręczny oraz alerty. Sprawdzić logi, eksport i backup pod kątem wycieku sekretów.

**Testy:** `T-RES-01`–`09`, `T-SEC-05`–`08`. **Bramka P8:** żadna awaria nie prowadzi do cichego pominięcia polisy, podwójnego zapisu oferty ani ekspozycji PESEL/SMS w logach. Każdy wiersz kończy się wynikiem, jawnym statusem do interwencji albo jawnym błędem.

### P9 — VPS, próba produkcyjna i rozszerzanie skali

**Zadania:** wdrożyć Compose i HTTPS; zamknąć porty bazy/kolejki; włączyć backup, retencję i monitoring; wykonać odtworzenie; uruchomić jeden rekord, następnie 10 i 100 wskazanych rekordów; porównać ręcznie wyniki próby z portalami. Nie uruchamiać automatycznie 30 229 wierszy po wdrożeniu.

**Testy:** `T-OPS-01`–`08`, `T-E2E-01`–`05`. **Bramka P9:** zatwierdzona próba porównawcza nie ma nieuzasadnionych rozbieżności, backup da się odtworzyć, monitoring wykrywa awarię workera, a tempo nie powoduje blokady kont. Zwiększenie partii jest osobną decyzją operacyjną.

## 11. Katalog testów funkcjonalnych i przypadków brzegowych

Każdy test ma: syntetyczne dane wejściowe, jedno oczekiwane zachowanie i zapisany wynik `pass/fail` w CI albo protokole pilotażu. Dane rzeczywistych osób nie trafiają do repozytorium. Fixtury portali to zanonimizowane HTML/JSON lub lokalne strony odtwarzające obserwowane stany; nie przechowywać zrzutów z widocznym PESEL. Testy `LIVE` uruchamia się wyłącznie na wskazanym, uprawnionym rekordzie i zapisuje tylko zanonimizowany protokół.

**Odkrywanie nowych edge case'ów:** w P0 prowadzić tabelę obserwacji dla każdego ekranu: stan zalogowany/wylogowany/SMS, liczba wyników Everest 0/1/wiele, osoba fizyczna/działalność, pola Compensy pełne/puste/sprzeczne, wynik UFG 0/1/wiele/błąd, tabela OC krótka/długa, data historyczna/dzisiejsza/przyszła. Dla każdej nowej odmiany zapisać oczekiwane zachowanie i zanonimizowaną fixturę **przed** poprawą adaptera. Po każdym błędzie produkcyjnym dopisać test regresyjny oraz aktualizację katalogu błędów z sekcji 13. Bramka nie przechodzi, jeśli zaobserwowany przypadek nie ma decyzji lub testu.

### Fundament, import i panel

| ID | Warunek lub działanie | Oczekiwany wynik |
| --- | --- | --- |
| `T-PLAT-01` | Pusta baza; start Compose i migracje | Web, API, worker, PostgreSQL i Redis są zdrowe; tabele powstają |
| `T-PLAT-02` | Ponowne uruchomienie tych samych migracji | Brak utraty danych i podwójnych tabel |
| `T-PLAT-03` | Brak obowiązkowego sekretu lub błędny URL | Proces odmawia startu z nazwą brakującej zmiennej, bez wypisania wartości |
| `T-PLAT-04` | Próba połączenia z PostgreSQL/Redis spoza sieci Compose | Porty usług nie są wystawione publicznie |
| `T-IMP-01` | Źródłowy plik `BAZA TRANSPORTOWA.xlsx` | 30 229 wierszy danych, 287 bez REGON; skrót pliku identyczny przed i po imporcie |
| `T-IMP-02` | REGON `012345678` zapisany jako tekst | W bazie i podglądzie pozostaje dziewięć cyfr z zerem |
| `T-IMP-03` | Ośmiocyfrowy REGON zapisany liczbowo | Status `needs_review`; żadnego cichego dopisania zera |
| `T-IMP-04` | Pusty, niedozwolony lub zbyt długi REGON | Wiersz pozostaje w imporcie z powodem; pusty REGON z NIP kwalifikuje się do P0A, a portal nie startuje przed rozstrzygnięciem |
| `T-IMP-05` | Dwa wiersze z tym samym REGON i nazwą | System wykrywa duplikat i nie uruchamia niejawnie dwóch weryfikacji |
| `T-IMP-06` | Zmieniona kolejność kolumn przy zachowanych nagłówkach | Mapowanie po nagłówku nadal działa albo importer żąda jawnego mapowania |
| `T-IMP-07` | Brak `Realizacja`, `Nazwa` lub `REGON` | Import kończy się czytelnym błędem, bez częściowego uruchomienia zadań; brak `Osoba Decyzyjna` jest dozwolony |
| `T-IMP-08` | Uszkodzony lub zbyt duży plik, pusty arkusz | Kontrolowana odmowa; plik tymczasowy jest usuwany |

### Wzbogacanie REGON i deduplikacja po P0

| ID | Warunek lub działanie | Oczekiwany wynik |
| --- | --- | --- |
| `T-REG-01` | Obecny plik źródłowy | 287 pustych REGON; 241 z NIP o 10 cyfrach i 46 bez NIP; żadne dane nie zmieniają się w oryginale |
| `T-REG-02` | Pusty REGON, poprawny NIP, jeden zgodny wynik rejestru | Wartość pochodna REGON, źródło i czas zapisane; wiersz gotowy do ponownej deduplikacji |
| `T-REG-03` | Pusty REGON i pusty albo błędny NIP/checksum | Brak zapytania do rejestru; status przeglądu z przyczyną |
| `T-REG-04` | Zapytanie po NIP zwraca zero wyników | Brak uzupełnienia; status `not_found` i możliwość ręcznego sprawdzenia |
| `T-REG-05` | Rejestr zwraca wiele REGON albo jednostkę lokalną i macierzystą | Brak automatycznego wyboru; widoczna decyzja operatora |
| `T-REG-06` | NIP odpowiedzi lub nazwa podmiotu nie zgadzają się z Excelem | Konflikt; żaden REGON nie trafia do kolejki portali |
| `T-REG-07` | Timeout, błąd 429/5xx lub chwilowy brak rejestru | Ograniczone ponowienia z opóźnieniem; zadanie zostaje do wznowienia bez utraty śladu |
| `T-REG-08` | Ponowne uruchomienie tej samej partii | Idempotentny zapis; cache ogranicza liczbę wywołań bez użycia nieaktualnej odpowiedzi po terminie ważności |
| `T-REG-09` | NIP ma zero wiodące albo w Excelu format liczbowy | Dziesięciocyfrowy identyfikator pozostaje tekstem; utracone zero jest oznaczone do przeglądu |
| `T-REG-10` | Odpowiedź rejestru ma REGON 9- albo 14-cyfrowy | Zachowany dokładny format; wybór jednostki zgodny z regułą zatwierdzoną w P0A |
| `T-REG-11` | Brak klucza API, błędny klucz lub wyczerpany limit | Czytelny stan integracji bez ujawnienia sekretu i bez uruchamiania portali |
| `T-REG-12` | Import przed i po wzbogaceniu | SHA-256 źródła bez zmian; suma statusów 287; korekty widoczne z pochodzeniem |
| `T-DUP-01` | Dwa wiersze z tym samym NIP/REGON i zgodną nazwą | Jedna grupa kanoniczna, jedno zadanie portalowe, dwa zachowane powiązania źródłowe |
| `T-DUP-02` | Brak REGON u jednego wiersza, po P0A otrzymuje REGON istniejącego wiersza | Ponowna deduplikacja łączy je przed Everest |
| `T-DUP-03` | Ten sam NIP, różne REGON albo nazwy | Stan konfliktu; bez automatycznego scalenia |
| `T-DUP-04` | Ten sam REGON, różne NIP | Stan konfliktu; bez automatycznego uruchomienia |
| `T-DUP-05` | Podobna nazwa, różne identyfikatory | Odrębne podmioty, bez heurystycznego scalenia |
| `T-DUP-06` | Ponowny klik startu albo ponowny import tej samej partii | Unikalny aktywny job na kanoniczny podmiot i partię; jawna historia prób |
| `T-DUP-07` | Eksport dla grupy kilku wierszy źródłowych | Wynik jest przypisany do każdego powiązania; nie powstają zduplikowane polisy |
| `T-UI-01` | Import i start pięciu wybranych wierszy | Panel pokazuje pięć zadań z odrębnymi statusami |
| `T-UI-02` | Odświeżenie strony podczas pracy | Aktualny stan jest odtworzony z API |
| `T-UI-03` | Filtrowanie po statusie, nazwie i REGON | Wyniki odpowiadają bazie i uprawnieniom użytkownika |
| `T-UI-04` | `waiting_for_sms` lub `waiting_for_manual_data` | Panel pokazuje właściwy formularz i termin działania |
| `T-UI-05` | Zadanie bez polis albo z błędem | Nie ma aktywnego przycisku pobrania nieistniejącego pliku |

### Zadania, sesje i kod SMS

| ID | Warunek lub działanie | Oczekiwany wynik |
| --- | --- | --- |
| `T-JOB-01` | Jedno uruchomienie jednego wiersza | Jeden job i jedna historia etapów |
| `T-JOB-02` | Ponowny klik „Uruchom” dla aktywnego wiersza | Brak drugiego aktywnego joba; panel wskazuje istniejący |
| `T-JOB-03` | Dwa joby korzystające z jednego konta portalu | Co najwyżej jedna aktywna sesja dla tego konta |
| `T-JOB-04` | Restart workera przed wysłaniem formularza | Zadanie wraca do ostatniego bezpiecznego checkpointu |
| `T-JOB-05` | Restart po `Zapisz` lub podczas UFG | Kontrola istniejącej oferty/weryfikacji przed dalszym działaniem; brak duplikatu |
| `T-JOB-06` | Anulowanie zadania oczekującego i aktywnego | Oczekujące nie startuje; aktywne kończy się po bezpiecznym punkcie i ma audyt |
| `T-JOB-07` | Praca przez północ w strefie polskiej | Wszystkie polisy w jednym runie używają tej samej zapisanej daty odniesienia |
| `T-SMS-01` | Poprawny kod do aktywnego wyzwania | Trafia raz do właściwej sesji i znika z pamięci po użyciu |
| `T-SMS-02` | Kod błędny | Użytkownik widzi błąd; limit prób chroni konto portalu |
| `T-SMS-03` | Kod po terminie | API odrzuca kod i inicjuje nowe logowanie, jeśli możliwe |
| `T-SMS-04` | Kod do innego zadania albo od nieuprawnionego użytkownika | Odmowa bez przekazania kodu workerowi |
| `T-SMS-05` | Restart workera w czasie oczekiwania na kod | Wyzwanie wygasa; stary kod nie jest użyty po restarcie |
| `T-SMS-06` | Przegląd DB, Redis, logów i śladów po teście | Brak kodu w trwałych danych i diagnostyce |
| `T-SMS-07` | Kilka kolejnych wierszy przy aktywnej sesji portalu | Ten sam profil; system nie inicjuje ponownego logowania ani SMS dla każdego wiersza |
| `T-SMS-08` | Restart workera z ważną sesją w profilu | Najpierw kontrola sesji; SMS tylko gdy portal faktycznie go wymaga |

### Everest i Compensa

| ID | Warunek lub działanie | Oczekiwany wynik |
| --- | --- | --- |
| `T-PZU-01` | Aktywna sesja PZU/Everest | Adapter nie loguje się drugi raz |
| `T-PZU-02` | Nowa sesja z SMS | Stan `waiting_for_sms`, potem poprawne przejście do wyszukiwarki |
| `T-PZU-03` | REGON bez wyniku | Jawny status `identity_review` lub `not_found`, bez wejścia do Compensy |
| `T-PZU-04` | Jedna zgodna działalność osoby fizycznej | Zweryfikowane imię, nazwisko i PESEL jednej osoby |
| `T-PZU-05` | Kilka osób lub kilka działalności dla REGON | Wybór ręczny, bez automatycznego pierwszego wyniku |
| `T-PZU-06` | Niepasująca nazwa/REGON albo sam rekord osoby fizycznej | Brak przejścia do Compensy i powód do weryfikacji |
| `T-PZU-07` | PESEL lub nazwisko niewidoczne/niedostępne | Status ręczny; bez domysłu z `Osoba Decyzyjna` |
| `T-PZU-08` | Wygasła sesja lub zmieniona etykieta elementu | Jedna kontrolowana próba ponownego logowania albo błąd selektora z nazwą kroku |
| `T-PZU-09` | Pusta `Osoba Decyzyjna` w Excelu | Jedna osoba powiązana z potwierdzoną działalnością → imię, nazwisko i PESEL z Everest; wiele osób → `identity_review` |
| `T-COM-01` | Aktywna sesja CPortal | Przejście do Compensa Komunikacja bez zbędnego logowania |
| `T-COM-02` | Nowe logowanie i wybór `Ubezpieczający` | Właściwa rola, PESEL i skonfigurowany numer rejestracyjny |
| `T-COM-03` | Wszystkie wymagane pola osoby wypełnione i zgodne | `Zapisz` bez nadpisywania danych |
| `T-COM-04` | Puste imię, nazwisko lub PESEL | Uzupełnienie wyłącznie potwierdzonymi wartościami z Everest |
| `T-COM-05` | Wypełnione pole różni się od danych Everest | Stop i ręczna weryfikacja przed `Zapisz` |
| `T-COM-06` | Pusty powiat lub inne wymagane pole bez wartości w portalu i Excelu | `waiting_for_manual_data`; puste pola z jednoznaczną wartością w przypisanym wierszu uzupełnić z Excela |
| `T-COM-07` | Puste `Nazwisko rodowe`, pozostałe pola poprawne | Pole pozostaje puste; proces może przejść do `Zapisz` |
| `T-COM-08` | Timeout odpowiedzi po `Zapisz` | Adapter sprawdza, czy oferta powstała, przed ewentualnym ponowieniem |
| `T-COM-09` | UFG zwraca błąd, niepełny wynik albo brak polis | Jawny odrębny status; brak fałszywego eksportu |
| `T-COM-10` | Podany numer rejestracyjny i wynik UFG zawierający wiele różnych numerów | Numer jest wyłącznie wymaganym polem wejścia; odczyt i filtr daty obejmują wszystkie polisy OC z tabeli |

### Polisy OC i plik wynikowy

| ID | Warunek lub działanie | Oczekiwany wynik |
| --- | --- | --- |
| `T-OC-01` | Zero polis OC w podsumowaniu | Zero rekordów i status `no_matching_policies` |
| `T-OC-02` | Jedna widoczna polisa OC | Wszystkie 12 pól danych odpowiadają widokowi |
| `T-OC-03` | Syntetyczne 158 polis z wewnętrznym przewijaniem | 158 unikalnych odczytanych wierszy, bez pominięcia ostatniego |
| `T-OC-04` | Tabela z paginacją lub doczytywaniem | Odczyt kończy się dopiero po ostatniej stronie/wierszu |
| `T-OC-05` | Podsumowanie 158, odczyt 157 | Błąd `incomplete_oc_table`; żaden wynik nie jest oznaczony jako kompletny |
| `T-OC-06` | Ten sam wiersz ponownie widoczny po scrollu | Deduplikacja bez utraty odrębnej polisy o podobnych danych |
| `T-OC-07` | `Okres ub. do` = wczoraj, dziś i jutro | W eksporcie dziś i jutro; wczoraj poza eksportem |
| `T-OC-08` | Pusta lub niepoprawna data końca | Ręczna weryfikacja; żadnego zgadywania daty |
| `T-OC-09` | Daty w formacie lokalnym, przełom roku lub dzień przestępny | Poprawne parsowanie do daty bez przesunięcia strefowego |
| `T-OC-10` | AC/ASS mają własne polisy | Ich wiersze nie są mieszane z OC |
| `T-OC-11` | Zmiana układu lub brak jednej kolumny OC | Błąd schematu z nazwą brakującego pola, bez cichego przesunięcia kolumn |
| `T-OC-12` | Polisa OC ma pustą markę/model lub liczbę szkód | Zapis jawnego `null`/braku danych, bez przesunięcia sąsiednich pól |
| `T-XLS-01` | Zero polis po filtrze | Brak pliku, status z liczbą zero |
| `T-XLS-02` | Jedna i wiele polis | Jeden wiersz Excela na polisę; komplet kolumn i metadanych |
| `T-XLS-03` | Nazwa działalności lub osoba decyzyjna zawiera `/`, `:`, cudzysłów lub długą nazwę; osoba może być pusta | Poprawna, bezpieczna nazwa `{REGON}_{nazwa}_{osoba}.xlsx` albo `{REGON}_{nazwa}.xlsx` przy pustej osobie |
| `T-XLS-04` | Dwa uruchomienia tej samej firmy | Dwa odrębne artefakty w magazynie; pobierana nazwa zgodna z wymaganiem |
| `T-XLS-05` | Tekst źródłowy zaczyna się od `=`, `+`, `-` lub `@` | Excel otwiera go jako tekst, bez wykonania formuły |
| `T-XLS-06` | REGON/PESEL z zerem wiodącym | W pliku zachowane jako tekst bez notacji naukowej |
| `T-XLS-07` | Daty początku i końca ochrony | Komórki zawierają czytelny tekst ISO `RRRR-MM-DD`, bez liczb seryjnych Excela; filtr zgodny z bazą |

### Odporność, ochrona danych i wdrożenie

| ID | Warunek lub działanie | Oczekiwany wynik |
| --- | --- | --- |
| `T-RES-01` | Przerwa sieci podczas pobierania wyniku | Ograniczone ponowienie od bezpiecznego checkpointu |
| `T-RES-02` | Portal zwraca limit lub blokadę konta | Zatrzymanie kolejki danego konta i alert; bez lawiny prób |
| `T-RES-03` | Restart workera przed/po `Zapisz` | Brak podwójnej oferty i jasny stan w bazie |
| `T-RES-04` | Restart workera przed/po UFG | Brak podwójnej weryfikacji bez potwierdzenia stanu |
| `T-RES-05` | Awaria Redis | Nowe zadania nie giną; panel sygnalizuje niedostępność kolejki |
| `T-RES-06` | Awaria PostgreSQL | Worker przerywa przed następnym skutkiem zewnętrznym, gdy nie może zapisać checkpointu |
| `T-RES-07` | Brak miejsca na dysku przy eksporcie | Jawny błąd eksportu; zapisane polisy pozostają w bazie |
| `T-RES-08` | Timeout przy odczycie 158 wierszy | Nie oznaczać częściowego odczytu jako sukcesu |
| `T-RES-09` | Ten sam rekord w dwóch partiach | Widoczna historia obu uruchomień, brak niejawnego nadpisania wyników |
| `T-SEC-01` | Operator pyta o cudze zadanie/eksport | HTTP 403 i wpis audytu |
| `T-SEC-02` | Próba pobrania pliku po odgadnięciu identyfikatora | HTTP 403/404 bez ujawnienia zawartości |
| `T-SEC-03` | Wyszukiwanie w panelu | Pełny PESEL nie pojawia się w URL, listach i telemetryce |
| `T-SEC-04` | Wylogowanie i wygaśnięcie sesji | Brak dostępu do API i eksportu po wygaśnięciu |
| `T-SEC-05` | Skan logów, kolejki i błędów po teście E2E | Brak haseł, kodów SMS i pełnych PESEL |
| `T-SEC-06` | Odczyt kopii zapasowej bez klucza | Dane wrażliwe nie są czytelne |
| `T-SEC-07` | Kontrola `.gitignore` i staged diff | Brak `.env`, Excela źródłowego i stanu sesji Playwright |
| `T-SEC-08` | Przekazanie kodu SMS przez API | TLS, uprawnienie do wyzwania, pojedyncze użycie, brak trwałego zapisu |
| `T-OPS-01` | Dostęp do VPS z Internetu | Publiczne wyłącznie zamierzone porty HTTPS/HTTP i administracyjne SSH |
| `T-OPS-02` | Certyfikat i żądanie HTTP | Poprawny TLS; HTTP przekierowuje do HTTPS |
| `T-OPS-03` | Restart całego Compose | Baza i pliki wynikowe są trwałe; zadania mają spójny stan |
| `T-OPS-04` | Backup i odtworzenie w osobnym środowisku | Odtworzona baza oraz wskazany plik eksportu zgadzają się ze skrótami |
| `T-OPS-05` | Celowo zatrzymany worker | Monitoring zgłasza niedostępność i rosnącą kolejkę |
| `T-OPS-06` | Wdrożenie nowej wersji i powrót do poprzedniej | Zachowana zgodność migracji lub udokumentowany bezpieczny rollback |
| `T-OPS-07` | Zużycie CPU/RAM/dysku przy małej partii | Zmierzone wartości i limit równoległości zapisane w protokole |
| `T-OPS-08` | Upłynięcie ustalonego okresu retencji | Usuwane są właściwe importy/eksporty i dane osobowe, audyt zgodny z polityką |
| `T-E2E-01` | Wskazany wiersz 18001; może mieć aktualną polisę albo jej nie mieć | Pełny przebieg `LIVE-P0-18001` odpowiada ręcznemu odczytowi; przy polisie eksport jest zgodny pole po polu, bez polisy nie powstaje plik |
| `T-E2E-02` | Rekord bez aktualnej polisy | Status bez pliku, zgodny z portalem |
| `T-E2E-03` | Partia 10 zatwierdzonych rekordów | Każdy ma wynik lub jawny wyjątek; brak cichego pominięcia |
| `T-E2E-04` | Partia 100 po odbiorze partii 10 | Stabilny limit konta i zgodność ręcznie sprawdzonej próbki |
| `T-E2E-05` | Porównanie ponownego uruchomienia | Brak podwójnych ofert i nierozpoznanych duplikatów polis |

## 12. Decyzje i otwarte kwestie dotyczące portali

`DECYZJA` oznacza wymóg potwierdzenia. Agent zapisuje odpowiedź, datę, sposób potwierdzenia i wpływ na testy; nie zmienia samodzielnie biznesowej reguły po zobaczeniu jednego niepełnego ekranu.

| ID | Pytanie do rozstrzygnięcia | Domyślne bezpieczne zachowanie do czasu decyzji |
| --- | --- | --- |
| `DECYZJA-01` | Dla wiersza 18001 potwierdzono w szczegółach działalności Everest zgodność REGON, nazwy oraz imienia i nazwiska osoby z arkuszem; na tym samym ekranie był PESEL. Czy identyczny wzorzec obowiązuje inne typy wyników? | Dla kolejnych wierszy wymagać tych samych kontroli; przy braku jednoznaczności zatrzymać na `identity_review` |
| `DECYZJA-02` | Rozstrzygnięta przez użytkownika: `RST22339` jest wymaganym polem wejściowym, a nie filtrem polis OC. | Nie ograniczać tabeli po numerze rejestracyjnym; sprawdzić kompletność wierszy względem podsumowania UFG |
| `DECYZJA-03` | Rozstrzygnięta instrukcją użytkownika: CPortal ma pierwszeństwo dla pól już wypełnionych; z Excela uzupełnia się tylko puste wymagane pola. Różnica adresu sama nie zatrzymuje procesu. | Jeśli brak wartości w obu źródłach lub PESEL/imię/nazwisko wskazują inną osobę, `waiting_for_manual_data` albo `identity_review` |
| `DECYZJA-04` | W pilotażu 49 komórek `Akcje` było pustych. Czy w innych wynikach może pojawić się dodatkowe szczegóły wymagane w eksporcie? | Eksport 12 widocznych pól danych; jeśli `Akcje` niepuste, zatrzymać do analizy przed rozszerzeniem kontraktu |
| `DECYZJA-05` | Retencja importów, PESEL, polis, eksportów i audytu; role z prawem pobierania | Konfiguracja retencji i ról pozostaje do zatwierdzenia przed produkcją |
| `DECYZJA-06` | Czy wolno automatyzować oba portale w opisanym zakresie i czy istnieje oficjalna integracja? | Pilot na uprawnionym koncie; brak masowego uruchomienia do potwierdzenia |
| `DECYZJA-07` | Czy Goldis uzyska klucz do API REGON GUS BIR1 i jaki wariant jednostki wybrać, gdy NIP zwraca kilka REGON? | P0A używa oficjalnej integracji dopiero po sprawdzeniu dostępu; wiele wyników wymaga ręcznej decyzji |
| `DECYZJA-08` | Jaki poziom zgodności nazwy i adresu pozwala automatycznie przyjąć REGON oraz które rekordy z tym samym NIP/REGON scalać? | Automatycznie akceptować tylko jednoznaczny wynik z potwierdzonym NIP i zgodną nazwą; sprzeczności kierować do przeglądu |

## 13. Katalog błędów i sposób ich obsługi

| Kod błędu | Rozpoznanie | Działanie systemu | Ponowienie |
| --- | --- | --- | --- |
| `INPUT_INVALID` | Pusty lub niepewny REGON, brak nazwy | Oznaczyć wiersz do poprawy przed portalami | Po ręcznej korekcie |
| `IDENTITY_NOT_FOUND` | Everest nie zwraca osoby dla REGON | Jawny wynik bez PESEL, raport dla operatora | Tylko ręczne |
| `IDENTITY_AMBIGUOUS` | Kilka osób lub niezgodność REGON/nazwy | Wstrzymać przekazanie do Compensy | Po wskazaniu właściwej osoby |
| `MFA_REQUIRED` | Portal żąda kodu | Pokazać aktywne wyzwanie SMS | Kod jednorazowy w czasie ważności |
| `AUTH_FAILED` | Odmowa loginu albo limit prób | Zatrzymać kolejkę tego konta i powiadomić administratora | Nie automatycznie |
| `PORTAL_TRANSIENT` | Timeout, chwilowa niedostępność | Zapisać krok; ograniczone ponowienie z opóźnieniem | Tak, tylko krok odczytowy |
| `PORTAL_SCHEMA_CHANGED` | Zniknął oczekiwany element lub kolumna | Zatrzymać adapter, zachować nazwę kroku i wersję | Po poprawce adaptera |
| `INSURED_DATA_MISSING` | Brak danych osoby bez pewnego źródła | Formularz ręcznego uzupełnienia w panelu | Po uzupełnieniu |
| `INSURED_DATA_CONFLICT` | Portal ma inną wartość niż Everest | Zatrzymać przed `Zapisz` | Po ręcznej decyzji |
| `SIDE_EFFECT_UNCERTAIN` | Timeout po `Zapisz` lub UFG | Odczytać stan istniejącej oferty/weryfikacji; bez ślepego ponowienia | Tylko po ustaleniu stanu |
| `UFG_INCOMPLETE` | Liczba OC w tabeli różna od podsumowania | Powtórzyć odczyt tabeli raz, potem ręczna weryfikacja | Bez nowej weryfikacji UFG |
| `DATE_INVALID` | Brak lub błędny `Okres ub. do` | Wstrzymać ocenę tej polisy; nie eksportować jej jako pewnej | Po wyjaśnieniu daty |
| `EXPORT_FAILED` | Błąd pliku albo brak miejsca | Zachować polisy w DB i ponowić sam eksport | Tak, bez powrotu do portali |
| `INFRA_UNAVAILABLE` | DB/Redis niedostępne | Zatrzymać pracę przed kolejnym skutkiem zewnętrznym | Po przywróceniu usługi |

Każdy wyjątek ma w panelu kod, etap, czas, identyfikator wiersza, możliwą czynność operatora oraz wersję adaptera. Nie umieszczać w komunikacie PESEL ani pełnego zrzutu formularza. Dla błędu nieznanego domyślnie zatrzymać wiersz i wymagać przeglądu, zamiast oznaczać `no_matching_policies`.

## 14. Pakiet przekazania kontekstu agentom Codex

### 14.1 Stan wspólny, który każdy agent ma otrzymać

1. **Cel:** produkt w panelu Goldis, nie jednorazowy skrypt. Pierwsze narzędzie pobiera OC z UFG przez Everest i Compensę, filtruje `Okres ub. do >= data uruchomienia` w strefie `Europe/Warsaw` i tworzy Excel tylko przy wyniku dodatnim.
2. **Źródło:** `docs/BAZA TRANSPORTOWA.xlsx`, arkusz `Realizacja`, B=`Nazwa`, C=`NIP`, D=`REGON`, I=`Osoba Decyzyjna`, N–P=`Adres`, `Kod Pocztowy`, `Miasto`. Występuje 30 229 wierszy i 287 pustych REGON; 241 z nich ma NIP o dziesięciu cyfrach. Oryginału nie modyfikować ani nie dodawać do Git. Fizyczny wiersz 18001 przeszedł pilotaż portali i eksportu; szczegóły bez danych osobowych są w P0.
3. **Portale:** PZU login → Everest → wybór osoby i PESEL → CPortal → Compensa Komunikacja → `Ubezpieczający` + PESEL + `RST22339` → Dane ubezpieczonych → `Zapisz` → Weryfikacja UFG → Szczegóły polis OC. Szczegóły i ograniczenia są w sekcjach 5 i 12.
4. **Wynik:** 12 pól danych z tabeli OC według sekcji 5, plik `{REGON}_{nazwa_dzialalnosci}_{imie_nazwisko_osoby_decyzyjnej}.xlsx` z osobą decyzyjną albo `{REGON}_{nazwa_dzialalnosci}.xlsx` bez niej; `Akcje` nie jest polem danych.
5. **Sekrety:** lokalny `.env` jest prywatny. Agent zna nazwy zmiennych z sekcji P1, lecz nie powinien czytać, kopiować ani wypisywać ich wartości. Kod ma pobierać wartości z konfiguracji w czasie działania.
6. **Stan testu na żywo:** wiersz 18001 przeszedł przez Everest, Compensę, UFG i eksport 3 aktualnych polis z 49 OC. Wcześniejsza nieudana próba logowania jest opisana w P0. Nadal otwarte są decyzje o adresie, wpływie numeru rejestracyjnego i dopuszczonym sposobie integracji; pojedynczy pilot nie dowodzi zachowania portali przy każdym przypadku.
7. **Reguła jakości:** żadnego domyślnego wyboru osoby, przypisania danych adresowych niewłaściwej osobie, pomijania niewidocznych wierszy OC ani automatycznego powtórzenia `Zapisz`/UFG po niepewnym wyniku. Po P0 wzbogacać brakujące REGON z NIP, a po wzbogaceniu ponownie deduplikować przed Everest.

### 14.2 Szablon zadania dla kolejnego agenta

Każde zadanie przekazać w tej strukturze, aby agent mógł rozpocząć bez odtwarzania rozmowy:

```text
Pakiet: P<numer> — <nazwa>
Stan poprzednich bramek: <zaliczone P0... / brak>
Cel i zakres: <konkretna funkcjonalność, pliki i interfejsy>
Wejścia i źródła prawdy: docs/PLAN_IMPLEMENTACJI.md + wskazane decyzje P0
Kontrakty, których nie wolno zmienić bez uzgodnienia: <typy/API/statusy/pola OC>
Przypadki testowe do wykonania: <ID z sekcji 11>
Przypadki brzegowe i decyzje: <ID z sekcji 12 i 13>
Dowód odbioru: <komendy testów, wynik, zanonimizowany przykład, diff>
Nie rób w tym pakiecie: <prace z kolejnych etapów, masowy test na żywo>
Pozostałe ryzyka/pytania: <krótka lista>
```

### 14.3 Zalecane pakiety pracy

| Pakiet | Kontekst wejściowy | Produkt pracy | Testy i bramka |
| --- | --- | --- | --- |
| `A: fundament` | Sekcje 0, 3, 4, P1 | Workspace, Compose lokalny, migracje, typy | `T-PLAT-*`, P1 |
| `B: import i panel` | Sekcje 1, 4, 7, P2–P3 | Parser, API, React, role | `T-IMP-*`, `T-UI-*`, `T-SEC-01..04`, P2–P3 |
| `B2: REGON i duplikaty` | Sekcje 1, 4, P0A, 12; po bramce P0 | Integracja NIP → REGON, statusy, grupy kanoniczne, audyt korekt | `T-REG-*`, `T-DUP-*`, P0A |
| `C: kolejka i SMS` | Sekcje 5–6, P4 | Stan zadania, worker, wyzwania SMS | `T-JOB-*`, `T-SMS-*`, P4 |
| `D: Everest` | Sekcje 5B, 12, P0/P5 | Adapter PZU i kontrakt osoby | `T-PZU-*`, P5; wymaga P0 |
| `E: Compensa i UFG` | Sekcje 5C, 12–13, P0/P6 | Adapter CPortal, zapis i UFG | `T-COM-*`, P6; wymaga P0 i P5 |
| `F: OC i eksport` | Sekcje 5D–E, P7 | Ekstrakcja, filtr, DB, `.xlsx` | `T-OC-*`, `T-XLS-*`, P7 |
| `G: odporność i VPS` | Sekcje 8–9, 13, P8–P9 | Monitoring, backup, wdrożenie | `T-RES-*`, `T-OPS-*`, `T-E2E-*`, P8–P9 |

### 14.4 Zasady przekazania i oznaczania zakończenia

- Agent kończący pakiet podaje zmienione pliki, decyzje projektowe, uruchomione testy z wynikiem, nieprzetestowane przypadki, znane błędy i instrukcję dla następnego pakietu.
- Bramka jest zaliczona dopiero po uzyskaniu opisanych dowodów. Samo przejście kompilacji lub pojedynczy zrzut ekranu nie wystarcza dla adaptera portalu.
- Przed zmianą kontraktu API, nazwy pól OC, kryterium daty albo reguły wyboru osoby agent aktualizuje ten dokument i wskazuje skutki dla późniejszych pakietów.
- Testy żywych portali uruchamiać wyłącznie w zakresie zatwierdzonej małej próby, bez umieszczania PESEL, SMS, haseł i pełnych odpowiedzi UFG w repozytorium albo relacji z testu.
- Jeżeli P0 nie rozstrzygnął decyzji, agent może budować interfejs i testy na fikcyjnych danych, lecz nie oznacza produkcyjnego adaptera jako gotowego.

## Źródła techniczne

- [GUS: oficjalne API REGON BIR1, wyszukiwanie po NIP i rejestracja klucza](https://api.stat.gov.pl/Home/RegonApi?lang=pl)
- [NestJS: kolejki BullMQ](https://docs.nestjs.com/techniques/queues)
- [Playwright: stan uwierzytelnienia](https://playwright.dev/docs/auth)
- [Next.js: samodzielny hosting](https://nextjs.org/docs/app/guides/self-hosting)
- [Docker Compose: produkcja na jednym serwerze](https://docs.docker.com/compose/how-tos/production/)
- [Sequelize: migracje](https://sequelize.org/docs/v6/other-topics/migrations/)

