# Gotowość workera do lokalnego testu — 17 listopada 2026

Przygotowano projekt Compose `goldis-local` z zachowaniem istniejącej bazy, profilu przeglądarki, rekordów i wyników. API, worker i panel zostały przebudowane z bieżącego kodu oraz ponownie uruchomione. Ten odbiór dotyczy gotowości lokalnej i scenariuszy syntetycznych; nie zastępuje wykonania aktualnego testu w rzeczywistych portalach po podaniu SMS.

## Naprawiony problem blokujący nowy import

Test przez aktualny panel ujawnił rzeczywisty błąd: poprawny plik `.xlsx` dawał HTTP 400 „Wybierz plik .xlsx”. Przyczyną było niekompletne drzewo zależności w `package-lock.json`. `type-is@1.6.18`, używany przez Multera, dostawał `media-typer@1.1.1` zamiast wymaganego `0.3.0`. Odczyt nagłówka z parametrem `boundary` kończył się nierozpoznaniem żądania multipart, więc kontroler nie otrzymywał pliku.

Lockfile uzupełniono wyłącznie o brakujące zależności pod Multerem: `media-typer@0.3.0`, `mime-types@2.1.35` i `mime-db@1.52.0`. Pozostałe wersje zachowano, w tym przypięty `multer@2.5.0`. Naprawę sprawdzono po czystym `npm ci`, w lokalnej przeglądarce, w teście HTTP NestJS oraz w przebudowanym i działającym kontenerze API.

Test importu sprawdza teraz nazwę i dokładne bajty pliku przekazanego do usługi. Wcześniej stub usługi zwracał sukces także bez pliku, przez co sam status HTTP nie wykrywał regresji parsera.

## Uzupełniony odbiór poprzednich zmian

- Dodano `apps/api/scripts/worker-execution-fence-smoke.cjs` do testu wyników na jednorazowej bazie. Test używa rzeczywistej blokady wiersza PostgreSQL: stary worker czeka za transakcją nowego właściciela, a po jej zakończeniu musi odmówić utworzenia SMS. Sprawdza też brak mutacji przez starego właściciela przy wygaszeniu, niepewności i przyjęciu kodu oraz przy intencjach rozpoczęcia i UFG. Aktualny właściciel może kontynuować; powtórna autoryzacja tej samej akcji jest blokowana.
- Scenariusz `automation-flow-smoke.cjs` dostosowano do obecnego interfejsu: osiem etapów, wybór firmy, podsumowanie, zapis zgłoszenia, interwencja SMS i eksport. Kontrole administratora otwierają właściwą sekcję, a zmiana użytkownika zaczyna się od znanej strony zamiast polegać na zapisanym widoku.
- Oczekiwania testów ponowienia PZU dotyczą teraz świeżego wejścia do aplikacji, a nie kliknięcia resend w starym iframe. Sprawdzana jest liczba nowych wejść, blokada starego kodu i limit ponowień.
- Reguła tożsamości pozostaje zgodna z decyzją użytkownika: najpierw osoba fizyczna; przy braku takiego wiersza można użyć PESEL-u z działalności, z kontrolą poprawności i zgodności danych. Firma ma osobną ścieżkę REGON.
- Odświeżono testowy katalog schematu po porównaniu różnic z istniejącymi migracjami 028 oraz 063–067. Brakowało m.in. tabeli budżetu rejestru, obsługi firmy bez PESEL-u, pauzy zgłoszenia, zdarzeń audytu oraz tabel i lease prowizji. Nie zmieniano produkcyjnych migracji ani nie wyłączano porównania schematu. Aktualny katalog ma 69 tabel, 815 kolumn, 525 ograniczeń i 239 indeksów. Tryby integracyjne obejmują teraz również migrację 067, zamiast zatrzymywać się na 066.

## Weryfikacja

