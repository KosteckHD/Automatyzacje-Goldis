# Test 100 wierszy — wynik końcowy

Zakres: **18001–18100**, dokładnie 100 zadań. Koniec: 20.11.2026 o 00:57:23 CET
(19.11 23:57:23 UTC). Data odniesienia pozostaje 2026-11-19 dla całej kampanii.
Zachowano istniejące identyfikatory i historię; nie uruchamiano innych wierszy.

| Wynik | Liczba |
|---|---:|
| Zakończone, dostępny Excel | 68 |
| Brak polis spełniających filtr daty | 3 |
| Brak dopasowania w PZU | 16 |
| Brak wymaganego PESEL w PZU | 1 |
| Niekompletne dane klienta w Compensie | 3 |
| Pominięte: wymagane dane płatnika | 4 |
| Niepotwierdzone rozpoczęcie sprawy w Compensie | 5 |
| **Razem** | **100** |

API zapisuje pominięcia płatnika jako `failed/COMPENSA_PAYER_DATA_SKIPPED`.
Panel wydziela je: 68 zakończonych, 3 bez polis, 20 błędów, 4 pominięcia,
5 wymagających uwagi. Poprawiono brakującą etykietę oraz polskie przyczyny.

## Weryfikacja

- **68/68** eksportów pobranych przez uwierzytelnione API i odczytanych jako XLSX.
  Poprawne nagłówki, tekstowe identyfikatory i liczby rekordów.
- **856 wyeksportowanych polis**; każda spełnia `coverage_to >= reference_date`.
  Jest to filtr daty końca, nie dodatkowy warunek daty rozpoczęcia ochrony.
- **71 snapshotów, 10 184 polis OC**, największy snapshot: 616 polis.
  Liczby rekordów i unikalne porządki źródłowe zgodne ze snapshotami.
- **74 zapisane numery spraw, 74 różne numery**. Brak powtórzonych zdarzeń
  `compensa_start_intent`, `compensa_insured_save_intent`, `ufg_verification_intent`
  w obrębie pojedynczego zadania.
- Niekompletne dane klienta i pominięcia płatnika: bez zapisu klienta i zapytania UFG.
- Pięć interwencji nie ma aktywnej dzierżawy. Brak zadań w kolejce i w toku.

## Pięć interwencji

Wiersze **18041, 18043, 18087, 18094, 18099**: `waiting_for_manual_data`,
`MANUAL_DATA_REQUIRED`, pole `PORTAL_ACTION_REVIEW`, checkpoint
`compensa_start_intent`, bez potwierdzonego `external_case_ref`.

Utrwalono zamiar rozpoczęcia sprawy, lecz nie utrwalono potwierdzenia jej otwarcia.
Sam ten stan nie rozstrzyga, czy portal odrzucił dane, nie odpowiedział, czy worker
nie rozpoznał kolejnego ekranu. Nie dowodzi błędu selektora ani nadmiernej ochrony.
Nie ponawiano automatycznie Start. Przed wznowieniem trzeba potwierdzić stan
istniejącej sprawy w Compensie; nie dopisywać fikcyjnego numeru i nie zerować
checkpointu w celu wymuszenia nowej sprawy.

**Nie uznano testu za bezwarunkowe 100% powodzenie.** Pełna ścieżka
PZU → Compensa → UFG → Excel jest potwierdzona dla 68 wierszy. Te kontrole
dotyczą badanego przebiegu, nie wszystkich możliwych wariantów danych i portalu.

## Naprawy potwierdzone podczas kampanii

- Zmiana hasła PZU z `.env.local` zastosowana do faktycznie montowanego sekretu.
- Rozpoznawanie potwierdzonego kolejnego pustego wyszukania Guidewire, z zachowaniem
  ochrony przed nieaktualnymi danymi osoby. Regresja adaptera: 8/8, w obrazie bez sieci.
- Kontrolowane wyjście z osieroconego logowania SMS; diagnostyka nawigacji bez kodów,
  treści formularzy, parametrów URL i cookies.
