# Plan implementacji administracji platformą Goldis

Stan rozpoznania: 2 października 2026. Dokument jest specyfikacją wykonawczą dla kolejnego agenta kodującego. Nie oznacza, że opisane funkcje są już wdrożone lub odebrane.

## 0. Cel, znaczenie zasobów i granice

Goldis jest platformą dostępu do **narzędzi**, ich uruchomień oraz wyników zapisanych w systemie. Pierwszym narzędziem jest automatyzacja weryfikacji polis OC. Słowo „zasób” w tym planie oznacza narzędzie, import, zadanie, interwencję, wynik lub artefakt. Fizyczne komputery pracowników nie są jednostką przydziału danych. W obszarze bezpieczeństwa „urządzenie” oznacza jedynie przeglądarkę/sesję, którą można rozpoznać i wylogować. Profil Chromium workera oraz „Zapamiętaj to urządzenie” w portalu PZU są odrębną sprawą techniczną i nie nadają uprawnień do platformy.

Cel: administrator ma móc określić, kto widzi katalog narzędzi, kto może uruchomić konkretne narzędzie, kto widzi jego importy i wyniki, kto pobiera pliki, a także nadzorować konta, sesje, pracę automatyzacji, interwencje, audyt i jakość. **Nie wolno przyznawać dostępu do danych tylko dlatego, że ktoś widzi kafel narzędzia.** Wszystkie decyzje egzekwuje API.

Zakres jednej organizacji (`tenant` Goldis) na pierwszy etap. Schemat pozostaje zgodny z istniejącym `tenant_id`, ale nie budować teraz samodzielnej administracji wieloma organizacjami. Nie implementować przechowywania sekretów portali w panelu, edytora selektorów Playwright, zdalnego sterowania Chromium ani samodzielnego restartowania kontenerów z UI. Wdrożenie produkcyjne automatyzacji live ma nadal osobne bramki z istniejących planów.

## 1. Stan repozytorium, który trzeba zachować

1. `apps/api/src/authorization-policy.ts` ma role `admin`, `operator`, `reviewer`, `auditor` i zakres `tenant`/`owned`. `apps/api/src/authorization-guard.ts` wyznacza właściciela zadania przez import. Nie ma warstwy przydziału do narzędzia. `automation_runs.tool_id` już istnieje; `import_batches` nie ma `tool_id`.
2. `apps/api/src/migrations/015-users-memberships-audit.ts` tworzy użytkowników, członkostwa i audyt. `user:manage` jest deklaracją uprawnienia, ale brak kontrolera użytkowników i panelu administracji. Bootstrap tworzy pierwszego administratora tylko przy pustej tabeli użytkowników (`bootstrap-admin.ts`).
3. `apps/api/src/session.ts` wydaje podpisany cookie na 8 godzin, sprawdza aktywnego użytkownika i rolę w bazie przy żądaniu, a logout czyści bieżące cookies. Nie istnieje rejestr sesji umożliwiający wylogowanie innych przeglądarek. Login ma limiter Redis.
4. Istnieją: `GET /api/health/live`, `/ready`, `/automation`; `worker_runtime_status`; kolejka/outbox i lease; `manual_interventions` z rewizją oraz stanem przeczytania; `audit_events`; listy uruchomień i pobieranie artefaktu. UI w `apps/web/app/workspace.tsx` jest jednym dużym ekranem, a część pozycji nawigacji jest tekstem.
5. Zweryfikować przed nowymi migracjami: migracja `018` wskazuje `users(id)`, podczas gdy migracja `015` tworzy `users(user_id)`; `019` ma tę samą rozbieżność. Świeża baza nie przejdzie przez `018` bez poprawy tych historycznych plików **przed ich pierwszym zastosowaniem**. Na bazie, gdzie migracje już zastosowano, nie przerabiać ich wstecz: najpierw odczytać faktyczny schemat i historię Umzug, a potrzebną naprawę wykonać nową migracją. Lista akcji w bazowym `audit_events` nie obejmuje wszystkich akcji z obecnego `audit.ts` (`run.auth_resumed`, `run.review_resumed`, `run.manual_data_corrected`); rozszerzyć ją nową migracją. Testować obie ścieżki: pustą bazę i kopię bazy zastanej.
6. Obecny odbiór pełnego DB/API/Redis/workera nie jest potwierdzony w `docs/STAN_IMPLEMENTACJI.md`. Nie wolno uznać testów modułowych za dowód end-to-end ani włączać `WORKER_LIVE_PORTALS=1` dla potrzeb tej pracy.

## 2. Decyzje projektowe, które przyjmujemy na start

