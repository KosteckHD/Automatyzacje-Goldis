# Inwentaryzacja grafu kasowania danych

Data: 9 października 2026. Dokument przygotowuje implementację punktu 7.9–7.10 planu [wyników, eksportów i usuwania](plany-implementacji-domkniecia/07-WYNIKI-EKSPORTY-I-USUWANIE.md).

## Zakres i metoda

Sprawdzono definicje modeli, migracje, miejsca składowania oraz ograniczenia FK bazy lokalnej po migracji `041-registry-provider-request-pacing`. Odczytano metadane schematu, nie rekordy klientów. Nie kasowano, nie edytowano ani nie eksportowano danych biznesowych. Tabela FK poniżej jest inwentaryzacją bazową z tego dnia; odbiór implementacji na świeżej bazie `001–048` potwierdził kaskadę import-scope dla reprezentatywnego importu, runu, wiersza i artefaktu. Nie jest to jeszcze pełny przegląd wszystkich magazynów dla purge tenanta.

## Graf referencji SQL

| Rodzic / zakres | Zależności | Skutek dla kasowania |
| --- | --- | --- |
| `tenants` | `audit_events` blokuje usunięcie (`RESTRICT`); członkostwa, importy i narzędzia wiążą się z tenantem | Nie usuwać tenanta przez kaskadę. Zachować tenant i minimalny ślad audytowy. |
| `tenant_memberships` | importy, zgłoszenia i wykonania przygotowanego zestawu mogą blokować usunięcie (`RESTRICT`) | Usunięcie użytkownika/członkostwa jest osobnym procesem administracyjnym. |
| `import_batches` | `source_rows`, preparation, workflow, enrichment jobs, wykonania zestawu i runy | Nie zakładać, że CASCADE wystarczy. `run_submissions` blokuje kasowanie importu; trzeba najpierw ocenić powiązane submissions, grupy, pozycje i współdzielone runy. |
| `source_rows` | korekty REGON, audyt wzbogacenia, konflikty grupowania, linki encji, preparation rows, wykonania i członkowie runu | Kasowanie jednego wiersza może dotknąć współdzielonego runu lub grupy. Najpierw usunąć/odłączyć link wybranego importu, a następnie ponownie policzyć referencje. |
| `canonical_entities` | linki źródeł i grupy/submissions mogą blokować usunięcie (`RESTRICT`) | Nie kasować encji, dopóki istnieją referencje spoza zakresu. Encje kanoniczne wymagają osobnego liczenia referencji. |
| `automation_runs` | źródła, eventy, identyfikacje, OC, eksporty, outbox, overrides, challenges i interwencje | Większość rekordów potomnych kaskaduje, lecz usunięcie runu nie usuwa automatycznie plików z dysku. Przed purge trzeba zatrzymać worker/delivery. |
| `run_submissions` | pozycje i grupy kaskadują od submission, ale submission połączone z batch/run/canonical entity może być chronione przez `RESTRICT` | Ustalić politykę dla niedokończonego submission i referencji do współdzielonego runu; nie omijać ograniczeń FK. |
| `manual_interventions` | aktywność kaskaduje; aktor aktywności ma FK `RESTRICT`; użytkownicy/przydziały są częściowo `SET NULL` | Audyt interwencji wymaga minimalizacji lub zachowania zgodnego z polityką audytu przed usunięciem aktorów. |
| `audit_events` | użytkownik aktora `SET NULL`, tenant `RESTRICT` | Nie usuwać zdarzeń przez publiczny endpoint. Przed purge sprawdzić, czy historyczne metadane nie zawierają PII; nowy audyt nie może powielać identyfikatorów firmy. |
| `registry_result_cache` i budżety/dzienniki providerów | brak FK do importu/źródła; klucz NIP jest HMAC, rekordy współdzielą tenanty i dni | Purge firmy nie może zgadywać, że rekord należy wyłącznie do jednego importu. Ustalić bezpieczną retencję i referencje cache; nie zachowywać payloadu pozwalającego odtworzyć dane po purge. |

Najważniejsze kaskady obecnego schematu obejmują `automation_runs → run_source_rows/run_events/run_identities/oc_snapshots/oc_policies/export_artifacts/run_dispatch_outbox/run_manual_data_overrides/auth_challenges/manual_interventions`; `source_rows → regon_corrections/regon_enrichment_audits/entity_grouping_conflicts/source_entity_links`; oraz `import_batches → source_rows/import_preparations/import_preparation_workflows/enrichment_jobs/prepared_set_executions/automation_runs`. `run_submissions`, referencje encji kanonicznych, członkostwa i tenant mogą jednak zatrzymać operację.

## Magazyny poza relacyjną bazą

