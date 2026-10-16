# 7. Plan implementacji wyników, eksportów i usuwania danych

Data: 8 października 2026. Obowiązują [wspólne zasady](README.md). Zależności: punkty 1–6; model usuwania uzgodnić już przy projektowaniu przygotowania i zestawu. Obejmuje P08/P09 planu nadrzędnego.

## Cel i założenia

Użytkownik otrzymuje wiarygodny wynik każdej sprawy oraz raport całego zestawu, może pobrać Excel i później świadomie usunąć dane. System nie myli braku polis z błędem odczytu, nie publikuje niespójnego pliku i nie odtwarza skasowanych danych przez retry, opóźniony wynik ani restore.

Przechowujemy importy/wyniki do polecenia użytkownika. Automatyczny reconcile może usuwać techniczne osierocone pliki po bezpiecznym okresie, ale nie legalnie istniejący wynik tylko z powodu wieku. Kasowanie danych lokalnych nie usuwa sprawy/oferty z zewnętrznego portalu.

Istnieją snapshot/policy records, encrypted staging, worker result forwarder, eksport z DB, atomic artifact writer oraz detector orphanów. Potrzebne są obsługa typów V2, raport zestawu, operacyjny reconcile i pełny proces purge. Opublikowanie pliku następuje przed commit metadanych — awaria może pozostawić orphan. Aktualny eksport odczytuje mutable SourceRow i wymaga PESEL, co musi zmienić się zgodnie z punktami 4–5.

## Stan implementacji na 9 października 2026

Migracje 042–050 zapewniają grant usuwania Menedżerowi domyślnie wyłączony, scope-bound step-up, utrwalony preview/fingerprint, idempotentne joby oraz stan journalu. Działają trzy zakresy: `artifact` usuwa sam Excel i jego metadane, `run` usuwa przebieg oraz artefakty, `import` usuwa wiersze importu wraz z zależnymi runami i gotowymi plikami. Import-scope blokuje się przy aktywnych zadaniach, submission, shared-run references, oczekującym eksporcie i stagingu; tombstones ukrywają cel, a triggery odrzucają późne zapisy również przy `manual_required`. UI importów i wyników pozwala wybrać zakres, przejrzeć liczności/blokady, potwierdzić hasłem i śledzić job po odświeżeniu. Write-ahead journal poza backupem przechowuje minimalne UUID, sequence i HMAC, a jego głowa jest aktualizowana razem z transakcją joba. API odmawia startu przy rozbieżności; `/health/ready` ponawia kontrolę journalu, a worker nie startuje bez gotowej API. Lokalna komenda maintenance replayuje artifact/run/import przed admission, a disposable test odtworzył starszy snapshot DB i potwierdził ponowne usunięcie danych i pliku. Fault injection sprawdza też awarię po unlinku pliku, rollback DB bez przesunięcia journalu i skuteczne ponowienie. Worker osobno uzgadnia terminalny staging po wygaśnięciu lease. Nadal brakuje bezpiecznego tenant purge, staging/cache/kolejek/payloadów, reconcile i pełnego historycznego audit scrub. Status odbioru i ograniczenia są w [raporcie wdrożenia](../STATUS_WDROZENIA_PLANOW_1-7_2026-10-08.md); pozostałe kroki planu nie są oznaczone jako wykonane.

## Mapa kodu

| Obszar | Punkt startowy |
| --- | --- |
| Kontrakty i wynik | [index.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/packages/core/src/index.ts), [worker-results.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/worker-results.ts) |
| Odczyt/staging | [compensa-ufg.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/compensa-ufg.ts), [result-staging.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/result-staging.ts), [result-forwarder.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/result-forwarder.ts) |
| Excel/finalizacja | [run-export.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/run-export.ts), [export.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/export.ts), [export-finalizer.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/export-finalizer.ts) |
| Pliki i download | [private-artifact-store.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/private-artifact-store.ts), [artifact-download.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/artifact-download.ts) |
| Zależności i scope | [db.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/db.ts), [imports.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/imports.ts), [runs.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/runs.ts), [history.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/history.ts) |

Rzeczywisty graf FK i magazynów zweryfikowany na lokalnym schemacie po migracji 041 znajduje się w [inwentaryzacji kasowania z 9 października](../INWENTARYZACJA_GRAFU_KASOWANIA_2026-10-09.md). Zawiera wyłącznie metadane schematu; nie odczytywano rekordów klientów.

## Kontrakt wyniku i raportu

