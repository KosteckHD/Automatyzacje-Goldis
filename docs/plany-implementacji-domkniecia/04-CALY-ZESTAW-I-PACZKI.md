# 4. Plan implementacji uruchamiania całego zestawu i paczek

Data: 8 października 2026. Obowiązują [wspólne zasady](README.md). Zależności: punkty 1–3, kontrakt wykonania punktu 5; odpowiada P04 planu nadrzędnego.

## Cel i założenia

Użytkownik uruchamia wszystkie gotowe rekordy jednym poleceniem. System sam tworzy i odzyskuje paczki, obsługuje admission, pokazuje całościowy postęp i nie powtarza pracy po retransmisji. Nie przenosimy dużej listy wierszy do jednego requestu.

Obecne `RunSubmission`, items/groups, canonical runs i `RunDispatchOutbox` pozostają podstawą. Wybór ma limit 500; nowe uruchomienie całego zestawu jest nadrzędną orkiestracją nad istniejącymi submission, nie nową konkurencyjną kolejką. Pięciu użytkowników korzysta z jednego profilu portalowego na start.

Run korzysta z zamrożonych danych przygotowania. Obecne miejsca czytające mutable `SourceRow` muszą otrzymać spójny snapshot/projection; zapisanie fingerprint bez zmiany konsumenta nie zapewnia niezmienności wejścia.

## Mapa kodu

| Obszar | Punkt startowy |
| --- | --- |
| Submission/admission | [run-submissions.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/run-submissions.ts) |
| Tożsamość i istniejące runy | [canonical-run-service.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/canonical-run-service.ts), [runs.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/runs.ts) |
| Dane trwałe | [db.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/db.ts), migracje 014/017/027 |
| Lease i walidacja workera | [execution-lease.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/execution-lease.ts), [run-worker.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/run-worker.ts) |
| UI | [run-submission-launcher.tsx](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/run-submission-launcher.tsx), [submission-detail.tsx](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/submissions/[id]/submission-detail.tsx) |

## Proponowany model i API

- `PreparedSetExecution`: tenant/preparation/revision/fingerprint, actor/tool/profile, referenceDate, requestHash/idempotencyKey, desiredControl/controlRevision, status i liczniki.
- `PreparedSetChunk`: execution, ordinal, stabilny zakres reprezentantów, status, childSubmissionId, cursor i lease. Unique execution+ordinal; unikalne powiązanie przygotowanego reprezentanta z tym wykonaniem.
- Mapa wszystkich source rows do representative→run, także dla duplikatów i jawnych pominięć. Nie wymuszać jednego runu dla każdego źródłowego wiersza.
- `RunInputSnapshot`: zamrożone wymagane wartości, identity key, prepared row ID/version, typ i data; zintegrować z istniejącym modelem, jeśli da się bez nowej tabeli. Snapshot ma wersję kontraktu i jest możliwy do usunięcia w punkcie 7.
- `POST /api/preparations/:id/executions`: sealed revision/fingerprint, referenceDate, profil oraz idempotencyKey. 202 i executionId. Odczyt summary/chunks/rows przez paginację. Pause/resume/cancel z controlRevision — logika punktu 6.

Domyślna propozycja: ponowienie tego samego requestHash/key zwraca ten sam executionId; ten sam key z inną treścią daje 409. Nowe świadome sprawdzenie używa nowego klucza i wyniku; istniejący aktywny run tej samej tożsamości/daty obsłużyć według polityki canonical run, z jawnym powiązaniem lub blokadą.

## Implementacja krok po kroku

