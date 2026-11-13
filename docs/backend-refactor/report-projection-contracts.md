# Kontrakty projekcji Reports

Stan po wydzieleniu odczytów, 2026-10-16. Reports jest właścicielem zapytań projekcyjnych i prezentacji odpowiedzi. Nie przejmuje modelowania ani zapisów tabel należących do Imports, Leads, Runs, Results, Identity lub Notifications.

Każde repozytorium pobiera połączenie przez provider `API_DATABASE` i zwraca typowane wiersze projekcji. Reguły wejścia, odmowy dostępu i mapowanie odpowiedzi pozostają w serwisach. Zapytania wiążą wartości przez replacements Sequelize.

| Projekcja | Tabele odczytywane | Zakres i dostęp |
| --- | --- | --- |
| Historia importów, runs i wyników | `import_batches`, `automation_runs`, `source_rows`, `regon_corrections`, `entity_grouping_conflicts`, `oc_snapshots`, `oc_policies`, `export_artifacts`, `users`, `tools`, `resource_tombstones` | `operationalCollectionScope` wymusza tenant i widoczność wyników według roli, właściciela lub grantu. Kursor sortuje stabilnie po `(created_at, id)`. Bariery importu, runu i artefaktu ograniczają tombstone do tenanta batcha. Run musi należeć do batcha tego samego tenanta. Serwis waliduje filtry i stan `dataState`. |
| Dashboard | `result_sets`, `business_leads`, `import_batches`, `tools`, `user_notifications`, `resource_tombstones` | Odczyty operacji i leadów wiążą tenant oraz użytkownika. Metryki zespołu są pobierane tylko dla managera/admina z aktywnym grantem `view_results`. Operacje i powiadomienia respektują bariery usuwania. |
| Raport kontaktów | `business_leads`, `result_sets`, `tenant_memberships`, `users`, `resource_tombstones` | Serwis dopuszcza managera/admina z `view_results`. Każde połączenie tabel jest ograniczone tenantem; zakres dat jest półotwarty `[from, to)`, a tombstone importu jest sprawdzany w tenantcie operacji. Opcjonalny `resultSetId` jest walidowany przed odczytem. |
| Raporty administracyjne i audyt | audyt, importy, runy, leady, wyniki/artefakty, interwencje, grupowanie i enrichment | Serwis ogranicza żądania do roli administracyjnej lub jawnego zakresu operacyjnego. Zapytania wiążą `tenantId`; przegląd audytora zawęża kategorie i zasoby, a przegląd recenzenta stosuje listę dozwolonych zdarzeń oraz bieżące granty narzędzi. Wymiary liczników nie ujawniają danych osobowych rekordu. |

Testy jednostkowe repozytoriów sprawdzają replacements, zakres actor/tenant, granty, kursor i bariery usuwania. `test:module:audit-reports` przechodzi. Wykonanie `test:module:reports` na izolowanym PostgreSQL pozostaje niepotwierdzone: lokalny Docker Engine nie był dostępny 2026-10-16. Ten brak nie jest PASS testu DB.
