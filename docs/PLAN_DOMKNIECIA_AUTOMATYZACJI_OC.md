# Plan domknięcia automatyzacji OC: Everest → Compensa → UFG → wynik

**Stan na 30.09.2026.** Ten dokument jest osobnym planem wykonania i odbioru działającej wersji. Dotyczy jednego zadania uruchamianego z panelu dla wskazanego wiersza importu, a następnie małej serii. Wiersz 18001 jest rekordem pilotażowym. Dane osobowe, hasła i kody SMS nie trafiają do tego dokumentu.

## 1. Cel i zasada pracy

Operator wybiera wiersz i datę odniesienia. Worker korzysta z **jednego długotrwale uruchomionego procesu Playwright i jednego osobnego profilu Chromium**, sprawdza bieżące sesje, wyszukuje firmę w Everest, wypełnia Compensę, odczytuje UFG, a API zapisuje i udostępnia wynik. Kod SMS jest wymagany wyłącznie wtedy, gdy portal go zażąda. Portal może ponownie wymagać uwierzytelnienia po wygaśnięciu sesji; aplikacja nie gwarantuje jednego SMS-u na zawsze.

W pilotażu 1 października 2026 potwierdzono ścieżkę pozytywną dla wiersza 18001: PESEL należy pobierać z wiersza **Osoba fizyczna** w wynikach wyszukania REGON w Everest. W Compensie wejście prowadzi przez kafelek **Compensa Komunikacja** na stronie głównej; do okna startowego trafiają ten PESEL i stały numer **RST22339**. Po zapisaniu oferty należy uruchomić UFG, otworzyć **Szczegóły**, a następnie **Szczegóły polis OC**. Parser odczytał 49/49 OC i wybrał 3 według daty 2026-10-01. Produkcyjny job i eksport API czekają na działający Docker/PostgreSQL/Redis oraz kompletną konfigurację lokalną.

Wznowienie po SMS-ie, błędzie lub restarcie odbywa się pod **tym samym `runId`** i od ostatniego potwierdzonego punktu kontrolnego. Nie tworzy się nowego zadania ani drugiej oferty tylko dlatego, że sesja wygasła.

## 2. Stan faktyczny i otwarte luki

| Element | Potwierdzono | Jeszcze do potwierdzenia |
| --- | --- | --- |
| PZU i sesja | Logowanie, ramka SMS, przejście ze Strefy Agenta do Everest i działający ekran wyszukiwania | Zachowanie po restarcie profilu i przy realnym wygaśnięciu sesji |
| Everest, wiersz 18001 | Wyszukanie REGON zwraca konto osoby oraz konto działalności. Operator potwierdził, że PESEL jest widoczny również w wierszu działalności | Struktura komórek i stabilne selektory; obecny adapter oczekuje REGON w wierszu wyniku, podczas gdy kolumna pokazuje PESEL. Regułę dopasowania trzeba poprawić i sprawdzić na żywo |
| Compensa | Logowanie, kafelek „Compensa Komunikacja”, modal i wybór „Ubezpieczający” przed polami | Stabilne selektory pól, numeru sprawy, potwierdzenia zapisu i następnych ekranów |
| UFG | Parser pełnej tabeli i kontrola liczności działają na fikcyjnej stronie | Rzeczywisty ekran podsumowania i wszystkich polis, w tym przewijanie oraz stan braku polis |
| Wynik | Jest prywatny kanał worker → API, zapis snapshotu, filtr daty, eksport i endpoint pobrania | Pełny test od kliknięcia w panelu do pobranego pliku z rzeczywistego zadania |
| Uruchomienie | Kod wspiera lokalny worker z widoczną przeglądarką | Konfiguracja PostgreSQL, Redis, sekretu usługowego, katalogów i zweryfikowanego pliku selektorów; w przykładowym JSON są nadal znaczniki `data-verified-*` |

**Bramka uruchomienia:** regularne przetwarzanie pozostaje wyłączone, dopóki wszystkie selektory używane w przebiegu nie są potwierdzone i nie przejdzie test jednego wiersza. Po potwierdzeniu selektorów można włączyć `WORKER_LIVE_PORTALS=1` wyłącznie w kontrolowanym lokalnym pilotażu 18001. Przykładowy `portal-selectors.example.json` nie jest konfiguracją produkcyjną.

