# Obsługa przypadków i odbiór automatyzacji — 17 października 2026

Decyzja użytkownika: przypadek 18024 poprawnie zatrzymuje wiersz, natomiast dodatkowy dialog „Ubezpieczający” z 18025 należy na razie pominąć i przejść do następnego zadania. Nie uzupełniamy tego dialogu i nie zatwierdzamy go.

## Macierz przypadków w kodzie

| Przypadek | Zachowanie automatyzacji | Dowód |
| --- | --- | --- |
| Zalogowana Compensa | Wejście przez **Compensa Komunikacja**, identyfikator z Everest i numer rejestracyjny. Bez obejścia przez Klient 360. | Test kolejności z pułapką Klient 360; pełne próby live. |
| Firma z Everest, m.in. 18012 i 18020 | Dokładny REGON i zgodna nazwa; REGON w Compensie i eksporcie, bez fikcyjnego PESEL-u. | Testy tożsamości i formularza; live 18012: 552/49 polis, 18020: 259/28; pobrane XLSX porównane. |
| Kilka kont tej samej osoby, 18019 | Identyczny poprawny PESEL oznacza jedną osobę; normalizacja nazw uwzględnia kolejność słów i polskie znaki. Różne identyfikatory nadal wymagają przeglądu. | Regresja Everest; live 18019: 27/2 i zgodny XLSX. |
| Brak wydzielonego nazwiska w Everest | Potwierdzenie danych osoby na formularzu Komunikacji przy tym samym PESEL-u, przed zapisem i eksportem. | Regresja dostawcy tożsamości/formularza i zakończone próby live. |
| Błędny REGON, 18011 | Błąd wejścia/przegląd; bez zgadywania numeru i bez tworzenia oferty. | Walidacja importu i potwierdzenie użytkownika. |
| Everest nie zwraca wyników, 18018 i 18029 | Rozliczenie braku wyniku dla wiersza, bez przejścia do Compensy; następne zadania mogą działać. | Testy Everest i rzeczywiste próby. |
| „Dane Klienta są niekompletne.”, 18014 i 18024 | Rozpoznany komunikat oraz puste, zablokowane pola kodu pocztowego/powiatu kończą wiersz kodem `COMPENSA_CUSTOMER_DATA_INCOMPLETE`. Bez zapisu i UFG; kolejka działa dalej. | Obserwacje live obu wierszy; test formularza, procesora i E2E `incomplete_customer`. |
| Dodatkowy dialog „Ubezpieczający”, 18025 | Sprawdzenie zgodności identyfikatora, anulowanie dialogu i kod `COMPENSA_PAYER_DATA_SKIPPED`; UI pokazuje „Pominięto”. Bez zapisu, UFG i eksportu; następne zadanie działa. | Testy formularza, procesora, liczników API oraz E2E `payer_skip` z następnym poprawnym zadaniem. |
| Dialog dotyczy innego identyfikatora albo istnieje już draft | Brak automatycznego pominięcia; przegląd tożsamości/stanu oferty. | Regresja wrong-payer i payer-with-draft. |
| SMS/ponowienie/timeout/limit | Kontrolowane oczekiwanie i dotychczasowe limity, bez dublowania zapisu. | E2E: SMS, rejected reentry, rejected resend, timeout, retry limit. |
| Nieznany stan lub niepewny zapis | Zatrzymanie do przeglądu; bez automatycznego odtwarzania niepewnej operacji. | Ochrona checkpointów i testy runnera. |

## Reprezentacja wyniku

Warstwa trwałych runów zachowuje istniejący terminalny status `failed` z dedykowanym kodem przyczyny. Nie dodano globalnego statusu ani migracji schematu. UI tłumaczy `COMPENSA_PAYER_DATA_SKIPPED` na **Pominięto**, a niekompletne dane na **Niekompletne dane Compensy**. Liczniki submission wydzielają `skipped` od błędów; pominięta pozycja jest rozliczona i nie blokuje kolejki. Raport nadzorowanej próby klasyfikuje ją jako `POMINIETY`. Odbiorca API powinien rozpatrywać status razem z `errorCode`.