- Snapshot z wersją, identity V1/V2, run input version, referenceDate, capturedAt, parserVersion, total/matched counts i source order. Zachować 12 istniejących pól OC; nowe pola/metadane muszą być kompatybilne i jawnie wersjonowane.
- `no_matching_policies` to zweryfikowany komplet danych z zerem po filtrze. `read_incomplete` i błąd dostawcy nie dają wyniku zerowego.
- Raport zestawu ma dwa poziomy: źródłowe wiersze z kategorią/reprezentantem/runId/przyczyną oraz polisy według unikalnego sprawdzenia. Nie dublować polis w głównym arkuszu tylko dlatego, że źródło miało duplikaty.
- Excel zawiera identyfikację firmy i właściwe pola dla typu. PESEL tylko na właściwej ścieżce i z prawami danych; spółka nie potrzebuje pustego/fikcyjnego PESEL. Generowanie wyłącznie z utrwalonego snapshotu i run input, bez ponownego UFG.
- Eksport całego zestawu ma wersję rozliczenia. Raport częściowy jest wyraźnie oznaczony; późniejszy wynik daje nową wersję raportu, bez nadpisania pobranego historycznego artefaktu.

## Zakresy kasowania i proponowane API

| Polecenie | Co usuwa | Co pozostaje |
| --- | --- | --- |
| Usuń eksport | Wskazany plik/metadane publikacji według polityki. | Snapshot/run; ewentualna regeneracja jest jawnie osobną operacją. |
| Usuń run i wynik | Wynik/tożsamość/staging/eksporty/interwencje/payloady tego runu. | Import źródłowy, o ile nie wybrano szerszego zakresu. |
| Usuń import i zależne dane | Source/preparation/corrections oraz zależne nieużywane runy/pliki. | Inny import i dane nadal przez niego referencjonowane. |
| Usuń dane całej firmy | Wszystkie dane biznesowe wybranego tenant. | Minimalny audyt/rejestr usunięć i konta/konfiguracja według jawnego zakresu; nie kasować infrastruktury przez tę funkcję. |

Współdzielony run wymaga decyzji scope: usunięcie jednego importu usuwa jego linki, a wspólny wynik pozostaje dla pozostałych prawidłowych referencji. Preview musi to wyjaśniać. Bez takiej analizy proste cascade source→run może usunąć dane innego importu.

Proponowane endpointy: `POST /api/deletions/preview` z target/expectedVersion, `POST /api/deletions` z preview fingerprint/idempotencyKey oraz potwierdzeniem step-up, `GET /api/deletions/:id`. Create zwraca 202/jobId. Finalizer/download/history i worker results mają wspólną kontrolę deletion, a nie tylko osobny endpoint delete.

Proponowane modele: DeletionJob (scope/actor/fingerprint/status/lease/checkpoint/retry), DeletionTarget (wewnętrzne IDs i zależności), ResourceTombstone/deletionEpoch, minimalny DeletionJournal. Statusy pending/stopping/purging/verifying/completed/failed_retryable/manual_required. Bez nazw/NIP/REGON/PESEL w rejestrze tombstones.

## Implementacja krok po kroku

