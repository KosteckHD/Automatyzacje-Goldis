# P05 — reguły porównania w Pythonie

Zależności: P01–P04. Efekt: deterministyczny wynik, odtwarzający v7 i wskazujący konkretne przyczyny niepewności. Przetwarzanie nie potrzebuje silnika arkuszy.

## 1. Wejście funkcji domenowej

Funkcja otrzymuje znormalizowane rekordy, zakres dat, niezmienne wersje słownika/przypisań/normalizacji oraz opcjonalną wersję zatwierdzonych wyjaśnień. Nie odczytuje aktywnego słownika z bazy w połowie pracy, nie odpytuje portali i nie aktualizuje plików klienta.

Wyjście zawiera osobno wyniki polis, wyniki pozycji, kontrolę odwrotną, niepewności i liczniki o jawnej jednostce. Każdy wynik ma dowód źródłowy i stabilny kod przyczyny.

## 2. Czynności implementacyjne

### P05.1 — wybór polis CRM

1. Wybrać polisy według daty wystawienia, włącznie z obiema granicami.
2. Pokazać liczbę wszystkich, wcześniejszych, wybranych i późniejszych polis.
3. Zachować dane całego dostarczonego CRM dla osobnej kontroli odwrotnej.
4. Sprzeczne duplikaty i brak daty pokazać jawnie, nie usuwać bez informacji.

### P05.2 — rozpoznanie numeru

Zachować źródłowy numer oraz klucz porównania. Numery są tekstem:

| TU | Reguła potwierdzona w prototypie |
| --- | --- |
| AGRO | `1002N01740628 → 01740628`; zera wiodące pozostają. |
| Compensa | `22014-1849756 → 1849756`. |
| OMINIMO | `OMPLINS260901320547 → 260901320547`. |
| UNIQA | `2026-4054286584 → 4054286584`. |
| Allianz | Końcowy człon po ostatnim myślniku; bez myślnika numer pozostaje bez zmian. |
| PZU | Uzgodnione dopasowanie numeru z sufiksem, z ochroną przed kilkoma możliwymi wznowieniami. |

Pozostałe reguły i ograniczone aliasy TU przenieść z v7 wraz z testami. Nie zamieniać ich w globalne porównywanie końcówek. Alias DA Direkt → OMINIMO pozostaje ograniczony do rozpoznanego formatu numeru, a nie całego TU.

Dopasowanie ma poziom: dokładne, potwierdzona reguła formatu, kandydat albo brak. Kolizja kilku numerów lub różnica TU pozostaje kandydatem. Wiele rat/ryzyk jednego potwierdzonego numeru nie jest kolizją.

### P05.3 — wybór osoby

Stawkę wybiera OFWCA danego wiersza rozliczenia. Aliasy nazw/ID pochodzą z wersjonowanego katalogu agentów. Wystawca CRM i konto uruchamiające analizę nie zastępują OFWCA. Gdy rozliczenia brak, właściciel może pozostać nieustalony. Kilku OFWCA przy jednej polisie pokazujemy wraz z przypisaniami, zamiast wybierać pierwszego.

### P05.4 — wybór reguły stawki

1. Zastosować ochronę dla brakującego procentu, korekt, zerowego/ujemnego inkasa i nieznanej osoby zgodnie z v7.
2. Rozpoznać TU, profil/kanał, kod i nazwę ryzyka oraz wariant.
3. Wybrać jedną regułę według jawnej specyficzności i warunków, nie kolejności w pliku.
4. Dla PZU użyć NOWE dla Nowego biznesu i WZNOWIENIE AKTYWNE dla aktywnego wznowienia. Sprzeczne lub nieznane oznaczenia pozostają bez oceny.
5. Zachować różnice Oli/Maćka, Panel/POS/flota, HDI, online i progi inkasa.
6. Dla HDI Zielona Karta stosować odrębną stawkę Maćka 11%, zamiast ogólnego OC 12%.
7. Status nieoferowania lub braku stawki w obecności rzeczywistego rozliczenia daje informację do wyjaśnienia; nie usuwa tego rozliczenia.
8. Brak jednoznacznego przypisania, pakietu lub progu nie pozwala wybrać takiej stawki, która akurat pasuje do procentu ASF.

