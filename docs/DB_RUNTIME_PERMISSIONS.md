# Prawa runtime PostgreSQL

## Role

| Rola | Proces | Właściciel DDL | DML / dostęp |
| --- | --- | --- | --- |
| `goldis_migrator` | migracje oraz jednorazowy bootstrap pierwszego administratora | Tak, `public` i obiekty aplikacji | Pełne prawa wynikające z własności; nie jest przekazywana procesom działającym stale |
| `goldis_api` | API HTTP | Nie | Jawna lista tabel aplikacji; dzienniki `audit_events` i `run_events` są tylko do odczytu i dopisywania; statusy workerów tylko do odczytu |
| `goldis_worker` | automat portalowy | Nie | Tabele runów, wejść/snapshotów, identyfikacji, outbox, SMS/interwencji i własnego heartbeat |
| `goldis_enrichment` | worker MF VAT / REGON | Nie | Tabele kolejek enrichment, źródła/korekty/grupowania/cache i własnego heartbeat; kolumnowy odczyt statusu użytkownika, członkostwa i grantów |

Wszystkie role runtime są `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`, nie należą do innych ról i nie mają `CREATE` w `public`. `PUBLIC` nie ma `CONNECT`, `CREATE` ani praw do tabel, sekwencji i funkcji aplikacji. Rola migratora nie dostaje uprawnień twórcy ról ani bazy.

## Macierz DML

Wersjonowany, wykonywany po każdej migracji kontrakt znajduje się w [`docker/postgres/apply-runtime-grants.sql`](../docker/postgres/apply-runtime-grants.sql). Skrypt najpierw cofa wcześniejsze prawa, następnie nadaje poniższe jawne prawa. Nie ma `ALTER DEFAULT PRIVILEGES ... GRANT` dla runtime; nowa tabela pozostaje zamknięta, dopóki nie zostanie dodana do macierzy.

| Rola | Tabele | Prawa |
| --- | --- | --- |
| API | Wszystkie tabele aplikacyjne poza wymienionymi niżej dziennikami i heartbeatami | `SELECT, INSERT, UPDATE, DELETE` |
| API | `audit_events`, `run_events` | `SELECT, INSERT` |
| API | `worker_runtime_status`, `enrichment_worker_runtime_status` | `SELECT` |
| API | sekwencje istniejące po migracji | `USAGE, SELECT, UPDATE` |
| portal worker | `automation_runs` | `SELECT, UPDATE` |
| portal worker | `source_rows`, `run_source_rows`, `run_manual_data_overrides`, `oc_snapshots` | `SELECT` |
| portal worker | `run_identities` | `SELECT, INSERT, UPDATE` |
| portal worker | `run_events` | `SELECT, INSERT` |
| portal worker | `manual_interventions`, `auth_challenges`, `run_dispatch_outbox` | `SELECT, INSERT, UPDATE` |
| portal worker | `worker_runtime_status` | `SELECT, INSERT, UPDATE, DELETE` |
| enrichment | `enrichment_jobs` | `SELECT, UPDATE` |
| enrichment | `enrichment_job_items`, `enrichment_worker_slots` | `SELECT, UPDATE` |
| enrichment | `enrichment_worker_runtime_status` | `SELECT, INSERT, UPDATE, DELETE` |
| enrichment | `import_batches`, `automation_runs`, `run_source_rows`, `regon_corrections`, `entity_grouping_conflicts` | `SELECT` |
| enrichment | `users(user_id,status)`, `tenant_memberships(tenant_id,user_id,role,status)`, `tools(tool_id,status)`, `tool_grants(tenant_id,tool_id,user_id,can_execute)` | `SELECT` tylko wymienionych kolumn |
| enrichment | `source_rows` | `SELECT, UPDATE` |
| enrichment | `regon_enrichment_audits` | `SELECT, INSERT` |
| enrichment | `registry_lookup_cache`, `registry_result_cache`, `registry_provider_daily_budgets`, `registry_provider_request_pacing` | `SELECT, INSERT, UPDATE`; dodatkowo `DELETE` tylko dla wygasłych wpisów `registry_result_cache` |
| enrichment | `canonical_entities` | `SELECT, INSERT, UPDATE` |
| enrichment | `source_entity_links`, `entity_grouping_conflicts` | `SELECT, INSERT` |

API jest granicą autoryzacji produktu, dlatego ma jawne prawa do wszystkich obszarów produktu. Worker portalowy nie może odczytać `users`, sesji, członkostw, grantów, `tool_settings` ani tokenów potwierdzających. Enrichment nie dostaje całej tabeli `users` ani prawa do zmiany runów i zdarzeń. Nowa migracja z nową tabelą lub sekwencją wymaga wpisu w SQL i aktualizacji tego dokumentu.

## Wdrożenie i kontrola

`ensure-runtime-roles.sh` można uruchomić wielokrotnie: odświeża hasła i flagi ról, usuwa odziedziczone członkostwa i wcześniejsze granty oraz przenosi istniejące relacje/widoki/funkcje z poprzedniego właściciela `goldis` do migratora. Nie usuwa ani nie przebudowuje danych. Po `migrate.js` uruchom `apply-runtime-grants.js` jako `goldis_migrator`; Compose i lokalny start wykonują oba kroki w tej kolejności.

`apps/api/scripts/runtime-permissions-smoke.cjs` sprawdza flagi ról, brak praw DDL, odmowę odczytu `users.password_hash` dla obu workerów, append-only dzienniki, prawa wykonania i źródła. Test wymaga osobnej, jednorazowej bazy z migracjami i zastosowaną macierzą; nie wolno kierować go do bazy produkcyjnej.
