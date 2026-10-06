# Dziennik audytu platformy

## Zakres

`GET /api/audit/events` udostępnia stronicowany dziennik zdarzeń tenanta. W odpowiedzi nie ma metadanych audytu ani treści plików. UI pokazuje czas w `Europe/Warsaw`, aktora, nazwę akcji, typ i identyfikator zasobu oraz wynik.

Filtry: wymagane `from` i `to` w ISO 8601 ze strefą; zakres rosnący, maksymalnie 90 dni; opcjonalne `actorId`, `action`, `resourceType`, `resourceId`, `outcome`, `toolId`, `limit` (domyślnie 50, zakres 1–100) i `cursor`. Daty są walidowane kalendarzowo, a UI przelicza dni warszawskie na granice czasu z uwzględnieniem zmiany czasu. Filtry formularza są stosowane po wysłaniu, nie przy każdym wpisanym znaku. Kursor jest keysetem `(created_at DESC, event_id DESC)`, związanym skrótem z tenantem, rolą, użytkownikiem reviewera, zakresem i pozostałymi filtrami. Zmiana filtrów albo roli unieważnia stary kursor.

## Dostęp

- Administrator czyta zdarzenia całego swojego tenanta.
- Auditor otrzymuje wyłącznie dziennik swojego tenanta i nie potrzebuje dostępu do `/admin` ani do historii operacyjnych.
- Reviewer otrzymuje wyłącznie jawnie dozwolone akcje operacyjne. SQL ogranicza każdy wpis do importu, zadania, pliku, interwencji lub korekty w narzędziu, dla którego reviewer ma aktualny grant `can_view_results` albo `can_download_results`. Filtry akcji i zasobu wskazujące konto, sesję, ustawienia lub inne niedozwolone kategorie są odrzucane kodem 400. Ograniczenie działa również wtedy, gdy klient wyśle bezpośrednie żądanie poza UI.
- Operator nie ma `audit:read`; guard odmawia przed uruchomieniem zapytania listującego.

Zapytanie zawsze ogranicza `tenant_id` przed filtrowaniem, kursorem i limitem. UI nie renderuje `metadata` ani `requestRef`. Brak dostępu, błąd usługi i pusta lista mają odrębne stany.

## Testy

- `audit-search.http.test.ts`: sesja, administrator/recenzent/audytor/operator, tenant scope, reviewer allowlist i grant SQL, odmowa niebezpiecznych filtrów, kursor oraz niezgodność kursora z filtrami.
- `audit-ui-smoke.cjs`: role reviewer/auditor/operator, ograniczone filtry, warszawski zakres dat z wyłącznym początkiem następnej doby, paginacja, przycisk wstecz i szerokość 375 px.
- Testy API używają syntetycznych wyników i mocka `sequelize.query`; UI używa Playwrighta i syntetycznego API.

Rzeczywista baza PostgreSQL, plan zapytania i testy izolacji tenantów/grantów pozostają częścią odbioru DB/HTTP w izolowanym środowisku.