1. **Spisać niezmienniki.** Cały zestaw rozliczony; zero utraconych reprezentantów; globalna deduplikacja wykonana wcześniej; brak nowego runu przy dwukliku; snapshot nie zmienia się po korekcie źródła. Rozdzielić selected rows, unique representatives i actual portal runs.
2. **Ustalić payload i statusy.** Projekt statusów queued/running/waiting_attention/completed/cancelled/failed oraz sterowania desiredControl. `completed` wymaga terminalnego rozliczenia wszystkich pozycji, a nie tylko paczek. Wyniki zerowe są terminalne; wymagane interwencje są oddzielne.
3. **Dodać migracje i indeksy.** Nadrzędne wykonanie, paczki i powiązania; unique idempotency, ordinal i representative. Indeksy status/due/tenant. FK i purge contract uzgodnić z punktem 7 przed wdrożeniem.
4. **Preview i utworzenie.** W jednej krótkiej transakcji: aktualne prawa, brak deletion, sealed revision, fingerprint, data i gotowość adaptera. Zwrócić counts z pominięciami; użytkownik nie musi znać liczby paczek. Nie akceptować arbitralnej listy tenant/identity od klienta.
5. **Snapshot wejścia.** Utworzyć raz dane wykonania z prepared rows. Zmienić consumers canonical/run validation/worker, aby czytały to samo wejście. W `validateAndParkRun` zastąpić bezwarunkowe `issues.length===0` kontraktem blocking issues przygotowania; nie ignorować rzeczywistych błędów.
6. **Generator paczek.** Keyset pagination po stabilnych reprezentantach; do 500 na child submission. Plan wszystkich paczek lub trwały cursor tworzony atomowo; przy restarcie użyć istniejącego ordinal/submission. Nie wczytywać całego wielkiego importu przy każdym tick.
7. **Połączenie z submission.** Wydzielić wspólną wewnętrzną usługę tworzenia child, zachowując dzisiejsze granty/audyt/outbox. Child i jego powiązanie z chunk zapisać w jednej transakcji lub użyć trwałego intent z unikalnością. Nie wywoływać własnego API bez uwierzytelnienia z schedulera.
8. **Idempotencja i canonical run.** Dwuklik/równoczesny start/retry nie dubluje paczek. Dla aktywnego runu wspólnego dla kilku źródeł zachować referencje i prawa wyników. Rozstrzygnięcie konfliktu identity/date widoczne jako accepted/shared/blocked, nie ukryte pominięcie.
9. **Admission i backpressure.** Uwzględnić capacity, okno pracy, cooldown, stan profilu i controlRevision. Nie publikować tysięcy aktywnych operacji naraz. Oczekiwanie na capacity/window/paused ma trwały due/status i nie prowadzi do busy loop.
10. **Outbox i odzyskanie.** Publikacja poza transakcją; queue delivery może być powtórne, a konsument używa run/dispatch lease i idempotencji. Crash przed/po publish nie traci pracy. Nie traktować Redis jako jedynego źródła prawdy; pending/outbox da się odtworzyć z DB.
11. **Agregacja postępu.** Liczniki przeliczać z autorytatywnych statusów lub aktualizować transakcyjnie z reconcile. Uwzględnić failed/review/cancelled/shared oraz terminalny run już istniejący. Ukończona paczka nie gwarantuje kompletnego zestawu, jeśli zostały nierozstrzygnięte pozycje.
12. **Kontynuacja po korekcie.** Nowa revision może dodać gotowe wcześniej zablokowane rekordy poprzez jawny continuation intent. Nie zmienia ukończonych snapshotów. Automatyczne lub ręczne dołączenie musi być widoczne i idempotentne; domyślnie jawna czynność Menedżera.
13. **UI.** Jedna czynność uruchomienia, preview counts/date/profile, status całego zestawu i drilldown do paczek/rekordów. Utrata sieci i ponowienie używają tego samego klucza. Przy 409 odświeżyć preview, nie powtarzać bezwarunkowo POST.
14. **Odbiór modułu.** Testy DB/outbox z kontrolowanym odbiornikiem. Nie uruchamiać procesora portalowego. Przekazać schema, snapshot/payload contract, invariants i raport liczników.

## Punkty odbioru

| ID | Kryterium |
| --- | --- |
| Z01 | 501/1201 wierszy uruchamiane bez ręcznego wyboru kolejnych paczek. |
| Z02 | Duplikat na granicy paczek ma jeden reprezentant/run i poprawne powiązania. |
| Z03 | Dwuklik i powtórna dostawa nie tworzą drugiego execution/chunk/run. |
| Z04 | Zmiana źródła po starcie nie zmienia snapshotu ani wyniku uruchomienia. |
| Z05 | Crash na każdym etapie child/outbox/publish daje odzyskanie bez zgubionej pracy. |
| Z06 | Capacity/pause/window/cooldown nie są błędem i nie powodują spin loop. |
| Z07 | Counts rozliczają wszystkie źródła i przedstawiają interwencje bez fałszywego completed. |
| Z08 | Snapshot, payload, walidacja API i workera są zgodne kontraktowo. |
| Z09 | Prawa, cofnięcie grantów i deletion sprawdzane przed admission i wykonaniem. |

## Testy i przekazanie

Zestawy 0 gotowych/1/500/501/1201; duplikat między paczkami; active run; wspólny wynik; dwie osoby startujące naraz; idempotency key z inną treścią; korekta podczas generatora; crash przed child, po child, po publish i przed ack; cancel/pause między paczkami; Redis down; grant revoked. Dane wyłącznie syntetyczne.

Testy `submission` i nowy izolowany moduł set-execution. API→snapshot i worker snapshot→validation sprawdzić osobno na tym samym kontrakcie. Odbiór punktu 4 kończy się na prawidłowym trwałym zleceniu, a nie na wykonaniu portali.