Pominięcie wymaga dokładnego zaobserwowanego dialogu, zgodnego identyfikatora i jednego aktywnego przycisku Anuluj. Adapter obsługuje także zastany dialog po odzyskaniu sesji. Nie klika Akceptuj i nie dopisuje brakujących danych. Stare wyniki 18025 pozostają historycznymi nieudanymi próbami; zmiana kodu nie zmienia ich w pominięcia.

## Weryfikacja po zmianie

- 67/67 testów workerów/adapterów, 16/16 testów core oraz 6/6 testów konfiguracji/liczników API: PASS.
- Pełna próba na jednorazowej bazie w trybie `users`: migracje 001–063, HTTP/DB i **9 scenariuszy E2E PASS**. Nowe scenariusze potwierdzają brak zapisu/UFG, anulowanie bez akceptacji, opis w UI, brak otwartej interwencji i ukończenie następnego poprawnego zadania.
- Produkcyjne kompilacje API, workera i Next.js: PASS. Testy runnera odbiorowego 10/10: PASS.
- Wcześniejszy test 18020–18030: 8 poprawnych pełnych przebiegów, 1253 odczytane polisy i 118 w pobranych, porównanych XLSX. Trzy pozostałe wiersze są opisane osobno, nie zaliczone jako eksporty.
- Osobna rzeczywista próba **18025 po zmianie: PASS**. Produkcyjny procesor i adapter zwróciły `skipped / payer_data_required`; run ma `COMPENSA_PAYER_DATA_SKIPPED`. Kontrola DB: jedno rozpoczęcie, zero draftów, intencji zapisu, zapisów i UFG, brak snapshotu oraz otwartej interwencji. Poprzednia próba zachowana. Po zakończeniu brak aktywnego workera i oczekujących dispatchy. Dowody: `exports/acceptance-18025-skip-policy-20261017/report.json` i `verification.json`.
- Rzeczywisty panel nowego runa: HTTP 200, nagłówek „Wiersz 18025: Pominięto”, polski opis przyczyny, zero błędów JavaScript. Osobno potwierdzono właściwy import w UI i odpowiedzi API. Dowód `ui-verification.json` i prywatne zrzuty w katalogu nowej próby.
- Przebudowano obrazy API, workera i web; odtworzono także parser korzystający z obrazu API. Cztery usługi `healthy`, API 3001 i UI 3000 odpowiadają HTTP 200. Hash formularza i procesora w uruchomionym kontenerze jest zgodny z kodem sprawdzonym w próbie live. Główny worker zachowuje portale wyłączone; nie włączano dodatkowych zadań. Dowód `deployment-verification.json`.
- Przywrócono panel kampanii 18020–18030 na 3100 bez uruchamiania workera portalowego i bez zmiany historycznego raportu. Playwright: HTTP 200, właściwy import, wszystkie 11 wierszy, zero błędów JavaScript. Nowy wynik pominięcia 18025 jest osobnym runem dostępnym w tym samym panelu.

## Kryterium odbioru

Uzgodniony przebieg nadaje się do odbioru użytkownika: nowa polityka pomijania 18025 została potwierdzona również na rzeczywistym portalu. Nie ma potrzeby powtarzać całych jedenastu wierszy tylko w celu sprawdzenia zmiany dialogu; przejście do następnego zadania pokrywa E2E.

Pozostaje niepotwierdzone automatyczne odzyskanie **niezapisanego formularza Compensy po zamknięciu sesji** na podstawie jego numeru. Poprzednich formularzy 18012/18014 nie znaleziono w listach ofert, a użytkownik zaakceptował osobne nowe próby. Nie traktować tych nowych prób jako zaliczenia odzyskiwania. Przed deklaracją pełnej pracy bez nadzoru należy sprawdzić ten wariant lub przyjąć ręczny przegląd takich przerwań.

Historia: [18010–18020](TEST_FLOW_18010_18020_2026-10-17.md), [18020–18030](TEST_FLOW_18020_18030_2026-10-17.md). Dowody portalowe i dane klientów pozostają wyłącznie w ignorowanych katalogach `exports`.
