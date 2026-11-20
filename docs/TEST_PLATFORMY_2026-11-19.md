# Test platformy — 19 listopada 2026

**Aktualizacja 20.11:** kampania 18001–18100 zakończona. Końcowy wynik i ograniczenia:
[Odbiór 100 wierszy](ODBIOR_WORKERA_100_2026-11-20.md). Poniżej zachowano historię prób.

## Zakres i stan

- Lokalny projekt Docker Compose `goldis-local`; dziewięć serwisów aplikacji.
- Import `45784330-03e0-4b03-af99-bcbc393b6c77`, wiersze **18001–18100**, data odniesienia 2026-11-19.
- Zgłoszenie utworzone przez interfejs: `5eb46533-7699-45dc-8d2c-3b9c1e9ac1aa`. Podgląd: 100 gotowych, 0 pominiętych, 100 osobnych zadań.
- Historyczne, wygasłe próby SMS 18001 i 18031 zamknięto przez platformę, z zachowaniem historii.
- Pierwsze zadanie wybrane przez kolejkę: wiersz 18003, `af7c04fa-ee22-44ae-bb8b-b289a8ab8936`. Kolejka nie zachowuje kolejności numerów wierszy.
- Pierwsza próba: platforma przyjęła i przekazała kod o 17:06:46 CET. O 17:07:07 worker zapisał `SMS_DELIVERY_UNCERTAIN`. Pozostałe 99 zadań zapisało `PORTAL_FAILURE` dla PZU. Nie powstały sprawy ani checkpointy Compensy. **Nie zaliczono testu workera.**
- Dalsze próby ograniczono do jednego zadania. Pozostałe 99 czeka na interwencję. Testy przydziału i porównywarki nie zostały jeszcze przeprowadzone.

## Rozpoznanie logowania PZU

- W pojedynczej sesji diagnostycznej PZU zwraca HTTP 200 i nagłówek „Przetwarzanie w toku dla Twojej bieżącej sesji.” pod `/pc/PolicyCenter.do`.
- Brak formularza SMS i markera zalogowanej aplikacji. Kontrola nawigacji workera nie zgłosiła blokady (`blocked=false`). Nie ma podstaw do uznania tej próby za błąd selektora wyszukiwania lub blokadę dozwolonych domen.
- To rozpoznanie dotyczy bieżącego zatrzymania; nie dowodzi samo w sobie dokładnej przyczyny pierwszej niepewnej odpowiedzi po SMS.
- Dodano ograniczoną diagnostykę nawigacji (maksymalnie 12 zdarzeń, bez query, treści, nagłówków i wartości cookies) i fazy przekazania SMS. Dla nieznanych ścieżek zapisuje się tylko `<other>`.
- Jawne ponowienie po rozpoznaniu powyższego nagłówka może jednorazowo odświeżyć cookies F5 `MRHSession` i `LastMRH_Session` w domenie PZU. Pozostawia tokeny zapamiętanego urządzenia i sesje innych portali. Nowe potwierdzenie live pozostaje do wykonania.
- Po wdrożeniu i ponownym uruchomieniu workera wznowiono wyłącznie zadanie 18003. O 17:22:58 CET PZU otworzyło świeże wyzwanie SMS (ważne do 17:27:58); formularz przekazano użytkownikowi. Samo uzyskanie nowego wyzwania nie potwierdza jeszcze udanego logowania ani wykonania wyszukiwania.

## Poprawki i weryfikacja

- Anulowanie wygasłego, nieaktywnego logowania SMS przed utworzeniem sprawy. Blokady: aktywna dzierżawa, przekazywany kod, zewnętrzna sprawa, checkpoint i inne rodzaje interwencji. API publikuje `canCancel`, interfejs korzysta z tej informacji. Otwarte interwencje anulowanej próby są zamykane.
- Regresja API: 5/5; osobna baza `run-control`, migracje 001–067: PASS, w tym rzeczywiste blokady aktywnej dzierżawy, sprawy, checkpointu i kodu w przekazaniu oraz idempotentne zamknięcie starego logowania.
- Sesja PZU i kontrola nawigacji po dodaniu diagnostyki: 24/24 fixture'ów Playwright. Dwa testy celowanego odświeżenia F5 i świeżego dokumentu SMS: 2/2.
- Formularz przydziału leadów: poprawiono układ desktopowy z flex na grid, aby komunikaty pustego stanu nie ściskały pól do zerowej szerokości. Pełna weryfikacja po dodaniu odbiorcy pozostaje do wykonania.