| Temat | Reguła wykonawcza |
| --- | --- |
| Tożsamość narzędzia | Stały, niezmienny `tool_id`, obecnie `oc-policy-verification` (`packages/core/src/index.ts`, `apps/api/src/canonical-run-service.ts`); identyfikatora używa API, worker, import, zadanie i raporty. Nie wyprowadzać go z nazwy wyświetlanej. |
| Uprawnienia | Najpierw aktywne konto i członkostwo, potem rola, następnie przydział narzędzia, na końcu zakres konkretnego importu/zadania. Brak jawnego przydziału = odmowa dla ról innych niż administrator. |
| Administrator | Admin organizacji ma dostęp do wszystkich narzędzi i danych własnego `tenant`; nie przechodzi granicy organizacji. Jego operacje wrażliwe są audytowane. Nie umożliwić usunięcia/wyłączenia ostatniego aktywnego admina. |
| Przydział | Pierwsza wersja: bezpośredni przydział użytkownikowi. Model może później obsłużyć zespoły, ale nie dodawać ich „na zapas”. Przydział ma osobne flagi `discover`, `execute`, `view_results`, `download_results`; `execute` implikuje `discover`, `download_results` implikuje `view_results`. |
| Własność danych | Operator nadal ma dostęp tylko do własnych importów/zadań. Przydział narzędzia **nie** otwiera cudzych danych. Reviewer może czytać dane w organizacji tylko dla przydzielonego narzędzia i rozstrzygać zgodnie z rolą. Auditor widzi audyt, bez importów i wyników. |
| Stare dane | Backfill `tool_id` importów wykonuje się deterministycznie: dla importów związanych tylko z obecnym narzędziem ustawić jego `tool_id`; importy z niejednoznaczną relacją zatrzymać w raporcie migracji i nie migrować „na ślepo”. Zachować historyczne prawa właściciela, ale nadać mu jawny grant w migracji dla obecnego narzędzia. |
| Cofnięcie dostępu | Odmowa przy następnym żądaniu API, w tym odczycie wyniku i pobraniu. Aktywne zadanie automatyzacji nie jest automatycznie anulowane; admin widzi je i może zdecydować. Otwarte interwencje po odebraniu przydziału przechodzą do puli admina. |
| Czas | Daty przechowywać w UTC, UI pokazuje strefę `Europe/Warsaw`; okresy raportów interpretować według tej strefy i opisać granice `from` włącznie, `to` wyłącznie. |
| Konfiguracja | Sekrety/selektory pozostają w konfiguracji wdrożenia. Ustawienia w bazie dotyczą tylko bezpiecznych parametrów operacyjnych z listy dozwolonej. |

## 3. Docelowa macierz dostępu

Uprawnienia muszą być sprawdzane po stronie serwera **dla każdego** endpointu listy, szczegółu, interwencji, challenge i pliku. UI może ukrywać akcje, lecz odpowiedź API jest źródłem prawdy. Rozdzielić uprawnienie roli od przydziału narzędzia; nie zastępować istniejącego `owned` samym `tool_id`.

| Czynność | Admin | Operator | Reviewer | Auditor |
| --- | --- | --- | --- | --- |
| Katalog narzędzi | Wszystkie | `discover` | `discover` | Brak, chyba że jawna funkcja audytu narzędzia |
| Import i start zadania | Wszystkie | `execute`, własny import | Nie | Nie |
| Odczyt importu/zadania/wyniku | Wszystkie | `view_results`, własne | `view_results`, organizacja | Nie |
| Pobranie pliku | Wszystkie | `download_results`, własny | Domyślnie nie, nawet przy `view_results` | Nie |
| SMS | Wszystkie | `execute` i własne zadanie, wciąż zgodnie z obecną polityką | Nie | Nie |
| Korekty/rozstrzygnięcia | Wszystkie | Propozycja na własnych danych | Zatwierdzenie w przydzielonym narzędziu | Nie |
| Interwencje | Wszystkie | Własne lub przypisane, pod warunkiem dostępu do zadania | Odczyt w przydzielonym narzędziu; rozstrzygnięcie tylko według rodzaju i roli | Nie |
| Audyt | Wszystkie | Nie | Tylko zdarzenia dotyczące danych przydzielonego narzędzia; bez audytu kont, sesji i ustawień | Audyt w organizacji bez danych operacyjnych |
| Użytkownicy, granty, sesje innych, ustawienia | Wszystkie | Nie | Nie | Nie |

Granice HTTP: 401 bez sesji; 404 dla nieistniejącego, obcego tenantowi, cudzej własności lub niedostępnego narzędzia, gdy identyfikator zasobu mógłby ujawnić jego istnienie; 403 dla zabronionej czynności na zasobie, do którego użytkownik ma już prawo wglądu. Lista ma po prostu pominąć niedostępne pozycje. Zasady potwierdzić testami `GET` i bezpośredniego URL, nie tylko widocznością przycisku.

## 4. Kontrakty danych i migracje

Każdą migrację pisać addytywnie i wykonywać na izolowanej kopii; kolejny numer po `020` wybrać po sprawdzeniu drzewa migracji w chwili pracy. Dodać indeksy, FK, `CHECK` i test ponownego uruchomienia. Nie zakładać, że wszystkie migracje `001`–`020` są zastosowane na działającej bazie.

### 4.1. Katalog i przydziały