- Koordynator odnawia zwykłe logowanie platformy po wygaśnięciu 30-minutowej sesji.
  Kontynuuje tylko nieukończone próby przed utworzeniem sprawy. Dla 18092 pojedyncze
  jawne wznowienie wygasłej sesji PZU zakończyło się powodzeniem.
- Produkcyjny build web, wdrożenie i odczyt końcowego podsumowania w przeglądarce:
  poprawne liczby i czytelne etykiety. Detektor UI zmienionego komponentu: bez ustaleń.

## Przydział leadów

Utworzono `operator-test-local-20261120`, prawa odczytu i pobrania wyników OC,
bez uruchamiania automatyzacji. Hasło pozostaje w lokalnym katalogu sekretów.

Pierwotna reguła czekała na zakończenie całej operacji i blokowała również 68
poprawnych wyników. Kontrola pustej puli prawidłowo zwróciła HTTP 409
`LEAD_POOL_CHANGED`, bez zmiany właściciela. Użytkownik następnie zdecydował:
**„Udostępniaj gotowe leady bez czekania na całą paczkę”.**

Wdrożono publikację kompletnej firmy niezależnie od pozostałych firm. Warunki:
co najmniej jedno zadanie zakończone z wynikiem, wszystkie przyjęte zadania firmy
zakończone, brak oczekującej grupy tej firmy, prawidłowy zachowany snapshot.
Publikacja i snapshot powstają w jednej transakcji z blokadą operacji; nie
zamykają operacji nadrzędnej. Listy, szczegóły, przydział, zwolnienie i raporty
korzystają z gotowości leada. Anulowanie reszty zachowuje opublikowane wyniki.
Udostępnienie następuje przy odczycie wyników przez uprawnionego użytkownika.
Nie przestawiano statusów bezpośrednio w bazie lokalnej platformy.

Wynik rzeczywistego testu:

- **68 gotowych leadów i 68 zachowanych snapshotów**, operacja nadal `waiting_attention`.
- Przydzielono 3 leady; ponowienie tego samego żądania zwraca ten sam przydział.
- Operator widzi swoje wyniki i pobiera czytelny Excel istniejącego zadania.
- Operator nie może przydzielać leadów: HTTP 403.
- Zmiana statusu kontaktu działa; stara wersja zwraca HTTP 409.
  Testową zmianę statusu przywrócono.
- Operator zwolnił jeden przydział: pozostały **2 przypisane, 66 wolnych**.
- Formularz i podsumowanie zweryfikowano na wąskim ekranie i desktopie 1365 px.
  Pola na desktopie mają poprawne, niezerowe szerokości. Tymczasowy rozmiar przywrócono.

Regresja na osobnej bazie: migracje 001–067, `reports`: PASS. Obejmuje brak
publikacji niepełnej firmy/snapshotu, równoczesną publikację bez duplikatu,
niezależne zamknięcie operacji, przydział i zwolnienie, konflikty wersji,
jednego zwycięzcę równoczesnych przydziałów, izolację tenantów i uprawnienia.
Testy zapytań leadów: 3/3. Build API i obraz produkcyjny: PASS, wdrożone.

32 pozostałe leady tej operacji pozostają nieopublikowane; to nie oznacza 32
działających workerów. Końcowe statusy zadań są w tabeli powyżej. Brak aktywnych
dzierżaw i zadań kolejki dla kampanii po zakończeniu kontroli.

## Porównywarka — test syntetyczny

Przygotowano CRM, ASF, Wartę i kompletny słownik 653 pozycji ze sztuczną stawką
15% dla obu agentów. **To wyłącznie dane testowe, nie rzeczywiste warunki TU.**
Słownik v1 opublikowano lokalnie; wszystkie trzy źródła przeszły przez API
platformy, CRM także przez formularz przeglądarki. Analizę uruchomiono z panelu.

Pierwszy wariant sprawdził niepewny sufiks numeru Warty. Drugi użył dokładnego
numeru, by oddzielnie sprawdzić brak możliwości oceny procentu. Wyeksportowane
identyfikatory plików wejściowych zachowują tekst i zera wiodące.

