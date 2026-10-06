# Plan domknięcia funkcjonalnego platformy Goldis

Data: 5 października 2026. Podstawa: bieżący kod, `PLAN_IMPLEMENTACJI.md`, `PLAN_ADMINISTRACJI_PLATFORMY.md` i `AUDYT_WYKONANIA_2026-10-05.md`.

Ten dokument określa pozostałe prace nad platformą. Jest planem, nie potwierdzeniem wykonania. Odbiór rzeczywistych ekranów Everest/Compensy pozostaje w planie automatyzacji, ale platforma musi zapewnić kompletną obsługę ich statusów, interwencji i wyników.

Każdy pakiet PL-01–PL-11 jest rozwinięty na konkretne kroki, pliki, projektowane kontrakty, migracje, testy i bramki w [szczegółowym planie implementacji dla agenta](PLAN_IMPLEMENTACJI_PLATFORMY_DLA_AGENTA.md). Ten dokument pozostaje skrótem zakresu i zależności.

## 1. Co oznacza kompletna platforma

Zakres pierwszego wydania: jedna organizacja Goldis, cztery istniejące role, katalog obsługiwanych narzędzi i pierwsze narzędzie OC. Platforma jest kompletna, gdy użytkownik może wrócić do wcześniejszej pracy, przygotować dane, uruchomić pojedynczy rekord lub partię, obsłużyć wyjątki i pobrać wynik. Administrator zarządza dostępem i pracą, recenzent rozstrzyga dane, audytor czyta dziennik. Każda z tych ścieżek ma działające UI, API, trwały zapis i test odbiorczy.

Nie dopisywać kolejnych narzędzi ani zespołów/wielu organizacji tylko dla rozbudowania katalogu. Nowy wpis narzędzia musi odpowiadać rzeczywistemu modułowi. Sekrety i selektory portali pozostają w konfiguracji wdrożenia zgodnie z istniejącym zakresem.

Trzy osobne statusy zakończenia:

1. **Platforma kompletna funkcjonalnie:** wszystkie właściwe jej ścieżki przechodzą na rzeczywistym API/DB/Redis z syntetycznymi portalami i wynikami.
2. **Narzędzie OC odebrane live:** pełny wynik i zachowanie po restarcie potwierdzone na Everest/Compensie; osobna bramka A9.
3. **Wydanie odebrane do eksploatacji:** backup, monitoring, retencja i zabezpieczenia działają na docelowym środowisku. Przy VPS dochodzi odbiór domeny, HTTPS i profilu portali na tym hoście.

## 2. Mapa funkcjonalności i obecnych luk

| Funkcjonalność | Obecny stan | Potrzebne domknięcie |
| --- | --- | --- |
| Konta, logowanie, hasła, sesje | Główne API i ekrany istnieją | Pełny odbiór revocation i ostatniego admina; potwierdzenia działań; odzyskiwanie dostępu według procedury |
| Role i granty | Polityka i API istnieją | Spójność wszystkich ekranów, endpointów, list i pobrań; pełna ścieżka recenzenta/audytora |
| Katalog narzędzi | API `/tools` istnieje; workspace wybiera OC na sztywno | Katalog i routing do obsługiwanych modułów, stany dostępności, powrót do pracy |
| Import XLSX | Parser, walidacja i podgląd istnieją | Lista wcześniejszych importów, filtry i paginacja; ponowne otwarcie importu po nowym logowaniu |
| Korekty REGON | Tworzenie propozycji `pending` istnieje | Zatwierdzenie/odrzucenie przez recenzenta/admina, zapis decyzji i aktualizacja wartości operacyjnej |
| NIP → REGON | Kontrakty, lookup/cache i zapis wyniku istnieją | Rzeczywisty provider, wykonanie z UI/API, limity i odbiór błędów rejestru |
| Grupowanie podmiotów | Automatyczne grupowanie i zapis konfliktu istnieją | Rozstrzygnięcie konfliktu w API/UI, kontrola skutków korekty i ponowna ocena grupy |
| Uruchamianie | Pojedynczy wiersz i kanoniczny run istnieją | Wybór zbioru/zakresu, trwała partia, podsumowanie i kontrolowany dispatch |
| Historia zadań | Lista do 50 rekordów dla wskazanego importu | Globalna historia w zakresie uprawnień, dalsze strony, filtry i linki do szczegółów |
| Interwencje i SMS | Znaczna część funkcji istnieje | Terminy/strefy, paginacja, role, błędy i pełny odbiór z rzeczywistym backendem |
| Wyniki i pliki | Zapis, ocena i prywatne pobranie istnieją | Historia dostępnych wyników, powiązanie ze wszystkimi wierszami grupy, odbiór praw i braku pliku |
| Ustawienia i operacje | Panel i API istnieją | Wyścigi limitów/przydziałów, kompletna nawigacja, statusy awarii i egzekwowanie ustawień przy partiach |
| Audyt i raporty | Zapisy i agregaty istnieją | Ekrany właściwych ról, spójne ID zasobów, filtry, testy danych i większych zbiorów |
| Eksploatacja | Compose, preflight i health istnieją | Retencja, backup/restore, monitoring, konfiguracja wydania i odbiór docelowego hosta |