**Punkt odniesienia z przekazanego programu:** ręczny pilotaż wiersza 18001 przeszedł Everest → Compensa → UFG i wykazał 49 pozycji OC; dla daty odniesienia 29.09.2026 trzy z nich były aktualne. To jest wzorzec do porównania pól i liczby całkowitej, a nie dowód, że automatyczny worker już działa. Przy nowej dacie liczba polis aktualnych może się zmienić. W Compensie należy użyć `RST22339` jako wymaganego wejścia formularza; numer nie zawęża odczytu UFG.

## 2A. Najkrótsza ścieżka do wstępnego odbioru

| Kolejność | Zmiana | Dowód zakończenia |
| --- | --- | --- |
| 1 | Potwierdzić komórki rzeczywistej tabeli Everest i poprawić adapter: wyszukiwany jest REGON, lecz kolumna wyniku pokazuje PESEL. Używać wyłącznie PESEL z jednego zgodnego wiersza działalności, bez przypisywania wyszukanego REGON jako rzekomo odczytanego z tabeli. Gdy sama lista nie potwierdza powiązania, sprawdzić szczegóły konta. | Odczyt live dla 18001 daje jedną potwierdzoną tożsamość; brak lub sprzeczność zatrzymuje zadanie przed Compensą. Test regresyjny odtwarza rzeczywisty układ tabeli bez danych osobowych. |
| 2 | Zmapować dalszy formularz Compensy i zapisać stabilne selektory: rola, identyfikator, `RST22339`, pola osoby i adresu, numer sprawy, potwierdzenie `Zapisz`. | Na jednym zadaniu jest jedna sprawa, pola portalu nie są nadpisane, brakujące pole ma stan interwencji, a konflikt osoby blokuje zapis. |
| 3 | Zmapować żywy widok UFG i odczytać wszystkie OC, również poza widocznym fragmentem. | Licznik UFG zgadza się z liczbą zebranych pozycji; dla znanego pilotażu oczekujemy 49 pozycji całkowitych, o ile portal nie zmienił danych. Daty i wybrane pozycje są ręcznie porównane. |
| 4 | Uruchomić lokalny panel, API, bazę, Redis i jeden worker z kompletną konfiguracją, a następnie wykonać 18001 od kliknięcia do wyniku. | Ten sam `runId` kończy się pobieralnym plikiem lub jawnym wynikiem zerowym. Plik zawiera tylko OC z `Okres ub. do >= referenceDate` zapisaną przy starcie zadania; zgodność 12 pól jest sprawdzona z UFG. |
| 5 | Wstrzyknąć awarie na checkpointach i uruchomić małą serię. | Restart, timeout po `Zapisz`, wygaśnięcie sesji, niepełne UFG i brakujące dane nie tworzą drugiej oferty ani drugiej weryfikacji; aktywna sesja jest używana ponownie. |

Optymalizacja liczby SMS wynika z utrzymywania jednego procesu i profilu Playwright oraz sprawdzania stanu sesji przed logowaniem. Należy zmierzyć liczbę prób loginu i wyzwań MFA podczas serii; nie zakładać, że ciasteczko lub sam profil gwarantuje ważną sesję. Jeśli portal zażąda kodu, ten sam `runId` czeka na jednorazowy kod i wraca do zapisanego etapu.

## 3. Kolejność prac i dowód ukończenia

### P0 — Ustalić selektory bez kolejnych ślepych prób logowania

1. W istniejącym profilu sprawdzić stan sesji PZU, zanim zostaną podane poświadczenia. Poprawiony inspektor odczytuje układ tabeli, klasy i długości numerów bez zapisywania PESEL-u lub REGON-u w logach.
2. Zmapować wyszukiwarkę i tabelę wyników Everest: element wiersza, typ konta, nazwę, osobę oraz PESEL. Potwierdzić, czy numer w kolumnie ma dokładnie 11 cyfr i jest odczytywany **z wiersza działalności**.
3. Dla wyszukiwania po REGON ustalić jawny warunek dopasowania: zapytanie ma dotyczyć dokładnego REGON z `sourceRowId`; z wyników dopuszczalny jest jeden wiersz działalności o zgodnej nazwie i osobie. Jeśli lista nie daje wystarczającego dowodu powiązania, otworzyć szczegóły konta; nie przypisywać REGON do wyniku przez domysł.
4. Wprowadzić selektory do lokalnego pliku konfiguracyjnego z nową wersją adaptera. Usunąć z używanej konfiguracji wszystkie znaczniki `data-verified-*`.

**Odbiór:** dla wiersza 18001 adapter zwraca jeden potwierdzony `IdentityMatchV1`; niezgodny typ, firma, osoba lub brak 11-cyfrowego PESEL-u zatrzymuje zadanie przed Compensą. Weryfikacja porównuje wartości w pamięci, bez ich wypisywania.

