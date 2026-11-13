# P03 — import plików bez silnika Excela

Zależności: P01/P02 i transport P06. Efekt: użytkownik otrzymuje poprawny zestaw danych, zakres dat i lokalizację błędów przed uruchomieniem porównania.

## 1. Wejście i obsługiwane formaty

Pierwsza wersja rozpoznaje dostarczone warianty CRM, ASF i Warty oraz sześciokolumnowy słownik. Obsługuje `.xlsx` i wejściowy `.xlsm` jako archiwum OOXML. Stary binarny `.xls`, pliki chronione hasłem i nieznane formaty otrzymują jawny komunikat, a nie pozornie pusty import.

Osobny raport UNIQA wymaga najpierw przykładu i nowego adaptera. Pozycji UNIQA znajdujących się w ASF nie opisujemy jako dostarczonego, osobnego pliku UNIQA.

## 2. Proponowane elementy

```text
services/commission-engine/src/goldis_commissions/importers/
  archive_limits.py
  workbook_reader.py
  format_detection.py
  crm.py
  asf.py
  warta.py
  dictionary.py
  cells.py
apps/api/src/features/commissions/
  commission-files.controller.ts
  commission-import.service.ts
  commission-input-preview.service.ts
  commission-files.repository.ts
```

Python tworzy wyniki parsowania zgodne ze schematem P01. Node zatwierdza zapis po weryfikacji odpowiedzi. Biblioteka arkuszy nie jest wywoływana w publicznym żądaniu oczekującym na pełne obliczenie.

## 3. Czynności implementacyjne

### P03.1 — przyjęcie dokumentu

1. Sprawdzić sesję, grant i limity przyjmowania danych.
2. Przyjąć strumień z limitem bajtów; nadać UUID i policzyć hash oryginału.
3. Zapisać zaszyfrowany dokument oraz metadane w stanie przyjętym. Błąd zapisu nie tworzy gotowego importu.
4. Utworzyć trwałe zlecenie parsowania i zwrócić użytkownikowi ID. Pokazywać osobno wgrywanie, parsowanie i gotowość.
5. Ten sam hash w zestawie wskazać jako duplikat i powiązać z reprezentantem. Ponowne użycie pliku w innej analizie jest dozwolone, bez powielania go w tej samej analizie.

### P03.2 — walidacja archiwum

- Weryfikować strukturę ZIP/OOXML, liczbę wpisów, rozmiary deklarowane i rzeczywiście odczytane, sumę rozpakowanych danych oraz rozmiar pojedynczego XML.
- Odrzucać ścieżki wychodzące z archiwum i niestandardowe odwołania. Nie uruchamiać VBA, DDE, zewnętrznych połączeń ani kodu z nazw plików.
- Stosować limity czasu, pamięci, liczby arkuszy, komórek, długości tekstów i gęstości danych. Nie polegać wyłącznie na limicie skompresowanego pliku.
- Parsować w izolowanym procesie, aby przerwanie nie wymagało restartu API.
- Nie zapisywać otwartego dokumentu klienta ponownie; mógłby utracić elementy nieobsługiwane przez bibliotekę.

### P03.3 — rozpoznanie formatu

1. Rozpoznawać nagłówki i charakterystyczne pola, nie samą nazwę pliku.
2. Porównać rozpoznany typ z kategorią wskazaną przez użytkownika. Niezgodność pokazać przed analizą.
3. Obsłużyć rzeczywiste położenia nagłówków oraz puste wiersze w plikach kontrolnych.
4. Dla Warty nie ufać zadeklarowanemu rozmiarowi arkusza `A1`; rzeczywiste wiersze odczytać z kontrolowanym limitem.
5. Wersjonować adapter formatu. Nieznany układ kolumn nie przechodzi jako poprawny plik z zerem pozycji.

### P03.4 — normalizacja komórek

Każdy rekord zachowuje plik, arkusz, numer wiersza i potrzebny zapis źródłowy.

