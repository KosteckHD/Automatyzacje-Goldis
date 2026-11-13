# P04 — słownik prowizji i wersjonowanie

Zależności: P01–P03; widok P07. Efekt: klient samodzielnie przegląda, uzupełnia i poprawia stawki, a każda analiza ma odtwarzalny zestaw reguł.

## 1. Podstawowy widok

Zachować sześć kolumn:

`Towarzystwo | Ryzyko / produkt | Wariant | Prowizja Oli % | Prowizja Maćka % | Uwagi`

Brak prowizji w danych oznaczamy czerwonym „BRAK”. Wartość można uzupełnić lub poprawić w tej samej komórce. Nie dodawać osobnych kolumn z decyzją klienta, poprawną stawką, datami lub dokumentem przy każdym wierszu. Przegląd per TU może być realizowany zakładkami albo filtrem, bez powielania tego samego ryzyka dla każdej polisy.

## 2. Wewnętrzny model wartości

| Status | Znaczenie |
| --- | --- |
| `RATE` | Zdefiniowany procent dla konkretnej osoby. |
| `NO_COMMISSION` | Jednoznacznie potwierdzony brak prowizji, czyli 0%. |
| `MISSING` | Brak danych, czerwone BRAK. |
| `NO_DEFINED_RATE` | Klient nie podał jednej zdefiniowanej stawki. |
| `NOT_OFFERED` | Klient deklaruje nieoferowanie produktu. |
| `UNKNOWN_CODE` | Nie rozpoznano kodu lub nazwy produktu. |
| `INDIVIDUAL` | Warunki ustalane indywidualnie; potrzebna stawka lub reguła. |

Status i komentarz przechowujemy oddzielnie od liczby. Dla jednej pozycji Ola może mieć stawkę, a Maciek status nieoferowania. Tak jest istotne m.in. dla MEDIPASS. „Można usunąć” w dokumencie nie jest poleceniem wykonania kasowania danych.

## 3. Czynności implementacyjne

### P04.1 — import startowy v7

1. Wczytać uzupełniony plik klienta przez Python, bez VBA i bez zmieniania oryginału.
2. Zachować pełne 653 pozycje, źródłowe komórki i hashe. To liczba zestawu startowego, nie stały limit produktu.
3. Odtworzyć właściwe jednostki procentów i osobne stawki agentów.
4. Przenieść opisane odpowiedzi tekstowe do statusów; dwie komórki „za to nie ma prowizji” zamienić na jawne zero z zachowaniem tekstowego pochodzenia.
5. Zaimportować aliasy i przypisania v7, m.in. odrębną stawkę HDI Zielona Karta, bez przeliczenia jej na ogólne OC.
6. Pokazać podsumowanie importu i oznaczyć tę wersję jako punkt startowy, nie migrację ze stawkami zaszytymi w SQL.

### P04.2 — robocza edycja

1. Edycja opublikowanej wersji tworzy kopię roboczą lub otwiera istniejącą wersję roboczą użytkownika.
2. Komórka przyjmuje liczbę lub jawnie wybrany status; uwagi opisują wyjątki i niepewności. Nie wykonujemy dowolnych wyrażeń.
3. Wprowadzenie procentu walidować bez zmiany znaczenia jednostki. Zapis 12,5 w edytorze oznacza 12,5%, a nie 0,125%.
4. Serwer sprawdza oczekiwaną rewizję. Dwie osoby nie nadpisują zmian po cichu.
5. Użytkownik może dodać nowy produkt lub wariant. Trwałe ID nie zależy od kolejności wierszy ani od nazwiska jako klucza technicznego.
6. Pozycję wycofywać wersją/statusami, nie usuwać z historycznych analiz.

Obecny lokalny importer wymaga zgodności z dotychczasowymi kluczami. W produkcie należy rozszerzyć go o kontrolowane dodawanie nowych wpisów i zmian nazw, z podglądem powiązań. Nie przenosić ograniczenia do dokładnie 653 kluczy jako wymogu aplikacji.

