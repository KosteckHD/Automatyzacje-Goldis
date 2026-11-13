# P06 — zadania, komunikacja Node/Python i odporność na awarie

Zależności: kontrakty P01, struktury P02, operacje P03–P05. Efekt: asynchroniczny przebieg dla użytkownika, z jednym trwałym właścicielem stanu i kontrolowanym zatwierdzeniem wyniku.

## 1. Wybrany model

BullMQ obsługuje nowy dispatcher Node. Python jest prywatną usługą obliczeniową, nie drugim systemem kolejkowania. PostgreSQL przechowuje prawdę o zadaniu. Nie uruchamiamy Celery ani własnego konsumenta wewnętrznego protokołu Redis BullMQ w Pythonie.

Publiczne `POST /runs` zwraca `202` z ID analizy po trwałym zapisaniu zlecenia. Dispatcher wykonuje wewnętrzne HTTP do Pythona i oczekuje na odpowiedź poza żądaniem przeglądarki. Użytkownik obserwuje postęp przez API Goldis.

Operacje: parsowanie pliku, walidacja/import słownika, porównanie i eksport. Każda ma własne wejście i limit. Dla małego VPS startujemy z jednym równoczesnym obliczeniem, bez zakładania z góry wydajności na większych danych.

## 2. Proponowane elementy

```text
apps/api/src/features/commissions/
  commission-dispatch.repository.ts
  commission-job.runner.ts
  commission-engine.client.ts
  commission-result-finalization.service.ts
apps/api/src/processes/commissions/main.ts
services/commission-engine/src/goldis_commissions/transport/
  app.py
  auth.py
  schemas.py
  process_supervisor.py
  task_executor.py
```

Python korzysta z FastAPI jako warstwy transportowej i ze stałego modułu wykonawczego w procesie potomnym. Nie wykonuje poleceń powłoki z parametrów użytkownika ani nie uruchamia kodu odczytanego ze skoroszytu.

## 3. Kontrakt prywatny

Proponowane endpointy dostępne wyłącznie w wewnętrznej sieci:

| Endpoint | Wejście / wyjście |
| --- | --- |
| `POST /internal/v1/parse` | Ograniczony plik i manifest; znormalizowane rekordy, problemy i pochodzenie. |
| `POST /internal/v1/dictionary/validate` | Dokument lub wpisy wersji roboczej; wartości/statusy i różnice strukturalne. |
| `POST /internal/v1/compare` | Znormalizowany snapshot i przypięte wersje; wyniki oraz liczniki. |
| `POST /internal/v1/export` | Zatwierdzony snapshot wyniku; ograniczony strumień XLSX. |
| `POST /internal/v1/executions/:id/cancel` | ID wykonania i token próby; zakończenie właściwego procesu. |
| `GET /health/live`, `GET /health/ready` | Stan procesu, obsługiwana wersja kontraktu i silnika; bez danych biznesowych. |

Każda operacja otrzymuje identyfikatory żądania i wykonania, token próby, hashe danych, wersję schematu/silnika oraz deadline. Sekret usługi jest podawany przez mechanizm secrets, nie URL ani dane użytkownika. Do nagłówków/logów nie trafiają rekordy klienta.

Wynik JSON może być strumieniowany jako wersjonowane komunikaty: postęp, rekord, zakończenie. Zakończenie zawiera liczniki i hash całości. Brak komunikatu końcowego oznacza niepełną odpowiedź, nie sukces. Dla eksportu Node odbiera plik z limitem rozmiaru i weryfikuje kompletność przed publikacją.

## 4. Trwałe przyjęcie i przekazanie do kolejki

1. API sprawdza sesję, grant, zakres tenant i gotowość importów.
2. Zapisuje analizę, przypięte wersje i trwałe zlecenie w jednej transakcji z audytem.
3. Publisher umieszcza w BullMQ deterministyczny identyfikator zlecenia. Awaria między zapisem DB a Redis jest naprawiana przez odczyt nieopublikowanych zleceń.
4. Powtórne żądanie z tym samym idempotency key zwraca istniejącą operację, o ile treść jest identyczna. Inna treść z tym samym kluczem daje konflikt.
5. Payload kolejki zawiera ID, nie pliki, klientów, stawki ani hasła.

Wykorzystać istniejący wzorzec trwałego outboxu i kontroli wykonania Goldis; nie tworzyć drugiego źródła prawdy o zakończeniu analizy.

## 5. Wykonanie krok po kroku

