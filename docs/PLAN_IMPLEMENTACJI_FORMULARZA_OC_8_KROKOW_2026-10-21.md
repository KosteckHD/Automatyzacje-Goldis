# Plan implementacji formularza automatyzacji OC — 8 kroków

Data: 21.10.2026.
Status: wdrożenie w toku; zakres wykonany i pozostałe bramki opisano w sekcji „Stan realizacji”.
Zakres: formularz `/tools/oc-policy-verification` oraz konieczne kontrakty API i testy.
Podstawa: osiem mockupów z [katalogu projektu](../output/mockups/oc-8-ekranow-2026-10-21/README.md).
Rozpoznanie wykonano na aktualnym katalogu roboczym, obejmującym niezacommitowane zmiany. Przed rozpoczęciem implementacji ponownie sprawdzić stan dotykanych plików i zachować istniejące zmiany.

## Stan realizacji — 21.10.2026

| Pakiet | Stan | Wykonane / pozostałe |
| --- | --- | --- |
| P0. Kontrakty i wejście | W toku | Rozpoznano bieżące trasy, uprawnienia i powiązania import → submission/execution → resultSet. Dodano kontrakty wyszukiwania, sterowania zgłoszeniem i odczytu/eksportu resultSet. UI odrzuca sprzeczne połączenia import/run/submission/resultSet przed pokazaniem wierszy lub sterowania. Przed końcowym odbiorem pozostała pełna macierz zachowań dla ról i przypadków granicznych. |
| P1. Wspólny stan | Częściowo | URL przechowuje krok, import i identyfikatory operacji; sprawdzane jest powiązanie ich z tym samym batch. Gotowość przygotowania oraz launcher pozostają dostępne przy przełączaniu panelu. Nie wykonano pełnego wydzielenia dużego `workspace.tsx` na osobne ekrany i hooki. |
| P2. Shell i nawigacja | Zrobione | Osiem ekranów, jeden panel, osadzona nawigacja i stopka, responsywny wybór kroku na mobile, Back/Forward oraz odczyt kontekstu po reloadzie. Zrzuty i syntetyczny test UI są w `output/acceptance/oc-8-screens-2026-10-21/`. |
| P3. Import i przygotowanie | Częściowo | Kroki 1–4 używają istniejących kontraktów importu, serwera wyszukiwania wierszy, enrichmentu i przygotowania. Izolowany PostgreSQL potwierdził import/preparation, prepared set, izolację tenantów, wyścig korekty i rollback audytu; nadal nie wykonano pełnego przebiegu z portalami ani pełnej macierzy rewizji i konfliktów. |
| P4. Wybór i start | Częściowo | Kroki 5–6 rozdzielają wybór, preview i jawne potwierdzenie; zachowują zakres/listę, cały zestaw, CSRF i idempotency key. Syntetyczny smoke sprawdza interakcje; pełna macierz granic 1/500, konfliktów wersji i cofnięcia grantów pozostaje do odbioru. |
| P5. Przebieg i sterowanie | Częściowo | Dodano pause/resume zgłoszenia dla zakresu/listy oraz statusy i pauzę/wznowienie wykonania całego zestawu; przyjęte runy kontynuują pracę zgodnie z bezpieczną granicą. Test modułu submission obejmuje trasy, CSRF i wersje; UI smoke potwierdza wznowienie kontekstu po reloadzie. Izolowany PostgreSQL zaliczył scenariusze przyjęcia, pauzy, wznowienia, anulowania i ochrony przed replayem dla zgłoszeń oraz wykonań całego zestawu. |
| P6. Wyniki i eksport | Częściowo | Dodano scoped summary, filtrowane wiersze i Excel z utrwalonych snapshotów; eksport sprawdza integralność, datę ochrony i neutralizuje tekst formuł. Bezpośredni `resultSetId` otwiera teraz krok 8; dashboard i powiadomienie „wynik gotowy” kierują do niego, a osobna pula wyników leadów pozostaje dostępna. Testy jednostkowe i izolowany PostgreSQL potwierdziły zakres resultSetów, filtry/agregaty, izolację tenantów oraz egzekwowanie jawnego grantu pobierania. |
| P7. Odbiór i przełączenie | Częściowo | Build, syntetyczny UI smoke i zrzuty ośmiu ekranów przechodzą; smoke potwierdza bezpośrednie wejście do wyników, odrzucenie sprzecznych kontekstów, `?view=legacy` i serwerową flagę rollbacku. Testy UI sprawdzają wejścia z dashboardu, historii importów/runów, `/submissions/:id` i zachowanie starej puli leadów; test modułu powiadomień sprawdza odnośnik „wynik gotowy”. [Raport odbioru](ODBIOR_FORMULARZA_OC_8_KROKOW_2026-10-21.md) zapisuje wyniki. Pozostają pełna macierz odbiorowa z rozdziału 12 i uzgodnione wdrożenie. |

Aktualne dowody i dokładne ograniczenia odbioru: [raport odbioru](ODBIOR_FORMULARZA_OC_8_KROKOW_2026-10-21.md). Tryby `tenant-scope` i `run-control` przeszły na tymczasowym kontenerze PostgreSQL z bazami tworzonymi i usuwanymi przez test. Syntetyczne UI smoke i test DB weryfikują różne warstwy; produkcyjny przebieg portali pozostaje poza tym odbiorem.

