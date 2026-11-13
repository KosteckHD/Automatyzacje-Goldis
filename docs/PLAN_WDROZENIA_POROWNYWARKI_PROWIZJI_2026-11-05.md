# Plan wdrożenia porównywarki prowizji do Goldis

**Dokument historyczny — zastąpiony planem Python/VPS.** Pierwotna wersja zakładała port silnika do TypeScript. Implementacja wykonuje ustalenie użytkownika: silnik porównania działa w Pythonie, a Goldis API obsługuje autoryzację, trwałe dane i kolejkę. Aktualny plan krok po kroku znajduje się w [dokumentacji porównywarki](porownywarka-prowizji/README.md), a rzeczywisty postęp i ograniczenia odbioru w [statusie implementacji](porownywarka-prowizji/IMPLEMENTATION_STATUS.md). Nie traktować dalszych propozycji TypeScript w tym historycznym dokumencie jako aktualnych decyzji.

## 1. Cel i zakres pierwszego wydania

Drugie narzędzie Goldis, o proponowanym identyfikatorze `commission-comparison`, ma sprawdzać:

1. Czy polisy wystawione w CRM w wybranym okresie mają rozliczenie w dostarczonych plikach ASF lub Warty.
2. Czy procent prowizji odpowiada właściwemu produktowi, ryzyku, wariantowi i osobie wskazanej jako OFWCA.
3. Czy rozliczenia z dostarczonych plików mają odpowiedniki w dostarczonym CRM.
4. Które pozycje wymagają dodatkowego raportu, wyjaśnienia numeru, przypisania ryzyka lub reguły biznesowej.

W pierwszym wydaniu użytkownik sam dostarcza pliki. Pobieranie danych z CRM i portali TU, ustalanie kwot niedopłat oraz automatyczne reklamacje pozostają poza zakresem. Wystąpienie jednej pozycji nie jest potwierdzeniem wszystkich rat, ryzyk ani faktycznej wypłaty.

Słownik startowy to v7: 653 pozycje w 36 grupach towarzystw/ofert, z oddzielnymi wartościami i statusami dla Oli i Maćka. Osoby prowizyjne są osobnymi rekordami domenowymi; nie utożsamiamy ich z kontami użytkowników Goldis.

## 2. Punkt odniesienia do odbioru

Przy identycznym zestawie danych i reguł wynik platformy musi odpowiadać prototypowi, także na poziomie poszczególnych pozycji, nie tylko sum:

| Miara | Wartość v7 |
| --- | ---: |
| Okres dat wystawienia CRM | 01.06–30.09.2026 |
| Wszystkie polisy w dostarczonym CRM | 1678 |
| Polisy w wybranym okresie | 944 |
| Polisy dopasowane | 682 |
| Polisy bez odnalezionego rozliczenia | 244 |
| Polisy z niepewnym numerem | 18 |
| Ocenione pozycje procentowe | 1651 |
| Pozycje bez oceny procentu | 481 |
| Rozbieżne pozycje procentowe | 257 |
| Polisy z rozbieżnością procentową | 140 |
| Pozycje rozliczeń po pominięciu identycznego pliku | 3977 |

Weryfikacja dodatkowa: 944 = 682 + 244 + 18. Pozostałych liczników nie sumujemy do liczby polis: jedna polisa może mieć kilka pozycji, rozbieżność i jednocześnie część ryzyk bez oceny.

Kontrola odwrotna ma osobny zakres: porównuje wszystkie dostarczone rozliczenia z całym dostarczonym CRM. W obecnym zestawie daje 83 grupy bez odpowiednika w CRM: 45 z datą umowy ASF w okresie, 29 poza okresem i 9 z Warty bez daty wystawienia. Grupa oznacza TU + źródło + numer po normalizacji; nie jest automatycznie jedną unikalną polisą między wszystkimi źródłami.