| Kontrola | Wynik |
| --- | --- |
| Pełny build API, workera i panelu po naprawie zależności | PASS |
| Testy końcowego obrazu workera, bez sieci, z Playwright | 232/232 PASS, bez pominięć |
| Import HTTP oraz kontrakt i usługa wznowień w końcowym obrazie API | 19/19 PASS |
| Test rzeczywistej blokady wykonania i zapisów wyników na jednorazowym PostgreSQL | PASS |
| Przeglądarka → aktualny panel → import → przygotowanie → zgłoszenie → kod testowy → produkcyjny procesor → UFG fixture → pobrany, odczytany XLSX | PASS |
| Cała macierz automatyzacji i moduły DB | 9/9 scenariuszy PASS; `users`, `run-control`, `runtime-roles` PASS; migracje 001–067; jednorazowe bazy usunięte |
| Ścisłe porównanie katalogu schematu, start/zamknięcie API, role i kontrolowane awarie DB/Redis | PASS, bez trybu aktualizacji kontraktu |
| Chromium z sandboxem i ustawieniami kontenera | PASS |
| Właściwy trwały profil workera, pusta strona w kontenerze bez sieci | PASS |
| API → działający kontener parsera, fikcyjny Excel | PASS, 1 wiersz, bez zapisu importu w bazie |
| Kontrola granic modułów i testy runnera | PASS, 5/5 i 2/2 |
| Skróty źródeł API/workera/panelu oraz lockfile w działającym API i workerze | Zgodne z repozytorium |

Pierwszy zestaw kontenerowy został wywołany z niewłaściwego katalogu i nie znajdował fixture; poprawione uruchomienie ma katalog `/app/apps/worker`. Kolejne niezaliczone przebiegi wykryły opisany błąd importu oraz nieaktualne założenia testu o nawigacji i nazwach elementów panelu. Zachowano ich logi; do odbioru liczą się wyniki końcowe wskazane powyżej.

Logi i dowody lokalne, ignorowane przez Git: `exports/worker-local-readiness-20261117/`. Najważniejsze: `worker-tests-final-image.log`, `api-regression-final-image.log`, **`acceptance.log`** (końcowy odbiór, kod wyjścia 0), `build-fixed-dependencies.log`, `final-health.json` oraz `source-*.json`. Negatywne próby dostępności celowo odłączają testową bazę lub Redis i oczekują HTTP 503; ich komunikaty o odmowie połączenia nie dotyczą działającej platformy lokalnej.

## Stan środowiska

- Panel: `http://127.0.0.1:3000`.
- Działają: PostgreSQL, Redis, API, panel, parser importu, worker portalowy, worker wzbogacania, silnik prowizji i worker prowizji. Usługi z healthcheckiem zgłaszają gotowość; worker prowizji nie ma własnego healthchecka.
- API: `automationReady=true`, `servicesReady=true`, `worker=online`, `portalMode=live`, `portalConfig=valid`.
- Konto bazy workera: `goldis_worker`, bez superusera, tworzenia baz/ról i omijania RLS.
- Dostawca zewnętrznego rejestru jest wyłączony. Worker wzbogacania działa; wcześniejszy rekord testowy ma już przygotowany REGON.
- Usunięto wyłącznie pozostawioną blokadę nieużywanego profilu po sprawdzeniu, że nie montuje go działający kontener. Profil zachowano. Po próbie offline ponownie rezerwuje go właściwy worker.
- Nie uruchamiano rzeczywistych portali, nie żądano nowego SMS i nie zmieniano danych dostępowych.

## Wcześniejszy rekord testowy

Zachowano import `45784330-03e0-4b03-af99-bcbc393b6c77`, wiersz **18001**, run `5ce9f17d-8f31-4670-bf62-3af898be5226`.

Zadanie nadal ma `waiting_for_manual_data / SMS_RETRY_REQUIRED`, interwencję PZU `SMS_TIMEOUT`, bez sprawy zewnętrznej i aktywnego wykonania. Licznik ponowień PZU wynosi 1 przy limicie 2, więc pozostaje jeszcze jedno jawne ponowienie. Brak aktywnego kodu oraz oczekującego dispatchu; przygotowanie nie zużyło kolejnej próby.

Data odniesienia tego zachowanego zadania to **2026-11-13**. Nie zmieniano jej na datę dzisiejszą. Po świadomym wznowieniu operator powinien wpisać najnowszy kod bezpośrednio w platformie. Do czasu rzeczywistego przejścia przez PZU i Compensę nie deklarować pełnego odbioru ich aktualnych ekranów ani polityki MFA.
