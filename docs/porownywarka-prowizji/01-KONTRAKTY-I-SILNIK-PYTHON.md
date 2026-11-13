# P01 — kontrakty i przygotowanie silnika Python

Zależności: brak nowych elementów platformy. Dokument nadrzędny: [Python / VPS](README.md). Efekt: instalowalny pakiet Python, bez lokalnych ścieżek Windows i zależności od aplikacji Excel, odtwarzający reguły v7.

## 1. Materiał wejściowy

- Lokalny `prototype.py`, `client_dictionary.py`, aktywny słownik v7 i ich hashe.
- Wynik referencyjny z 5 listopada 2026 dla zakresu czerwiec–wrzesień.
- 89 dotychczasowych testów oraz źródłowe przykłady formatów numerów i procentów.
- Prywatne pliki CRM/ASF/Warty oraz uzupełniony słownik klienta; bez kopiowania ich do repozytorium.

## 2. Proponowane pliki

```text
services/commission-engine/
  pyproject.toml
  requirements.lock
  Dockerfile
  src/goldis_commissions/
    domain/models.py
    domain/normalization.py
    domain/rate_selection.py
    domain/reconciliation.py
    domain/decimal_codec.py
    importers/
    exporters/
    transport/
    cli.py
  tests/unit/
  tests/contracts/
  tests/regression/
packages/core/src/commissions/contracts.ts
contracts/commissions/v1/
```

To plan plików, nie gotowy kod. Moduły domeny nie importują FastAPI, bazy, kolejki ani bibliotek XLSX. Importer, transport i eksport są adapterami tej samej logiki.

## 3. Czynności implementacyjne

### P01.1 — zamrożenie wzorca

1. Zapisać hashe silnika, reguł, słownika i manifestu danych użytych w v7.
2. Zbudować kontrolowany opis wyniku referencyjnego: klucz polisy, źródłowy wiersz, dopasowanie, osoba, wariant, obie stawki, różnica i przyczyna.
3. Ustalić stabilne identyfikatory źródeł. Test porównawczy nie może zależeć od absolutnej ścieżki na komputerze autora.
4. Oddzielić publiczne syntetyczne fixture od prywatnego testu na materiale klienta.

### P01.2 — wydzielenie funkcji

1. Rozdzielić czytanie plików, normalizację numeru, rozpoznanie TU/OFWCA, wybór stawki i budowę wyniku.
2. Zastąpić ścieżki `C:\...` parametrami adapterów. Usunąć wymóg PowerShell i lokalnego katalogu Downloads.
3. Przekazywać słownik jako gotowy, niezmienny obiekt, nie wyszukiwać „aktywnego pliku” w trakcie obliczeń.
4. Wszystkie obliczenia procentowe przeprowadzać w `Decimal`. Przy zmianie reprezentacji z dotychczasowych float sprawdzić tolerancję v7, zamiast zakładać zgodność.
5. Zachować konfigurację i jawne wersje reguł, w tym ograniczenia pakietów i nierozpoznanych kodów.
6. Dodać CLI do testowego wywołania z manifestu wejściowego i zapisania wyniku JSON. CLI i transport HTTP wywołują te same funkcje.

### P01.3 — kontrakt danych

Opisać w jednym wersjonowanym schemacie:

- `schema_version`, typ operacji, `request_id`, `execution_id`, token próby i wersję silnika.
- Listę dozwolonych źródeł oraz ich hashe i pozycje.
- Rekord CRM z datą wystawienia i oddzielnymi datami ochrony/wprowadzenia, jeśli są potrzebne.
- Rekord rozliczenia z kodem/nazwą ryzyka, OFWCA, procentem, inkasem, datą umowy i okresem raportu.
- Wpis słownika z trwałym ID, osobą prowizyjną, wariantem, statusem i procentem.
- Osobne statusy dopasowania polisy, oceny procentu i kierunku braku.
- Wynik, liczniki o określonej jednostce i błędy z lokalizacją źródłową.

Procent `"15.000000"` oznacza 15 punktów procentowych. Numer `"01740628"` pozostaje tekstem. `null` oznacza brak wartości, a nie zero. Token wersji reguł i wartości słownika nie są wymieniane podczas przetwarzania.

Schemat walidują Python i TypeScript; kontrakty sprawdzają również testy negatywne. Typy TS nie implementują wyboru stawek. Kolejka przenosi identyfikator zadania, a duże dane idą przez ograniczone połączenie wewnętrzne.

### P01.4 — polityka braku silnika Excela

1. Uruchomić testy w czystym kontenerze Linux, w którym nie ma Office ani LibreOffice.
2. Odczytywać dane arkuszy, nie wykonywać formuł i VBA.
3. Zdefiniować błąd `FORMULA_REQUIRES_VALUE` z plikiem/arkuszem/komórką dla krytycznej wartości będącej formułą. Zapisany cache nie jest dowodem świeżego przeliczenia.
4. Przygotować szkielet eksportu wartości, bez zależności od przeliczenia formuł przez odbiorcę.
5. Kod podglądów i renderowania używany lokalnie przy tworzeniu dokumentów nie może stać się zależnością produkcyjną silnika.

## 4. Testy

- Przenieść dotychczasowe testy z jawną wersją słownika; test v1 nie może zacząć nieświadomie używać v7.
- Pokryć dwa zapisy procentów, zero, brak, status nieoferowania i nieznany kod.
- Odtworzyć numery AGRO, Compensy, OMINIMO, UNIQA, Allianz i PZU oraz kolizje.
- Sprawdzić nowe/wznowienie aktywne, OFWCA i wyjątki Oli.
- Udowodnić, że zmiana otrzymanego procentu nie zmienia wyboru stawki oczekiwanej.
- Porównać każdy wynik z v7 oraz agregaty: 944 polis, 1651 ocenionych pozycji, 481 bez oceny, 257 rozbieżności na 140 polisach.
- Ten sam manifest uruchomiony dwa razy daje ten sam wynik biznesowy; czas generowania i identyfikator techniczny nie wchodzą do tego porównania.

## 5. Kryteria zakończenia

- Pakiet instaluje się i przechodzi testy na Linux z przypiętymi zależnościami.
- Nie wymaga plików z komputera autora ani lokalnych runtime Codex.
- Utrzymano pełną zgodność z v7, a każda zamierzona różnica ma osobny opis i zatwierdzoną zmianę reguły.
- Dostępny jest kontrakt v1 i prywatny raport parytetu, bez danych klienta w logach/repozytorium.

## 6. Granica następnego etapu

P02 otrzymuje kontrakty i wersję pakietu. Nie otrzymuje wymogu przepisania reguł do NestJS. Nowe interpretacje pakietów i biznesowe zmiany procentów są osobnymi zmianami po zachowaniu wzorca v7.
