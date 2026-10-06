# Katalog i historie platformy Goldis

## Ścieżki

- `/` pokazuje katalog narzędzi po logowaniu. Niezalogowany użytkownik zachowuje ekran logowania.
- `/tools/oc-policy-verification` otwiera istniejący workspace OC.
- `/imports` pokazuje dozwolone importy i stan wierszy wymagających przeglądu.
- `/imports/:id` wraca do danego importu. API sprawdza zakres zanim UI pobierze szczegóły i wiersze.
- `/runs` pokazuje historię zadań. Stary `GET /api/runs?batchId=...` nadal zwraca tablicę i służy istniejącemu workspace.
- `/runs/:id` wraca do szczegółu zadania.
- `/results` pokazuje `completed` i `no_matching_policies`; przypadek bez aktualnych polis jest jawnym wynikiem z licznikami i bez artefaktu.

## API kolekcji

Nowe listy: `GET /api/imports`, `GET /api/history/runs` i `GET /api/history/results`. Odpowiedź to `{ items, nextCursor }`. `limit` domyślnie wynosi 50 i ma zakres 1–100. Kolejność jest stabilna: `created_at DESC, id DESC`. Kursor zawiera wersję, znacznik czasu, UUID ostatniego rekordu i SHA-256 z filtra. Kursor należy odrzucić po zmianie filtrów.

Wspólne filtry runów i wyników: `toolId`, `batchId`, `status`, `from`, `to`, `cursor`, `limit`. `from`/`to` muszą być pełnym ISO 8601 ze strefą i mieć poprawną datę kalendarzową. Status historii wyników może być tylko `completed` albo `no_matching_policies`.

Importy przyjmują `toolId`, `from`, `to`, `dataState=all|ready|needs_review`, `cursor`, `limit`. `dataState` wynika z bieżących źródeł przeglądu: problemów w wierszach, pustego REGON-u operacyjnego, oczekującej korekty i otwartego konfliktu. `reviewCount` może się zmienić od poprzedniego odczytu, bo dane przeglądu są operacyjne.

Wiersz historii importu zwraca `id`, `toolId`, `fileName`, `totalRows`, `reviewCount`, `createdAt`, `ownerLabel`. Run zwraca `id`, `batchId`, `rowNumber`, `toolId`, `status`, `referenceDate`, `errorCode`, `createdAt`. Wynik dodaje `policyCounts` i `artifactAvailable`. Kolekcje nie ujawniają zawartości Excel, identyfikatorów osobowych ani pełnego PESEL-u.

## Zakres danych

Kolekcje najpierw sprawdzają rolę przez `PermissionGuard`, a następnie filtrują rekordy w SQL przed kursorem i limitem:

- admin: zasoby aktywnego tenanta;
- operator: własne importy z aktualnym grantem wyników;
- reviewer: importy tenanta z aktualnym grantem wyników;
- auditor: bez kolekcji operacyjnych.

Odczyt list zależy od `can_view_results` lub `can_download_results`, a nie od samej widoczności kafla (`can_discover`). Operator nie otrzymuje zadań innego właściciela przez przypisanie SMS; ten specjalny odczyt pozostaje w istniejącym endpointcie interwencji. Stary/legacy import bez tenant membership jest ukryty do czasu jawnego przypisania właściciela przez istniejącą procedurę bootstrap.

`artifactAvailable` oznacza, że artefakt jest gotowy do pobrania, nie że użytkownik ma grant download. Link w UI zależy od `canDownloadResults`; endpoint download ponownie sprawdza grant i zakres runu.

## Odbiór

Test `history.test.ts` sprawdza generowane scope SQL, bindy, brak pól wrażliwych, jawny zerowy wynik i kursor. Test HTTP sprawdza login/rolę i kolekcję przez guard z syntetycznym serwisem. Smoke UI działa na produkcyjnym buildzie Next.js z podmienionymi odpowiedziami API. Żaden z nich nie zastępuje izolowanego PostgreSQL.

Przed uznaniem kolekcji za odebrane uruchom na syntetycznym PostgreSQL testy admin/operator A/operator B/reviewer/auditor, cross-tenant, revoked grant, import legacy, powtarzające się `created_at`, strony bez duplikatów i `EXPLAIN ANALYZE` dla każdej listy. Dopiero z tych pomiarów podejmij decyzję o migracji indeksów. Nie używaj lokalnej bazy na 5432 bez jawnego potwierdzenia izolacji.