### P1 — Domknąć formularz Compensy

1. Sprawdzić istniejącą sesję Compensy. Jeśli jest ważna, otworzyć kafelek bez ponownego logowania. Jeśli wygasła, wykonać jedno zwykłe logowanie i obsłużyć MFA tylko wtedy, gdy portal go pokaże.
2. Potwierdzić stabilne selektory modalu: „Ubezpieczający”, pole PESEL/REGON, numer rejestracyjny, przycisk rozpoczęcia. Nie utrwalać identyfikatorów `uniqueId_*` ani losowych `id_*`.
3. Potwierdzić `RST22339` w lokalnej konfiguracji zgodnie z przekazanym programem. Numer służy do wejścia w formularz i **nie filtruje** polis OC.
4. Zmapować dane osoby i adres: imię, nazwisko, PESEL, adres, kod pocztowy, miasto, powiat, przycisk zapisu. Uzupełniać tylko puste pola z tego samego `sourceRowId`. Wypełnione, sprzeczne imię, nazwisko lub PESEL zatrzymują zadanie do kontroli. Jeśli powiatu nie ma w źródle i portal go nie uzupełni, zatrzymać zadanie z instrukcją uzupełnienia; nie zgadywać.
5. Zanim automat kliknie „Zapisz”, utrwalić identyfikator sprawy i zamiar zapisu. Potwierdzić rezultat na ekranie tej samej sprawy. Po timeoutcie odczytać stan sprawy przed ewentualnym ponowieniem.

**Odbiór:** dla jednego wiersza powstaje dokładnie jedna sprawa; po przerwaniu przed i po „Zapisz” nie powstaje druga. Puste dane mają jawny stan interwencji, a nie ciche pominięcie.

### P2 — Odczytać UFG i kompletne OC

1. Na potwierdzonej sprawie uruchomić weryfikację UFG jeden raz. Odczytać liczbę OC z podsumowania i wszystkie wiersze szczegółów, również te ładowane przy przewijaniu. Jeśli rzeczywisty widok ma paginację, dodać jej obsługę po zaobserwowaniu.
2. Porównać `rows.length` z liczbą OC w UFG. Sprawdzić wymagane kolumny, kolejność i unikalność pozycji oraz daty ochrony. AC/ASS nie zastępują OC.
3. Przy niezgodnej liczbie, nieczytelnej dacie, zmianie nagłówków lub timeoutcie zwrócić błąd/interwencję bez częściowego wyniku i bez pliku. Prawdziwe zero OC przy kompletnym podsumowaniu jest osobnym, poprawnym wynikiem.

**Odbiór:** snapshot z portalu ma wszystkie pozycje OC i zgodny licznik. Ręcznie porównać losowo wybrane pozycje oraz przypadek zerowy, jeśli jest dostępny bez tworzenia fikcyjnych danych klienta.

### P3 — Dostarczyć wynik z workera do aplikacji i pobrać go

1. Worker przekazuje zweryfikowany `IdentityMatchV1` i `OcSnapshotV1` do prywatnego endpointu API przez `WorkerResultForwarder`. W kolejce BullMQ pozostaje tylko `runId`; treść wyniku nie trafia do logów.
2. API waliduje kontrakty i zapisuje snapshot w PostgreSQL w transakcji. Według daty odniesienia zapisanej przy starcie zadania wybiera OC z `Okres ub. do >= referenceDate`.
3. Dla dodatniego wyniku API tworzy plik `.xlsx`, zapisuje jego metadane i udostępnia go wyłącznie przez autoryzowany endpoint panelu. Dla zera aktualnych polis kończy zadanie jako `no_matching_policies` bez pustego pliku.
4. Przy utraconej odpowiedzi z API worker ponawia dostarczenie/finalizację, a API rozpoznaje już zapisany snapshot i artefakt. Nie wraca do Compensy po samo pobranie pliku.

**Odbiór:** jedno zadanie przechodzi od przycisku w panelu do pobranego pliku; liczba i daty polis w pliku zgadzają się z bazą i UFG. Ponowienie żądania nie duplikuje polis ani pliku.

### P4 — Uruchomienie usługi i praca ciągła