Lokalne 89 testów jest materiałem do przeniesienia. Ich przejście nie zastępuje testów integracji nowego modułu z Goldis. Po zmianie zestawu plików lub reguł powstaje nowy punkt odniesienia; nie wymuszamy powyższych liczb na nowych danych.

## 3. Decyzje architektoniczne

### Wykorzystanie istniejącej platformy

Przegląd repozytorium potwierdził: frontend Next.js/React w `apps/web/app`, API NestJS i Sequelize, PostgreSQL, BullMQ/Redis, katalog narzędzi, sesje i granty, audyt, mechanizmy eksportów oraz ograniczony parser importów.

Moduł otrzyma własną domenę `apps/api/src/features/commissions` i kontrakty/reguły w `packages/core/src/commissions`. Domena korzysta z publicznych kontraktów innych funkcji i portów infrastruktury; nie importuje ich prywatnych repozytoriów. Należy zachować istniejące kontrole granic architektury i atomowości audytu.

Silnik porównania przenosimy do TypeScript jako funkcje bez zależności od HTTP, bazy i UI. Python v7 pozostaje zamrożonym wzorcem dla testów porównawczych. Pierwszy port odtwarza reguły v7; nowych interpretacji pakietów i kodów nie dodajemy przy okazji portowania. Docelowo produkcja utrzymuje jeden silnik, a nie dwa równoległe zestawy reguł.

Zadania wykonuje osobny proces/konsument kolejki prowizji, proponowany w `apps/api/src/processes/commissions`. Uruchomienie porównania nie zależy od Playwrighta, SMS ani dostępności portali. W Redis przekazujemy identyfikator zadania, bez danych klientów.

### Istotne miejsca integracji

- `apps/api/src/features/tools`: rejestracja narzędzia i ustawienia dostępności.
- `apps/web/app/tools/tool-catalog.tsx`: obecnie linkowanie jest warunkowane identyfikatorem narzędzia OC; sam wpis w bazie nie wystarczy, aby otworzyć nowy moduł.
- `apps/api/src/features/authorization`: sprawdzenie domyślnego identyfikatora OC, zakresów zasobów i wyjątków wspólnego dostępu do wyników OC. Nie przenosić tych wyjątków automatycznie na prowizje.
- `packages/core/src/index.ts`: istnieją kontrakty zadania przeznaczone wyłącznie dla OC. Nowy moduł dostaje własny kontrakt; nie osłabiamy walidacji starego przez zamianę identyfikatora na dowolny tekst.
- `apps/api/src/features/imports`: ponownie wykorzystać zabezpieczenia archiwum i ograniczenia parsera, ale nie model wiersza wymagający danych firmowych OC ani jego reguły NIP/REGON.
- `apps/api/src/infrastructure/artifacts` i `features/results`: wykorzystać bezpieczny zapis/pobieranie przez odpowiedni publiczny kontrakt. Obecne rozwiązywanie ścieżek dopuszcza artefakty `.xlsx`; wejściowy `.xlsm` wymaga osobnego kontrolowanego typu magazynowania, nie dowolnej ścieżki użytkownika.
- `apps/api/src/composition/module.ts`, rejestr modeli, migracje, role DB, konfiguracja procesów i skrypty startowe: rejestracja nowych elementów.

Numery migracji nadać z aktualnego stanu repozytorium. W przeglądzie występowały migracje do 065; nie jest to potwierdzenie wersji działającej bazy ani rezerwacja kolejnego numeru.

## 4. Przebieg użytkownika