## 1. Wynik wdrożenia

Zastąpić obecny długi widok i trzyetapowy wskaźnik formularzem zawierającym osiem równorzędnych pozycji nawigacji oraz jeden otwarty panel roboczy:

1. Plik Excel.
2. Kontrola danych.
3. Uzupełnianie REGON.
4. Deduplikacja.
5. Wybór wierszy.
6. Podsumowanie i start.
7. Przebieg zadań.
8. Wyniki i eksport.

Użytkownik może wejść do każdego kroku, wracać do poprzednich i obserwować trwające operacje bez utraty kontekstu. Możliwość przeglądania kroku jest niezależna od prawa i gotowości do wykonania jego operacji.

Wdrożenie obejmuje prawdziwe dane i działające akcje wszystkich ośmiu ekranów. Samo ukrycie części obecnej strony oraz dodanie ośmiu etykiet nie spełnia celu.

## 2. Ustalenia projektowe

- Zachować czarno-złotą identyfikację Goldis, istniejące logo, lokalne fonty Newsreader/Hanken Grotesk i tokeny z `apps/web/app/styles/tokens.css`.
- Zachować globalny sidebar platformy. Obok panelu roboczego dodać osobną nawigację po ośmiu krokach; nie budować drugiego globalnego menu.
- Nagłówek „Weryfikacja OC”, kontekst importu oraz nawigacja pozostają wspólne. Zmienia się treść jednego panelu.
- Wybrany krok i stan jego operacji to dwie odrębne informacje. Wyświetlenie kroku 8 nie oznacza ukończenia kroków 1–7.
- Numery, nazwy firm, daty, liczniki i gotowość usług na mockupach są przykładowe. W aplikacji zastąpić je wartościami API; usunąć etykietę koncepcji.
- Zachować funkcje dostępne obecnie: historię rewizji, korekty i konflikty, uruchamianie pojedynczego wiersza, całego importu, zakresu i listy, SMS, interwencje oraz sterowanie zadaniami.
- Osiem ekranów jest podziałem interfejsu. Nie rozdzielać na siłę istniejących operacji backendowych, które wspólnie analizują i deduplikują import.
- Każde „Dalej”, poza jawnym importem w kroku 1 i potwierdzeniem startu w kroku 6, służy do nawigacji. Nie uruchamia lookupu, analizy ani portali.

## 3. Aktualna implementacja i konsekwencje

| Obszar | Stan znaleziony w kodzie | Konsekwencja dla prac |
| --- | --- | --- |
| Punkt wejścia | `apps/web/app/tools/oc-policy-verification/page.tsx` renderuje `Workspace`. | Nową funkcję osadzić na tej samej trasie. |
| Formularz | `apps/web/app/workspace.tsx` łączy sesję, import, listę wierszy, interwencje, runy, SMS i wynik. | Wydzielić koordynator i widoki bez naruszania wejścia katalogu oraz logowania. |
| Wskaźnik postępu | `apps/web/components/tools/RunStepper.tsx` ma trzy stałe pozycje i typ `1 | 2 | 3`. | Dla nowego formularza zastąpić go nawigacją; nie rozszerzać samej liczby markerów. |
| Shell | `PlatformRouteFrame` i `LeadSidebar` już opakowują trasę; stary shell jest częściowo ukrywany przez CSS. | Nowy formularz używa istniejącej ramy bez duplikowania sidebaru/topbara i bez zależności od ukrywania starej struktury. |
| Przygotowanie | `import-preparation-panel.tsx` pobiera rewizje, workflow, wiersze i oblicza `runReady`; przekazuje gotowość callbackiem. | Odczyt gotowości przenieść ponad przełączane ekrany. Odmontowanie kroku 4 nie może blokować startu. |
| REGON i korekty | `enrichment-review.tsx` łączy zadania rejestru, tabelę wzbogacania i propozycje korekt. | Wydzielić części dla kroków 2–3, zachowując istniejącą weryfikację uprawnień i wersji. |
| Start | `run-submission-launcher.tsx` łączy wybór, preview, potwierdzenie, wykonanie całego importu i polling. | Rozdzielić jego odpowiedzialności między kroki 5, 6 i 7. |
| Zgłoszenia | Start zakresu/listy przekierowuje do `/submissions/:id`; istnieje osobny widok zgłoszenia. | W nowym formularzu po przyjęciu zadania przejść do kroku 7 z zapisanym ID. Zachować samodzielną trasę zgłoszenia i stare linki. |
| Pauza całego importu | Launcher wywołuje `.../prepared-set-executions/:id/pause` i `resume`. Serwis ma metody pause/resume, ale kontroler nie wystawia tych tras. | Podłączyć istniejące metody i sprawdzić rzeczywisty kontrakt HTTP; sam test UI z atrapą nie wykrywa tej luki. |
| Wyniki | Istnieją artefakty pojedynczego runu oraz lista leadów z filtrem `resultSetId`. `GET /api/leads/export` nie przyjmuje filtra partii. | Zapewnić odczyt i eksport dokładnie bieżącego uruchomienia; nie podstawiać globalnego eksportu leadów. |
| Wiersze importu | Lista obsługuje stronę i filtry all/ready/review, ale nie pole wyszukiwania z mockupu. | Rozszerzyć filtrowanie po stronie serwera i zapewnić pełne liczniki. |
| Korekty | Istniejący kontrakt propozycji w imporcie dotyczy REGON-u. | Nie podłączać przycisku naprawy NIP-u do korekty REGON-u. Rozdzielić obsługiwane korekty od informacji o poprawie pliku i ponownym imporcie. |

