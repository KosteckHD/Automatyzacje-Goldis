# 6. Plan implementacji SMS, korekt i sterowania przez panel

Data: 8 października 2026. Obowiązują [wspólne zasady](README.md). Zależności: punkty 1–2, kontrakty punktów 3–5 i bariera usuwania z punktu 7. Odpowiada P07 oraz operacyjnej części P11.

## Cel i założenia

Admin i Menedżer prowadzą automatyzację przez platformę: widzą postęp i wyjątki, przejmują interwencje, wpisują SMS, poprawiają wymagane dane, wstrzymują/wznawiają lub anulują pracę. Zwykła obsługa nie wymaga zdalnego pulpitu ani zmiany pliku konfiguracyjnego.

Istnieją auth challenges, jednorazowy odbiornik workera, retry policy, interwencje/przydziały/read state, manual data i cancel/resume. Rozszerzyć je o manager, control plane całego zestawu i jednoznaczne stany. SMS nie jest brakiem docelowej automatyzacji — jest jej uzgodnionym krokiem.

Kod SMS nie trafia do DB, audytu, loggera body, storage przeglądarki ani eksportu. Utrwalać challenge/metadane/outcome, a treść przekazywać istniejącym prywatnym kanałem jednorazowo. Nie zastępować tego prywatnego transportu publicznym endpointem workera.

## Stan implementacji na 9 października 2026

Dodano per-run pause/resume w migration `049`: request jest zapisany jako osobny `controlState`/revision; worker potwierdza go tylko przy żywym fencing lease i na granicy przed następną kontrolowaną akcją portalu. API wznawia ten sam run przez outbox. `051` wymaga `expectedRevision` i klucza idempotencji oraz utrwala odpowiedź polecenia, więc retry po niepewnym HTTP nie tworzy kolejnej rewizji ani dispatchu; stare rewizje dostają 409. UI ponawia z tym samym kluczem w obrębie tej samej rewizji. Bez aktywnego lease pauza może zostać potwierdzona od razu; `waiting_for_sms` i `waiting_for_manual_data` są już bezpiecznie zaparkowane i endpoint nie zmienia ich. Admin/Menedżer widzą akcję i stan. Disposable PostgreSQL smoke przechodzi request → ACK → zwolnienie lease → wznowienie, idempotentne retry, odrzucenie stale revision oraz pause bez workera.

Otwarty kontrakt względem dalszych punktów planu: browser smoke Admin/Menedżera obejmuje już per-run pause/resume i body `expectedRevision`/`idempotencyKey`. Disposable PostgreSQL smoke pokrywa też wyścig anulowania z aktywnym przekazaniem SMS: anulowanie dostaje 409, gdy kod ma stan `claimed`, a po trwałym wyniku przekazania można ponowić anulowanie i unieważnić challenge. Nadal brakuje macierzy pause/resume z SMS i korekt oraz DB/API testu odwołania grantu podczas działania workera. Pause ACK nie wycofuje już wysłanej akcji, a pacing dotyczy adapterowych punktów sterowania — nie każdego requestu strony. Cały zestaw ma osobny CAS pause/resume.

## Mapa kodu

| Obszar | Punkt startowy |
| --- | --- |
| Challenge API | [auth-challenges.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/auth-challenges.ts), [sms-retry-policy.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/sms-retry-policy.ts) |
| Challenge worker | [auth-challenges.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/auth-challenges.ts), [code-inbox.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/worker/src/code-inbox.ts) |
| Przydziały i dane | [interventions.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/interventions.ts), [manual-data.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/manual-data.ts) |
| Sterowanie | [runs.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/runs.ts), [admin.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/admin.ts), [run-submissions.ts](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/api/src/run-submissions.ts) |
| Panel | [workspace.tsx](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/workspace.tsx), [activity-signal.tsx](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/activity-signal.tsx), [submission-detail.tsx](C:/Users/micha/Desktop/Goldis-Automatyzacje/apps/web/app/submissions/[id]/submission-detail.tsx) |

## Kontrakty i stany sterowania

