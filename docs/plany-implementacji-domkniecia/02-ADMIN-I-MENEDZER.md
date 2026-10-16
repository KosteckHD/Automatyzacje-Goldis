# 2. Plan implementacji Admina i Menedżera

Data: 8 października 2026. Obowiązują [wspólne zasady](README.md). Zależność: fundamenty z punktu 1; odpowiada P01 planu nadrzędnego.

## Cel i założenia

Menedżer prowadzi pracę operacyjną całej firmy: import, przygotowanie, korekty, uruchamianie, SMS, interwencje i wyniki. Admin dodatkowo zarządza bezpieczeństwem, kontami i konfiguracją. Dostęp Menedżera nie zależy od tego, kto wgrał plik, lecz od aktualnego członkostwa i grantów narzędzia.

Obecne role `admin/operator/reviewer/auditor` pozostają kompatybilne. Nowa rola `manager` jest wartością domenową, nie aliasem Admina. Nie rozszerzać praw istniejących kont automatycznie. Ograniczenie produktu do jednej firmy nie usuwa tenant scope ani regresji izolacji.

## Mapa kodu

| Obszar | Punkt startowy |
| --- | --- |
| Rola i akcje | [authorization-policy.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/authorization-policy.ts) |
| Guard i scope SQL | [authorization-guard.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/authorization-guard.ts), [resource-scope.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/resource-scope.ts) |
| Granty i sesja | [tool-access.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/tool-access.ts), [session.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/session.ts) |
| Obsługa ról i review | [admin.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/admin.ts), [review-service.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/review-service.ts) |
| Interwencje | [interventions.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/interventions.ts), [manual-data.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/manual-data.ts) |
| Schema/UI | [db.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/db.ts), [admin/page.tsx](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/admin/page.tsx), [workspace.tsx](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/workspace.tsx) |

## Docelowy kontrakt uprawnień

| Działanie | Admin | Menedżer |
| --- | --- | --- |
| Import i przygotowanie | Tak | Aktywny grant operacji narzędzia |
| Podgląd całej firmy | Tak | `can_view_results`; tenant scope |
| Wykonanie i sterowanie | Tak | `can_execute`; tenant scope |
| SMS i uzupełnienia | Tak | Grant właściwej czynności + aktualny przydział |
| Korekta i rozstrzygnięcie | Tak | Podgląd + dedykowana akcja review; audyt decyzji |
| Pobranie pliku | Tak | Niezależny grant pobrania |
| Usunięcie importu/runu | Tak, step-up | Proponowany osobny grant usuwania + step-up |
| Usunięcie całej firmy | Tak, step-up | Nie |
| Konta/role/granty/sekrety/limity techniczne | Tak | Nie |
| Wstrzymanie własnego zestawu/operacyjnej kolejki | Tak | Grant wykonania; ograniczony zakres, bez edycji sekretów |

Grant usuwania i prawo operacyjnego wstrzymania projektować oddzielnie od globalnych ustawień technicznych. Zmiana aktywnej roli lub grantu obowiązuje przy kolejnym request i przed skutkiem workera. UI opiera się na uprawnieniach, ale backend pozostaje autorytatywny.

## Modele, migracje i API

- Rozszerzyć check constraint `tenant_memberships_role_valid` nową migracją po bieżącym numerze, bez zmiany historycznej 015. Zachować role dotychczasowe i dodać test upgrade.
- Dodać akcje przygotowania, pełnego zestawu, pauzy i usuwania do wspólnej polityki. Jeśli grant usuwania jest nową kolumną, domyślna wartość dla istniejących użytkowników to false.
- Aktualizacja ról odbywa się istniejącym API administracji, z walidacją nowej wartości i audytem. Pole actor/tenant/role z body nie nadaje praw.
- Uprawnienia dla przyszłych endpointów punktów 3–7 muszą być sprawdzane guardem i usługą przy zmianie danych. Brak implementacji endpointu nie może oznaczać zgody na „tymczasowy” endpoint bez ochrony.
- Step-up i przechowywanie grantów kasowania łączą się z punktem 7; MFA/HTTPS instalacji pozostają w planie nadrzędnym.

## Implementacja krok po kroku