## 4. Architektura docelowa

### 4.1. Organizacja frontendu

Proponowany podział, bez dodawania nowej biblioteki zarządzania stanem:

| Element | Odpowiedzialność |
| --- | --- |
| `OcAutomationWorkspace` | Koordynacja importu, wybranego kroku, uruchomienia i uprawnień. |
| `OcWorkspaceProvider` / hooki funkcji | Stan wspólny i serwerowe odczyty, pozostające aktywne po zmianie ekranu. |
| `OcStepNavigation` | Osiem linków, statusy, aktualny krok i komunikaty o brakach. |
| `OcImportContext` | Nazwa pliku, metadane importu i jawna zmiana pliku. |
| `OcStepFooter` | Nazwane akcje „Wstecz”/„Dalej” i odróżnienie nawigacji od wykonania operacji. |
| `UploadStep`, `ValidationStep`, `RegistryStep`, `DeduplicationStep` | Ekrany 1–4. |
| `SelectionStep`, `LaunchStep`, `ProgressStep`, `ResultsStep` | Ekrany 5–8. |
| Współdzielone panele | Dialog SMS, historia rewizji, korekty, lista interwencji, szczegóły runu. |

Nowe elementy umieścić w obrębie funkcji OC, np. `apps/web/app/tools/oc-policy-verification/_components` i `_lib`. To propozycje nazw, a nie pliki już istniejące.

Główna treść montuje jeden ekran. Koordynator i stan operacji nie należą do pojedynczego ekranu. Nie utrzymywać ośmiu pełnych tabel ukrytych CSS-em. Nie przenosić całego `workspace.tsx` do jednego nowego komponentu pod inną nazwą.

### 4.2. Podział stanu

| Rodzaj | Przykłady | Zasada |
| --- | --- | --- |
| Nawigacja | Krok, importId, submissionId/executionId, wybrany run. | Identyfikatory w URL, a relacje i uprawnienia weryfikowane na serwerze. |
| Trwałe dane domenowe | Import, rowVersion, przygotowania, workflow, zadania, snapshoty i artefakty. | Źródłem prawdy jest API. Odświeżenie nie może tworzyć nowej operacji. |
| Robocze ustawienia UI | Tryb wyboru, zakres, lista numerów, filtry, strona tabeli, rozwinięte szczegóły. | Zachować przy zmianie kroku; powiązać z użytkownikiem i importem. |
| Potwierdzenie startu | Checkbox, fingerprint podglądu, klucz idempotencji. | Reset po zmianie wyboru, wersji danych lub uprawnień; klucz zachować do wyjaśnienia niepewnego wyniku żądania. |
| Wrażliwe/ulotne dane | Kod SMS, niezapisany File, dane sesji. | Nie zapisywać kodu w URL/storage; po reloadzie przed importem poprosić o ponowny wybór pliku. |

Opcjonalne zapamiętanie niesensytywnych ustawień formularza w sessionStorage nie zastępuje danych serwerowych. Nie przechowywać tam pełnych rekordów firm, tokenów ani kodów SMS.

### 4.3. URL i powrót do pracy

Przykładowy adres docelowy:

`/tools/oc-policy-verification?import=<uuid>&step=regon`

Dla pracy na uruchomieniu dołączyć jednoznaczny kontekst `submission=<uuid>` albo `execution=<uuid>`. Nazwy kroków w URL: `upload`, `validation`, `regon`, `deduplication`, `selection`, `launch`, `progress`, `results`.

- Linki kroków obsługują Wstecz/Dalej przeglądarki i odświeżenie.
- Nieprawidłowy step normalizować do poprawnego ekranu, bez tworzenia danych.
- Otwarty krok bez wymaganego importu pokazuje stan pusty i link do kroku 1.
- Brak jawnego step: przy nowej pracy krok 1; dla importu właściwy krok według odczytanego stanu; dla linku z runem krok 7.
- Zachować obsługę dotychczasowych parametrów `import` i `run`, w tym wejść z historii i powiadomień.
- Kotwice starego formularza mapować świadomie: workspace-import → 1, workspace-runs/run-detail → 7, workspace-result → 2, ponieważ stara sekcja result zawiera podgląd importu.
- Przy sprzecznych identyfikatorach odrzucić niewłaściwe powiązanie; nie łączyć importu A z uruchomieniem B.
- Po wylogowaniu, usunięciu zasobu lub utracie prawa odczytu wyczyścić widoczne dane i odpowiednio zakończyć polling.

### 4.4. Statusy i unieważnianie danych

Model widoku kroku powinien oddzielać co najmniej: wybrany, do wykonania, w toku, gotowy, wymaga uwagi, błąd, nieaktualny oraz brak kontekstu. To statusy prezentacyjne, wyliczane z istniejących statusów domenowych.

