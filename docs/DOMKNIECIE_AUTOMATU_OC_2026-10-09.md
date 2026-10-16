# Domknięcie samodzielnej automatyzacji OC

## Stan po pierwszym etapie implementacji

Wdrożone w kodzie workera:

- Jednoznaczne dopasowanie pól oraz celów istotnych akcji Compensy. Nie wybiera się pierwszego z kilku przycisków rozpoczęcia, zapisu lub weryfikacji UFG ani pierwszego numeru sprawy.
- Oczekiwanie na sekcję osoby po rozpoczęciu Compensa Komunikacja: maksymalnie 60 sekund domyślnie, przerwanie przez AbortSignal, zatrzymanie bez ponownego rozpoczęcia po timeoutcie. Opcjonalny znacznik błędu pobrania pojazdu; nie dodano zgadywanego selektora błędu do konfiguracji.
- Oddzielny opcjonalny znacznik zakończenia UFG. Sama widoczność tabeli podsumowania może poprzedzać odpowiedź i nie jest wystarczającym potwierdzeniem.
- Generowanie konfiguracji pilota z zaobserwowanym numerem sprawy i przyciskiem UFG zamiast wcześniejszych niedopasowanych kandydatów. Nadal jest to konfiguracja pilota, nie certyfikowana konfiguracja produkcyjna.

Walidacja: build workera zakończony powodzeniem. Testy przeglądarkowe formularza, zapisu, UFG oraz konfiguracji: 22/22, bez pominięć. Nowe testy sprawdzają opóźnioną odpowiedź CEP, brak odpowiedzi, niejednoznaczny przycisk rozpoczęcia oraz podsumowanie widoczne przed zakończeniem weryfikacji UFG. Istniejące testy obejmują niepewny zapis, uzgadnianie przed ponowieniem i niekompletny wynik UFG.

## Kolejne wymagane etapy

### Drugi etap: uzgadnianie zapisu i zamiaru rozpoczęcia

Zapis najpierw odczytuje numer sprawy i trwały checkpoint. Przy niepewnym poprzednim zapisie sprawdza wynik portalu przed wymaganiem formularza edycji. Dzięki temu zniknięcie formularza po udanym zapisie nie blokuje uzgodnienia. Nierozstrzygnięty wynik nadal zatrzymuje zadanie, bez ponownego kliknięcia. Testy potwierdzają oba warianty z ukrytym formularzem.

Stan compensa_start_intent przy ponownym wejściu do etapu Compensy wymaga istniejącego formularza, tak jak compensa_offer_draft_open. Nie wraca do rozpoczęcia nowej oferty. Przekazywany jest również sygnał przerwania. Dwa testy pętli produkcyjnej sprawdzają te punkty wznowienia.

Walidacja drugiego etapu: build oraz 8 testów zapisu w Chromium i 6 testów pętli LiveRunProcessor zakończone powodzeniem. Testy checkpointów korzystają z repozytorium pamięciowego; nie zastępują odbioru rzeczywistego checkpointu PostgreSQL i istniejącej sprawy w Compensie.

### Trzeci etap: ponowne sprawdzenie przez API

API resume-review i pole canResumeReview uwzględniają ponowne sprawdzenie niepewnej akcji Compensy przez administratora lub managera. Wymagany jest zapisany numer konkretnej sprawy i znany checkpoint; zmiana nie potwierdza sukcesu operacji. Worker uzgadnia stan portalu, a bramki trwałych zamiarów nadal blokują powtórzenie niepewnej akcji. Interwencja CASE_REFERENCE_REVIEW, konflikt osoby, brakujące dane, SMS oraz nieznany checkpoint nie uzyskują tego uprawnienia.

Worker zachowuje szczegółowy fieldCode interwencji zapisu i UFG. Wznowienie zapisuje w zdarzeniu portalRecheck. Zmiany zbudowano i zweryfikowano testami kontraktu, istniejących korekt danych, zabezpieczeń HTTP i pętli workera. Nie wdrożono jeszcze nowych obrazów kontenerów ani nie wykonano odbioru tego mechanizmu z rzeczywistą sprawą.