1. Otwiera „Porównywarka prowizji” z katalogu narzędzi.
2. Wybiera okres **dat wystawienia polis w CRM**. Obie daty graniczne są włączone.
3. Dodaje pliki do grup: „Lista polis CRM”, „ASF”, „Warta”; opcjonalny raport UNIQA tylko jako odrębny, rozpoznany format.
4. Widzi rozpoznane typy plików, liczbę wierszy, okresy, duplikaty, błędy i liczbę polis mieszczących się w wybranym zakresie. Przykład: 1678 wszystkich, 944 w zakresie, 734 poza nim.
5. Wybiera aktywną wersję słownika. Może wcześniej przejrzeć i uzupełnić słownik.
6. Uruchamia analizę. Ekran pokazuje stan zadania, a po zakończeniu podsumowanie i listę problemów.
7. Filtruje wyniki według TU, OFWCA, rodzaju problemu, numeru i wariantu. Otwiera szczegóły z dowodem źródłowym.
8. Pobiera Excel lub zapisuje wyjaśnienie. Po poprawie słownika albo dodaniu plików uruchamia nową analizę; poprzedni wynik pozostaje zachowany.

Nie uzależniamy uruchomienia od stuprocentowego uzupełnienia słownika. Nierozstrzygnięte wpisy muszą być widoczne w wynikach. Zakończone zadanie z brakami biznesowymi nie jest awarią techniczną.

## 5. Słownik i zarządzanie regułami

### Prosty edytor

Podstawowy widok ma sześć kolumn, zgodnie z uzgodnieniem:

`Towarzystwo | Ryzyko / produkt | Wariant | Prowizja Oli % | Prowizja Maćka % | Uwagi`

- Brakujące stawki pokazujemy czerwonym „BRAK”. Użytkownik uzupełnia lub poprawia wartość bezpośrednio w komórce.
- Nowy i Wznowienie aktywne pozostają osobnymi wariantami PZU. „Nie wskazano” nie potwierdza jednakowych warunków wszystkich wariantów.
- Bez dodatkowych kolumn „Decyzja klienta”, „Poprawna stawka” ani formularza odpowiedzi przy każdym wierszu.
- W modelu przechowujemy osobno liczbę i status: stawka, brak prowizji, brak zdefiniowanej stawki, produkt nieoferowany, nierozpoznany kod, warunki indywidualne, brak danych. Opis tekstowy nie jest procentem.
- „Za to nie ma prowizji” z aktualnego pliku klienta oznacza jawne 0%. „Nie wiem”, „nie oferujemy” i „można usunąć” nie uruchamiają usuwania danych ani nie oznaczają 0%.
- Pozostałe uwagi o nierozpoznanych produktach pozostają widoczne, jeśli takie pozycje występują w rozliczeniach.

### Wersje

Edycja tworzy wersję roboczą. Użytkownik z właściwym grantem publikuje ją po podglądzie różnic. Publikacja zapisuje autora, czas, poprzednią wersję i źródło. Opublikowanej wersji nie zmieniamy w miejscu. Można ponownie aktywować poprzednią wersję dla przyszłych analiz.

Każda analiza przypina wersje słownika, przypisań ryzyk, reguł normalizacji numerów i silnika oraz listę konkretnych plików. Zmiana aktywnego słownika nie zmienia historycznych wyników.

Daty obowiązywania i podstawa daty wyboru stawki są informacją wersji/reguły, dostępną w ustawieniach szczegółowych. Nie dodajemy obowiązkowych kolumn dat do podstawowej tabeli. Gdy historia nie jest znana, wynik jawnie wskazuje zastosowanie wybranego słownika do całego okresu. Nie wyznaczamy dat obowiązywania na podstawie dnia importu.

### Import słownika

- Obsłużyć bieżący sześciokolumnowy plik klienta i jego `.xlsm`, odczytując dane bez wykonywania makr.
- Rozróżniać procent Excela i liczbę punktów procentowych: `0,15` z formatem procentowym = 15%, a `15` z literalnym znakiem `%` = 15%. Nie zgadywać jednostki wyłącznie z wielkości liczby.
- Zachować surową wartość, format i komórkę źródłową. Formuł bez bezpiecznej, zapisanej wartości nie wykonywać podczas importu; zgłosić konkretny problem.
- Przypisywać dane według trwałego klucza TU/produkt/wariant/osoba, nie kolejności wierszy.
- Zmiany kluczy, nowe pozycje i niejednoznaczne duplikaty pokazywać do rozstrzygnięcia. Nie pomijać ich po cichu ani nie wyłączać całego TU na podstawie uwagi przy jednym produkcie.
- Pokazać podgląd: nowe stawki, korekty, zmiany statusu i nierozpoznane pozycje. Zachować poprzednią wersję.