- Import przetworzony z błędami wierszy może pozwalać na dalszą pracę z poprawnymi rekordami.
- Brak kilku REGON-ów nie blokuje automatycznie całej pozostałej partii, jeżeli kontrakt przygotowania dopuszcza pominięcia.
- Wynik lookupu lub zatwierdzona korekta unieważnia dotychczasową gotowość przygotowania i preview; wymaga aktualnego zestawu roboczego.
- Zmiana zakresu/listy unieważnia preview i potwierdzenie startu.
- Zmiana pliku tworzy nowy kontekst importu, nie nadpisuje poprzedniego i nie anuluje jego trwających operacji.
- Zakończone i przyjęte wcześniej zadania pozostają powiązane ze swoim snapshotem. Nowa korekta nie przepisuje ich historii.
- Zmiana ekranów nie kasuje wyboru, przygotowania ani historii operacji.
- Żaden status „Gotowe” nie wynika tylko z tego, że jego numer jest mniejszy niż numer wybranego kroku.

## 5. Zakres każdego ekranu

| Krok i wzorzec | Implementacja i dane | Kryterium odbioru |
| --- | --- | --- |
| 1. [Plik Excel](../output/mockups/oc-8-ekranow-2026-10-21/01-plik-excel.png) | Dropzone, wybór/usunięcie pliku przed wysłaniem, wymagania, stan wysyłania, błędy API. Korzystać z istniejącego POST /api/imports. Po sukcesie zapisać import w URL i przejść do kontroli. Odczyt nazw arkusza/rozmiaru pokazać tylko wtedy, gdy są rzeczywiście znane. | Jedna jawna akcja tworzy import; wyjście i powrót nie wysyła pliku ponownie. Błędny plik nie gubi formularza. |
| 2. [Kontrola danych](../output/mockups/oc-8-ekranow-2026-10-21/02-kontrola-danych.png) | Podgląd importu, problemy, wyszukiwanie, filtry i paginacja serwerowa. Jawne rozpoczęcie kontroli może używać istniejącej pełnej analizy przygotowania. Pokazać obsługiwane korekty REGON-u i linki do przeglądu konfliktów. Dla nieobsługiwanego pola, np. NIP-u, podać poprawę Excela i nowy import zamiast pozornego formularza korekty. | Problem wiersza i jego aktualna wersja są prawdziwe; tabela i liczniki uwzględniają cały import. Rozpoczęcie kontroli nie kontaktuje portali. |
| 3. [Uzupełnianie REGON](../output/mockups/oc-8-ekranow-2026-10-21/03-uzupelnianie-regon.png) | Zadanie rejestru dla zakresu lub pojedynczego wiersza; historia, anulowanie i status. Wykorzystać enrichment-jobs. Automatyczny workflow lookup + ponowna analiza zachować jako osobną, jasno nazwaną akcję, zależną od przygotowania. | Rozpoczęta operacja jest widoczna po wyjściu i powrocie. Gdy rejestr jest niedostępny, UI pokazuje rzeczywisty stan, bez fikcyjnego sukcesu. |
| 4. [Deduplikacja](../output/mockups/oc-8-ekranow-2026-10-21/04-deduplikacja.png) | Lista rewizji, przeliczenie zestawu, reprezentant duplikatu, powody pominięcia, eksport przygotowania. Wykorzystać preparations i ich rows/export. Jeśli aktualna analiza z kroku 2 już wystarcza, pokazać jej wynik bez tworzenia kopii. | Gotowość pochodzi z aktualnej zamkniętej rewizji; oryginalne wiersze pozostają zachowane. Powrót do innego kroku nie zmienia gotowości. |
| 5. [Wybór wierszy](../output/mockups/oc-8-ekranow-2026-10-21/05-wybor-wierszy.png) | Cały import, zakres lub lista, w tym pojedynczy wiersz. Dla zakresu/listy zachować limit 500 z DTO; cały import używa wykonania zestawu i paczkowania. Jawna akcja pobiera preview. | Zmiana wyboru resetuje podgląd i potwierdzenie. Zakres większy niż 500 nie jest po cichu obcinany ani automatycznie uruchamiany w innym trybie. |
| 6. [Podsumowanie i start](../output/mockups/oc-8-ekranow-2026-10-21/06-podsumowanie-start.png) | Podgląd z kroku 5: wersja/fingerprint, data odniesienia z API, rzeczywiste liczniki, pominięcia, health, checkbox oraz jeden przycisk startu. Osobne istniejące kontrakty dla run-submission i prepared-set-execution. | Dopiero potwierdzenie tworzy zadania. Podwójne kliknięcie i ponowienie tego samego żądania nie tworzy duplikatów; nieaktualny podgląd wymaga ponownego sprawdzenia. |
| 7. [Przebieg zadań](../output/mockups/oc-8-ekranow-2026-10-21/07-przebieg-zadan.png) | Postęp konkretnego wykonania/zgłoszenia, lista zadań, interwencje, dialog SMS, błędy, pauza/wznowienie/anulowanie. Ponownie wykorzystać działającą obsługę runów i SMS. Odróżnić pauzę całego wykonania od pauzy zaznaczonego runu. | Akcje obejmują dokładnie wskazany zakres. Przejście do wyników nie zatrzymuje procesu. Dane innego importu ani dawnego uruchomienia nie trafiają do liczników. |
| 8. [Wyniki i eksport](../output/mockups/oc-8-ekranow-2026-10-21/08-wyniki-eksport.png) | Wyniki bieżącego resultSet/wykonania, filtry, wyszukiwanie, paginacja, wynik pojedynczego runu i zbiorczy Excel. Obsłużyć stan częściowy, brak polis, błąd i brak prawa pobierania. | Eksport i tabela dotyczą tej samej partii oraz daty. Brak pasujących polis nie jest błędem. Wynik częściowy ma wyraźne oznaczenie i nie udaje ukończonego raportu. |

