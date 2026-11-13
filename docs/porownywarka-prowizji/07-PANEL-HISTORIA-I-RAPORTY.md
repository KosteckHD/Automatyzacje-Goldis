# P07 — panel użytkownika, historia i raporty Python

Zależności: P02–P06. Efekt: użytkownik wykonuje pełny przepływ prowizyjny w przeglądarce, a pobrany plik jest gotowym raportem bez potrzeby przeliczenia w Excelu.

## 1. Miejsca implementacji

```text
apps/web/app/tools/commission-comparison/
  page.tsx
  workspace.tsx
  input-files.tsx
  dictionary-editor.tsx
  run-history.tsx
  findings-table.tsx
  finding-details.tsx
apps/web/app/tools/tool-catalog.tsx
services/commission-engine/src/goldis_commissions/exporters/
  report.py
  dictionary.py
  formatting.py
```

Nazwy są propozycją. Przed kodowaniem UI przeczytać obowiązujący `apps/web/AGENTS.md` i lokalne przewodniki Next. Korzystać z istniejących komponentów i stylu Goldis, zachowując dostępność oraz obsługę błędów.

## 2. Ekran nowej analizy

1. W katalogu podłączyć nowy identyfikator narzędzia do widoku, uwzględniając oddzielne prawa wykonania i odczytu.
2. Formularz zawiera okres dat wystawienia, grupy plików i wersję słownika. Nie prosi o ręczne wskazanie osoby dla każdej polisy.
3. Przy pliku pokazać jego kategorię, stan parsowania, wiersze, dostępny okres, duplikat lub błąd.
4. Po parsowaniu wyświetlić liczbę polis ogółem i w zakresie oraz powody wyłączeń. Przykład 1678 → 944 jest widoczny przed uruchomieniem.
5. Pokazać, które raporty dostarczono, a których nie potwierdzono. Nie twierdzić, że system dowiódł kompletności miesięcy lub kanału UNIQA Oli.
6. Uruchomienie ma blokadę podwójnego kliknięcia i idempotency key. Po odświeżeniu strona odnajduje już przyjętą analizę.

## 3. Słownik

Sześć podstawowych kolumn opisanych w P04, bez formularza „Decyzja klienta / poprawne stawki / dokument” przy każdym wierszu. Braki są czerwone, stawki edytowane bezpośrednio, a wariant Nowy/Wznowienie jest osobną kolumną.

- Filtrowanie po TU, ryzyku, wariancie i brakujących wartościach.
- Czytelne odróżnienie 0%, BRAK i statusu nieoferowania.
- Wyszukiwanie, możliwość dodania nowego wpisu i uwagi.
- Widoczna wersja aktywna/robocza, podgląd różnic i pojedyncza publikacja wersji.
- Szczegółowe warunki i daty wersji poza podstawową tabelą; brak przymusu wypełniania nieznanej historii.
- Konflikt równoczesnej edycji pokazuje, co zmieniło się na serwerze; nie nadpisuje wpisu.

## 4. Ekran wyniku

### Podsumowanie

Pokazać okres, zestaw plików, wersję słownika i stan zadania. Liczniki mają jednostki:

- polisy: dopasowane, bez rozliczenia, z niepewnym numerem;
- pozycje rozliczeń: ocenione, rozbieżne i bez oceny;
- polisy z co najmniej jedną rozbieżnością;
- oddzielne grupy kontroli odwrotnej „brak w CRM”.

Nie sumować policzonych w różny sposób kart do jednej liczby. Jedna polisa może mieć wiele ryzyk i jednocześnie rozbieżność oraz pozycję bez oceny.

### Listy i szczegóły

Widoki: braki w rozliczeniach, rozbieżne procenty, brak oceny, niepewne numery, braki w CRM oraz pełna lista polis/pozycji. Filtry: TU, osoba, numer, wariant, rodzaj problemu i źródło. Filtrowanie/paginacja odbywają się po stronie serwera w dozwolonym zakresie danych.

Szczegół pokazuje obie postacie numeru, OFWCA, profil, kod/nazwę ryzyka, rzeczywisty i oczekiwany procent, różnicę p.p., regułę dopasowania i dokładne źródła. Nie zastępować braku liczby zerem ani pustym statusem.

Każdy problem ma następne działanie:

| Przypadek | Działanie |
| --- | --- |
| Brak w ASF/Warcie | Sprawdzenie zestawu i terminu raportów. |
| Brak w CRM | Dostarczenie wpisu CRM albo wyjaśnienie zakresu. |
| Niepewny numer | Potwierdzenie konkretnego powiązania. |
| Brak stawki | Uzupełnienie właściwej pozycji słownika. |
| Nieznany kod / profil | Ustalenie znaczenia i wersjonowanego przypisania. |
| Pakiet / próg / korekta | Potwierdzenie warunku obliczenia. |
| Produkt nieoferowany, ale jest rozliczenie | Wyjaśnienie sprzeczności; nie ukrywanie wiersza. |

## 5. Historia

Lista analiz prezentuje autora, okres, czas, stan, liczbę polis, użyty słownik i eksporty. Zmiana aktywnego słownika nie zmienia starych wyników. Akcja „Przelicz” tworzy nową analizę z wybranymi wersjami i odwołaniem do poprzedniej. Wyjaśnienia użytkownika mają historię i pochodzenie.

## 6. Eksport wykonywany w Pythonie

1. Eksport otrzymuje **zatwierdzony snapshot**, nie uruchamia ponownie porównania i nie czyta bieżącego aktywnego słownika.
2. `XlsxWriter` zapisuje typed liczby/daty, identyfikatory jako tekst, filtry, nagłówki, zamrożenie i kolory statusów. Nie wymaga otwierania pliku w Excelu na serwerze; zob. [dokumentacja biblioteki](https://xlsxwriter.readthedocs.io/getting_started.html).
3. Do raportu trafiają wartości obliczone w Pythonie, bez formuł wymagających zewnętrznego silnika. Kwoty i procenty mają jawne jednostki i format.
4. Zachować zera wiodące i pełne numery; nie dopuszczać konwersji do notacji naukowej jako utraty identyfikatora.
5. Dla tekstu używać bezpiecznego zapisu string; wyłączyć automatyczne rozpoznawanie formuł i niezamierzonych URL. Nazwy arkuszy kontrolować i rozstrzygać kolizje po skróceniu.
6. Zwykły raport zawiera podsumowanie, wyniki per TU oraz osobne niepewności i kontrolę odwrotną. Arkusze „Zmiany słownika” / „Efekt aktualizacji” dodawać, gdy rzeczywiście porównujemy dwie analizy lub wersje.
7. Jeśli raport jest filtrowany, zapisać te filtry i zgodne liczniki. Nie opisywać wycinka jako całości.
8. Node odbiera kompletny XLSX z limitem, sprawdza hash/strukturę, szyfruje i zapisuje atomowo. Gotowy link jest publikowany dopiero po autoryzowanym zatwierdzeniu artefaktu.

Opcjonalny eksport słownika zachowuje prosty układ sześciu kolumn i czerwone BRAK, z wartościami możliwymi do bezpośredniej edycji. Nie wymaga makr.

## 7. Błędy i dostępność

Obsłużyć pusty wynik, niepełny import, utratę sieci, wygaśnięcie sesji, odebranie grantu, odrzuconą wersję i anulowanie. Spóźniona odpowiedź nie przywraca starego stanu ekranu. Zapewnić klawiaturę, fokus po błędzie i czytelność tabel na mniejszych ekranach bez ukrywania krytycznych pól.

## 8. Testy i kryteria zakończenia

- Przejść w izolowanym środowisku: upload → podgląd → wybór słownika → analiza → szczegół → eksport. Bez portali OC i bez Excela.
- Potwierdzić zgodność ekranów i XLSX ze snapshotem, typy komórek, daty, zera, brakujące wartości i pełne numery.
- Sprawdzić wynik 1678/944 i osobne zakresy kontroli odwrotnej.
- Otworzyć zapisany XLSX biblioteką niezależną od eksportera i porównać wszystkie istotne wiersze; przejrzeć układ representative wszystkich typów arkuszy.
- Odbiór wizualny można wykonać na stanowisku testowym, ale nie jest zależnością produkcyjnego VPS.
- Pobieranie bez grantu i po usunięciu zasobu jest odrzucane. Awaria generowania nie publikuje uszkodzonego pliku.

Etap jest zakończony, gdy użytkownik rozumie przyczynę problemu i może przejść do właściwego działania, a raport jest użyteczny bez ręcznego przeliczania.