Ważne dowody z kodu: `imports.ts` udostępnia szczegóły importu, ale nie listę importów; `runs.ts` przyjmuje pojedyncze `rowNumber` i zwraca do 50 zadań; `proposeRegonCorrection` tworzy `pending`, a kontroler nie ma decyzji recenzenta; `EntityGroupingService` zapisuje konflikt bez końcowego przepływu rozstrzygnięcia; `RegistryLookupService` nie jest podłączony do produkcyjnego providera. Te zakresy nie są ukończone wyłącznie dlatego, że modele i komponenty istnieją.

## 3. Pakiety wykonawcze

### PL-01 — wersja bazowa i odtwarzalne środowisko

- [ ] Utrwalić sprawdzoną wersję źródeł, lockfile i migracji w Git, po przeglądzie plików prywatnych. Nie dodawać konfiguracji z sekretami, importów klientów ani profili.
- [ ] Zapewnić izolowane PostgreSQL/Redis do testów oraz powtarzalny start panelu/API/workera; odróżnić środowisko testowe od istniejącej bazy.
- [ ] Sprawdzić migracje świeżej i legacy bazy oraz kopii aktualnej bazy. Nowe zmiany schematu wykonywać kolejnymi migracjami addytywnymi.
- [ ] Zdefiniować dane syntetyczne dla czterech ról, dwóch operatorów, wielu stron list, konfliktów i wyników.

**Odbiór:** nowa instalacja i aktualizacja dochodzą do tego samego schematu; usługi uruchamiają się powtarzalnie; testy nie korzystają z danych klienta. Docker blokuje dziś odbiór zależny od usług, ale nie niezależne poprawki kodu.

### PL-02 — poprawki platformy z audytu

- [ ] Poprawić konwersję UTC ↔ `Europe/Warsaw` dla terminów interwencji. Zapis bez edycji zachowuje ten sam moment; objąć czas letni/zimowy.
- [ ] Dodać paginację użytkowników, interwencji i zadań operacyjnych; zachować filtry podczas przechodzenia między stronami.
- [ ] Dodać potwierdzenia cofnięcia grantu, wyłączenia konta, zmiany roli i cofnięcia wszystkich sesji; komunikat opisuje skutek.
- [ ] Obsłużyć błędy odświeżania, stale version/revision i cofnięcie sesji w każdym widoku bez niewidocznych błędów Promise.

**Odbiór:** niezmieniony termin pozostaje niezmieniony; dostępny 101. użytkownik i 51. zgłoszenie; konflikt zapisu nie nadpisuje nowszych danych; anulowanie potwierdzenia nie wysyła mutacji.

### PL-03 — katalog, nawigacja i powrót do wcześniejszej pracy

- [ ] Zbudować katalog z `/api/tools`, ze stanami available/maintenance/disabled i grantami użytkownika; po wyborze otwierać właściwy moduł.
- [ ] Dodać autoryzowaną listę importów z filtrem daty/narzędzia/statusu i stabilną paginacją; właściciel/tenant filtrują SQL przed paginacją.
- [ ] Dodać widoki historii importów, zadań i wyników oraz linki do importu/runu. Odświeżenie strony zachowuje wybrany zasób i filtry przez URL.
- [ ] Zapewnić puste stany, brak uprawnień, zasób usunięty/niedostępny, ładowanie i błąd usług.

**Odbiór:** użytkownik wylogowuje się, loguje ponownie i otwiera wcześniejszy import, zadanie i wynik bez ponownego uploadu. Drugi operator nie widzi ich przez listę ani znany URL. Katalog nie obiecuje niezaimplementowanego narzędzia.

### PL-04 — kompletne ścieżki kont i ról