1. **Inwentaryzacja użycia ról.** Wyszukać wszystkie union types, listy ról, `switch`, guardy AdminOnly, membership resolver, scope SQL, test fixtures i warunki UI. Sporządzić checklistę producentów/konsumentów; sama zmiana typu nie zamyka zadania.
2. **Polityka jako kontrakt.** Zapisać macierz dla każdej akcji i ról istniejących + manager. Jawnie określić wymagane granty, tenant scope oraz warunek przydziału interwencji. Dodać testy polityki przed rozszerzeniem kontrolerów.
3. **Migracja DB.** Rozszerzyć constraint i granty, dodać potrzebne indeksy. Sprawdzić fresh/upgrade. Nie przypisywać manager wszystkim operatorom/reviewerom; admin zmienia wybrane konta.
4. **Wspólne typy i sesja.** Dodać manager do modelu, serializacji i resolverów. Sprawdzić aktualną rolę z DB, także dla sesji powstałej przed zmianą. Nie ufać roli utrwalonej w starym payloadzie przeglądarki.
5. **Scope list i detali.** Manager otrzymuje tenant scope z aktywnym narzędziem i odpowiednim grantem. Zastosować przed count/filter/page; sprawdzić API historii, importów, submissions i wyników. Brak grantu nie ujawnia nawet liczby cudzych rekordów.
6. **Operacyjne kontrolery/usługi.** Włączyć manager do importu, enrichment, review, konfliktów, submission, run resume/cancel i manual data. Tam, gdzie `AdminOnlyGuard` chroni też funkcję operacyjną, wydzielić endpoint/usługę operacyjną; nie usuwać ochrony administracji.
7. **Przydział interwencji.** Dodać manager do zasad `canAssignIntervention`, przejęcia i zwalniania. Weryfikować current assignment/version atomowo. Dostęp do SMS wymaga wykonania; samo prawo podglądu nie daje wysłania kodu.
8. **Kontrola przed długim skutkiem.** Enrichment, admission i worker po czekaniu sprawdzają aktualne granty, członkostwo i usuwanie. Zmiana praw nie zostawia aktywnych przydziałów pozwalających wznowić operację. Zdefiniować zachowanie zadania po utracie uprawnień jego inicjatora.
9. **Audyt i administracja.** Rejestrować rolę/przydział/granty bez danych wrażliwych. Chronić przed eskalacją, zmianą roli przez manager i usunięciem ostatniego dostępnego admina. Równoczesne zmiany sprawdzać z istniejącymi blokadami użytkowników.
10. **UI.** Dodać rolę do formularza Admina, czytelny zakres uprawnień i operacyjny widok Menedżera. Ukryć niedostępne akcje, obsłużyć 403 po cofnięciu grantu i odświeżyć aktualny stan. Nie przekształcać manager w pełny panel bezpieczeństwa.
11. **Migracja wybranych kont.** Przygotować audytowany sposób nadania manager wskazanym osobom, bez automatycznego bootstrapu. Nie ustawiać nowych ról na rzeczywistych kontach w ramach testu.
12. **Odbiór macierzy.** Testy polityki, HTTP, PostgreSQL, download i UI. Osobno manager z każdym grantem, bez grantów, z disabled tool oraz po zmianie roli. Przekazać finalną tabelę uprawnień i dowody.

## Punkty odbioru

| ID | Kryterium |
| --- | --- |
| R01 | Rola manager zapisywana i odczytywana przez DB, API, sesję i UI. |
| R02 | Manager obsługuje operacyjne dane całej swojej firmy, także import innego autora. |
| R03 | Podgląd/wykonanie/download/usuwanie nie nadają się wzajemnie przez przypadek. |
| R04 | Brak dostępu do obcego tenant i administracji bezpieczeństwem. |
| R05 | Cofnięcie roli/grantu działa na starej sesji i oczekującej interwencji. |
| R06 | Równoczesne przydziały i zmiany ról mają jeden spójny wynik. |
| R07 | Role istniejące nie otrzymują nowych praw i pozostają zgodne z dotychczasową polityką. |
| R08 | UI i backend pokazują/egzekwują tę samą macierz; zmiany mają audyt. |

## Testy i zależności

Testy tabelaryczne polityki; HTTP z fałszywym actor/tenant w body; izolowany DB upgrade; dwa tenanty; count/filter/download; revocation w trakcie SMS/lookup; UI desktop/mobile. Używać modułów auth/security-db/review/sms/submission oraz testów grantów. Nie łączyć ich w pełny flow.

**Odbiór wykonany lokalnie:** disposable PostgreSQL tworzy zgłoszenie Menedżera, dispatcher leasinguje grupę, po czym grant `canExecute` zostaje cofnięty przed atomowym admission. Grupa trafia do `blocked/EXECUTE_ACCESS_REVOKED`; nie powstają `automation_run` ani outbox. Ponowne nadanie grantu nie przyjmuje starej grupy automatycznie. To zamyka race na granicy lease→admission; cofnięcie praw po rozpoczęciu runu i zachowanie workera przed następną zewnętrzną akcją pozostają otwarte.

Po zaliczeniu dostarczyć punkty 3–7 ze wspólnymi permission actions. Wdrożenie samych typów/grantów nie zalicza funkcji przygotowania, pauzy ani usuwania — ich działanie odbierane jest w odpowiednich planach.