## 6. Dane i kontrakty

Proponowane grupy danych:

| Obszar | Zakres |
| --- | --- |
| Agenci prowizyjni | Stałe ID Oli i Maćka, identyfikatory OFWCA, kontrolowane aliasy nazw; oddzielnie od kont logowania. |
| Pliki wejściowe | Tenant, rodzaj źródła, hash, wersja parsera, okres rozliczenia, status walidacji, bezpieczny klucz magazynu. |
| Wiersze źródłowe | Plik/arkusz/wiersz, surowy i znormalizowany numer, TU, produkt, ryzyko, daty z ich znaczeniem, OFWCA, procent i potrzebne kwoty. |
| Wersje słownika i wpisy | Procent/status dla konkretnej osoby, wariant, warunki, pochodzenie, status robocza/opublikowana. |
| Wersje przypisań | Jawne powiązania kodów i nazw z produktami oraz reguły numerów; bez dopasowywania po otrzymanym procencie. |
| Analizy i pliki analizy | Zakres dat, stan wykonania, użytkownik, identyfikatory plików, przypięte wersje, hash danych, próba wykonania. |
| Wyniki | Rozliczenie każdej polisy oraz każdej pozycji; status dopasowania, oceny procentu, przyczyna i kierunek braku. Oddzielone jednostki liczników. |
| Wyjaśnienia | Decyzja użytkownika, uzasadnienie i źródło; historia decyzji oraz wersja wykorzystywana w kolejnym przeliczeniu. |
| Eksporty | Powiązanie z analizą i niezmiennym wynikiem, wersja formatu, stan generowania i uprawnione pobieranie. |

Każdy zasób otrzymuje zakres organizacji (`tenantId`). Dane procentowe przechowujemy jako wartości dziesiętne z określoną jednostką i precyzją, nie jako sformatowany tekst. Tolerancja porównania w pierwszym porcie ma odpowiadać v7: 0,000001 punktu procentowego; nie zaokrąglamy różnicy przed oceną.

Proponowane API pod `/api/tools/commission-comparison`:

| Funkcja | Endpoint |
| --- | --- |
| Import i stan plików | `POST /files`, `GET /files/:id` |
| Podgląd zakresu i jakości zestawu | `POST /input-preview` |
| Wersje i wpisy słownika | `GET /dictionary/versions`, `GET /dictionary/versions/:id/entries` |
| Utworzenie/edycja roboczej wersji | `POST /dictionary/drafts`, `PATCH /dictionary/drafts/:id/entries/:entryId` |
| Import, różnice, publikacja | `POST /dictionary/imports`, `GET /dictionary/drafts/:id/diff`, `POST /dictionary/drafts/:id/publish` |
| Uruchomienie i postęp | `POST /runs`, `GET /runs/:id`, `POST /runs/:id/cancel` |
| Wyniki i wyjaśnienia | `GET /runs/:id/findings`, `POST /runs/:id/resolutions` |
| Historia i eksport | `GET /runs`, `POST /runs/:id/exports`, `GET /exports/:id/download` |

Tworzenie zadań i publikacja wersji muszą być odporne na podwójne kliknięcia. Edycja używa oczekiwanej rewizji; spóźniony zapis drugiej osoby zwraca konflikt zamiast nadpisania zmian. Listy wyników są filtrowane i stronicowane po stronie serwera, z uprawnieniami stosowanymi przed liczeniem.

## 7. Reguły porównania, które trzeba zachować