- [ ] Odebrać tworzenie konta, zmianę własnego hasła, hasło tymczasowe, wymuszenie zmiany, wyłączenie/włączenie konta, logout i cofnięcie jednej/wszystkich sesji.
- [ ] Potwierdzić równoległą ochronę ostatniego administratora i cofnięcie sesji po zmianie hasła/roli/statusu.
- [ ] Udostępnić audytorowi oddzielny ekran dziennika, bez zarządzania kontami i dostępu do danych operacyjnych.
- [ ] Udostępnić recenzentowi kolejkę danych do rozstrzygnięcia. Odbierać możliwości według roli i grantu, a nie na podstawie widoczności kafla.
- [ ] Domknąć opisany w macierzy zakres audytu recenzenta: wyłącznie zdarzenia danych przydzielonego narzędzia, bez zdarzeń kont/sesji/ustawień. Obecne API wyszukiwarki dopuszcza admina/audytora, więc wymaga rozszerzenia z osobnym filtrowaniem serwerowym.
- [ ] Sprawdzić zmianę praw podczas otwartej strony i obsługę przejęcia zgłoszeń po odcięciu operatora; udokumentować odzyskanie dostępu administracyjnego.

**Odbiór:** cztery role wykonują tylko swoje czynności; cofnięta sesja lub grant nie pozwala na następny odczyt/pobranie; organizacja zachowuje aktywnego admina.

### PL-05 — zamknięcie korekt i konfliktów danych

- [ ] Dodać listę oczekujących korekt oraz decyzje zatwierdź/odrzuć z wersją, autorem i powodem.
- [ ] Zatwierdzenie aktualizuje wartość operacyjną REGON, walidację i grupowanie; oryginalny import pozostaje zachowany. Odrzucenie nie zmienia wartości operacyjnej.
- [ ] Dodać bezpieczne rozstrzygnięcie konfliktów podmiotów: wskazanie zweryfikowanego powiązania albo kontrolowane rozdzielenie z audytem.
- [ ] Sprawdzić wpływ zmiany na aktywny run. Nie podmieniać tożsamości/danych zadania, które już rozpoczęło skutki portalowe; wyświetlić konsekwencje i wymaganą dalszą akcję.
- [ ] Odbierać równoczesne decyzje dwóch recenzentów, brak grantu, nieaktualną wersję oraz rollback przy błędzie audytu.

**Odbiór:** propozycja nie pozostaje bez dostępnej drogi rozstrzygnięcia; zaakceptowany rekord wraca do poprawnego stanu; decyzja jest jednokrotna, trwała i audytowana; konflikt nie zostaje automatycznie pominięty.

### PL-06 — rzeczywiste uzupełnianie REGON z NIP

- [ ] Wybrać źródło rejestru i zapewnić wymagany dostęp; podłączyć provider do istniejącego lookup/cache zamiast tworzyć drugą logikę walidacji.
- [ ] Dodać autoryzowane uruchomienie wzbogacenia i jego postęp. Zapytania wykonać dla właściwych rekordów, z ograniczeniem liczby równoczesnych żądań i deduplikacją NIP.
- [ ] Obsłużyć timeout, limit rejestru, niedostępność, brak wyniku, wiele wyników i niezgodność podmiotu; pokazać pochodzenie i datę danych.
- [ ] Wynik stosować transakcyjnie do zgodnej wersji wiersza, po sprawdzeniu REGON/NIP/nazwy; potem ponownie ocenić grupowanie.

**Odbiór:** jeden zgodny wynik uzupełnia dane; niejednoznaczność wymaga przeglądu; niedostępny rejestr nie blokuje rekordów z już poprawnym REGON. Syntetyczny provider odbiera platformę, rzeczywisty provider wymaga osobnego smoke na uprawnionych danych.

### PL-07 — uruchamianie partii i kontrola zadań

- [ ] Dodać wybór pojedynczych rekordów i zakresu wierszy oraz podgląd: gotowe, wymagające przeglądu, powiązane duplikaty, rzeczywista liczba nowych uruchomień.
- [ ] Utrwalić partię, wybór i wersje danych, jedną datę odniesienia oraz identyfikator idempotencji żądania; nie opierać partii na bieżącym stanie Reacta.
- [ ] Wykorzystać kanoniczne runy i outbox. Deduplikować zgodną firmę/tożsamość, zachowując powiązania wszystkich wierszy źródłowych; różne osoby nie mogą być bezwarunkowo scalane.
- [ ] Ustalić dispatch partii przy limicie godzinowym i oknie pracy: wysyłać dopuszczone zadania, pozostałe pozostają oczekujące. Nie tworzyć częściowego niewidocznego sukcesu, gdy limit wyczerpie się w środku żądania.
- [ ] Pokazać postęp i status każdego rekordu. Błąd/interwencja jednego rekordu nie zatrzymuje niezależnych pozostałych; konto portalowe ma jednego aktywnego właściciela.
- [ ] Dodać anulowanie oczekujących elementów partii i jasną obsługę aktywnego zadania; po restarcie kontynuować z trwałego stanu.