| Magazyn | Lokalizacja / dane | Wymagany purge |
| --- | --- | --- |
| Opublikowane XLSX | prywatny katalog `API_EXPORT_DIR/artifacts/<UUID>.xlsx`; `export_artifacts.storage_key` wskazuje metadane | Zweryfikować identyfikator i literalną ścieżkę w obrębie katalogu. Zapisać klucze plików w jobie przed usunięciem metadanych; obsłużyć plik brakujący i plik nadal współdzielony. |
| Staging wyniku workera | szyfrowane pliki `<UUID>.stage` w katalogu `RESULT_STAGING_DIR` | Zatrzymać delivery, utrwalić listę, usuwać idempotentnie po checkpointach; błędny klucz/hash nie może być uznany za sukces purge. |
| Kolejki i cache runtime | Redis/BullMQ | Zatrzymać joby z wybranego zakresu i usunąć wiadomości pomocniczo. Trwała bariera w PostgreSQL musi nadal odrzucać stare wiadomości po restarcie/restore. |
| Rejestry zewnętrzne | MF/GUS | To cache odpowiedzi, budżet i pacing bez FK do źródła; nie są dowodem skasowania importu. Zdefiniować politykę czyszczenia payloadów, bez naruszania globalnych limitów lub pacingu. |
| Oryginalny upload XLSX | `ImportService.create` zapisuje nazwę/hash i sparsowane `source_rows`, nie archiwizuje oryginalnych bajtów pliku | Brak trwałego pliku uploadu do usunięcia w obecnym kontrakcie; ponownie sprawdzić, jeśli pojawi się archiwizacja źródła. |
| Snapshot runu | `automation_runs.input_snapshot` (migracja 039), w tym dane wejściowe osoby/podmiotu | Wrażliwy payload trzeba usunąć nawet wtedy, gdy odłączany jest `source_row_id`; nie wolno pozostawić go przez cascade lub logi. |

## Bariery i wnioski do kontraktu

1. Scope `artifact`, `run` i `import` mają trwałe joby/tombstones, bariery historii/downloadu/finalizera, retry workera oraz zewnętrzny HMAC journal (`050`) sprawdzany przy admission API. Worker uzgadnia osierocony plik staging terminalnego runu dopiero po wygaśnięciu lease; ten reconcile nie jest jeszcze częścią joba purge. Nie ma jeszcze tenant purge ani pełnej bariery/checkpointu dla żywego runu portalowego; journal obejmuje obecnie trzy obsługiwane scope.
2. Przyjęcie wyniku lub utworzenie pliku może wyprzedzić commit metadanych. Kasowanie i reconcile muszą rozróżniać plik aktywnej publikacji od osieroconego.
3. `run_source_rows` oraz submission/canonical references umożliwiają współdzielenie. Usunięcie importu ma odłączyć tylko jego referencje; usuwać run dopiero po ponownym, transakcyjnym sprawdzeniu, że zakres nie ma innych właścicieli.
4. Usunięcie wszystkich danych firmy nie może usuwać kontenera, globalnych sekretów ani schematu. Lokalny tenant i minimalny dowód operacji pozostają, chyba że osobna procedura administracyjna stanowi inaczej.
5. Podgląd musi zwracać zakresy i liczności bez ujawniania zasobów innego tenanta, wiązać fingerprint z wersją celu i wygasać. Start purge ponownie oblicza fingerprint pod blokadą.
6. Samo hasło potwierdzone przez obecne `/auth/change-password` nie jest tokenem step-up: rotuje sekret i unieważnia sesje. Potrzebny jest osobny, jednorazowy, krótkotrwały token powiązany z użytkownikiem, tenantem, sesją, rewizją poświadczeń i dokładnym fingerprintem podglądu.
7. Endpoint preview/step-up/job działa dla zakresów `artifact`, `run` i `import`. Import-scope odmawia startu przy aktywnych zadaniach, submissions, współdzielonych runach, oczekujących eksportach i stagingu; bariery zapisu pozostają zamknięte również przy `manual_required`.
8. Pozostają niewdrożone: tenant-wide purge, purge stagingu/Redis/cache i pozostałych payloadów w zleceniach usuwania, pełny przegląd/scrub logów i cross-store reconcile pozostałych magazynów. Fault injection pokrywa awarię po unlinku artefaktu przed zatwierdzeniem DB oraz awarię późniejszego wpisu replay po wcześniejszym commit/checkpoint; retry zaczyna od pierwszego niezatwierdzonego wpisu. Pozostałe checkpointy purge/replay i kopie z różnych epok nadal wymagają testów. HMAC journal jest wdrożony dla artifact/run/import i używany do lokalnego replay; nie należy jeszcze wyciągać wniosku, że wystarcza do odtworzenia tenant-wide purge.

## Odbiór tej inwentaryzacji

- [x] Zmapowano istotne FK i wskazano `RESTRICT` oraz zależności współdzielone.
- [x] Wskazano pliki, staging, Redis i dane/cache bez FK.
- [x] Potwierdzono, że oryginalny XLSX nie jest obecnie trwale przechowywany.
- [x] Rozdzielono obserwacje lokalnego schematu od elementów jeszcze niezaimplementowanych.
- [ ] Przed purge tenanta powtórzyć katalogowy przegląd całego schematu `001–051` i pokryć każdą tabelę jobem albo uzasadnioną regułą zachowania; osobno sprawdzić retencję audytu, `RESTRICT`, blokadę nowych zapisów, staging i kolejki.