1. **Ustalić fixture wyniku i filtr daty.** Zestaw OC z zerem, wieloma polisami, datą graniczną, brakującym polem i niepełną tabelą. Zapisz expected total/matched i wszystkie pola. Datę odniesienia i regułę filtra utrwalić w runie; nie przesuwać jej przy retry lub nowym dniu.
2. **Walidacja snapshotu V1/V2.** Zweryfikować tożsamość typu, run input, właściwą sprawę, source order, policzalną kompletność i daty. Konsument odrzuca obcy/malformed wynik; typ spółki nie wymaga decrypt PESEL. Sprawdzenie grant/deletion/lease przed commit.
3. **Idempotentne przyjęcie wyniku.** Ten sam run/snapshot digest akceptowany bez drugiego zapisu; inny payload dla zakończonego wyniku daje konflikt i diagnostykę. Worker→API korzysta z istniejącego prywatnego uwierzytelnienia. Nie pozwalać spóźnionemu delivery nadpisać wyniku lub tombstone.
4. **Staging i dostarczenie.** Utrzymać AES-GCM, keyVersion, atomic write/checkpoint/hash. Retry delivery odczytuje staging, nie wraca do UFG. Po potwierdzeniu zapisu usunąć staging zgodnie z checkpoint; błąd klucza i checksum jawny, bez surowych danych w loggerze.
5. **Eksport runu z immutable danych.** Zastąpić zależność od mutable source zatwierdzonym RunInputSnapshot/Identity V2. Wygenerować 12 pól OC i właściwe firmowe metadane, zachować historyczną zgodność JDG. Dodać ochronę formula-like text oraz deterministyczną kolejność.
6. **Raport całego zestawu.** Arkusze podsumowania, rozliczenia wierszy, polis i wyjątków; jedna revision/capturedAt raportu. Duplikaty wskazują reprezentanta. Oczekujące pozycje widoczne, częściowy raport oznaczony; zero gotowych rekordów też ma poprawny raport.
7. **Publikacja artefaktu i reconcile.** Reuse finalizer/atomic writer, zapis publikacji w toku z identyfikatorem i hashem, kontrola deletion przed publikacją i commit. Completed metadata bez pliku wykrywane i naprawiane z snapshotu lub pokazywane jako błąd. Techniczne orphan cleanup z grace period, lease publikacji, dry-run i audytem; nie kasować pliku tworzonych metadanych.
8. **Download i UI wyników.** Autoryzacja osobnego grantu, tenant scope i deletion barrier przed otwarciem pliku. Panel rozróżnia zero/partial/error/ready/deletion. Nie udostępniać publicznych ścieżek storage. Nowe requesty po barierze odrzucone; już przesłanych bajtów nie da się cofnąć.
9. **Inwentaryzacja grafu kasowania.** Sporządzić rzeczywistą listę FK i wszystkich magazynów: source/corrections/preparation/execution/submission/run source links/identity/OC/events/interventions/challenges/outbox/Redis/staging/artifacts/cache/audit metadata. Sprawdzić, czy przechowywany jest sam plik importu. Współdzielenie runów i canonical entities wymaga reference analysis.
10. **Schemat kasowania i step-up.** Migracje 042–048 dodają odrębny grant Menedżera, 5-minutowy hash-token związany z sesją/rewizjami/fingerprintem, atomowy zapis preview/job/file manifest/tombstone, import-scope oraz barierę DB pozostającą zamkniętą w stanie `manual_required`. Dziennik write-ahead HMAC poza backupem dopisuje intent przed commitem; migration `050` zapisuje głowę zaakceptowaną przez DB, a API blokuje start przy rozbieżności. Replay istniejących scope działa w lokalnym trybie maintenance; tenant-wide scope i purge dodatkowych magazynów są otwarte.
11. **Preview i atomowe zlecenie.** Dla artifact/run/import wyliczają się stan, pliki i blokady. Przed create backend ponownie weryfikuje wersję/fingerprint/grant/step-up. Job, pliki, tombstones i audit intent powstają w jednej transakcji; użycie klucza idempotencji dla innego żądania daje 409. Zakres tenant nadal nie ma executora.
12. **Zatrzymanie zapisów i zadań.** Run-scope wymaga terminalnego przebiegu bez submissions, współdzielenia, outbox, staged result i pending export; artifact/run wykluczają się blokadą runu. Import-scope odrzuca nowe operacje na źródle przez triggery zapisu do tabel batch/source, ukrywa import i jego runy oraz zatrzymuje finalizer/download. Snapshot blokuje aktywne workflowy i współdzielone odwołania. Pierwszy per-run pause request/worker safe-checkpoint ACK i wznowienie tego samego runu jest zaimplementowane w `049`; nadal brakuje wspólnej bariery dla admission całego systemu, expected revision i testów wyścigów SMS/korekt/cancel. Executor import nadal blokuje preview z operacjami aktywnymi.
13. **Purge danych współdzielonych i DB.** Dla wybranego importu usuwanie jest blokowane, gdy źródłowe wiersze są używane przez run spoza importu. Gdy nie ma zewnętrznych referencji, import-scope utrwala tombstone'y wszystkich jego runów/artefaktów i kaskadowo usuwa zależne rekordy DB. Osobne testy sprawdzają retencję importu przy run-scope i kaskadę przy import-scope. Tenant-wide purging, aktywny przebieg współdzielony przez importy i pełna walidacja cross-table/cache pozostają otwarte; obecna kaskada DB nie jest deklarowana jako pełne wyczyszczenie wszystkich magazynów.
14. **Purge plików, stagingu i kolejki.** Job utrwala manifest eksportów, weryfikuje literalne ścieżki we własnym root, odrzuca symlink/traversal i uznaje brakujący plik za retry-safe. Usuwa metadane artefaktu dopiero po unlink pliku. Podgląd blokuje run/import ze staged result, ale sam staging, Redis/BullMQ, pliki tymczasowe i referencje shared files nie są jeszcze purge'owane; nie usuwać globalnego klucza szyfrowania dla pojedynczego importu.
15. **Cache, logi i audyt.** Usunąć zależne payloady i dane pozwalające odtworzyć cel; cache współdzielony obsłużyć zakresem/referencjami. Minimalny dowód usunięcia pozostaje bez PII. Przejrzeć historyczny audyt: jeśli ma dane objęte purge, przygotować dedykowaną, ograniczoną procedurę zgodną z jego constraintami/immutability; nie otwierać publicznego API edycji audytu. Zapobiec nowemu logowaniu danych już od etapu wyniku.
16. **Weryfikacja i retry.** Po etapach sprawdzić brak domenowych danych/pliku/stagingu oraz skuteczność blokady download/write. Awaria dowolnego kroku zapisuje checkpoint/nextAttemptAt; ponowienie idempotentne. Completed dopiero po weryfikacji aktywnych magazynów; niepowodzenie daje błąd i przyszły alarm, nie zielony toast.
17. **Restore i rejestr usunięć.** Journal z monotoniczną sekwencją, łańcuchem HMAC i minimalnymi wewnętrznymi IDs jest zapisywany poza archiwum backupu; walidator odrzuca zmianę, ucięcie, brak klucza i błędny łańcuch. Migration `050` zapisuje aktualną głowę w DB, API blokuje admission przy rozbieżności, readiness odpytuje journal ponownie, a worker wymaga gotowej API przed startem. Komenda maintenance replayuje nowsze cele `artifact`/`run`/`import`, usuwa odpowiadające im pliki, checkpointuje każdy wpis i jest idempotentna przy powtórzeniu. Disposable test odtworzył stary stan importu/plików przed API startem. Fault injection sprawdza awarię po unlinku pliku i rollback DB bez przesunięcia journalu, a osobna sekwencja wieloelementowa potwierdza, że awaria późniejszego wpisu pozostawia wcześniejszy commit/checkpoint i retry wznawia od pierwszego niezatwierdzonego wpisu. Otwarty zakres: tenant, staging/cache/kolejki/payloady, cross-store verification po pełnym purge, pozostałe granice crash/replay i kopie z różnymi epokami. Rotacja backupów jawna; VPS nie jest wymagany do lokalnego kontraktu i testu.
18. **UI i odbiór.** Osobne zakresy kasowania, preview counts i referencji, potwierdzenie, step-up, job progress i końcowy status. Instrukcja wyjaśnia aktywne zadania, współdzielenie, skutki zewnętrzne i okno backupów. Osobne testy results/export/reconcile/purge/restore z syntetycznymi danymi.