### Ważne doprecyzowania względem obrazów

1. Przycisk „Zaproponuj korektę” musi odpowiadać polu rzeczywiście obsługiwanemu przez kontrakt. Ten plan nie zakłada dodania ogólnego edytora wszystkich danych firmy.
2. Pauza całego prepared-set-execution kończy się na bezpiecznej granicy porcji zgodnie z istniejącym serwisem; etykieta ma to mówić. Pauza pojedynczego runu dotyczy bezpiecznej akcji portalu. Nie obiecywać natychmiastowego zatrzymania.
3. Przy zakresie/liście potrzebne jest sterowanie całym zgłoszeniem, jeśli przycisk dotyczy całej partii. Samo zatrzymanie jednego runu nie spełnia tego działania.
4. Liczba wierszy, unikalnych firm, grup i runów nie zawsze jest równa. Używać właściwej jednostki w każdej etykiecie.
5. Data odniesienia pochodzi z utrwalonego podglądu/uruchomienia, a czas zdarzeń prezentować w Europe/Warsaw. Nie przeliczać starych wyników na aktualną datę przy każdym wejściu.
6. Health portali nie blokuje samego importu, korekt i odczytu wyników. W kroku startu rozróżnić gotowość do wykonania od dopuszczonego przez backend oczekiwania w kolejce.

## 6. API: ponowne użycie i wymagane uzupełnienia

Adresy poniżej obejmują prefiks /api używany przez frontend.

### 6.1. Istniejące kontrakty do ponownego użycia

| Funkcja | Kontrakty |
| --- | --- |
| Import i odczyt | POST /api/imports; GET /api/imports/:id; GET /api/imports/:id/rows; GET /api/imports/:id/enrichment. |
| Rejestr | POST/GET /api/imports/:id/enrichment-jobs; GET /api/enrichment-jobs/:id i /items; POST /cancel. |
| Przygotowanie | POST/GET /api/imports/:id/preparations; GET konkretnej rewizji, jej /rows i /export; POST /cancel. |
| Workflow | POST /api/imports/:id/preparations/:preparationId/workflow; GET preparation-workflows; POST /cancel dla workflow. |
| Zakres/lista | POST /api/imports/:id/run-submissions/preview; POST /api/imports/:id/run-submissions; GET /api/run-submissions/:id i /items; POST /cancel. |
| Cały import | GET /api/imports/:id/prepared-set-executions/preview; POST prepared-set-executions; GET konkretnego wykonania; POST /cancel. |
| Pojedynczy run | GET /api/runs/:id; istniejące pause/resume/cancel/resume-auth/resume-review; GET /artifact. |
| Interwencje i sesja | Istniejące auth/me, auth-challenges, interventions oraz hook useAutomationHealth. |
| Wyniki firm | GET /api/leads z resultSetId; istniejące odczyty historii i snapshotów, po sprawdzeniu zgodności zakresu oraz kompletności wyników bez polis. |

Nie odtwarzać domenowych operacji w React. Korekty, zamykanie rewizji, walidacja fingerprintu, autoryzacja i idempotencja pozostają po stronie API.

### 6.2. Pakiet kontraktów wymaganych do pełnej wersji

| Zadanie | Zakres |
| --- | --- |
| A. Kontekst i wznowienie | Zapewnić odczyt aktualnego przygotowania, jego świeżości i dostępnych uruchomień importu. Rozszerzyć istniejące odpowiedzi lub dodać małą projekcję odczytową, np. GET /api/imports/:id/oc-context. Pozwolić wskazać wcześniejsze uruchomienie. Nie dodawać nowej maszyny workflow do przechowywania samego numeru kroku. |
| B. Problemy importu | Rozszerzyć serwerowy odczyt wierszy o search/issue, pełne liczniki oraz metadane paginacji. Zachować zgodność obecnych klientów, np. przez opt-in nowego formatu odpowiedzi. Nie zmieniać tablicy na obiekt bez aktualizacji konsumentów. |
| C. Metadane startu | Odpowiedzi preview/start/get muszą udostępniać stabilne resultSetId i informacje potrzebne do powrotu. Wykonanie całego zestawu już zwraca resultSetId; sprawdzić i ujednolicić ścieżkę zakresu/listy. |
| D. Pauza wykonania | Wystawić brakujące POST .../prepared-set-executions/:executionId/pause i /resume, podłączając istniejące metody serwisu, expectedVersion, CSRF, uprawnienia i audyt. |
| E. Pauza zgłoszenia | Zweryfikować i uzupełnić sterowanie submission dla zakresu/listy: POST /api/run-submissions/:id/pause i /resume to proponowane trasy. Wstrzymać dalsze przyjmowanie prac tego zgłoszenia, obsłużyć przyjęte runy zgodnie z regułą bezpiecznej pauzy i trwałe wznowienie. Nie realizować pauzy tylko blokadą przycisku albo globalnym wyłączeniem wszystkich importów. |
| F. Postęp i wyniki | Zapewnić serwerowe agregaty postępu i wyników dla resultSetId, także wyników częściowych i firm bez polis. Rozszerzyć istniejące odczyty albo dodać projekcję GET /api/result-sets/:id/summary oraz /rows. Podane nazwy są propozycją, do uzgodnienia w pierwszym pakiecie prac. |
| G. Eksport partii | Udostępnić zbiorczy eksport polis dla resultSetId, np. GET /api/result-sets/:id/export. Korzystać z utrwalonych snapshotów i istniejących mechanizmów eksportu, nie z odczytu live portali ani globalnego arkusza CRM. |