Stare zadanie 18001 zatrzymane na compensa_start_intent bez zapisanego numeru sprawy nadal pozostaje zablokowane. Nie można bezpiecznie powiązać go z dowolną otwartą ofertą tej samej osoby. Wymaga osobnego ustalenia i potwierdzenia konkretnej sprawy, zanim numer zostanie zapisany przez dedykowaną ścieżkę uzgadniania; nie dopisano numeru ręcznie do bazy.

Nowe rozpoczęcia próbują zapisać jednoznaczny widoczny numer sprawy już podczas oczekiwania na CEP, a nie dopiero po pojawieniu się formularza osoby. Po zapisie numeru nie powtarzają tej operacji w pętli. Testy opóźnienia i timeoutu potwierdzają wcześniejsze przechwycenie numeru i pojedyncze rozpoczęcie. Ostatnia walidacja: 6 testów kontraktów API, 17 testów formularza/pętli workera i test zabezpieczeń HTTP przeszły; build API i workera zakończone powodzeniem.

1. Potwierdzić na prawdziwym portalu, że oczekiwanie doprowadza do formularza bez ręcznej akcji edycji. Jeżeli portal wymaga dodatkowego przejścia, dodać rozpoznawany stan i jego jednoznaczną akcję. Sam dłuższy timeout nie stanowi dowodu naprawy.
2. Zweryfikować zapis i zgodność numeru sprawy w rzeczywistych checkpointach produkcyjnego zadania, w tym po ponownym otwarciu sprawy. Ustalić znacznik potwierdzenia zapisu w konfiguracji na podstawie rzeczywistego DOM.
3. Domknąć uzgadnianie zablokowanych akcji PORTAL_ACTION_REVIEW / OFFER_SAVE_REVIEW: wznowienie może nastąpić dopiero po ustaleniu stanu konkretnej sprawy. Obecne API resume-review dopuszcza poprawki pól, ale nie rozwiązuje takiego uzgadniania.
4. Sprawdzić sesje, SMS, logowanie poza panelem, restart i zamknięcie Chromium. Zgodność panelu z portalem musi być potwierdzona; nie wolno zapisywać fikcyjnego sukcesu SMS.
5. Potwierdzić kompletność parsera przy braku polis i tabeli przewijanej, błędnych nagłówkach/dacie/liczbie wierszy. Utrzymać blokowanie niekompletnego eksportu.
6. Potwierdzić regułę biznesową daty. Obecnie pozostawiono istniejącą regułę koniec ochrony >= data odniesienia; nie zmieniono jej na inną bez ustalenia wymagań.
7. Uruchomić produkcyjne zadanie wiersza 18001 przez kolejkę do XLSX bez kliknięć w portalach. Porównać wynikowy plik z pełnym odczytem UFG oraz sprawdzić wznowienie bez drugiej oferty.

## Warunek dopuszczenia do samodzielnej pracy

### Krok 4: sesje PZU i SMS — stan po testach 9 października

Logowanie PZU z .env i przekazanie rzeczywistego SMS przez platformę potwierdzono w zadaniu 4bc65b0b-4523-464d-b1d9-d96d97bdb932. Zadanie wstrzymano po zalogowaniu. W późniejszym teście 78e11bad-f1b0-4940-b83a-e6735c281f6f portal przeszedł do authenticated, podczas gdy worker nadal czekał na SMS. Użytkownik wskazał tę rozbieżność. Zgłoszenie uzgodniono z faktyczną sesją i zamknięto jako uwierzytelnienie bez przekazanego kodu, bez fikcyjnego SMS_CODE_ACCEPTED.

Worker podczas oczekiwania na kod obserwuje teraz stan tej samej sesji portalu. Potwierdzone logowanie zamyka tylko nadal aktywne, niewykorzystane wyzwanie, pod kontrolą aktualnej dzierżawy i identyfikatora przeglądarki. Wyzwaniu już zajętemu lub wysłanemu nie odbiera ścieżki przekazania kodu. Utrata dzierżawy przerywa obserwację; bufor i oczekiwanie pamięciowe są czyszczone. Testy obejmują wyścig z kodem, restart, wygaśnięcie, odrzucenie, zamknięcie karty i zalogowanie poza panelem. Zdarzenie portal_authenticated_without_code jest odrębne od przyjęcia SMS.

Formularz logowania wymaga pojedynczych widocznych i aktywnych pól oraz przycisku, sprawdzonych przed wpisaniem danych. Nie wybiera pierwszego z wielu dopasowań. Czyszczenie pola SMS dotyczy wyłącznie pola faktycznie wypełnionego przez worker i nie otwiera nowej karty po jego zamknięciu.