1. `tools`: `tool_id VARCHAR(80) PK`, `display_name`, `description`, `status` (`available`, `maintenance`, `disabled`), `sort_order`, `created_at`, `updated_at`. Zasiać `oc-policy-verification` migracją; ID zgodne z `automation_runs.tool_id`. Status katalogu nie uruchamia sam z siebie workera. Obecny kontrakt `@goldis/core` akceptuje tylko to narzędzie; dodanie kolejnego wymaga nowego modułu, typów i obsługi worker/API, a nie samego wpisu w tabeli.
2. `tool_grants`: `tenant_id`, `tool_id`, `user_id`, cztery flagi uprawnień, `granted_by`, `created_at`, `updated_at`, `version`; PK `(tenant_id, tool_id, user_id)`. FK do `tenant_memberships(tenant_id,user_id)`, `tools(tool_id)` i użytkownika przyznającego. Ograniczenia implikacji flag. Grant wygasa logicznie wraz z nieaktywnym członkostwem, a usunięcie grantu audytować. Nie dodawać wrażliwego wolnego tekstu do tej tabeli.
3. Dodać `tool_id` do `import_batches`, backfill i kontrolę relacji. Po potwierdzeniu, że każde historyczne `import_batch` ma jedno narzędzie, ustawić `NOT NULL` i FK. Zadanie musi mieć `tool_id` równy narzędziu importu; egzekwować w serwisie transakcyjnie oraz testem, ewentualnie triggerem DB, jeśli inne procesy tworzą run poza API.
4. Nadać jawne granty obecnym aktywnym operatorom/recenzentom do pierwszego narzędzia tylko po inwentaryzacji kont i ich obecnego zakresu. Dla nowych użytkowników brak grantów. Zapisać w dzienniku migracji liczbę nadanych grantów, bez nazwisk/identyfikatorów biznesowych.
5. Każdy nowy moduł narzędzia ma dodać wpis w katalogu, swój `tool_id` w imporcie i zadaniu, mapę wspieranych akcji oraz testy autoryzacji. Nie używać ogólnego grantu „wszystkie przyszłe narzędzia” dla operatorów.

### 4.2. Sesje i bezpieczeństwo kont

1. `user_sessions`: `session_id UUID PK` (losowy identyfikator), `tenant_id`, `user_id`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `revoked_by`, `revoke_reason`, opcjonalnie skrót IP i bezpieczny skrót User-Agent do opisu sesji. W DB nie zapisywać pełnego cookie ani CSRF. FK i indeks `(user_id, revoked_at, expires_at)`.
2. W podpisanym cookie umieścić wersję formatu, `session_id`, `tenant_id`, termin i losowy CSRF; guard sprawdza podpis, termin oraz aktywny wiersz sesji po stronie serwera i bieżące konto/członkostwo. `logout` unieważnia wiersz bieżącej sesji, a dopiero potem czyści cookie. Redis można użyć jako cache, ale baza jest źródłem prawdy; awaria cache nie może przywrócić cofniętej sesji. `last_seen_at` aktualizować z ograniczoną częstością, aby nie wykonywać zapisu przy każdym pollingowym GET. Zachować `HttpOnly`, `Secure` w produkcji, `SameSite=Strict`, CSRF i ochronę Origin. Rotacja formatu cookie wymaga świadomego wygaszenia starych sesji.
3. `user_security_events` nie jest potrzebne jako druga kopia audytu; zdarzenia loginu, wylogowania, cofnięcia sesji, zmiany hasła i uprawnień trafiają do `audit_events`. Uzupełnić ograniczenie dozwolonych akcji w DB i typ `AuditedAction` w jednym wydaniu.
4. Admin może wyłączyć konto, zmienić rolę, ustawić hasło tymczasowe przez jednorazowy bezpieczny przepływ i cofnąć sesje; użytkownik może zmienić własne hasło po podaniu obecnego. Nie generować ani nie wysyłać haseł mailem z aplikacji. Zmiana hasła/roli/statusu cofa wszystkie wcześniejsze sesje w tej samej transakcji lub z gwarantowanym krokiem fail-closed.
5. Ochrona ostatniego admina przy konkurencyjnych żądaniach: blokada właściwych wierszy członkostwa i transakcyjny check. Operacja na sobie samym nie może pozostawić organizacji bez admina. Admin nie powinien móc cofnąć własnej bieżącej sesji bez czytelnego ostrzeżenia w UI; API nadal zachowuje spójność.

### 4.3. Przydział interwencji

1. Rozszerzyć `manual_interventions`: `assignee_user_id NULL`, `priority` (`normal`, `high`), `due_at NULL`, `assigned_at`, `assigned_by`, opcjonalnie `assignment_version`; indeks `(status, assignee_user_id, priority, created_at)` i FK. Nie zmieniać istniejących statusów `open/resolved/cancelled/expired` na podstawie samego przypisania.
2. `intervention_activity`: `activity_id`, `intervention_id`, `actor_user_id`, `event_type` (`assigned`, `unassigned`, `priority_changed`, `note_added`, `resolved`), `created_at`, **bezpieczna** notatka o ograniczonej długości. Ponieważ notatka może przypadkowo zawierać PESEL/SMS, dla MVP lepiej użyć kodów powodu i krótkiego komentarza filtrowanego przed zapisem; brak swobodnego tekstu jest dopuszczalny, jeżeli nie da się zagwarantować jego bezpieczeństwa. Historia audytu przechowuje tylko identyfikatory i rodzaj zmiany.
3. Jedno otwarte zgłoszenie na run pozostaje źródłem prawdy. `intervention_user_reads` oznacza wyłącznie przeczytanie; przydział i rozwiązanie to osobne operacje. Ponowny timeout SMS aktualizuje rewizję tego samego zgłoszenia i powiadamia przypisanego oraz admina.