1. **Zakres dat:** główna lista według daty wystawienia CRM, niezależnie od daty ochrony czy miesiąca raportu. Przeszukujemy wszystkie wybrane raporty. W podsumowaniu pokazujemy także polisy wyłączone przez zakres.
2. **Osoba:** oczekiwaną stawkę wybiera OFWCA w danej pozycji rozliczenia. Przy braku rozliczenia właściciel może pozostać nieustalony. Kilku OFWCA przy jednej polisie wymaga jawnego pokazania, nie automatycznego wyboru pierwszego.
3. **Numery:** zachowujemy zapis źródłowy i osobno klucz porównania. Reguły są zależne od TU. Dla AGRO `1002N01740628 → 01740628`; Compensy `22014-1849756 → 1849756`; OMINIMO `OMPLINS260901320547 → 260901320547`; UNIQA `2026-4054286584 → 4054286584`; Allianz końcowy człon po ostatnim myślniku, bez myślnika numer pozostaje bez zmian. PZU zachowuje uzgodnioną obsługę sufiksów i ochronę przed wieloma możliwymi wznowieniami. Pozostałe reguły i ograniczone aliasy TU przenosimy z v7.
4. **Kolizje:** jednakowy skrót nie wystarcza przy wielu możliwych polisach. Kandydat nie jest pewnym brakiem ani potwierdzonym dopasowaniem. Nie stosować ogólnego porównywania końcówek wszystkich numerów.
5. **Stawki:** dopasowanie według TU, kodu/nazwy, osoby i warunków; nigdy według tego, jaki procent byłby zgodny z raportem. PZU NOWE i WZNOWIENIE AKTYWNE pozostają oddzielne. Panel, POS, floty, HDI i online nie są automatycznie zamienne.
6. **Pakiety i korekty:** nierozstrzygnięty pakiet, próg inkasa, zerowe/ujemne inkaso lub korekta pozostają bez oceny zgodnie z v7. Nie tworzymy brakujących reguł z samej obserwacji otrzymanego procentu.
7. **Braki:** osobne kierunki CRM → rozliczenia i rozliczenia → CRM. Dla Warty obecność w jednym właściwym kanale wystarcza; nie wymagamy tej samej polisy w ASF i Warcie jednocześnie. UNIQA w ASF nie jest osobnym dostarczonym raportem UNIQA.
8. **Kontrola odwrotna:** przeszukuje cały dostarczony CRM. Datę umowy ASF, miesiąc rozliczenia i nieznaną datę Warty pokazujemy osobno; nie zaliczamy automatycznie wszystkich takich wpisów do braków z wybranego okresu wystawienia.
9. **Duplikaty:** identyczny plik liczony raz w danym zestawie, z widocznym powiązaniem. Jednakowe wiersze rozliczeń mogą oznaczać raty; nie usuwamy ich automatycznie.
10. **Pochodzenie:** szczegóły wyniku wskazują oba numery, regułę dopasowania, plik/arkusz/wiersz, OFWCA, stawkę otrzymaną i oczekiwaną oraz konkretną wersję/pozycję słownika.

Status dopasowania i status procentu przechowujemy oddzielnie. „Rozliczenie odnalezione, procentu nie oceniono” jest prawidłowym wynikiem, różnym od braku rozliczenia. Rozbieżność względem przyjętego słownika nie jest automatycznie potwierdzoną należnością do reklamacji.

## 8. Wyniki, bezpieczeństwo i niezawodność

Ekran wyników ma podsumowanie oraz widoki: braki w rozliczeniach, rozbieżne procenty, brak możliwości oceny, niepewne numery i braki w CRM. Każdy problem pokazuje przyczynę oraz następne działanie. OFWCA, TU i zakres czasu muszą być czytelne. Eksport z tego samego snapshotu ma zgadzać się z ekranem, również po filtrowaniu i w licznikach.

Należy podłączyć istniejące `discover`, `execute`, `view_results`, `download_results` oraz osobny grant zarządzania słownikiem. Możliwość analizowania nie oznacza automatycznie prawa do zmiany stawek. Odebranie dostępu musi działać także dla bezpośredniego URL wyniku, starego linku pobierania i zadania oczekującego.