- Numery polis: tekst, z zachowaniem zer wiodących i oryginalnego numeru. Jeżeli źródło zapisało długi identyfikator jako liczbę i utraciło precyzję, nie odtwarzać cyfr przez zgadywanie.
- Daty: jawnie nazwana data wystawienia, umowy, ochrony lub raportu. Obsłużyć system dat zapisany w skoroszycie i znaczenie samej daty bez zmiany dnia przez UTC.
- Procenty: `Decimal`, format komórki, surowa wartość i jednostka. Obsłużyć literalny/escaped znak `%`, zapis procentowy i tekstową liczbę z przecinkiem.
- Puste komórki: nie są zerem. Krytyczne formuły: błąd `FORMULA_REQUIRES_VALUE`; zapisany cache służy najwyżej do informacji, bez automatycznego uznania wartości za aktualną.
- Scalenia: przekazywać etykietę lub stawkę tylko w rozpoznanym zakresie źródłowej tabeli, nie w całym arkuszu i nie pomiędzy sekcjami.
- Tekstowe odpowiedzi klienta: klasyfikacja według P04, bez wykonywania poleceń zapisanych w komórkach.

Odczyt strumieniowy stosować, gdy zachowuje niezbędne dane formatu; jeżeli format wymaga pełnego załadowania, ten wariant musi mieć zmierzony limit i nadzór procesu. Nie przenosić bez ograniczeń lokalnego `list(iter_rows(...))` dla dowolnej wielkości dokumentu.

### P03.5 — zapis i zakres

1. Node sprawdza schemat odpowiedzi, identyfikator pliku, liczbę rekordów, limity i pochodzenie wierszy.
2. Zapisać znormalizowane dane i stan importu transakcyjnie; wynik niekompletnego parsowania nie staje się gotowym źródłem.
3. Podgląd zakresu liczyć po dacie wystawienia CRM. Dla zestawu wzorcowego: 1678 wszystkich, 633 wcześniejsze, 944 w zakresie, 101 późniejszych.
4. Wszystkie wskazane raporty przeszukiwać niezależnie od ich miesiąca. Pokazać, jakie okresy raportów dostarczono, ale nie deklarować automatycznie kompletności rozliczeń.
5. Powtórzone pozycje CRM i sprzeczne dane tej samej polisy kierować do wyjaśnienia. Jednakowe wiersze ASF/Warty mogą oznaczać raty, więc nie usuwać ich automatycznie.

## 4. Komunikaty i stany

Rozróżnić: plik przyjęty, w kolejce, parsowany, gotowy, gotowy z problemami, odrzucony, usunięty. Dla błędu pokazać nazwę pliku, arkusz/komórkę, kod przyczyny i działanie użytkownika. Stos wewnętrzny, payload i poufne dane z walidatora nie trafiają do komunikatu ani logów.

## 5. Testy

- Każdy rzeczywisty układ źródła i jego syntetyczny odpowiednik.
- Warta z błędnym wymiarem, scalenia, puste wiersze, zmieniona kolejność kolumn oraz błędne nagłówki.
- Procenty 15 i 0,15 z różnymi formatami, zapis tekstowy, jawne zero, brak i formuła.
- Daty graniczne i brak daty; wiersz z datą nie zostaje odrzucony bez wyjaśnienia.
- Duplikat pliku, powtarzające się raty, uszkodzone OOXML i przekroczenie każdego limitu.
- Anulowanie parsowania, śmierć procesu i ponowione zlecenie; brak podwójnych rekordów.
- Brak odwołań do PESEL/telefonów w wyniku parsera, jeżeli dane te nie są potrzebne do celu narzędzia.

## 6. Kryteria zakończenia

Zestaw kontrolny daje 1678 polis CRM i 3977 wierszy rozliczeń po pominięciu identycznego pliku, a wybrany zakres daje 944 polisy. Użytkownik widzi wszystkie wyłączenia i problemy. Parser działa na Linux bez Excela, z aktywnymi limitami i bez pozornie poprawnych pustych wyników.