Kolejny rzeczywisty test z produkcyjnej kolejki, 64dc3bec-6e55-4648-bcd0-31ca1b61e839, zakończył logowanie po ponownym otwarciu profilu bez nowego kodu i bez pozostawionego zgłoszenia. Tym razem nie powstało zdarzenie uzgadniania: sesja została rozpoznana jako zalogowana bezpośrednio. Automatyczna obserwacja przejścia z SMS do zalogowania ma test deterministyczny; nie przypisujemy temu ostatniemu przebiegowi zdarzenia, które w nim nie wystąpiło. Zapamiętanie urządzenia nie gwarantuje braku SMS w każdym następnym logowaniu.

### Krok 5: kompletność parsera i eksport — kod gotowy, pełny odbiór nadal w kroku 7

Parser ignoruje ukryte starsze tabele i wymaga jednoznacznej widocznej tabeli/podsumowania. Odrzuca podwójne nagłówki OC, niepoprawne lub niebezpieczne numery, duplikaty w jednym renderze oraz konflikt wartości podczas przewijania. Tabela wirtualizowana jest czytana od początku także wtedy, gdy użytkownik przewinął ją wcześniej. Zmiana nagłówków i brak wierszy nadal blokują snapshot.

Potwierdzone podsumowanie zero OC zwraca kompletny pusty snapshot bez otwierania nieistniejących lub wyłączonych szczegółów. Zmianę sprawdzono również przez rzeczywisty adapter UFG na lokalnym fikcyjnym portalu. Jeśli tabela jest widoczna i zawiera rekordy mimo podsumowania zero, wynik nie zostaje zaakceptowany.

Test eksportu przekazuje kompletny syntetyczny snapshot 49 polis i ponownie odczytuje wygenerowany XLSX: otrzymuje dokładnie 3 rekordy spełniające istniejącą regułę daty, a wszystkie 15 kolumn zgadza się ze źródłem. Nie zmieniono reguły koniec ochrony >= data odniesienia. Moduł results zawiera teraz istniejące testy eksportu zamiast odwołania do nieistniejącego worker-results.test.js. Zestaw ufg-browser obejmuje parser tabeli przewijanej.

Walidacja: 27 testów modułu SMS; 44 testy sesji/przeglądarki/UFG/inbox bez pominięć przed końcowym rozszerzeniem; następnie 12 testów modułu ufg-browser, 22 results, 12 runnera, osobny test zamkniętej karty/logowania poza panelem oraz 31 testów aktualnego uzgadniania SMS, pętli wykonania i repozytorium. Build API i workera zakończył się powodzeniem. Testy eksportu są syntetyczne; nie wygenerowano ani nie zatwierdzono produkcyjnego XLSX dla rzeczywistego wiersza 18001. Nie przebudowano obrazów kontenerów na podstawie tych zmian.

### Krok 6: reguła daty i ograniczenie nawigacji

Użytkownik potwierdził 9 października 2026 zachowanie reguły: koniec ochrony >= data zadania. Data początku ochrony nie filtruje wyniku; polisa zaczynająca się później nadal jest uwzględniana. Wspólny policyMatchesDate normalizuje i waliduje teraz również datę odniesienia, zamiast porównywać dowolny tekst. Testy potwierdzają dzień graniczny, przeterminowaną polisę, przyszły początek ochrony, dzień przestępny, błędną datę oraz zgodność wyboru z XLSX.

BrowserSession otrzymuje w produkcyjnym LiveRunProcessor niezmienną politykę nawigacji z konfiguracji obu portali. Nawigacja głównej karty do obcej domeny, innego portu, protokołu lub poza dokładną ścieżkę aplikacji jest blokowana przed wysłaniem żądania. Przekierowania logowania mogą korzystać wyłącznie z jawnie skonfigurowanych originów HTTPS. Akcje wyszukiwania, rozpoczęcia, zapisu i UFG dodatkowo wymagają adresu aplikacji, a nie strony SSO. Nowe okno jest zamykane i blokuje następne akcje tego portalu; automat nie przełącza się na nie. Naruszenie wymaga zatrzymania i sprawdzenia konfiguracji, bez automatycznego rozszerzania dozwolonego zakresu.

