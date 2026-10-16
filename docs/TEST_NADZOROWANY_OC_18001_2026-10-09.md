# Nadzorowany test portali — wiersz 18001, 2026-10-09

Test wykonano w widocznym Chromium należącym do workera, w jego skonfigurowanym trwałym profilu. Worker miał wyłączone pobieranie nowych zadań na czas kroków nadzorowanych. Kontener drugiego workera był zatrzymany. Dane dostępowe odczytano z pliku środowiska bez ich wypisywania.

## Wynik obserwacji

- PZU: istniejąca sesja rozpoznana jako zalogowana.
- Produkcyjny EverestIdentityProvider dopasował osobę do rzeczywistego wiersza 18001.
- Compensa: automatyczne rozpoznanie/logowanie sesji zakończone powodzeniem.
- Otwarto dialog Compensa Komunikacja i rozpoczęto go raz, z odczytanym PESEL i skonfigurowaną rejestracją.
- Pobranie danych pojazdu zakończyło się: portal pokazał wypełnione dane auta.
- Otwarto edycję klienta; w dalszej obserwacji widoczna była sekcja insured-section.
- Imię, nazwisko i PESEL w insured-section porównano z dopasowaniem Everest; wszystkie trzy porównania były zgodne.
- Kliknięto Zapisz w insured-section. Portal zastąpił formularz tabelą zapisanej osoby i udostępnił weryfikację UFG.
- Weryfikację UFG wykonano raz. Podsumowanie podało 49 polis OC.
- Otwarto szczegóły weryfikacji i Szczegóły polis OC.
- Produkcyjny readOcSnapshot odczytał 49 z 49 wierszy bez błędu kompletności.
- Produkcyjny selectCurrentPolicies wskazał 3 polisy dla daty 2026-10-09.

Reguła wyboru sprawdza datę końca ochrony >= data odniesienia. Nie sprawdza daty początku ochrony.

## Zakres i ograniczenia

Był to nadzorowany przebieg portalu, z kontrolowanymi pojedynczymi akcjami i rzeczywistymi adapterami logowania, dopasowania osoby oraz odczytu OC. Nie był to zakończony samoczynny przebieg LiveRunProcessor z kolejki. Poprzednie zadanie zachowało status waiting_for_manual_data. Nie zmieniano tego statusu na sukces, nie przekazano ręcznie odczytanego zestawu do finalizacji API i nie wygenerowano produkcyjnego XLSX.

Samoczynny przebieg wcześniej zatrzymał się po rozpoczęciu Compensa Komunikacja, oczekując insured-section. Należy dopracować rozpoznanie zakończenia pobierania danych pojazdu i przejścia do tej sekcji. Ten test nie rozstrzyga, czy samo wydłużenie oczekiwania wystarczy; w przebiegu nadzorowanym wykonano również akcję edycji klienta.

## Potwierdzone selektory z tego przebiegu

- Edycja klienta: button:has(> span.i-edit_underlined):visible.
- Sekcja osoby: insured-section.
- Imię/nazwisko/PESEL: insured-section div.row:has(> label:text-is("ETYKIETA")) input; pojedyncze dopasowanie i zgodność wartości.
- Powiat: insured-section div.row:has(> label:text-is("Powiat")) select; portal pokazał wypełnione pole.
- Zapis osoby: insured-section button:has-text("Zapisz"):visible.
- Numer sprawy: span:text-is("Oferta Nr") ~ span.tm-textGray14B; zaobserwowano jedno dopasowanie. Nie zweryfikowano jeszcze zgodności odczytu z checkpointem produkcyjnym.
- Weryfikacja: button:has-text("Weryfikacja"):visible; jedno dopasowanie. Wcześniejszy selector has-text("Weryfikacja UFG") nie dopasował przycisku.
- Szczegóły weryfikacji: button:has-text("Szczegóły"):visible; jedno dopasowanie.
- Szczegóły OC: button:has(span:text-is("Szczegóły polis OC")):visible.

Nie zapisano w raporcie PESEL, danych osoby, danych pojazdu, numerów polis ani danych dostępowych.

## Osobny test logowania PZU w świeżej sesji

Na żądanie użytkownika uruchomiono wyłącznie logowanie PZU w nowym profilu Chromium należącym do workera. Kolejkę wstrzymano; logowanie użyło produkcyjnego PzuEverestSession i danych dostępowych z .env. Portal przeszedł do waiting_for_sms. W rzeczywistym DOM potwierdzono pojedyncze dopasowanie ramki SMS, pola kodu i przycisku zatwierdzenia; pole oraz przycisk były widoczne, a przycisk aktywny. Nie otwierano Compensy.

Pierwsza diagnostyka nie utworzyła zgłoszenia w platformie. Po korekcie użytkownika zamknięto tę sesję i wykonano właściwy test opisany poniżej.

## PZU: potwierdzony SMS przez platformę

Utworzono przez istniejące API nowy import jednego rzeczywistego wiersza 18001, zakończono przygotowanie importu i uruchomiono zadanie 4bc65b0b-4523-464d-b1d9-d96d97bdb932. Test użył nowego profilu Chromium i produkcyjnej kolejki, dzierżawy wykonania, PzuEverestSession, awaitSms oraz odbiornika kodu. Zakres workera ograniczono do identyfikatora tego zadania i samego logowania PZU.

API pokazało rzeczywisty stan waiting_for_sms oraz aktywne zgłoszenie SMS PZU. Użytkownik podał kod w platformie. Worker przekazał go do portalu; portal potwierdził authenticated. Zadanie ma controlState=paused, status=everest_search oraz zdarzenie pzu_login_verified_test_paused. Kontrola przeglądarki tej samej sesji również zwróciła authenticated. API nie zwraca już aktywnego wyzwania SMS, a zgłoszenie zostało zamknięte.

Worker wstrzymał zadanie po uwierzytelnieniu, przed wyszukiwaniem osoby i otwieraniem kolejnego portalu. Nie jest to ukończony przebieg OC ani potwierdzenie wszystkich sytuacji wyjątkowych SMS. Build workera i 12 testów pętli wykonania oraz repozytorium przeszły; obejmują ograniczenie zakresu testu, obsługę SMS, brak wyszukiwania/zapisu oraz odrzucenie nieaktualnej dzierżawy przy zapisie checkpointu.