### 4.4. Ustawienia i raporty

1. `tool_settings`: `(tenant_id, tool_id)` PK, `enabled_for_new_runs`, `max_new_runs_per_hour`, `allowed_local_start`, `allowed_local_end`, `timezone`, `updated_by`, `updated_at`, `version`. W pierwszej wersji dopuszczać tylko parametry faktycznie egzekwowane przez API i worker. Jeśli ograniczenie tempa wymaga osobnego liczników/Redis, dostarczyć je razem z UI. Nie obiecywać zatrzymania aktywnego procesu przez zmianę ustawienia.
2. `automation_control_events` nie jest konieczne przy zdarzeniach audytu; każda zmiana ustawień ma wpis `settings.updated` i poprzednią/nową *bezpieczną* wartość tylko wtedy, gdy przejdzie kontrolę metadanych. Nie zapisywać loginów, haseł, selektorów, cookies ani ścieżek profilu.
3. Raporty czytać ze źródeł `automation_runs`, `run_events`, `manual_interventions`, `audit_events`, `export_artifacts`. W pierwszym wydaniu nie dodawać tabeli agregatów; dodać indeksy pod potwierdzone zapytania. Agregaty dzienne/materializowane widoki dopiero po pomiarze czasu odpowiedzi na realnej skali.

## 5. Wspólny mechanizm autoryzacji: kolejność wdrożenia

1. Dodać serwis `ToolAccessService` i testowalną funkcję `authorize(action, principal, resource)`; decyzja zawiera rolę, grant i zakres właściciela. Centralna funkcja ma zwracać także bezpieczny powód odmowy do wewnętrznego audytu, bez ujawniania go klientowi.
2. Rozszerzyć `PermissionAction` o rozdzielone prawa `tool:discover`, `tool:execute`, `result:read`, `result:download`, `session:manage`, `settings:manage`, `operations:read`, `intervention:assign`, `reports:read`. Zachować kompatybilność istniejących akcji tam, gdzie to możliwe, i jawnie zmapować każdą trasę. Nie używać pojedynczego `user:manage` do wszystkich nowych funkcji.
3. Rozszerzyć resolver zasobu o `tool_id` z **bazy**, nie z body klienta. Dla runu: `run -> batch -> tenant/owner/tool`; dla interwencji: `intervention -> run -> batch`; dla artefaktu: `artifact -> run -> batch`; dla importu: bezpośrednio z `import_batches`. Jeśli `run.tool_id` i `batch.tool_id` się różnią, zwrócić błąd spójności 503 i alarm administracyjny, nie wybrać jednego losowo.
4. W metodach listujących stosować predykat `tenant + allowed tool_ids + ownership` w SQL przed paginacją i liczeniem. Nie pobierać pełnej listy, aby odfiltrować ją w React. Paginacja musi być stabilna także po cofnięciu grantu.
5. Zabezpieczyć wszystkie wejścia: import, wiersze, enrichment, grupy/konflikty, runy, SMS, ręczne dane, interwencje, download, przyszłe raporty. Wyjątki konta technicznego workera mają być osobną tożsamością serwisową, bez używania cookie użytkownika.
6. Dodać `GET /api/auth/me` z `role`, `tools` i dozwolonymi akcjami w bezpiecznym zakresie, aby UI nie zgadywał. Każda mutacja i pobranie nadal sprawdza uprawnienie w aktualnym stanie DB.
7. Przy odcięciu dostępu sprawdzić otwarte interwencje przypisane użytkownikowi. Usunąć przydział atomowo albo w trwałym zadaniu kompensacyjnym; nie zostawić zgłoszenia „prywatnie” ukrytego przed adminem.

## 6. API i ekrany według funkcjonalności

Kontrakty poniżej są docelowe; prefiks `/api` wynika z `main.ts`. Dla każdej mutacji: sesja, Origin/CSRF, walidacja JSON, kontrola wersji (`If-Match` lub `version` w body), transakcja, audyt, zwięzła odpowiedź. Dla list: limit maksymalny 100, stabilny kursor, whitelist filtrów i sortowań. Nie zwracać PESEL, sekretów, pełnego User-Agent ani ścieżek plików.

### A. Dostęp do zasobów

**API:** `GET /tools` (katalog po uprawnieniach), `GET /admin/tools`, `GET /admin/users/:id/grants`, `PUT /admin/users/:id/grants/:toolId` (pełny zestaw czterech flag + wersja), `DELETE /admin/users/:id/grants/:toolId`. Zmiana grantu loguje aktora, odbiorcę i tool ID; nie loguje danych biznesowych. Zwraca 409 przy starym `version` i 404 dla obcej organizacji.