## Przygotowanie następnych etapów

Użytkownik zezwolił na lokalne konto operatora testowego i syntetyczne pliki porównywarki. Konto nie zostało jeszcze utworzone. Cztery skoroszyty oraz jawny manifest oczekiwań znajdują się w `outputs/platform-acceptance-20261119/`: CRM, ASF, Warta i słownik 653 pozycji ze stawką testową 15%. Pliki nie zawierają danych klientów. Nie zostały jeszcze zaimportowane ani porównane przez platformę.

Dwóch niezależnych agentów ukończyło odczytowy audyt UX. Do dalszej weryfikacji: niewidoczne błędy `wholeError` w postępie całego importu; ciche ograniczenie list prowizji do 500/200; sprzeczny status „Brak uruchomienia”; rozpoznawalność zakresu wierszy i historii powtarzanych prób. Te ustalenia nie oznaczają zakończenia testów funkcjonalnych.

## Ponowny test po zmianie konfiguracji przez użytkownika

- Po restarcie kontenerów ponownie wystąpiła osierocona blokada profilu; usunięto wyłącznie plik blokady po zatrzymaniu workera i potwierdzeniu braku aktywnego właściciela.
- Porównanie `.env.local` z faktycznie montowanymi sekretami wykazało nieaktualne hasło PZU w pliku sekretu. Zsynchronizowano wyłącznie `PZU_PASSWORD`; wartości nie zapisano w raporcie ani w logach.
- Nowy kod dla **18001** został zaakceptowany. O 17:37:30 CET zakończono pełny przebieg PZU → Compensa → UFG → Excel: snapshot 50 polis OC, eksport 4 polis spełniających filtr daty. Pobrany XLSX jest czytelny, ma dokładnie 4 rekordy i poprawne daty końca.
- **18002**: `IDENTITY_NOT_FOUND`, bez utworzenia sprawy Compensy.
- **18003** ujawnił błąd świeżości dwóch kolejnych pustych wyszukań. Guidewire potwierdza przycisk wyszukania przez POST i aktualizuje kontrolkę `smartsearch`, pozostawiając dotychczasowy element „Brak wyników wyszukiwania” bez mutacji. Worker czekał wyłącznie na mutację wyniku, więc klasyfikował odpowiedź jako `PORTAL_FAILURE`.
- Poprawka dopuszcza niezmieniony pusty wynik wyłącznie po HTTP 200 dla dokładnego zdarzenia `${searchName}_Button_act` i wysłanego REGON-u, poprawnej odpowiedzi `targets` dla tej kontrolki, jej wyczyszczeniu, `aria-invalid=false`, widocznym pustym wyniku i braku widocznych wierszy. Nie rozluźnia akceptacji niezmienionych danych osoby.
- Regresja poprawki: 3/3 testy celowane; 8/8 testów całego adaptera w obrazie Docker, bez sieci. Obejmuje odrzucenie odpowiedzi dla innego REGON-u i ignorowanie niezwiązanych mutacji.
- Po wdrożeniu **18003** poprawnie zakończył się `IDENTITY_NOT_FOUND`, a **18004** przeszedł do Compensy bez nowego SMS.
- Dalszy test prowadzi koordynator przez zwykłe uwierzytelnione API platformy, w kolejności 18001–18100, po jednym aktywnym zadaniu. Zachowuje istniejące identyfikatory i historię. Zatrzymuje serię przy błędzie wspólnej sesji. Stan bieżący i dowody: `exports/platform-acceptance-20261119/retest-state.json`, `retest-worker-100-after-search-fix.log`, `export-verification.json`. Test całej setki nadal trwa.