A–G opisują wymagane zachowania. Konkretne nowe nazwy tras należy zatwierdzić w kontraktach implementacyjnych; rozszerzenie istniejącej odpowiedzi jest preferowane, gdy daje to samo bez mnożenia endpointów.

Zbiorczy Excel powinien zawierać rozliczenie firm i arkusz polis z identyfikacją firmy, runu i daty odniesienia. Zestaw pominiętych wierszy jest dostępny w raporcie przygotowania. Dla częściowego eksportu utrwalić/podać moment odcięcia i stan partii. Nie pobierać naraz wszystkich plików runów z przeglądarki.

Każdy odczyt i eksport jest ograniczony uprawnieniami oraz właściwą organizacją/zasobem przed liczeniem i paginacją. Wspólny widok nie może ujawniać interwencji innych partii tylko dlatego, że ma do nich dostęp na globalnej liście.

## 7. Odświeżanie, błędy i ochrona przed powtórzeniami

- Odczyty lekkiego kontekstu i trwających operacji działają nad przełączanymi ekranami. Szczegółowe tabele pobierać dla aktualnego ekranu.
- Utrzymać jeden polling na dany zasób; anulować stare żądania i odrzucać spóźnione odpowiedzi po zmianie importu lub uruchomienia.
- Zakończyć szybkie odpytywanie dla stanów terminalnych. Przy ukrytej karcie ograniczyć ruch; po powrocie lub odzyskaniu sieci odświeżyć stan.
- Rozróżnić błąd odświeżania i stan operacji. Brak sieci nie oznacza niepowodzenia zadania na serwerze.
- Utrata odpowiedzi po POST startu oznacza „sprawdzam, czy przyjęto”, a nie automatyczne wysłanie nowego startu z nowym UUID. Wyjaśnić wynik przez ponowienie z tym samym kluczem lub odczyt przyjętej operacji.
- Po zmianie wersji/fingerprintu zablokować stary start i wskazać ponowny podgląd. Dla działania z expectedVersion odświeżyć zasób po konflikcie.
- Kod SMS pozostaje związany z konkretnym runem/challenge. Zachować istniejące limity, wygaśnięcie, niepewną dostawę, zasady ponowienia i uprawnienia; zmiana ekranu nie wysyła ponownie kodu.
- Ekrany obsługują loading, pustą listę, brak danych wejściowych, częściowy wynik, brak dostępu, usunięty zasób, błąd sieci i konflikt wersji.
- Zmiana kroku nie zeruje aktywnego procesu i nie zamyka jego zgłoszeń.

## 8. Układ i dostępność

- Desktop: obecny sidebar platformy + nawigacja kroków + jeden panel, zgodnie z mockupami. Przy zwiniętym globalnym sidebarze panel wykorzystuje wolne miejsce.
- Tablet: zmniejszyć drugą kolumnę, a gdy panel staje się za wąski, przejść na układ jednokolumnowy.
- Mobile: nad panelem przycisk „Krok X z 8 — nazwa” rozwijający wszystkie etapy; nie wymuszać ośmiu zakładek w jednej poziomej linii.
- Nawigacja ma semantykę linków i aria-current=step. Nie udawać widgetu tabs bez pełnej obsługi jego klawiatury.
- Po świadomej zmianie kroku ustawić fokus na nagłówku panelu; nie przejmować fokusu przy odświeżaniu statusów.
- Stany przekazywać tekstem i ikoną, nie tylko kolorem. Zapewnić widoczny fokus, etykiety inputów i przycisków oraz reduced motion.
- Footer może być przyklejony wewnątrz przestrzeni pracy, lecz nie zasłania ostatnich wierszy ani komunikatów; na mobile przyciski mogą układać się pionowo.
- Scroll poziomy dopuszczalny w tabeli, nie w całej stronie.
- Nie kopiować dekoracyjnych artefaktów obrazu ani fikcyjnych kontrolek; korzystać z istniejących fontów, logo i ikon.

## 9. Kolejność prac i bramki odbioru

To pakiety implementacyjne, niezależne od ośmiu kroków formularza. Można realizować je jako osobne, małe PR-y.