**Odbiór:** ponowienie tego samego żądania i restart nie dublują zadań; niepoprawne wiersze są jawne; limity nie są przekraczane przy równoczesnych startach; wszystkie elementy partii mają dostępny końcowy lub wymagający obsługi status.

### PL-08 — kompletne interwencje i obsługa wyników

- [ ] Odebrać listę, liczniki, odczyt, przydział, priorytet, termin, historię, korektę danych i wznowienie zgodnie z rolą.
- [ ] Połączyć modal SMS z rzeczywistym API/DB/Redis i produkcyjnym workerem na fixture; sprawdzić kod odrzucony, timeout, limit, niepewną dostawę, restart i anulowanie.
- [ ] Zamknięcie okna/oznaczenie przeczytania nie rozwiązuje zadania. Stan challenge jest źródłem terminu; licznik nie tworzy nowych wyzwań.
- [ ] Zapewnić historię wyników i pobranie dla zgodnych grantów, rozróżniając ukończony wynik, zero pasujących polis, brak/niedostępność pliku i błąd integracji.
- [ ] Wynik wspólnego kanonicznego runu dostępny z właściwych wierszy źródłowych; pobranie po odebraniu grantu jest odmawiane.

**Odbiór:** operator obsługuje przypisany SMS także bez prawa odczytu wyniku; uprawniony użytkownik pobiera zgodny plik; zero nie generuje pustego eksportu; niedostępność API po odczycie wznawia dostarczenie bez nowej akcji portalowej.

### PL-09 — ustawienia, audyt i raporty

- [ ] Odebrać pauzę nowych startów, limit godzinowy, okna pracy, CAS ustawień i konkurencyjne starty. Jasno wskazać skutek ustawień na przyjęte zadania/partie.
- [ ] Sprawdzić metryki operacyjne DB/Redis/worker/outbox, stary heartbeat i zadania bez wykonania; pokazać rozpoznawalną przyczynę i dalszą czynność.
- [ ] Ujednolicić ID zasobów audytu: pobranie zapisuje dziś `resource_type='artifact'` z ID runu, a filtr narzędzia wyszukiwarki wiąże artifact z `export_artifacts.artifact_id`. Naprawić kontrakt i obsłużyć historyczne wpisy; raport pobrań musi zachować zgodność.
- [ ] Testować audyt/raporty na znanym zestawie danych, granicach okresów, retry, cancelled/failed/no_matching_policies i filtrach narzędzia. Opisy wskaźników odpowiadają zapytaniom.
- [ ] Zmierzyć duże listy/raporty i import reprezentatywnej dużej bazy; usunąć potwierdzone problemy zapytań i pamięci.

**Odbiór:** każda skuteczna decyzja ma wymagany wpis; pobranie jest odnajdywane po narzędziu; liczby raportu odpowiadają ręcznie policzonemu zestawowi; API nie zwraca danych z obcego zakresu.

### PL-10 — interfejs i odbiór całego produktu

- [ ] Sprawdzić desktop/mobile, klawiaturę, etykiety, fokus, kontrast, długie nazwy, puste listy, błędy i powrót z historii do szczegółów.
- [ ] Wprowadzić jeden runner ścieżek produktu przez prawdziwy backend; smoke z podstawionymi odpowiedziami zachować jako szybką regresję UI.
- [ ] Przejść: admin tworzy konto/nadaje grant → operator importuje/otwiera historię → recenzent rozstrzyga dane → operator uruchamia partię → przydzielony operator obsługuje SMS → wynik/pobranie → audyt/raport → cofnięcie grantu.
- [ ] Powtórzyć z dwoma operatorami, dwoma recenzentami i sesjami; wykonać awarie API/DB/Redis/workera i restart z trwałego stanu.
- [ ] Uaktualnić instrukcję administratora, operatora, recenzenta i audytora oraz jeden bieżący status bramek. Testy właściwe zmienionym zachowaniom są obowiązkowe; nie dodawać testów odtwarzających tylko strukturę kodu.

**Odbiór:** pełna ścieżka wykonuje się bez ręcznej ingerencji w DB i bez mockowania uprawnień. Nie ma funkcji dostępnej tylko przez nieudokumentowany SQL lub niedostępny endpoint.

### PL-11 — utrzymanie i gotowość wydania