Końcowa analiza `a4e8ac6a-0adf-4502-ac24-26d0e84e31ad`, okres
**2026-11-01–2026-11-30**, słownik `121884cf-48ab-4950-9e18-1682f947bdea`:

| Oczekiwanie | Wynik |
|---|---|
| Unikalne polisy CRM w okresie | 5 |
| Dopasowane do raportów | 4 |
| Poprawne OC ze stawką 15% | Potwierdzone |
| Błędna stawka 10% zamiast 15% | Wykryta, różnica −5 pp |
| Polisa bez rozliczenia | 1, wykryta |
| Nieznane ryzyko + Warta bez procentu | 2 przypadki bez oceny procentu |
| Powtórzony wiersz CRM | Jedna polisa, zachowane dwa odwołania źródłowe |
| Polisa z 31.10 poza okresem | Wyłączona z głównego porównania |
| Raport bez polisy w całym CRM | Tylko testowy numer 0001999 |
| Ponowienie tego samego klucza startu | Ten sam run, bez drugiej analizy |
| Eksport | Czytelny XLSX, 4 arkusze |

Znaleziono i poprawiono stały, historyczny zakres dat w opisie kontroli odwrotnej.
Opis używa teraz dat bieżącej analizy. Test reguł silnika: 6/6. Nowy obraz silnika
wdrożony; poprawny opis potwierdzony w rzeczywistej analizie po wdrożeniu.
Końcowe liczniki odczytano również z panelu platformy.

## Użyteczność i pozostałe ograniczenia

Dwóch wcześniej zatwierdzonych, niezależnych agentów przeprowadziło audyt UX.
Po ich ocenie oraz testach poprawiono znikającą szerokość pól przydziału,
niezrozumiałe etykiety stanów workera i opis dat porównywarki.

Do dalszej poprawy, bez oznaczania ich jako naprawionych:

- W przebiegu **całego importu** gałąź postępu pomija komunikat `wholeError`.
  Ustalenie z kodu, niewywoływane w teście wybranego zakresu 100 wierszy.
- Porównywarka ucina wyświetlanie list do 500 problemów i 200 wierszy kontroli
  odwrotnej bez informacji o ograniczeniu. Ustalenie z kodu; mały zestaw nie
  weryfikuje zachowania pod dużym obciążeniem.
- Ostrzeżenie o duplikacie CRM jest zapisane w wyniku silnika; panel nie pokazuje
  listy ostrzeżeń. Licznik polis pozostaje poprawny.
- Komunikat o przywróceniu wyboru i potrzebie nowego podsumowania może pojawiać
  się podczas podglądu już uruchomionej operacji. Komunikat przyjęcia analizy do
  kolejki pozostaje widoczny po jej zakończeniu, do zmiany widoku.

Te uwagi nie blokują sprawdzonych ścieżek. Pięć niepewnych Startów Compensy
pozostaje rzeczywistym ograniczeniem domknięcia całej kampanii. Potrzebna jest
kontrola stanu spraw w portalu; nie powtórzono operacji o nieznanym skutku.

Końcowy stan usług: 9 kontenerów działa; wszystkie z healthcheckiem są zdrowe.
`commission-worker` nie ma zdefiniowanego healthchecku, jego obsługę potwierdza
zakończona analiza. Nie restartowano niezwiązanego projektu Docker.

## Dowody

Ignorowany katalog `exports/platform-acceptance-20261119/`:
`retest-manifest.json`, `retest-state.json`, `retest-continuation-18092-session.log`,
`export-verification.json`, `verify-exports-final-20261120.log`,
`worker-final-100.jpg`, `lead-preparation.json`.
Końcowe kontrole kolejnych etapów: `lead-lifecycle-verification.json`,
`partial-leads-db-check.log`, `comparison-verification.json`,
`comparison-current-result.json`, `comparison-current-export.xlsx`,
`comparison-final-ui.jpg`, `lead-allocation-review.jpg`, `leads-desktop.jpg`.
Pobrane pliki klientów w `downloaded/` pozostają lokalne, nie do publikacji.
Raport nie zawiera PESEL, haseł, kodów SMS ani danych klientów.