| Polecenie | Efekt | Kiedy panel potwierdza wykonanie |
| --- | --- | --- |
| Wstrzymaj nowe zadania | Brak nowych admission; już wykonywany rekord może dojść do bezpiecznego punktu. | Po trwałym zapisie admission control; aktywna praca opisana osobno. |
| Wstrzymaj zestaw | Brak kolejnych paczek/runów; kontrolowane zatrzymanie aktywnych. | Po potwierdzeniu checkpoint/worker ack; wcześniej „zatrzymywanie”. |
| Wstrzymaj rekord | Brak kolejnej akcji po bezpiecznym checkpoint. | Po ack, a nie w chwili przyjęcia requestu. |
| Wznów | Aktualne prawa i checkpoint, jeden resume intent. | Gdy zapisano/podjęto właściwe wznowienie; outcome pokazany z DB. |
| Anuluj | Koniec nowych działań, invalidation challenge, brak nowej publikacji. | Po trwałej barierze i rozstrzygnięciu aktywnego etapu; wysłane skutki pozostają jawne. |

Proponowany control record: target, desiredState, controlRevision, actor/time, workerAck, safeCheckpoint i outstandingAction. Reuse pól execution z punktu 4. Nie dodawać `paused` do `RunStatus` bez aktualizacji wszystkich transitions/queries; stan sterowania może pozostać oddzielny.

SMS identyfikuje challengeId, current challenge revision, portal/account fingerprint, run, worker generation, expiry i assignment. Istniejące statusy active/claimed/submitted/consumed/invalidated/expired zachować i rozszerzać kontraktowo.

## Implementacja krok po kroku

1. **Ustalić widoki i czynności.** Lista zestawów, lista interwencji i detal rekordu; każda pozycja ma firmę/wiersz, etap, przyczynę, właściciela i możliwą akcję. Rozdzielić błąd danych, oczekiwanie na SMS/dostawcę i awarię systemową. Odbiór UX oprzeć na scenariuszach, nie tylko zrzucie.
2. **Wspólny backend sterowania.** Zapisać desired state/controlRevision w transakcji z audytem. Proponowane endpointy pause/resume/cancel dla execution/run mają expected revision i idempotencyKey. Konflikt starej karty to 409; tenant/grant pochodzą z sesji.
3. **Scheduler i worker.** Admission/generator/outbox i worker sprawdzają tę samą barierę. Kontrola przed każdą zewnętrzną akcją, po pacing i przed lokalnym zapisem. Ack stanu pauzy dopiero na bezpiecznym punkcie; utrata lease nie jest dowodem cofnięcia wysłanego requestu.
4. **Przydziały interwencji.** CAS claim/release/reassign z rewizją; manager ma tenant scope i odpowiedni grant. Aktualne przypisanie sprawdzić również przy wykonaniu czynności. Timeout przydziału lub blokada konta pozwala audytowane przejęcie. Samo „przeczytane” nie zamyka interwencji.
5. **SMS submission.** Pod transakcyjną blokadą challenge/run sprawdzić aktywność, expiry, aktualny challenge, assignment, grant i control/deletion. Dwa żądania dają jednego claim. Private handoff związany z worker generation; odrzucony/stary kod nie trafia do portalu.
6. **Niepewne przekazanie SMS.** Po timeout nie wysyłać tego samego kodu automatycznie kolejny raz. Wykorzystać istniejący stan uncertain i retry policy. Panel pokazuje, czy trzeba nowego challenge/logowania. Limity żądań SMS i błędnych kodów wspólne dla profilu; nie tworzyć pętli resend.
7. **Bezpieczeństwo treści SMS.** Przejrzeć logowanie HTTP/errors/telemetry i logger workera. Redakcja przed loggerem, brak treści w audit/fixtures snapshots. Input trzymany tylko chwilowo, czyszczony po wysłaniu/zmianie challenge/wylogowaniu. Frontend może zachować klucz requestu, ale nie kod.
8. **Korekty przed startem.** Używać istniejącego proposal/review; walidować identyfikator i źródło. Zatwierdzenie unieważnia revision/preview punktów 3–4. Zmiana wiersza źródłowego nie zmienia już rozpoczętego snapshotu; gotowe dane wracają jako nowa revision/continuation.
9. **Korekty podczas runu.** Manual override tylko dla dopuszczonych pól i konkretnego checkpointu/run input version. Adres/powiat z dozwolonego formularza; tożsamość wymaga dowodu, nie swobodnego zastąpienia. Po zmianie przy identity mismatch wrócić do weryfikacji przed skutkami, a nie kontynuować istniejącą obcą sprawę.
10. **Wznowienie.** Zweryfikować current checkpoint, brak nierozstrzygniętej akcji, grant i assignment. Jeden resume outbox intent; odebranie jobu ponownie jest idempotentne. Consumed SMS i completed/ cancelled/purged run nie są „wznawialne” tą samą ścieżką.
11. **UI SMS i korekt.** Jasny portal/run/expiry, input z etykietą, focus i stan submitting. Konflikt dwóch osób aktualizuje detal. Formularz korekty pokazuje wymagane pola/źródło i walidację, bez utraty draftu przy odświeżeniu niezwiązanego statusu.
12. **UI sterowania.** Osobne etykiety „wstrzymaj nowe”, „zatrzymaj zestaw”, „anuluj”. Pokazać requested/effective i już wykonane skutki. Potwierdzenie anulowania opisuje konkretny zakres, bez sugerowania cofnięcia oferty. Nie mieszać tego z kasowaniem danych.
13. **Odświeżanie i sesja.** Jeden request statusu na widok, brak overlap, AbortController/response version przy zmianie wyboru, backoff po błędzie. Ukryta karta nie odpytuje intensywnie. Polling nie jest interakcją przedłużającą idle session. 401 czyści wrażliwy stan, 403 aktualizuje dostęp, 409 wymaga reload statusu.
14. **Odbiór i instrukcja.** Osobne testy sms/interventions/manual data/control/UI, pięć użytkowników i dodatkowe karty. Instrukcja: kto przejmuje interwencję, kiedy kod wygasa, co robi pause/cancel, jak wrócić po utracie sieci. Nie używać realnego SMS jako fixture.