- [ ] Przygotować mechanizm retencji: osobne okresy, tryb podglądu, bezpieczne sprzątanie plików i rekordów, ochronę aktywnych runów/interwencji i idempotencję. Włączyć usuwanie dopiero dla zatwierdzonej polityki.
- [ ] Wdrożyć backup DB/eksportów i osobno kluczy; faktycznie odtworzyć całość w izolacji.
- [ ] Zapewnić wykrywanie offline workera, zaległego outboxa, nieobsłużonych interwencji, braku miejsca i nieudanego backupu. Kanał powiadomień oraz odbiorca są decyzją wdrożeniową; test nie wysyła wiadomości osobom bez autoryzacji.
- [ ] Odebrać wersję i rollback, uprawnienia wolumenów, procesy bez zbędnych przywilejów, minimalne obrazy, zależności oraz konfigurację proxy/HTTPS na docelowym hoście.

**Odbiór:** operator ma procedurę awarii, alert dociera uzgodnioną drogą, backup da się odtworzyć, a wydanie ma identyfikowalną wersję. Dla publicznego VPS obowiązuje również istniejący plan bezpieczeństwa i odbiór portali na nowym hoście.

## 4. Kolejność i pierwszy zakres tej sesji

Zależności: PL-01 → PL-02 → PL-03/PL-04 → PL-05 → PL-06 → PL-07 → PL-08/PL-09 → PL-10. PL-11 można przygotowywać wcześniej; jego odbiór zależy od gotowej platformy i docelowego środowiska. Rozbudowany odbiór PL-05–PL-09 wymaga działających izolowanych usług.

**Pierwszy pakiet kodowania:** PL-02, następnie PL-03 i brakujący ekran audytora z PL-04; PL-01 przygotowuje środowisko odbioru. Dostarcza poprawione terminy, dostęp do dalszych stron, potwierdzenia i możliwość wrócenia do importów/zadań po ponownym logowaniu. Pierwszy pakiet nie powinien zmieniać adapterów Everest/Compensy.

**Następny pakiet:** PL-05 i domknięcie ról, potem provider PL-06 i partie PL-07. Same poprawki administracji nie zamykają pierwotnego zakresu produktu, ponieważ przewidziano również korekty, wzbogacanie i uruchamianie zakresów.

Po każdym pakiecie zapisać: zmienione pliki, migracje, komendy i wynik testów, stan odbioru oraz pozostałe blokady. Do głównego dziennika dopisywać dowody, a checklistę tego dokumentu oznaczać dopiero po spełnieniu kryterium, nie po samym napisaniu kodu.

## 5. Decyzje wymagane przed zależnymi etapami

| Decyzja | Blokuje | Prace możliwe wcześniej |
| --- | --- | --- |
| Źródło rejestru NIP → REGON i uprawniony dostęp | Rzeczywisty provider/odbiór PL-06 | Kontrakt, UI, kolejka, fixture i obsługa błędów |
| Terminy przechowywania poszczególnych rodzajów danych | Włączenie usuwania PL-11 | Mechanizm, dry-run i testy syntetyczne |
| Docelowy host/domena i kanał alertów | Odbiór eksploatacji PL-11 | Konfiguracja i procedury, test lokalny |
| Dostęp operatora do portali i ewentualnego SMS | A9 i odbiór profilu na hoście docelowym | Wszystkie syntetyczne prace platformowe |

Nie trzeba teraz uzależniać rozpoczęcia PL-02–PL-05 od tych decyzji.

## 6. Końcowa checklista kompletności

- [ ] Każda funkcja z tabeli ma działające UI/API, zgodne uprawnienia i trwały stan.
- [ ] Żadna korekta, partia ani interwencja nie pozostaje bez obsługiwanej dalszej czynności.
- [ ] Wcześniejsze importy, zadania i wyniki można otworzyć po nowym logowaniu.
- [ ] Cztery role oraz granice danych potwierdzono przez HTTP, także po znanym URL i cofnięciu dostępu.
- [ ] Cała ścieżka produktu oraz wymagane awarie przechodzą na izolowanym backendzie.
- [ ] Historyczne dane/migracje są zgodne, a audyt i raporty mają sprawdzone definicje.
- [ ] Wydanie i dokumentacja są odtwarzalne; osobno wskazano otwarte A9/eksploatację, jeśli jeszcze nie zostały odebrane.

Pełny termin zakończenia można oszacować po PL-01 i odbiorze pierwszego pakietu. Lista funkcji bez kryteriów odbioru ani samo przejście istniejących testów nie wystarczają do oznaczenia platformy jako kompletnej.