| Pakiet | Prace | Warunek zakończenia |
| --- | --- | --- |
| P0. Kontrakty i stan wejściowy | Ponownie przejrzeć zmienione pliki, lokalne AGENTS.md i dokumentację zainstalowanego Next przed kodowaniem. Spisać DTO, możliwości użytkowników, jednostki liczników, relacje batch/submission/execution/resultSet i nowe kontrakty A–G. Przygotować syntetyczne fixture. | Mapa kontraktów i scenariuszy obejmuje wszystkie akcje mockupów, bez otwartych luk maskowanych atrapą. |
| P1. Wspólny stan | Wydzielić odczyty sesji, importu, przygotowania i operacji; odłączyć gotowość od montowania panelu. Zachować istniejący wygląd do czasu podłączenia nowego shellu. | Zmiana/odmontowanie widoku nie usuwa gotowości, zakresu i powiązań; dotychczasowe kontrakty działają. |
| P2. Shell i nawigacja | Wdrożyć wspólne nagłówki, kontekst importu, osiem kroków, routing, footer, responsywność i legacy linki. | Jeden panel, poprawne URL, historia przeglądarki i brak mutacji przy nawigacji. |
| P3. Import i przygotowanie | Podłączyć kroki 1–4, filtrowanie, rejestr, korekty, rewizje, unieważnianie i eksport przygotowania. | Nowy import można przygotować, wzbogacić i przeliczyć; stan pozostaje poprawny po przejściu między krokami. |
| P4. Wybór i start | Podłączyć kroki 5–6 i obie ścieżki startu, limit 500, fingerprint, idempotencję i zmianę uprawnień. | Start tylko po potwierdzeniu aktualnego podglądu; brak podwójnych uruchomień. |
| P5. Przebieg i sterowanie | Wdrożyć kontrakty D–F dla postępu, krok 7, istniejący SMS, interwencje i sterowanie właściwym zakresem. | Pauza i wznowienie działają przez prawdziwe kontrolery API, nie tylko stuby; powrót do uruchomienia działa po reloadzie. |
| P6. Wyniki i eksport | Podłączyć krok 8, serwerowe agregaty, filtry, wynik częściowy i eksport G. | Tabela, liczniki i Excel odnoszą się do tego samego resultSet; uwzględniają brak polis i częściowy przebieg. |
| P7. Odbiór i przełączenie | Zrzuty wszystkich ekranów, testy modułowe i UI, build, aktualizacja instrukcji, przełączenie nowego formularza i kontrola rollbacku. | Spełnione kryteria rozdziału 12, z dowodami testów i bez utraty dawnych wejść. |

Zależności: P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7. Kontrakty postępu, wyników i eksportu opracować już w P0, aby ostatnie ekrany nie stały się atrapami.

## 10. Testy i dowody odbioru

### 10.1. Testy logiki i kontraktów

- Stan kroku jest niezależny od wybranego numeru; wymagane dane i uprawnienia decydują o akcji.
- Zmiana danych/rewizji/zakresu unieważnia właściwe preview i potwierdzenie, zachowując stare snapshoty.
- Reload oraz przejście między krokami odtwarzają powiązania i trwające zadania bez POST.
- Zakres/lista: granice 1 i 500, nieprawidłowe numery, duplikaty, wybór całego dużego importu.
- Podwójny start, ponowienie po timeout, konflikt fingerprintu, cofnięte uprawnienia, niezgodne identyfikatory zasobów.
- Rzeczywiste trasy pause/resume oraz expectedVersion dla wykonania, zgłoszenia i runu.
- Agregaty: wiele stron, duplikaty i współdzielone runy, brak polis, błędy, częściowe wykonanie oraz kilka uruchomień tego samego importu.
- Eksport: zgodny zakres i snapshot, kompletność danych, brak obcych firm, poprawne uprawnienia i zabezpieczenia eksportu pól tekstowych.

### 10.2. Testy interfejsu

Dodać syntetyczny test `oc-workspace-ui-smoke.cjs` albo równoważne scenariusze w obecnym runnerze:

1. Otworzyć każdy z ośmiu ekranów; sprawdzić nazwę, aktywny krok i pojedynczy panel.
2. Przejść 1 → 5 → 2 → 8, użyć Back/Forward i odświeżenia; nie zarejestrować niezamówionych operacji.
3. Ustawić zakres/listę, wyjść i wrócić; zachować ustawienia.
4. Zasymulować lookup w tle i późniejszą nową rewizję; pokazać prawdziwe statusy.
5. Rozdzielić preview w kroku 5 i start w kroku 6; zweryfikować żądanie oraz idempotencję.
6. Otworzyć krok 7 z ID istniejącego uruchomienia i obsłużyć SMS bez zmiany runu.
7. Zmienić batch w czasie trwającego odczytu; spóźniona odpowiedź nie nadpisuje nowego kontekstu.
8. Sprawdzić użytkownika wykonującego, użytkownika z samym odczytem, brak prawa eksportu oraz utratę uprawnień.
9. Sprawdzić stany 401/403/404 lub usunięcia, błąd sieci, pustą listę i częściowy wynik.
10. Sprawdzić klawiaturę, fokus, mobile i brak overflow.

Testy formularza korzystają z syntetycznych odpowiedzi. Testy backendu niezależnie sprawdzają prawdziwe kontrolery i persystencję. Nie uznawać przejścia stubowanego testu UI za dowód działania nieistniejącej trasy.

### 10.3. Istniejące komendy do wykorzystania

Dobierać je do zmienionego zakresu, nie uruchamiać mechanicznie całego zestawu po każdej drobnej zmianie:

- `npm run build -w @goldis/web`.
- Przy zmianie API: `npm run build -w @goldis/api`; przy zmianie kontraktów core najpierw właściwy build zależności.
- `npm run test:module:review`, `npm run test:module:registry-jobs`, `npm run test:module:submission`.
- `npm run test:module:run-control`, `npm run test:module:interventions`, `npm run test:module:results`.
- `npm run test:run-submission-ui-smoke -w @goldis/web`.
- `npm run test:w3-sms-ui-smoke -w @goldis/web`, `npm run test:w4-enrichment-ui-smoke -w @goldis/web`.
- Testy grantów, historii i review w apps/web, jeśli ich komponenty lub wejścia zostały zmienione.
- `npm run test:architecture` oraz sprawdzenie kontraktów backendu, jeśli dotknięto granic modułów.

Zgodnie z obowiązującymi planami repozytorium nie dodawać do tego odbioru pełnego rzeczywistego flow import → rejestr → portale → eksport. Korzystać z modułowych testów i lokalnych fixture; nowe UI nie wymaga wysyłania SMS na realne konto ani pracy na bazie użytkownika.

### 10.4. Odbiór wizualny

- Zrzuty wszystkich ośmiu ekranów przy 1600×1000 lub zbliżonym rozmiarze mockupów.
- Wspólny przegląd przy 320, 768, 1280 i 1920 px: panele, tabela, footer i nawigacja.
- Scenariusze długich nazw, dużych liczników i wielu stron.
- Porównanie układu, typografii, kolorów, zaznaczenia i hierarchii działań z PNG; nie porównywać losowych tekstów i szumu obrazu.
- Jeden zbiorczy przegląd, zbiorcza poprawka znalezionych problemów i końcowe potwierdzenie.

Raport odbioru zapisuje wersję kodu, komendy, wyniki PASS/FAIL/SKIP/BLOCKED i zrzuty. Ten plan nie stwierdza, że opisane testy już wykonano.

## 11. Wdrożenie i wycofanie

1. Przełączać formularz konfiguracją serwera `OC_AUTOMATION_WORKSPACE_ENABLED=1` (nowy, domyślny) lub `0` (stary). Parametr `?view=legacy` pozwala otworzyć stary widok niezależnie od flagi; flaga ma pierwszeństwo przy wyłączaniu nowego formularza.
2. Wdrożyć wymagane, zgodne wstecz kontrakty API przed zależnym frontendem. Jeśli nowe sterowanie wymaga persystencji, przygotować wyłącznie addytywne migracje z numerem ustalonym z aktualnego repozytorium.
3. Odebrać komplet w izolowanym środowisku testowym. Następnie przełączyć formularz dla uzgodnionej grupy kont, a po odbiorze jako domyślny.
4. Nowe UI odczytuje dotychczasowe importy, przygotowania i zadania. Nie wymaga ponownego importowania bazy ani ponownego uruchamiania starych zadań.
5. Przy problemie cofnąć flagę/interfejs do starego widoku. Nie usuwać utworzonych zadań ani nie odwracać migracji z danymi operacyjnymi tylko z powodu rollbacku UI.
6. Sprawdzić po przełączeniu główne wejścia z importów, historii runów, zgłoszeń, powiadomień i wyników.
7. Po stabilnym odbiorze usunąć starą gałąź formularza oraz style tylko po sprawdzeniu wszystkich konsumentów. Zachować trasę katalogu, logowanie i samodzielne szczegóły zgłoszeń.

Zaktualizować `docs/STAN_IMPLEMENTACJI.md`, instrukcję administratora i procedurę release/rollback dopiero z rzeczywistym wynikiem wdrożenia.

## 12. Definicja ukończenia

- [ ] Wszystkie osiem ekranów istnieje i odpowiada uzgodnionym mockupom.
- [ ] Każdy ekran korzysta z prawdziwych danych, a każda widoczna akcja ma działający kontrakt.
- [x] Jest jedna globalna rama platformy i jeden panel roboczy.
- [x] Nawigacja działa swobodnie, bez mutacji, gubienia kontekstu lub przypadkowego uruchamiania operacji.
- [x] URL, odświeżenie i historia przeglądarki odtwarzają kontekst importu i właściwego uruchomienia.
- [x] Gotowość przygotowania nie zależy od tego, który panel jest zamontowany.
- [ ] Korekty i lookup unieważniają odpowiednie przygotowanie/podgląd, zachowując historię.
- [x] Cały import, zakres, lista i pojedynczy wiersz pozostają obsługiwane.
- [x] Start wymaga aktualnego preview i jawnego potwierdzenia; ponowienia są idempotentne.
- [ ] Pauza/wznowienie/anulowanie i SMS działają na właściwym zasobie także przez rzeczywiste API.
- [ ] Wyniki, liczniki i zbiorczy Excel mają ten sam zakres i właściwą datę odniesienia.
- [ ] Użytkownik bez uprawnień nie może wykonać ukrytej/zablokowanej operacji przez bezpośrednie żądanie.
- [x] Zaliczone zostały właściwe testy modułowe, testy UI, build, odbiór responsywności w syntetycznym smoke oraz izolowane testy PostgreSQL w trybach `tenant-scope` i `run-control`.
- [x] Potwierdzono działanie dawnych linków i techniczne wycofanie nowego UI (dashboard, historia importów/runów, `/submissions/:id`, stara pula leadów, `?view=legacy` i flaga serwerowa).
- [x] Raport oraz dokumentacja opisują faktyczny stan, a nie deklarację wykonania planu.