### P04.3 — import kolejnych korekt

- Rozpoznawać istniejące wpisy według stabilnej identyfikacji i TU/ryzyka/wariantu; nie porównywać tylko numeru wiersza.
- Wyświetlić różnice: dopisany procent, korekta, zmiana statusu, nowy wpis, zmieniony klucz i konflikt.
- Brak wiersza w nowym pliku nie oznacza automatycznego usunięcia starego produktu.
- Nie utożsamiać niespójnych nazw TU ani profili POS/Panel/flota bez jawnego przypisania.
- Duplikat z różnymi stawkami musi zostać rozstrzygnięty, a nie wybrany po kolejności lub po procencie w ASF.

### P04.4 — publikacja i aktywacja

1. Przed publikacją walidować strukturę, jednostki, konflikty i spójność powiązań.
2. Braki biznesowe mogą pozostać w opublikowanej wersji jako jawne statusy. Nie blokować całego narzędzia wymogiem uzupełnienia wszystkich produktów.
3. Jedna operacja transakcyjna tworzy niezmienną wersję, zapisuje audyt i ewentualnie zmienia wskaźnik wersji aktywnej.
4. Zapisać autora, czas, poprzednika, skrót zawartości i pochodzenie zmian.
5. Przywrócenie poprzedniej wersji zmienia tylko wybór dla nowych analiz. Już uruchomione zadanie zachowuje przypiętą wersję.

### P04.5 — warianty i daty

- PZU Nowy i Wznowienie aktywne są oddzielnymi wariantami; nie łączyć ich w jedną stawkę.
- „Nie wskazano” nie jest potwierdzeniem, że każdy wariant ma identyczne warunki.
- Daty obowiązywania i zasada wyboru daty są ustawieniami szczegółowymi wersji/reguły. Nie przeciążać nimi podstawowej tabeli.
- Gdy daty historyczne nie są znane, zapisać ten fakt i oznaczyć analizę jako zastosowanie wybranego słownika do całego okresu. Dzień importu nie wyznacza początku obowiązywania.
- Niezgodne okresy i nakładające się reguły tej samej specyficzności wymagają rozstrzygnięcia.

### P04.6 — przypisania ryzyk

Zmiana procentu i zmiana znaczenia kodu są osobnymi zmianami. Przypisanie zapisuje warunki TU, profilu/kanału, kodu/nazwy, wariantu i osoby, z wersją oraz źródłem. Użytkownik nie dodaje skryptu Python ani dowolnego regexu. Reguły numerów wybieramy z kontrolowanych typów/parametrów i testowanych przykładów.

Jeżeli nazwa lub kod nie daje jednoznacznego wskazania, wynik pozostaje bez oceny. Samo istnienie pasującego procentu nie jest przypisaniem.

## 4. Testy

- Import 653 pozycji, stawki i statusy dla dwóch osób oraz źródła każdej wartości.
- Zero kontra brak, nieoferowanie kontra brak stawki, nierozpoznany kod kontra polecenie usunięcia.
- Procent zapisany jako liczba, procent Excela i tekst; błędna jednostka i formuła.
- Dodanie produktu, zmiana nazwy, brak wiersza w kolejnym imporcie i konflikt powtórzonego klucza.
- Równoczesna edycja, podwójna publikacja, brak grantu i cofnięcie wersji aktywnej.
- Analiza utworzona przed zmianą aktywnej wersji nadal otrzymuje pierwotny słownik.

## 5. Kryteria zakończenia

Klient edytuje sześciokolumnową tabelę bez formularza odpowiedzi. Import v7 jest zgodny ze źródłem. Każda publikacja ma historię i audyt, a stary wynik nie zmienia się po edycji. Nowe produkty są możliwe do dodania bez ingerowania w kod silnika i bez automatycznego dopasowania nieznanego ryzyka.