Pliki i dane nie mogą być ujawniane innemu tenantowi ani w logach/Redis. Wykorzystać polityki szyfrowania i audytu platformy. Parser ma ograniczenia rozmiaru pliku, liczby arkuszy/komórek, ekspansji ZIP, pamięci i czasu. Nie ufać rozszerzeniu ani zadeklarowanym wymiarom arkusza — dotyczy to m.in. obecnych plików Warty. Makra i zewnętrzne łącza nie są wykonywane; tekst nie staje się formułą w eksporcie.

Trwały stan zadania, zapis zlecenia i audyt mają być spójne transakcyjnie, z kontrolowanym przekazaniem do kolejki zgodnym z istniejącym outboxem. Ponowiona dostawa zadania nie tworzy drugiego wyniku. Wynik publikujemy dopiero po pełnym zapisie, a przerwany eksport można odtworzyć z tego samego snapshotu. Obsłużyć restart procesu, retry, anulowanie i wygaśnięcie wykonania.

Przed przyjęciem modelu danych ustalić usuwanie plików, analiz i eksportów wraz z istniejącymi blokadami i dziennikiem usunięć. Nie wprowadzać automatycznego TTL dla danych biznesowych bez uzgodnienia. Usunięcie zasobu w trakcie pracy musi blokować jego ponowne utworzenie przez spóźnionego workera.

## 9. Kolejność implementacji i kryteria zakończenia

| Etap | Dostarczany zakres | Kryterium zakończenia |
| --- | --- | --- |
| P01 — kontrakt i wzorzec | Zamrożenie v7, prywatny zestaw porównawczy, syntetyczne fixture, kontrakty danych i jednostki liczników. | Każdy przypadek z v7 ma opis oczekiwanego zachowania; zdefiniowano porównanie pojedynczych pozycji. |
| P02 — fundament modułu | Migracje, agent/tenant, modele, rejestracja narzędzia, granty i porty infrastruktury. | Dostęp i odmowy działają dla zasobów oraz pobierania; migracje sprawdzone na pustej i uaktualnianej izolowanej bazie. |
| P03 — import plików | Parsery CRM/ASF/Warta, walidacja, zachowanie źródeł, duplikaty, podgląd zakresu i jakości. | 1678/944 odtworzone dla zestawu kontrolnego; błędy wskazują plik/komórkę, a identyczny plik nie podwaja analizy. |
| P04 — słownik | Import uzupełnionego pliku klienta, sześciokolumnowy edytor, wersje robocze, różnice, publikacja i historia. | 653 pozycje zaimportowane; 15 z literalnym znakiem % i 0,15 z procentowym formatem Excela dają stawkę 15%; statusy tekstowe nie zamieniają się w zera. |
| P05 — silnik TS | Normalizacja numerów, przypisanie OFWCA, wybór stawek, oba kierunki braków, niepewności i ślad źródłowy. | Pełny parytet z v7: 944 / 682 / 244 / 18, 1651 / 481, 257 na 140 polisach oraz zgodność pojedynczych wyników. |
| P06 — zadania i snapshoty | Trwałe uruchamianie, kolejka, status/progres, retry, anulowanie, zapisy i audyt. | Podwójne żądanie i restart nie tworzą drugiego wyniku; historyczna analiza nie zmienia się po publikacji nowego słownika. |
| P07 — ekrany i eksport | Katalog, nowa analiza, słownik, historia, filtry, szczegóły i Excel. | Użytkownik wykonuje cały lokalny przebieg prowizyjny; eksport i ekran pokazują ten sam snapshot i liczniki. |
| P08 — odbiór i udostępnienie | Testy modułu, regresja OC, konfiguracja lokalnego startu, backup/odtworzenie i instrukcja. | Odbiór użytkownika na uzgodnionych danych, zachowana izolacja OC, gotowy sposób wyłączenia modułu i powrotu do wcześniejszego słownika. |