W pierwszym wydaniu nie rozstrzygamy nowych pakietów i kodów poza v7. Każda nowa interpretacja jest nową wersją reguł z osobnymi testami.

### P05.5 — obliczenie różnicy

- Wartości w Pythonie są `Decimal` w punktach procentowych.
- Różnica = procent otrzymany minus oczekiwany.
- Tolerancja początkowa jest zgodna z v7: 0,000001 p.p. Nie zaokrąglać przed kwalifikacją.
- Zero jest liczbą. Brak wartości i status tekstowy nie są liczbami.
- Dla Warty bez procentów nie wyliczać ich z kwot i zerowego inkasa. To przypadek bez oceny, nie zgodność ani błąd procentu.
- Nie przeliczać różnicy procentowej na kwotę należności bez ustalenia właściwej podstawy, waluty, rat i korekt.

### P05.6 — dwa kierunki braków

**CRM → rozliczenia:** dla wybranego okresu szukamy we wszystkich wybranych, właściwych raportach. Dla Warty obecność w ASF albo Warcie wystarcza; nie wymagamy obecności w obu naraz. UNIQA w ASF i brak osobnego raportu muszą być opisane zgodnie z rzeczywistym zestawem danych.

**Rozliczenia → CRM:** przeszukujemy cały dostarczony CRM. Grupujemy według TU, źródła i numeru po normalizacji, zachowując wszystkie wiersze źródłowe. Data umowy ASF w okresie, poza okresem i brak daty Warty są oddzielnymi informacjami. Tych grup nie doliczamy do liczby polis z CRM bez rozliczenia.

Niepewny numer nie jest pewnym brakiem. Brak w dostarczonych plikach nie potwierdza niewypłacenia prowizji.

### P05.7 — wyjaśnienia użytkownika

Powiązanie numerów lub przypisanie ryzyka zatwierdzone przez użytkownika zapisuje autora, uzasadnienie, zakres i źródło. Nie zmienia już opublikowanego wyniku w miejscu. Nowe przeliczenie przypina wersję tej decyzji. Decyzja dla jednej polisy nie staje się globalną regułą bez osobnego zatwierdzenia i testów kolizji.

## 3. Wynik pojedynczej pozycji

Zawiera: identyfikator polisy i źródła, oba numery, TU, OFWCA, kod/nazwę/profil, wariant, otrzymany i oczekiwany procent, różnicę, status dopasowania, status oceny, przyczynę, użyte reguły oraz plik/arkusz/wiersz/komórkę słownika. Brak procentu nie jest serializowany jako `0`.

## 4. Testy i odbiór

- Pełna zgodność z v7 po źródłowych wierszach i wynikach: 944 polis; 682/244/18; 1651/481; 257 na 140 polisach.
- Kontrola odwrotna: osobne 83 grupy i ten sam podział dostępnych dat.
- Wszystkie przykłady numerów, kolizje, wielokrotne raty, wieloagentowość i ograniczone aliasy TU.
- Zmiana otrzymanego procentu nie zmienia wyboru reguły; zmiana OFWCA zmienia stawkę tylko zgodnie ze słownikiem.
- Te same dane i wersje dają identyczny wynik biznesowy niezależnie od kolejności plików i wykonania procesów.
- Przypadki bez oceny pozostają opisane, a nie zastąpione domniemaniem zgodności.

Po spełnieniu tych warunków silnik jest gotowy do trwałego wykonywania zadań P06. Liczby wzorca dotyczą tego zestawu danych, nie stanowią limitów aplikacji.