1. Dispatcher odbiera job, sprawdza w DB aktualny stan, uprawnienia, usuwanie i dopuszczalność rozpoczęcia.
2. Przydziela nową próbę i token wykonania. Sprawdza dostępność dokładnie przypiętej wersji silnika.
3. Pobiera wyłącznie zasoby z manifestu i odszyfrowuje dane po stronie Node. Python nie dostaje magazynu, keyringu ani poświadczeń DB/Redis.
4. Wysyła ograniczone żądanie wewnętrzne. Python weryfikuje transport, limity i schemat przed uruchomieniem funkcji domenowej.
5. Nadzorca Pythona uruchamia zaufany moduł w procesie potomnym, z prywatnym katalogiem tymczasowym, limitem czasu i pamięci oraz możliwością zakończenia grupy procesów.
6. Postęp zapisuje etapy i rzeczywiście przetworzone rekordy. Jeżeli mianownik nie jest znany, nie przedstawiać wymyślonego procentu ukończenia.
7. Dispatcher waliduje każdą odpowiedź: schemat, pliki/wiersze z manifestu, jednostki, limit rekordów, hashe i zgodność liczników. Duże wyniki zapisuje do stagingu oznaczonego próbą, bez udostępnienia w UI.
8. Po pełnym zakończeniu sprawdza aktualny token, stan anulowania/usuwania, zgodność snapshotu i uprawnienia.
9. Publikuje wynik i audyt atomowo. Dopiero potem job staje się zakończony. Powtórna dostawa nie tworzy drugiego opublikowanego wyniku.

Nie utrzymywać długiej transakcji DB przez czas HTTP i obliczeń. W stagingu nie może być publicznie widocznego, częściowego wyniku.

## 6. Stany i przyczyny

Analiza: `queued`, `running`, `completed`, `completed_with_findings`, `failed`, `cancel_requested`, `cancelled`. Postęp obliczeń jest osobnym polem, np. parsowanie, dopasowanie, ocena, zapis.

Brak prowizji lub nierozpoznany kod prowadzi do wyniku biznesowego, nie do `failed`. Błąd usługi, uszkodzony transport lub przekroczenie twardego limitu procesu jest problemem technicznym. Kod błędu musi wskazywać, czy możliwe jest automatyczne ponowienie.

## 7. Restart, retry i anulowanie

- **Ponowiona dostawa:** sprawdzić token/status. Zakończone zlecenie zwraca istniejący efekt. Wynik starej próby jest odrzucany.
- **Awaria Python:** Node zapisuje kontrolowany błąd i ponawia według limitu/backoff. Niepewny częściowy wynik nie zostaje opublikowany.
- **Awaria Node:** blokada kolejki może wygasnąć i nastąpi kolejna próba. Python nie jest właścicielem trwałego stanu; poprzedni proces ma deadline, a jego wynik nie przejdzie finalizacji z nieaktualnym tokenem.
- **Anulowanie:** najpierw trwale zapisać żądanie, potem przerwać RPC i wysłać cancel do właściwego wykonania. Samo zamknięcie strony w przeglądarce nie anuluje analizy.
- **Utrata połączenia:** Python kończy dziecko po wykryciu przerwania lub deadline. Nie polegać wyłącznie na tym, że klient zamknął HTTP.
- **Usunięty zasób:** blokada publikacji obejmuje również spóźniony wynik i eksport. Porządkowanie stagingu nie odtwarza usuniętych danych.
- **Nowe wdrożenie:** zadanie nie przełącza się po cichu na nowy silnik. Pozwolić dokończyć stare próby, utrzymać zgodną wersję lub jawnie oznaczyć potrzebę nowej analizy.

Na start jedna instancja usługi i jeden proces ASGI nadzorujący proces obliczeń. Przed skalowaniem doprojektować kierowanie cancel do właściwej instancji; mapa procesów w pamięci nie jest współdzielona między workerami HTTP i nie zastępuje trwałej kolejki.

## 8. Limity i role

Dispatcher ma ograniczoną rolę DB/Redis dla prowizji i dostęp do wymaganych artefaktów. Python ma tylko sekret połączenia wewnętrznego. Node nie wykonuje CPU-intensywnego parsowania arkuszy w pętli obsługującej heartbeat. Ustalić limity żądania/odpowiedzi, timeout połączenia i całej operacji, równoległość oraz wielkość stagingu.

BullMQ wymaga odnawiania blokad; przekroczenie czasu lub awaria może skutkować ponowną dostawą. Nie jest to gwarancja wykonania dokładnie jeden raz — zob. [dokumentacja workerów](https://docs.bullmq.io/guide/workers).

## 9. Testy i kryteria zakończenia

Przerwać osobno Node, Python i proces dziecka; zerwać HTTP; dostarczyć ten sam job dwa razy; opublikować nowy słownik podczas oczekiwania; anulować podczas obliczenia i zapisu; usunąć źródło; cofnąć grant; wysłać odpowiedź ze złym tokenem lub brakującym zakończeniem.

Odbiór wymaga: najwyżej jednego zatwierdzonego wyniku, braku częściowych danych w UI, odtwarzalnego snapshotu, ograniczonego retry i braku osieroconych procesów. Stan zadania pozostaje prawdziwy po restarcie całego stosu VPS.