P02–P04 mogą przygotowywać kontrakty P05, ale nie udostępniamy produkcyjnego interfejsu z nieporównanym silnikiem. Najpierw odbiór lokalny Goldis, potem osobny etap wdrożenia serwerowego zgodnie z bieżącą procedurą platformy.

## 10. Testy odbioru

- Jednostkowe: jednostki procentów, jawne zero, statusy tekstowe, warianty PZU, różnice Ola/Maciek, szczególne stawki HDI, pakiety, korekty i progi.
- Numery: wszystkie uzgodnione przykłady, zera wiodące, Allianz bez myślnika, kolizje i wiele możliwych wznowień PZU; brak przypadkowych połączeń między TU.
- Import: różne arkusze/nagłówki, puste i błędne komórki, scalenia, nieprawidłowe wymiary Warty, `.xlsm`, duplikat pliku, uszkodzone archiwum i limity zasobów.
- Porównawcze: wyniki TS kontra v7 po kluczu polisa + plik + arkusz + wiersz, wraz ze stawką, agentem, wariantem i przyczyną braku oceny.
- Baza/API: izolacja tenantów, wszystkie granty, próba dostępu do obcego identyfikatora, CSRF, konflikt równoczesnej edycji, idempotencja i atomowość audytu.
- Worker: restart, retry, powtórna dostawa, anulowanie, awaria eksportu, usunięcie zasobu podczas zadania i pełne odtworzenie wyniku ze snapshotu.
- UI: przygotowanie zestawu, bezpośrednia edycja stawki, publikacja wersji, zakres 1678 → 944, filtry, szczegóły, pobranie i czytelne błędy. Osobno brak danych i zerowa prowizja.
- Regresja: katalog, logowanie, granty, historia, pobieranie i obecne kontrakty OC zachowują działanie. Testy nie uruchamiają portali OC, SMS ani zewnętrznych usług.

Testy bazy i kolejki wykonywać na izolowanych instancjach i syntetycznych danych. Rzeczywiste pliki klienta oraz słownik pozostają poza Git; do repo trafiają syntetyczne przypadki i kontrakty. Raport parytetu może przechowywać agregaty i hashe bez danych identyfikacyjnych klientów.

## 11. Niewiadome biznesowe i dalsze rozwijanie jakości

Poniższe kwestie nie muszą blokować pierwszego wydania, jeżeli narzędzie potrafi pokazać je jako nierozstrzygnięte:

- 302 pozycje bezpośredniej Warty bez procentu i rozbicia na ryzyka: potrzebny dokładniejszy raport albo potwierdzona podstawa obliczenia.
- Pakiety PZU i Allianz: stawka pakietowa, składniki i podstawa naliczania.
- Nieznane kody MTU/TUZ/Wiener oraz profile YCD/Jupiter/POS: znaczenie i warunki przypisania.
- Kanał rozliczenia UNIQA Oli oraz kompletność raportów za późniejsze miesiące.
- Terminy pojawiania się prowizji, rozliczanie rat, zwrotów i anulowanych polis.
- Historyczne daty obowiązywania słowników oraz to, która data wyznacza zastosowanie stawki.
- Sprzeczna nazwa TU Nationale-Nederlanden/METLIFE w materiale źródłowym.

Każde potwierdzone ustalenie oznacza nową wersję reguł/słownika i nową analizę. Nie używamy liczby „zgodnych” jako celu optymalizacji. Poprawa narzędzia oznacza więcej uzasadnionych ocen i mniej niepewności, nawet jeśli ujawnia kolejne rozbieżności.

## 12. Proponowany pierwszy zakres prac

Rozpocząć od P01 i P02: kontrakt danych prowizyjnych, zamrożenie wzorca v7, schemat wersjonowania i dostępu oraz rejestracja nowego narzędzia. Potem wdrożyć importy i słownik, osiągnąć parytet silnika, a dopiero na tej podstawie zakończyć uruchamianie zadań i widoki wyników. Każdy etap kończy się testami własnego zakresu i krótkim raportem expected/actual.