**UI:** katalog narzędzi jako prawdziwa nawigacja; admin: macierz użytkownik × narzędzie z filtrem użytkownika/roli i szczegóły jednego użytkownika. Przy każdym prawie krótki opis konsekwencji. Osobno oznaczyć dostęp do cudzych danych (wynika z roli) i do plików (osobna flaga). Po zmianie uprawnień odświeżyć widok aktywnej sesji użytkownika przy następnym żądaniu.

**Działania kodera:** migracja katalogu i importów → serwis przydziałów → guard/resolver → wszystkie endpointy danych i listy → UI. Najpierw wdrożyć z trybem obserwacji na danych testowych; przełączyć na egzekwowanie dopiero po audycie backfillu grantów. Tryb obserwacji nie może trafić jako domyślny na produkcję.

### B. Sesje i bezpieczeństwo kont

**API:** `GET/POST /admin/users` (nowe konto domyślnie bez grantów), `GET/PATCH /admin/users/:id`, `POST /admin/users/:id/disable`, `POST /admin/users/:id/enable`, `POST /admin/users/:id/revoke-sessions`, `GET /admin/users/:id/sessions`, `POST /auth/change-password`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`. Reset hasła admina jako jednorazowy token o krótkiej ważności lub bezpieczny proces lokalny; implementować dopiero z kanałem dostarczenia tokenu. Na MVP dopuszczalne ręczne ustawienie hasła przez admina z obowiązkową zmianą przy pierwszym loginie, bez jego wyświetlania po zapisie.

**UI:** lista kont (rola, stan, ostatnie logowanie, liczba aktywnych sesji), ekran szczegółu z grantami, lista własnych sesji i „Wyloguj inne sesje”, akcja admina „Cofnij sesje”. Etykieta sesji: przybliżony typ przeglądarki i czas ostatniej aktywności; nie identyfikować urządzenia jako sprzętu z wysoką pewnością.

**Działania kodera:** dodać tabelę sesji → wydawanie nowego cookie → guard sprawdzający DB → cofanie → obsługa zmiany hasła/statusu/roli → UI. Wdrożenie formatu cookie zaplanować tak, aby stare cookie wygasły kontrolowanie; udokumentować, że użytkownicy będą musieli się ponownie zalogować. Zachować rate limit loginu i oddzielnie limit prób resetu/zmiany hasła.

### C. Centrum operacyjne

**API:** `GET /admin/operations/summary` z czasem odczytu i statusami API/DB/Redis/worker, trybem portali, ważnością konfiguracji, liczbą zadań `queued/running/waiting/completed/failed`, wiekiem najstarszego oczekującego, liczbą otwartych interwencji i lagiem outboxu. `GET /admin/operations/runs` z filtrami i paginacją; `GET /admin/operations/incidents` oparte na istniejących interwencjach. Nie ujawniać sekretów konfiguracji ani payloadu kolejki.

**UI:** widok „Operacje” z kartami stanu i znacznikiem „dane z [czas]”, nie udawać aktualności przy błędzie odświeżenia. Linki prowadzą do listy runów/interwencji z odpowiednim filtrem. Rozróżnić `usługi gotowe`, `worker online`, `portale włączone` i `automatyzacja gotowa`; to nie są równoważne stany. Dla awarii pokazać bezpieczny kod i praktyczny następny krok.

**Działania kodera:** wykorzystać `health.ts`, `worker_runtime_status`, run/outbox i interwencje; dodać brakujące agregaty po stronie serwera. Ustalić świeżość worker heartbeat zgodnie z aktualnym `health-readiness.ts`, nie tworzyć niezależnego timera w UI. Szczegóły administracyjne wymagają sesji admina; publiczne liveness/readiness pozostają minimalne.

### D. Interwencje i przydział pracy

**API:** rozszerzyć `GET /interventions` o `assignee`, `priority`, `overdue`, `toolId`, sort. `PATCH /interventions/:id/assignment`, `PATCH /interventions/:id/priority`, ewentualnie `POST /interventions/:id/activity` dla bezpiecznej notatki. Przydzielić można tylko aktywnemu użytkownikowi z dostępem do narzędzia i właściwą rolą dla rodzaju zgłoszenia; admin może być odbiorcą zawsze. `409` przy wyścigu rewizji lub zamkniętym zgłoszeniu.

**UI:** kolejka „Nieprzypisane”, „Moje”, „Wszystkie”, priorytet, czas powstania i termin; szczegół z historią. Odczyt nie rozwiązuje zgłoszenia. Przy zgłoszeniu SMS pokazać rzeczywisty `expiresAt` i nie pozwolić przydziałem przedłużyć challenge. Przy rozstrzygnięciu wymagającym danych ręcznych utrzymać istniejący kontrolowany `resume-review`.

**Działania kodera:** migracja pól i historii → transakcyjne przydzielenie z blokadą wiersza interwencji → lista SQL z autoryzacją → UI. Zachować unikalny otwarty incident na run i obecną logikę rewizji/nieprzeczytania. Po wyłączeniu konta lub cofnięciu grantu automatycznie odpiąć niezamknięte zgłoszenia.

### E. Ustawienia automatyzacji

**API:** `GET /admin/tools/:toolId/settings`, `PATCH /admin/tools/:toolId/settings` z `version`; tylko whitelist pól z tabeli `tool_settings`. Akcja `enabled_for_new_runs=false` blokuje utworzenie nowego runu w API, ale nie kasuje kolejki i nie zatrzymuje aktywnego ani wcześniej przyjętego runu. Limit/godziny sprawdzać atomowo podczas tworzenia nowego runu. Dispatcher publikuje już przyjęte dyspozycje niezależnie od późniejszej pauzy; inaczej ustawienie mogłoby bezterminowo uwięzić stare zadania.

**UI:** przełącznik nowych uruchomień, limit godzinowy, okno pracy i status skuteczności ustawienia. Pokazać osobno read-only status workera i portali. Pola sekretów oraz selektorów nie istnieją w UI. Zmiana ustawień wymaga świadomego potwierdzenia skutku, gdy są aktywne zadania.

**Działania kodera:** najpierw egzekwowanie w `RunService.create` i dispatcherze, potem formularz. Dla limitu godzinowego użyć atomowego licznika/DB z testem równoległych startów; samo policzenie runów, a następnie insert bez blokady, jest błędne. Okno pracy uwzględnia zmianę czasu w `Europe/Warsaw`; godzina końca jest wyłączna. Stan `WORKER_LIVE_PORTALS` i sekrety pozostają poza ustawieniem DB.

### F. Audyt z wyszukiwaniem

**API:** `GET /admin/audit?from&to&actorId&action&resourceType&resourceId&outcome&toolId&limit&cursor`. Dla audytora osobny dostęp do tego samego read-only endpointu z zakresem organizacji. Ograniczyć okres jednego zapytania (np. 90 dni), maksymalną stronę i dozwolone sortowanie `created_at DESC, event_id DESC`. `toolId` wynika z relacji do zasobu, nie z dowolnej metadanej.

**UI:** wyszukiwarka z filtrami, tabela: czas, aktor, czynność, rodzaj zasobu, identyfikator techniczny, wynik, odnośnik do zasobu tylko gdy użytkownik ma prawo go otworzyć. Brak pokazywania metadanych wrażliwych. Ewentualny eksport audytu dopiero z osobnym uprawnieniem, limitem i audytem eksportu.

**Działania kodera:** najpierw ujednolicić typy/DB constraint akcji i zapewnić zapis zdarzeń dla zarządzania dostępem, sesjami, przydziałami oraz ustawieniami. Potem paginowany odczyt; indeks `(tenant_id, created_at DESC, event_id DESC)` oraz dodatkowe indeksy po pomiarze filtrów. Wykryć istniejące luki audytu i je uzupełnić. Audyt nie może zawierać PESEL, NIP, REGON, SMS, haseł, cookies, tokenów, pełnych odpowiedzi portali ani nazw importowanych firm. Sukces wrażliwej mutacji i audyt muszą być atomowe.

### G. Raporty i jakość pracy

**API:** `GET /admin/reports/overview?from&to&toolId`, `GET /admin/reports/failures`, `GET /admin/reports/interventions`, `GET /admin/reports/throughput`. Maksymalny zakres dat, limity i agregacja w DB. Raport nie może pokazywać danych, których odbiorca nie mógłby zobaczyć w danych źródłowych. Na pierwszy etap tylko admin; nie nadawać automatycznie reporterowi nowej roli.

**Definicje liczb:** `utworzone` według `automation_runs.created_at`; `zakończone` według `finished_at` i statusu `completed`; `bez polis` to `no_matching_policies`, osobna kategoria, nie porażka; `błąd` to `failed`; `w toku` to pozostałe; `czas wykonania` liczony od `started_at` do `finished_at` tylko dla zakończonych, mediana i p90; `czas interwencji` od `created_at` do `resolved_at` tylko dla rozwiązanych, otwarte pokazać osobno; `skuteczność` = `completed / (completed + no_matching_policies + failed)` i wyświetlić licznik/mianownik. Nie mieszać runów utworzonych w okresie z ukończonymi w okresie w jednym procencie bez etykiety kohorty. „Pobrane wyniki” liczyć z audytu pobrań, a „wygenerowane” z artefaktów.

**UI:** zakres dat, narzędzie, karty KPI, wykres trendu dziennego, tabela kodów błędów i interwencji, opis definicji po najechaniu/otwarciu. Każdy wskaźnik prowadzi do przefiltrowanej listy, jeśli zakres jest zgodny. Małe próby pokazywać jako liczby, bez mylących procentów.

**Działania kodera:** najpierw ustalić testowe zbiory danych i oczekiwane liczniki, potem SQL agregatów i interfejs. Dodać indeksy tylko dla rzeczywistych filtrów. Sprawdzić deduplikację `run_events` i `audit_events`, aby retry nie zawyżało miar. Raporty nie mogą opierać się na samym obecnym ograniczeniu `runs.list` do 50 pozycji.

## 7. Kolejność prac i bramki dla agenta

Każdy etap kończy się aktualizacją `docs/POSTEP_IMPLEMENTACJI.md`: zakres kodu, migracje, uruchomione testy, wynik i otwarta blokada. Nie oznaczać bramki jako zaliczonej, jeśli środowisko nie pozwoliło jej uruchomić.

### Etap 0 — baza i stan wyjściowy

- [ ] Sprawdzić `git status`, aktualny numer migracji, obecną wartość `tool_id`, `docs/STAN_IMPLEMENTACJI.md` oraz skrypty testowe. Nie nadpisywać niezwiązanych zmian.
- [ ] Uruchomić `npm test`, `npm run build`, `npm run test:db-integration` na izolowanym środowisku, jeśli DB jest dostępna. Zanotować pominięcia i błędy środowiska.
- [ ] Zweryfikować w PostgreSQL migracje `018/019` i constraint audytu; przygotować addytywną naprawę oraz smoke od pustej bazy i od bazy po `015/020`.
- **Bramka E0:** świeża baza i baza aktualizowana migracją kończą na tym samym schemacie; nie ma niejawnych założeń o produkcyjnych danych.

### Etap 1 — katalog i kontrola dostępu

- [ ] Dodać katalog, granty, `tool_id` importu, bezpieczny backfill, indeksy i modele ORM.
- [ ] Dodać `ToolAccessService`, rozszerzyć `PermissionGuard`, listy i każdy endpoint pochodzący od importu/runu/artefaktu/challenge/interwencji.
- [ ] Dodać API admina do grantów, katalog `/tools` i UI. Testy bezpośrednich URL, list, paginacji, wycofania grantu w trakcie sesji, tenantów, właścicieli i zgodności `batch.tool_id/run.tool_id`.
- **Bramka E1:** operator bez przydziału nie widzi narzędzia ani wyników; operator z grantem widzi tylko swoje; admin widzi organizację; pobranie cudzych/nieprzydzielonych plików jest zablokowane także po znanym URL.

### Etap 2 — konta i sesje

- [ ] Dodać rejestr sesji, wersjonowany cookie, revocation i komplet endpointów kont.
- [ ] Dodać wymuszenie zmiany hasła, zabezpieczenie ostatniego admina, UI własnych i administracyjnych sesji.
- [ ] Testy dwóch przeglądarek, wyłączenia konta, zmiany roli/hasła, logoutu pojedynczego i wszystkich sesji, konkurencyjnych zmian adminów, błędnego/starego cookie, CSRF i limitera.
- **Bramka E2:** cofnięta sesja nie wykona następnego odczytu ani pobrania; ostatni admin pozostaje aktywny; stare cookie po migracji są odrzucone.

### Etap 3 — centrum operacyjne i interwencje

- [ ] Dodać bezpieczne agregaty operacyjne i widok. Dodać przydziały interwencji i listy według tool/assignee/priorytetu.
- [ ] Zachować SMS timeout, limit retry, rewizję i idempotencję z istniejącego przepływu. Testować dwa równoległe przydziały, odebranie grantu i rozwiązanie zgłoszenia podczas przydziału.
- **Bramka E3:** awaria workera lub Redis ma odrębny status; zgłoszenie nie ginie i nie jest jednocześnie przypisane dwóm osobom; sam odczyt nie rozwiązuje zgłoszenia.

### Etap 4 — ustawienia

- [ ] Dodać `tool_settings`, walidację, wersję, audyt i egzekwowanie w tworzeniu/dispatchu nowych runów.
- [ ] Dopiero potem pokazać formularz. Przetestować 2 równoległe starty przy limicie 1, pauzę nowych runów, run już aktywny, zmianę czasu i retry outboxu.
- **Bramka E4:** UI pokazuje wyłącznie ustawienia faktycznie działające; żaden sekret ani selektor nie jest dostępny przez API.

### Etap 5 — audyt i raporty

- [ ] Ujednolicić zapisy audytu i indeksy; dodać wyszukiwanie z paginacją i UI.
- [ ] Zbudować raporty z jawnych definicji, testowego zestawu danych i testów agregacji. Sprawdzić granice dat, brak wyniku, retry, status `no_matching_policies` i filtr narzędzia.
- **Bramka E5:** wyszukiwarka audytu i raporty są zgodne z danymi źródłowymi, nie ujawniają danych wrażliwych i działają na większej partii bez pobierania całych tabel do pamięci.

### Etap 6 — odbiór całości

- [ ] Przejść drogę dwóch operatorów: każdy ma inne narzędzie lub inny import; admin zmienia grant w czasie zalogowania; operator próbuje otworzyć stary wynik i URL pobrania.
- [ ] Przejść utworzenie runu → interwencję → przypisanie → rozwiązanie → wynik → audyt → raport bez portali zewnętrznych, na izolowanych syntetycznych danych.
- [ ] Uruchomić `npm test`, `npm run build`, `npm run test:db-integration`, testy HTTP z PostgreSQL/Redis i smoke UI. Sprawdzić negatywne przypadki CSRF, 401/403/404, stale `version`, awarię DB/Redis i brak wycieku w logach.
- [ ] Zaktualizować README, instrukcję admina, matrycę ról, procedurę utraty konta, znaczenie ustawień i `docs/STAN_IMPLEMENTACJI.md`. Oddzielić odbiór tej administracji od nadal otwartych bramek żywego PZU/Compensy.
- **Bramka E6:** wszystkie scenariusze E0–E5 są potwierdzone uruchomionymi testami i ręcznym przeglądem UI; migracja została sprawdzona na kopii aktualnej bazy, a plan wycofania wydania jest zapisany.

## 8. Wymagane scenariusze testowe

| ID | Scenariusz | Oczekiwany wynik |
| --- | --- | --- |
| AC-01 | Operator bez grantu pyta o katalog, import, run, artefakt po znanych ID | Brak narzędzia na liście; bezpośredni zasób nieujawniony; brak pliku |
| AC-02 | Operator ma `discover` bez `execute` i `view_results` | Widzi kafel, nie uruchomi, nie odczyta wyniku |
| AC-03 | Operator ma wszystkie flagi, ale import jest innego operatora | Nie czyta cudzego importu/runu/artefaktu |
| AC-04 | Grant odebrany przy aktywnej sesji i gotowym XLSX | Następne żądanie odmawia odczytu i pobrania |
| AC-05 | Reviewer ma `view_results`, bez `download_results` | Odczyt zgodny z rolą; plik niedostępny |
| AC-06 | Zmieniony `tool_id` w body/URL lub niespójny run/import | Nie zmienia zakresu; błąd spójności jest bezpieczny |
| SE-01 | Cofnięcie jednej i wszystkich sesji użytkownika | Cofnięty cookie odrzucony, inne działają tylko przy cofnięciu jednej |
| SE-02 | Dwie równoległe próby wyłączenia ostatnich adminów | Co najmniej jeden admin pozostaje aktywny |
| OP-01 | DB działa, Redis nie; worker heartbeat stary | Widok odróżnia niesprawne usługi i offline workera |
| IN-01 | Dwie osoby przypisują tę samą interwencję | Jedno powodzenie, drugi 409; jedno zdarzenie każdej skutecznej zmiany |
| IN-02 | Odczyt interwencji i timeout SMS | Zgłoszenie pozostaje otwarte, rewizja rośnie, termin challenge bez zmian |
| ST-01 | Limit 1 start/h i dwa równoległe POST | Jedno zadanie; drugie odmówione bez runu/outboxu |
| AU-01 | Filtry czasu/aktora/akcji i eksport artefaktu | Wyniki stronicowane, pobranie widoczne, brak PESEL/SMS/sekretów |
| RP-01 | Run `completed`, `no_matching_policies`, `failed`, otwarty i rozwiązany incident | Każda metryka według definicji; brak podwójnego liczenia retry |

## 9. Zasady wdrożenia i wycofania

1. Najpierw kopia DB i test odtworzenia. Migracje są addytywne; aplikacja przejściowa musi umieć odczytać nowe kolumny bez obowiązku ich natychmiastowego użycia. Backfill uruchomić jako kontrolowany krok z raportem liczby rekordów oraz wyjątków.
2. Wydanie dostępu do narzędzi musi być atomowo zsynchronizowane z nadaniem grantów historycznym użytkownikom. Jeżeli audyt backfillu nie przejdzie, nie przełączać polityki na egzekwowanie. Po przełączeniu brak grantu oznacza odmowę.
3. Przy nowym formacie sesji zakomunikować jednorazowe ponowne logowanie. Nie utrzymywać bezterminowego trybu akceptującego stare cookies.
4. Ustawienia pauzy/limitu nie zastępują flagi `WORKER_LIVE_PORTALS`. Nawet po odbiorze administracji live pozostaje wyłączone do spełnienia osobnych kryteriów automatyzacji.
5. Wycofanie kodu może pozostawić nowe tabele/kolumny w DB; nie usuwać danych migracją `down` na produkcji bez analizy. Przy awarii autoryzacji system ma odmawiać dostępu, a admin ma mieć procedurę naprawy z konsoli i kopii, bez awaryjnego „otwarcia wszystkim”.

## 10. Wynik pracy kolejnego agenta

Agent ma dostarczyć kod, migracje, testy, działające ekrany, aktualne instrukcje oraz dziennik bramek E0–E6. W raporcie końcowym osobno wypisać: zaimplementowane funkcje, testy modułowe, testy DB/API/Redis, smoke UI, migrację na kopii bazy i nadal otwarte bramki portali live. Jeśli środowisko nie pozwala uruchomić DB/Redis, ukończyć niezależny zakres, udokumentować konkretną blokadę i nie przedstawiać funkcji jako odebranej end-to-end.