W Everest usunięto wybór pierwszego przycisku nawigacji i pierwszego pola wyszukiwania. Niejednoznaczne dopasowanie zatrzymuje adapter przed kliknięciem lub wpisaniem REGON. Zachowano kontrolę dzierżawy przed akcją i istniejący odstęp między akcjami; nie przyspieszano pracy przez usuwanie tych zabezpieczeń. Kontrola adresu używa konfiguracji w pamięci, bez dodatkowych połączeń z portalem.

Walidacja kroku 6: moduł everest-browser 8/8 (w tym blokada obcej domeny, nieznanej ścieżki i popup), results 24/24, core 13/13; wcześniejszy zestaw nawigacji/dat/pętli wykonania 22/22. Build API i workera zakończony powodzeniem. Testy wykonano na lokalnych fikcyjnych stronach w osobnych profilach; nie otwierano PZU ani Compensy, nie rozpoczynano oferty i nie wykonano operacji na rzeczywistym portalu. Nowe ograniczenia nawigacji wymagają jeszcze odbioru na rzeczywistych adresach w kroku 7. Obrazy kontenerów nie zostały przebudowane.

Wszystkie powyższe etapy muszą mieć dowód w kodzie, odpowiednich testach i odbiorze na żywym portalu. Obecny wynik nie uprawnia do deklaracji gotowości samodzielnego przebiegu. Dostępność workera ani syntaktyczna poprawność konfiguracji nie zastępują odbioru selektorów i całej ścieżki.

Raport nadzorowanego odczytu 49/49 polis znajduje się w TEST_NADZOROWANY_OC_18001_2026-10-09.md. Nie jest on raportem zakończonego zadania z kolejki.

### Krok 7: rzeczywisty przebieg z kolejki — odbiór nie przeszedł

Użytkownik zatwierdził utworzenie jednej nowej oferty testowej. Nowy import zawierał dokładnie wiersz 18001, a przygotowanie zakończyło się ready=1 bez błędów. Zadanie 501a8619-43b5-42c0-90c3-dd4af299df11 uruchomiono przez API i produkcyjną kolejkę. Chromium należało wyłącznie do workera; nie wykonywano ręcznych kliknięć w portalach. API przebudowano i odtworzono z aktualnego źródła, a worker uruchomiono z aktualnego dist. Pozostałe zadania były wstrzymane lub terminalne; stare zadanie Compensy nie zostało wznowione.

Potwierdzono logowanie PZU, rzeczywiste uzgodnienie przejścia z oczekiwania SMS do authenticated bez podania nowego kodu, dopasowanie osoby przez Everest, logowanie Compensy i jedno rozpoczęcie komunikacji. Portal pokazał ofertę oraz pobrane dane pojazdu. Zadanie zatrzymało się z PORTAL_ACTION_REVIEW, checkpointem compensa_start_intent i bez external_case_ref. Nie wykonano zapisu osoby ani UFG i nie wygenerowano XLSX.

Przyczyną był nieodświeżony plik konfiguracji pilota: aktywny caseReference miał wartość .offer-number:visible zamiast selektora z aktualnego generatora. Odczyt DOM tej samej otwartej sprawy potwierdził pojedynczy widoczny numer oferty i poprawny format numeru po normalizacji. Odświeżono plik generatorem, zweryfikowano go loaderem i przeładowano konfigurację workera. Formularz imienia miał jedno widoczne dopasowanie. Nie wpisano numeru sprawy ręcznie do bazy i nie zmieniono zadania na sukces.

Uruchamianie pełnego testu w skrypcie acceptance-worker regeneruje teraz konfigurację z zaobserwowanych selektorów przed startem. Wznowienie kolejki wymaga jednego aktywnego zadania wskazanego identyfikatorem, z wierszem 18001 i właściwym narzędziem. To zabezpiecza następny test przed tym samym starym plikiem, ale nie stanowi odbioru poprawionego przebiegu. Pozostało bezpieczne powiązanie tej konkretnej, właśnie utworzonej oferty z zatrzymanym zadaniem i wznowienie przez API, następnie zapis, UFG, pełny snapshot, XLSX oraz kontrola wznowienia bez ponownego rozpoczęcia. Nie ma zgody na tworzenie drugiej nowej oferty w tej próbie.