## Punkty odbioru

| ID | Kryterium |
| --- | --- |
| W01 | Zero polis i niepełny odczyt mają różne wyniki; wszystkie pola/count/datę zweryfikowano. |
| W02 | Snapshot i Excel zgodne dla V1 JDG oraz V2 spółki; brak zależności od późniejszej korekty źródła. |
| W03 | Raport rozlicza cały zestaw, duplikaty i oczekujące rekordy, bez fałszywej kompletności. |
| W04 | Powtórny delivery/finalize nie dubluje danych/plików, konflikt treści jest odrzucany. |
| W05 | Disk-full, brak pliku, hash/key error i commit failure dają kontrolowany wynik; reconcile nie usuwa aktywnej publikacji. |
| W06 | Preview i prawa odpowiadają rzeczywistemu zakresowi; brak step-up blokuje destrukcyjną czynność. |
| W07 | Po barierze stare joby/worker results/download nie odtwarzają ani nie udostępniają celu. |
| W08 | Usunięcie jednego importu nie niszczy danych nadal używanych przez inny import. |
| W09 | Purge obejmuje DB/pliki/staging/payloady, jest idempotentne i wznawialne. |
| W10 | Audyt/rejestr zachowuje minimalny dowód bez usuwanej tożsamości; brak nowego wycieku w logach. |
| W11 | Restore starszej kopii stosuje najnowszy journal przed udostępnieniem; dane usunięte nie wracają. |
| W12 | Brak automatycznej retencji wiekowej danych biznesowych; zakres eksport vs wynik vs import wyjaśniony. |

## Testy szczególne i przekazanie

Testy wyników: syntetyczny snapshot 0/wiele OC, daty graniczne, missing field, obca identity i total mismatch; odczyt wygenerowanego XLSX pole po polu; tekst rozpoczynający się jak formuła; V1/V2 i wrong key. Eksport nie wykonuje lookup/portali.

Testy awarii: crash po pliku przed DB, plik usunięty po completed, stale staging, generator raportu podczas korekty; orphan w toku i prawdziwy orphan. Reconcile na prywatnym katalogu utworzonym przez test.

Testy purge: równoległy finalize/delivery/SMS; active lease; purge w połowie DB/files; brak pliku; path traversal/symlink; shared run z dwoma importami; częściowy audit payload; restored DB/file sprzed usunięcia; stary journal odrzucony. Nowy świadomy import tego samego podmiotu z nowymi IDs jest dozwolony — tombstone blokuje odtworzenie skasowanych zasobów, nie wiecznie danego NIP.

Przekazanie: kontrakty snapshot/export/report, graf zależności purge, uprawnienia i step-up, schemat jobs/journal, dry-run/reconcile narzędzie, protokół lokalnego restore i instrukcja użytkownika. Gotowość produkcyjnego backupu/monitoringu nadal wymaga etapu VPS z planu nadrzędnego.