## Punkty odbioru

| ID | Kryterium |
| --- | --- |
| O01 | Admin i manager widzą/obsługują właściwe interwencje niezależnie od autora importu. |
| O02 | Jeden challenge przyjmuje jeden kod; portal/run/profile/expiry sprawdzane. |
| O03 | Kod nie występuje w DB/logach/audycie/storage i nie jest automatycznie retransmitowany po niepewności. |
| O04 | CAS przydziału i grant revocation skuteczne, nawet gdy karta była otwarta. |
| O05 | Pauza ma requested/effective; po skutecznym zatrzymaniu brak kolejnej kontrolowanej akcji. |
| O06 | Resume idempotentne z właściwego etapu; cancelled/purged nie odżywa. |
| O07 | Korekty wersjonowane, nie zmieniają historycznego snapshotu i nie potwierdzają obcej tożsamości. |
| O08 | Pięciu użytkowników/karty/polling nie powoduje konfliktów kodów i lawiny requestów. |
| O09 | UI czytelne i dostępne przy 320/768/1920, klawiaturze i błędach sieci/API. |

## Testy szczególne i przekazanie

Dwa SMS równocześnie; expiry na granicy czasu; challenge zastąpiony w trakcie typing; zła generacja workera/portal; grant odwołany po claim; delivery uncertain; blokada użytkownika przejmującego; reassign ze starej karty. Pauza przed/po intent, podczas pacing, podczas HTTP i po checkpoint; cancellation przed outbox publish; dwuklik resume; usuwanie równocześnie z korektą/SMS. W disposable DB sprawdzono już aktywne przekazanie SMS ↔ cancel (cancel nie może zakończyć się sukcesem przy stanie `claimed`, a po rozstrzygnięciu można je ponowić); pozostałe kombinacje nadal są otwarte.

API i worker otrzymują osobne syntetyczne challenge/control contracts. UI używa mock API, test DB rzeczywistego przejścia jest osobny. Przekazać state/control decision table, słownik komunikatów, manifest permission actions i instrukcję obsługi.