1. Lokalnie: PostgreSQL i Redis uruchomić w Compose, a API, panel i **jeden** worker Playwright na komputerze operatora. Ustawić brakujące `DATABASE_URL`, `REDIS_URL`, `WORKER_AUTH_SECRET`, katalog profilu i ścieżkę zweryfikowanych selektorów. Sekrety i profil pozostają poza repozytorium.
2. Utrzymywać worker między zadaniami. Sprawdzać stan sesji przed logowaniem; nie otwierać nowego profilu ani nowego `runId` po SMS-ie. Drugi worker dla tego samego konta/profilu nie może równolegle wykonywać działań portalowych.
3. Zrestartować worker kontrolowanie po pierwszym udanym zadaniu. Sprawdzić, czy PZU i Compensa nadal akceptują sesję; jeśli nie, pokazać jedno żądanie logowania/SMS dla tego samego zadania. Trwały profil zwiększa szansę zapamiętania urządzenia, ale decyzja należy do portalu.
4. Dopiero po odbiorze lokalnym przenieść usługę na serwer z kontrolowanym dostępem, trwałym prywatnym profilem, HTTPS dla panelu/API, kopiami bazy i katalogu wyników oraz obserwowaniem stanu workera. Nie przenosić sesji z codziennego profilu przeglądarki.

**Odbiór:** trzy zadania z rzędu używają jednej sesji bez nowego SMS-u, o ile portal jej nie wygasił. Restart nie tworzy nowej oferty ani nie gubi wyniku; pobranie działa tylko po zalogowaniu do panelu.

## 4. Macierz prób awaryjnych

| Próba | Oczekiwane zachowanie |
| --- | --- |
| PZU pokazuje login, SMS, 403 lub nieznany ekran | Jedna kontrolowana próba; przy MFA interwencja w tym samym `runId`; przy odmowie/błędzie zatrzymanie z kodem, bez pętli logowania |
| Everest nie zwraca firmy, zwraca wiele firm albo brak PESEL-u w wierszu działalności | `identity_review`/jawny błąd; Compensa nie jest otwierana |
| Brak REGON, adresu, kodu, miasta lub powiatu; konflikt osoby | Błędny REGON blokuje start; brak wymaganych danych i konflikt przechodzą do interwencji bez zgadywania i bez „Zapisz” |
| Sesja Compensy wygasa podczas formularza | Ponowne sprawdzenie sesji, logowanie tylko gdy potrzebne, wznowienie od checkpointu tej samej sprawy |
| Timeout podczas „Zapisz” lub restart tuż po nim | Sprawdzenie tej samej sprawy; przy niepewnym wyniku stop do kontroli, bez drugiego kliknięcia |
| UFG zwraca zero, niepełną tabelę, zmianę nagłówków lub błędną datę | Zero po pełnej weryfikacji daje wynik zerowy; pozostałe przypadki blokują eksport |
| API/Redis/worker przestaje odpowiadać po odczycie UFG | Wznowienie dostarczenia zapisanego snapshotu i eksportu bez ponownego działania w portalu |
| Dwie równoczesne próby tego samego wiersza | Jeden aktywny właściciel zadania i profilu; brak drugiej oferty i drugiej weryfikacji |
| Pobranie bez uprawnienia albo brak pliku | Odmowa lub jawny brak; bez publicznego adresu pliku i bez danych osobowych w odpowiedzi błędu |

## 5. Kolejność testów i decyzja o włączeniu

1. **Kod bez portali:** build, testy kontraktów, fikcyjne strony Playwright, baza/API/eksport i awarie z tabeli. Każdy test sprawdza efekt zewnętrzny lub zatrzymanie w odpowiednim miejscu.
2. **Odczyt live bez zapisu:** wiersz 18001 w Everest, porównanie tożsamości i selektorów. Nie przechodzić dalej, jeśli powiązanie REGON → wiersz działalności → PESEL jest niepewne.
3. **Jeden przebieg live:** Compensa, zapis jednej sprawy, UFG, wynik w API i pobranie pliku. Ręczne porównanie liczb i dat z portalem.
4. **Awaria i wznowienie:** ponowienie tego samego `runId`, restart workera po checkpointach, wygasła sesja, brak danych i niepewny zapis. Liczyć kliknięcia „Zapisz” i UFG, nie treść SMS.
5. **Mała seria:** trzy kolejne wiersze w jednej sesji, potem restart i jeden następny. Dopiero po tym włączyć regularne użycie i rozważyć serwer.

**Definicja „wstępnie przetestowana”:** etapy 1–4 przeszły dla jednego uprawnionego rekordu, wynik jest pobieralny lub jawnie zerowy, a przećwiczone awarie kończą się bez duplikatów i bez utraty danych. Samo przejście testów syntetycznych nie spełnia tego warunku.
