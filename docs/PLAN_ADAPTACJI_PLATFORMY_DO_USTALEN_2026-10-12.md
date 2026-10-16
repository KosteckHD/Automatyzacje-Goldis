# Plan adaptacji Goldis do ustaleń z rozmowy — 12.10.2026

## 1. Cel i zasady wiążące

Ten dokument jest instrukcją wykonawczą dla agenta kodującego na **aktualnym drzewie roboczym**. Nie zastępuje wcześniejszego audytu gotowości produkcyjnej, lecz aktualizuje zakres produktu. W repozytorium jest dużo istniejących zmian niezacommitowanych; przed edycją każdego pliku sprawdź jego bieżącą treść i nie cofaj cudzej pracy.

1. Jedna organizacja, pierwszy produkt to automat OC. Druga automatyzacja i MFA są odłożone.
2. Każdy nowy import jest osobną operacją: może utworzyć nowy wynik i nowy lead dla tej samej firmy. Duplikaty w **tym imporcie** usuwa się przed startem automatu; nie deduplikuj globalnie po REGON/NIP pomiędzy importami.
3. Identyfikator do szukania firmy to REGON; gdy źródło ma tylko NIP, REGON uzupełnia wyłącznie publiczny **MF VAT**. Nie wymagaj klucza BIR ani nie przełączaj po cichu na GUS. Nie odsiewaj firmy tylko według typu podmiotu.
4. Do przebiegu osoby wymagane są dane wskazanej osoby decyzyjnej i bezpiecznie dopasowany PESEL z portalu. Brak osoby w wejściu lub niemożliwe dopasowanie nie tworzy wyniku ani leada gotowego do przydziału dla danego wiersza; następne wiersze idą dalej. Nie wpisuj przypadkowej osoby ani PESEL.
5. Interwencję, korektę i SMS obsługuje użytkownik, który uruchomił operację. Dla jednego portalu w jednym przebiegu wolno wysłać pierwszy kod i **dwa** dodatkowe kody. Nie stosuj godzin pracy do przyjmowania SMS. Ręczne użycie tych samych kont portalowych jest dozwolone; wykryta kolizja sesji/sprawy kończy lub zatrzymuje bezpiecznie dotknięty wiersz, nie wykonuje ponownie niepewnej akcji.
6. Dla każdego wiersza zakończonego z co najmniej jedną polisą spełniającą obecny filtr daty powstaje XLSX `Nazwa_REGON.xlsx`: jeden wiersz danych firmy, pod nim dokładna lista pojazdów/polis. Nazwa, osoba, komórka, telefon i e-mail pochodzą z **wejściowego Excela**; REGON z Excela albo, jeśli go brakowało, z uzupełnienia NIP przez MF VAT. PESEL i pojazdy pochodzą z wyniku automatu.
7. Usunięcie otrzymanego leada przez pracownika oznacza usunięcie **przydziału**, nie rekordu z bazy. Lead wraca do puli. Usunięcie własnego importu nie może usunąć leadów już przypisanych **innym** osobom ani ich danych potrzebnych do pracy. W aktywnym systemie usuwany zasób znika od razu; fizyczna operacja może być asynchroniczna.
8. Importy, wyniki i kopie zapasowe pozostają bez automatycznego terminu wygaśnięcia, dopóki uprawniona osoba ich nie usunie. Odtwarzanie ma RPO ≤ 24 h i RTO ≤ 8 h. Po odtworzeniu, przed otwarciem usługi, odtwórz dziennik usunięć; dziennik musi obejmować każdą nadal przechowywaną kopię.
9. Start produkcyjny od konta administratora; administrator resetuje hasła, administrator i menedżer nadają dostęp. Użytkownik zarządza własnymi importami/wynikami i swoimi przydziałami. Odbiór lokalny wykonuje użytkownik na działającym systemie.

**Rozstrzygnięcia implementacyjne przy braku dalszych pytań:** brak polis po filtrze daty daje jawny status `no_matching_policies`, bez XLSX i bez leada gotowego do przydziału; jeden rekord pojazd/polisa w tabeli XLSX to jedna pozycja ze snapshotu UFG (ten sam pojazd z dwiema polisami ma dwa wiersze). Lead pozostaje jeden na firmę w danej operacji, jak w aktualnym modelu, a osobne ukończone przebiegi tej firmy są jego wynikami. Gdy właściciel usuwa import, zachowaj leady przypisane innym użytkownikom; pozostałe leady z tego importu usuń razem z importem. Te decyzje trzeba zapisać w testach kontraktowych.

## 2. Obecny stan i różnica względem celu

| Obszar | Ustalono w kodzie | Zmiana |
| --- | --- | --- |
| Import | `workbook.ts`, `SourceRow` i `source_rows` mają `phone`, `email`, lecz nie osobną `Komórkę`. | Nowe pole `mobile` w parserze, DB, API i widokach; `Telefon` pozostaje osobny. |
| Przygotowanie | `preparation-analysis.ts` już wykrywa duplikaty, lecz brak osoby nie blokuje `ready`. `run-submissions.ts` i `prepared-set-executions.ts` przyjmują gotowe grupy. | Wymagana osoba przed dopuszczeniem wiersza; duplikat nigdy nie wyzwala uruchomienia. |
| Rejestr | `registry-provider-factory.ts` ma MF VAT z budżetem 100 żądań/dobę, pacingiem i cache, ale domyślnie provider jest `disabled`; repo zawiera także adapter BIR. | Włącz MF VAT w konfiguracji docelowej, pokaż wyczerpanie budżetu, usuń BIR z aktywnej ścieżki wdrożenia. |
| Tożsamość | `everest-identity-provider.ts` zwraca m.in. `unsupported_entity_type`, `missing_pesel`; `live-run.ts` kieruje wiele przypadków do `identity_review`. | Próba po REGON bez filtra typu; rozdziel naprawialną niejednoznaczność od terminalnego braku wymaganej osoby/PESEL. |
| SMS | `sms-retry-policy.ts` dopuszcza w PZU tylko jeden retry, w Compensie limit nie jest egzekwowany tym licznikiem; `runs.ts` inkrementuje tylko PZU. | Dwa dodatkowe wysłania per portal i przebieg, licznik trwały, spójny API/UI/worker. |
| Eksport | `export.ts` powtarza REGON/nazwę/PESEL przy każdej polisie, bez osoby i obu telefonów. `run-export-snapshot.ts` czyta V1 bez kontaktów. `exportFileName` daje `REGON_Nazwa_Osoba.xlsx`. | Snapshot V2 kontaktów, nowy układ XLSX i nazwa `Nazwa_REGON.xlsx`. |
| Leady | `business-leads.ts` trzyma telefon/e-mail, uznaje same `no_matching_policies` za `ready`, nie ma zwolnienia własnego przydziału. | Komórka, lead tylko z dodatnim wynikiem, API zwolnienia przydziału i UI. |
| Usuwanie | `deletion-jobs.ts` kasuje `ImportBatch`; `result_sets` i `business_leads` mają kaskady. `business-leads.ts` wymaga żywego importu. `deletion-restore.ts` powtarza kaskadę. | Niezależny utrwalony wynik przypisanego leada, odłączenie od importu, identyczna logika przy usuwaniu i odtwarzaniu. |
| Produkcja | Audyt w `AUDYT_GOTOWOSCI_PRODUKCYJNEJ_2026-10-12.md` wykazał otwarte P0 oraz czerwony smoke migracji. | Zamknąć bramki P0, restore i testy przed publicznym uruchomieniem. |

## 3. Dokładny kontrakt wynikowego XLSX

Arkusz `Wynik OC`:

| Komórki | Zawartość |
| --- | --- |
| `A1:G1` | `Nazwa`, `REGON`, `Osoba Decyzyjna`, `Komórka`, `Telefon`, `Email`, `PESEL` |
| `A2:G2` | **Jeden** wiersz wartości, w kolejności nagłówków; A oraz C–F z pierwotnego importu po jawnych korektach przed startem, B z importu lub jednoznacznego lookupu MF VAT, G z potwierdzonej tożsamości automatu. |
| `A4` | `Znalezione pojazdy i polisy OC` |
| `A5:L5` | `L.p.`, `Ubezpieczony`, `Typ i nr polisy`, `Rodzaj umowy`, `Liczba szkód ubezpieczonego`, `Nr rejestracyjny`, `Grupa pojazdu`, `Marka`, `Model`, `ZU`, `Okres ub. od`, `Okres ub. do` |
| `A6:L...` | Wszystkie pozycje OC spełniające `policyMatchesDate` dla daty odniesienia, w kolejności `sourceOrdinal`; bez powtarzania danych firmy. |

Komórki z REGON, PESEL, telefonami, rejestracją i numerem polisy zapisuj jako **tekst**, z zachowaniem zer na początku i ochroną przed formułami Excel. Nie przepisuj innych pól z portalu do A2. Pusty telefon/e-mail pozostaje pusty, nie przesuwa kolumn. Jeśli brak dopasowanych polis, status jest jawny, lecz pliku nie ma. Fizyczny klucz magazynu pozostaje UUID; dwie różne operacje mogą mieć identyczną nazwę pobieranego pliku bez nadpisania zawartości. Nazwę firmy sanitizuj i skracaj, REGON waliduj, a nazwę pliku ustaw dokładnie `bezpiecznaNazwa_REGON.xlsx`.

**API i UI mają czytać wynik ze strukturalnych danych DB/snapshotu, a nie parsować własny XLSX po pobraniu.** Arkusz jest kontraktem eksportowym; ten sam DTO zasila „Wyniki automatyzacji” i „Przydzielone leady”.

## 4. Kolejność implementacji dla agenta kodującego

Każdy krok kończ działającym buildem i testami dotyczącymi zmiany. Migracje są wyłącznie nowe, nie edytuj historycznych `001–053`. Przy zmianie Next.js najpierw przeczytaj instrukcję `apps/web/AGENTS.md` i właściwy poradnik z `node_modules/next/dist/docs/`.

### Krok 0 — zamrożenie punktu odniesienia

1. Zapisz `git status --short`, identyfikator HEAD i listę lokalnych migracji. Nie czyść niezatwierdzonych zmian. Sprawdź `docs/PLAN_NAPRAW_USER_FLOW_2026-10-12.md` oraz audyt produkcyjny.
2. Uruchom `npm run build`, `npm test` i odpowiednie moduły DB na odrębnej bazie. Napraw starą asercję `MANAGER_MEMBERSHIP_GRANT_OR_ADMIN_BOUNDARY_MISMATCH` w `apps/api/scripts/migration-smoke.cjs` zgodnie z **obecną** polityką uprawnień, nie przez zmianę prawa dostępu bez decyzji. Ponów `npm run test:module:migrations`.
3. Przygotuj mały zestaw fixture: NIP bez REGON, wiersz bez osoby, duplikat w jednym imporcie, ta sama firma w dwóch importach, dwa wiersze z różnymi firmami, wynik z zerem i wieloma polisami. Nie używaj danych realnych w fixture.

**Odbiór:** zielony build i migracje, zapisane niezależne fixture, bez utraty obecnego stanu drzewa.

### Krok 1 — wejściowy Excel i trwały kontakt

1. Dodaj migrację `054` z `source_rows.mobile text NOT NULL DEFAULT ''`, indeksy tylko gdy wynikają z zapytań. Uzupełnij model w `apps/api/src/db.ts` oraz `SourceRow` w `packages/core/src/index.ts`.
2. W `apps/api/src/workbook.ts` mapuj nagłówek `Komórka` osobno od `Telefon`. Użyj tego samego bezpiecznego walidatora numeru, ale **nie** podstawiaj komórki za telefon. Odrzuć zduplikowany nagłówek danego pola. Zachowaj działanie starych plików bez `Komórka` jako puste pole.
3. Przenieś pole przez `apps/api/src/imports.ts`, DTO listy/szczegółu, przygotowanie/eksport przygotowania, lead `contact_data` jako odrębny typ `mobile`, oraz `apps/web/app/leads/LeadWorkspace.tsx`, widoki importu i raport XLSX leadów. Napis `Komórka` ma się pojawiać w UI oddzielnie od `Telefon`.
4. Dane kontaktowe i nazwę zamroź przy uruchomieniu w `automation_runs.input_snapshot` jako **V2** (`companyName`, `effectiveRegon`, `decisionMakerName`, `mobile`, `phone`, `email`, źródłowy wiersz/wersja). Uaktualnij `apps/api/src/run-export-snapshot.ts` i `run-export.ts`. Dla starych V1 nie wymyślaj brakującej komórki: odczytaj nadal istniejący wiersz źródłowy jako zgodność wsteczną, a po jego usunięciu pokaż jawny brak danych. Nie zmieniaj historycznych gotowych XLSX.

**Odbiór:** wejście z dwoma różnymi numerami daje dwa różne pola w DB, API, leadzie i nowym XLSX; zmiana źródła po startowym snapshocie nie zmienia eksportu uruchomionego zadania.

### Krok 2 — przygotowanie, MF VAT i granica uruchomienia

1. W `apps/api/src/preparation-analysis.ts` dodaj stan/reason `PERSON_REQUIRED` dla wiersza bez `Osoba Decyzyjna`. Wiersz może być poprawiony przed startem, ale nie trafia do grup `ready`; jego brak nie blokuje pozostałych wierszy. Zsynchronizuj komunikaty i liczniki w `import-preparations.ts`, `preparation-workflows.ts`, `run-submissions.ts`, `prepared-set-executions.ts` i UI przygotowania.
2. Po lookupie NIP→REGON z MF VAT ponów analizę duplikatów. Utrzymaj jednego reprezentanta w obrębie importu i status `duplicate` dla pozostałych. W admission sprawdź ponownie zapieczętowany stan, wersje wierszy i brak duplikatu w transakcji; nie polegaj wyłącznie na blokadzie w UI.
3. W konfiguracji `compose.yaml`, przykładach `.env*`, skryptach startowych i preflight wybierz `GOLDIS_ENRICHMENT_PROVIDER=mf-vat`, produkcyjny endpoint, `REGISTRY_CACHE_HMAC_KEY`, obecny budżet i pacing. Utrzymaj cache oraz datę zapytania; wyczerpany budżet/przerwa MF daje `waiting_registry`/czytelny stan do późniejszej próby, **nie** fałszywy REGON. Przed wdrożeniem sprawdź aktualne limity MF i zachowaj konfigurowalny bezpieczny próg.
4. Zweryfikuj w `imports.ts`, `canonical-run-service.ts`, `run-submissions.ts` i unikalnych indeksach, że hash pliku ani REGON nie powodują użycia wyniku z wcześniejszego importu. Idempotencja chroni tylko **to samo żądanie/operację**; ponowny świadomy import tworzy nowy `batch`, `result_set`, run i lead.

**Odbiór:** dwa identyczne pliki zaimportowane osobno tworzą różne identyfikatory wyników/leada, a duplikat w jednym pliku wywołuje najwyżej jeden przebieg; brak osoby i awaria MF nie zatrzymują innych gotowych wierszy.

### Krok 3 — identyfikacja osoby, izolacja wiersza, portale

1. W `apps/worker/src/everest-identity-provider.ts`, `identity.ts`, `pipeline.ts` i `live-run.ts` nie filtruj wejścia według typu firmy przed wyszukiwaniem REGON. Korzystaj wyłącznie z jednoznacznego dopasowania oczekiwanej osoby i PESEL. Jeśli portal nie udostępnia osoby/PESEL, zakończ ten wiersz jawnie jako brak wyniku; nie twórz identity ani eksportu.
2. Rozdziel `IDENTITY_NOT_FOUND`/`missing_pesel`/`unsupported_entity_type` od rzeczywistej niejednoznaczności, którą można bezpiecznie skorygować **przed nieodwracalnym krokiem portalowym**. Oznacz stan terminalny w modelu statusów lub użyj `failed` z stabilnym reason code; UI ma pokazać powód, a batch kontynuować. Nie zamieniaj braku osoby na sukces `no_matching_policies`.
3. W `run-worker.ts`, `pg-run-repository.ts` i przebiegu zestawu sprawdź, że terminalizacja jednego wiersza zawsze zwalnia kolejkę następnego. Przetestuj połączenie: sukces → brak osoby → sukces, restart pomiędzy wierszami oraz dwie równoległe próby tego samego wiersza.
4. Zachowaj fence/lease, checkpointy i bariery ponownego wykonania oferty oraz UFG. Dla kolizji ręcznej pracy na tym samym koncie portalu wykrywaj utratę sesji, zmianę formularza lub istniejącą sprawę; zwróć bezpieczny błąd/interwencję **tylko dla tego wiersza**. Nie resetuj automatycznie cudzego formularza i nie twórz drugiej oferty przy niepewnym stanie. Zanotuj w runbooku operacyjnym, że portal może zerwać sesję przy ręcznej pracy.

**Odbiór:** brak danych osoby kończy wiersz bez PESEL i bez leada `ready`, następny wiersz dochodzi do wyniku; spółka z jednoznacznie dostępną osobą jest próbowana, a niedostępna osoba ma jawny status bez fałszywych danych.

### Krok 4 — SMS i uprawnienia uruchamiającego

1. Zastąp jedyny `pzu_sms_retry_count` spójną trwałą ewidencją **dla PZU i Compensy**, z polem/licznikiem liczby dodatkowych wysłań 0–2 per run/portal. Zaplanuj migrację `055` lub kolejną wolną po `054`; migracja istniejącego licznika PZU ma zachować wykorzystane próby. Rozróżnij próby wpisania kodu od **wysłania nowego** kodu.
2. Zmień `sms-retry-policy.ts`, `runs.ts`, `interventions.ts`, `auth-challenges.ts` i worker `live-run.ts`, aby transakcyjnie rezerwowały ponowienie, były odporne na powtórzenie żądania/restart i odmawiały trzeciego dodatkowego wysłania. Pokazuj `pozostało 2/1/0` w UI. Brak godzin pracy dla kodów; istniejące okno nowych uruchomień narzędzia jest osobną polityką.
3. Powiąż uprawnienie do podania kodu, retry, korekty i rozwiązania interwencji z `result_set.actor_user_id`/aktorem uruchomienia, a nie tylko z właścicielem importu lub bieżącym assignee interwencji. Uaktualnij wprost `manual-data-contract.ts`, `manual-data.ts`, `authorization-policy.ts`, `authorization-guard.ts`, `interventions.ts` i `auth-challenges.ts`; obecne ograniczenie korekt do admina/menedżera nie realizuje tej reguły. Administrator może widzieć/audytować, ale nie przejmuje domyślnie SMS użytkownika. Sprawdź wszystkie ścieżki kontrolerów, nie tylko ukrycie przycisku.

**Odbiór:** pierwszy kod + dwa ponowienia dla każdego portalu, trzecie odrzucone także po restarcie; obcy operator nie widzi kodu ani nie wznawia cudzego przebiegu; kod działa poza godzinami pracy.

### Krok 5 — nowy XLSX i spójność wyniku

1. Zmień `exportOcWorkbook` w `apps/api/src/export.ts` dokładnie według §3. Użyj V2 snapshotu z kroku 1; PESEL odszyfruj wyłącznie na potrzeby autoryzowanego eksportu. Zachowaj kontrolę kompletności snapshotu OC i obecny filtr daty. W `packages/core/src/index.ts` zmień `exportFileName` na `Nazwa_REGON.xlsx`.
2. W `run-export.ts`, `export-finalizer.ts`, `artifact-download.ts` sprawdź, że eksport jest opublikowany dopiero po trwałym, poprawnym XLSX, `policyCount > 0`, a metadata i download otrzymują nową nazwę. Klucz artefaktu nadal bazuje na UUID. Nie powtarzaj nazwy/PESEL w wierszach pojazdów.
3. W wynikach (`history.ts`, `runs.ts`, `worker-results.ts`, strony `apps/web/app/results`, `my-results`) użyj tych samych pól/pozycji co snapshot wynikowy. Dla zera polis pokaż `brak dopasowanych polis` bez przycisku pobrania. Ustal w DTO jawne powiązanie lead → lista ukończonych wyników; nie wywodź go z kolejności komórek arkusza.
4. Zaktualizuj `export.test.ts`, `run-export.test.ts`, testy core i smoke pobierania: dokładny tekst i pozycja każdej komórki, PESEL jako tekst, więcej niż jedna polisa, dwie operacje o tej samej nazwie pliku bez kolizji, formuła w każdym polu tekstowym.

**Odbiór:** otwarty XLSX ma dokładnie jeden wiersz firmy w A2:G2, pod nim wszystkie dopasowane pojazdy/polisy i nazwę `Nazwa_REGON.xlsx`; UI pokazuje ten sam wynik.

### Krok 6 — lead gotowy tylko po realnym wyniku

1. W `business-leads.ts` zmień `completeResultSet`: `ready` wymaga co najmniej jednego ukończonego run z `currentOcCount > 0` oraz terminalności wszystkich powiązanych runów; same `no_matching_policies` nie dają leada do przydziału. Częściowe wyniki tej samej firmy oznacz w leadzie czytelnie: dodatnie wyniki dostępne, zakończone niepowodzeniem wiersze widoczne jako wyjątki. Nie blokuj całej firmy przez niezwiązany wiersz innej firmy.
2. Zapewnij, że `attachSubmissionGroups` nie wciąga przypadkowo wierszy z innych importów do kontaktów leada. Zachowaj niezależne leady między importami, a w ramach jednego importu deterministyczne połączenie duplikatów i wyników firmy. Dodaj `mobile` do `contact_data`, listy/szczegółu i eksportu zbiorczego leadów.
3. Rozdziel pola wyniku firmy od danych kontaktu: PESEL i szczegóły pojazdów dostępne tylko z uprawnieniem do wyników/pobierania, w logach/audycie bez wartości PESEL. Testy autoryzacji sprawdzą operatora, menedżera, admina, reviewera i brak sesji.

**Odbiór:** wynik zero polis nie pojawia się w puli; wynik dodatni pojawia się raz na firmę/operację i zawiera właściwy kontakt z tego importu.

### Krok 7 — zwolnienie własnego leada, bez usuwania rekordu

1. Dodaj endpoint np. `POST /api/leads/:id/release` w `business-leads.ts`: CSRF, aktywna sesja, własny aktualny przydział, `expectedVersion` i klucz idempotencji. W jednej transakcji z blokadą wiersza wyzeruj `assigned_to_user_id`, `assigned_by_user_id`, `assigned_at`; zwiększ wersję przydziału i zapisz audyt `lead.assignment.released`. **Nie wykonuj DELETE** z `business_leads`, `lead_run_links`, snapshotów ani historii kontaktu.
2. Nie używaj `contact_status_version` jako wersji przydziału, jeśli status kontaktu zmienia się niezależnie; dodaj osobną `assignment_version` migracją. Historia przydziałów powinna pokazywać zwolnienie i ponowny przydział; istniejących `lead_allocations` nie wymazuj dla samego zwolnienia.
3. Dodaj akcję „Usuń z moich przydziałów” w `apps/web/app/leads/LeadWorkspace.tsx` z czytelnym skutkiem, bez etykiety sugerującej kasowanie bazy. Po sukcesie lead znika z „Moje wyniki”, wraca do puli, może być ponownie przydzielony przez menedżera/admina. Kontroler musi odrzucać zwolnienie cudzego leada i wyścig z ponownym przydziałem.

**Odbiór:** po zwolnieniu ten sam `lead_id` jest w DB i w puli, status kontaktu oraz historia są zachowane; obcy pracownik nie może go zwolnić.

### Krok 8 — usunięcie własnego importu z zachowaniem cudzych leadów

To jest zmiana schematu, nie poprawka samego przycisku. Aktualny FK `result_sets -> import_batches ON DELETE CASCADE` usuwa leady; `lead_run_links` i statystyki też tracą źródła, a `list/get/exportWorkbook` wymagają żywego importu.

1. Dodaj nową migrację po krokach 1/4/7: `result_sets.batch_id` nullable i FK `ON DELETE SET NULL` (lub równoważny trwały model odłączenia), wraz z jednoznacznym `source_import_deleted_at`/stanem odłączenia. Utwórz `lead_result_snapshots` (lead, oryginalny run UUID, data odniesienia, A–F z V2, zaszyfrowany PESEL, dokładne pozycje pojazd/polisa, liczby, checksum, wersja schematu). Unikalność `(lead_id, original_run_id)`, FK do leada, **bez FK do importu/run/source_row**. Snapshot materializuj z zatwierdzonych danych po ukończeniu wyniku, a historyczne dodatnie, przypisane leady backfilluj przed migracją kasowania. Nie przechowuj PESEL jawnie w nowej tabeli.
2. W `deletions.ts` pokaż w podglądzie liczbę leadów zachowanych dla innych użytkowników oraz usuwanych. Autoryzacja: operator tylko `import_batches.owner_user_id = actor`, tylko własne runy/artefakty w tym imporcie; admin i menedżer według istniejących grantów. Rozszerz `deletion-step-up.ts`, `deletion-jobs.ts` oraz UI preview tak, aby właściciel mógł wykonać własne usunięcie po ponownym potwierdzeniu hasła. Brak prawa do cudzej operacji ma dawać 404/403 także przez bezpośrednie API.
3. Przy zaakceptowaniu joba postaw tombstone **natychmiast**, żeby import i jego własne wyniki zniknęły z aktywnych list. Widok cudzego przypisanego leada nie może być blokowany tym tombstone, bo ma niezależny snapshot. Zablokuj nowe przydziały/edycje źródła w trakcie joba, lecz pozwól dotychczasowemu assignee czytać swój zachowany lead.
4. W transakcji fizycznego usuwania: zablokuj import, powiązane result sety i leady; sprawdź ukończenie snapshotów zachowanych leadów; usuń leady nieprzypisane lub przypisane właścicielowi usuwającemu; dla leadów przypisanych **innym** odłącz wynik od importu i zachowaj lead, status kontaktu, historię przydziałów oraz snapshoty. Usuń raw import, source rows, runy i oryginalne artefakty. Nie kasuj całej `lead_allocations` tylko dlatego, że zawiera ID jednego zachowanego lub usuniętego leada; zostaw ją jako historyczny zapis ID. Sprzątnij osierocone result sety/powiadomienia według jawnej polityki.
5. Zmień `business-leads.ts` (`allocationCandidateWhere`, `list`, `get`, `exportWorkbook`, status kontaktu i nowy download) oraz UI: zachowany lead czyta `lead_result_snapshots`, pokazuje `sourceImportId: null` i „Import usunięty”; nie próbuje otworzyć skasowanego pliku/importu. Nowy XLSX dla zachowanego leada generuj na żądanie z zaszyfrowanego snapshotu przez autoryzowany endpoint, zamiast zatrzymywać stary plik raw importu. Assignee zachowuje wynik, a właściciel nie widzi skasowanego importu.
6. Tę samą operację odłączenia wywołuj z `deletion-restore.ts` przy odtwarzaniu dziennika. Zaktualizuj format/wersję journalu i bramę startu tak, aby restore nie wskrzesił usuniętych danych ani nie zgubił zachowanych leadów z kopii. Obsłuż idempotentne ponowienie joba oraz crash pomiędzy tombstone, skasowaniem plików i transakcją DB. Jeżeli wymagany snapshot jest niekompletny, job ma zostać w stanie naprawialnym, nigdy kaskadowo skasować cudzy lead.

**Odbiór:** po skasowaniu importu A jego owner nie widzi importu/runów/artefaktów; użytkownik B nadal widzi ten sam `lead_id`, kontakt, status i wynik pojazdów/PESEL oraz pobiera poprawny XLSX. Lead nieprzypisany z A znika. Test restore z kopii sprzed skasowania i replay journalu daje dokładnie ten sam stan.

### Krok 9 — gotowość publicznej produkcji

1. Zamknij udokumentowane P0 z audytu: limit scalonych zakresów XLSX przed ExcelJS (`workbook-archive.ts`), normalizacja/usunięcie klientowskiego `X-Forwarded-*` na bramie i test obejścia limitera, szyfrowanie artefaktów z PESEL w spoczynku, osobne nieuprzywilejowane konta PostgreSQL dla migracji/API/workera, bezpieczny sandbox Chromium, brak publicznego API/Redis/DB. Ręczne konta portalowe nadal mogą pracować równolegle zgodnie z krokiem 3.
2. Dostarcz topologię VPS: HTTPS, poprawne trusted proxies/cookie/origin/CSRF, sekretami zarządzanymi poza repo, jednorazowy bootstrap admina, reset hasła przez admina i granty przez admina/menedżera z audytem. Jedna organizacja jest seedowana bez publicznej rejestracji tenantów. MFA pozostaje odłożone zgodnie z decyzją użytkownika; opisz ryzyko i zastosowane zabezpieczenia zastępcze w runbooku, nie oznaczaj tego jako wdrożone MFA.
3. Rób **zaszyfrowane** backupy DB, artefaktów i kluczy bez automatycznego TTL, dopóki uprawniona osoba jawnie ich nie usunie. Zaplanuj pojemność i procedurę ręcznego usuwania kopii; dziennik usunięć oraz jego integralność zachowuj przez cały okres istnienia najstarszej kopii. Testuj codzienny backup, alarm po braku backupu, próbę cold restore na innym hostie, replay journalu przed ruchem, pomiar RPO ≤ 24 h i RTO ≤ 8 h. Raportuj brak miejsca, niedziałający worker, zaległą kolejkę, błędy portali/MF, joby deletion `manual_required` i niespójne artefakty.
4. Oznacz wydanie commitem i digestem obrazu, wykonaj migracje na kopii aktualnej bazy, przygotuj rollback aplikacji i procedurę obsługi migracji jednokierunkowych. Nie uruchamiaj migracji z konta runtime. Przed otwarciem usługi wykonaj stagingowe testy sieci, ról i autoryzacji.

**Odbiór:** publiczny adres odpowiada przez HTTPS; direct API/DB/Redis nie są dostępne z Internetu; próba obejścia XFF i złośliwy XLSX nie działa; restore na innym środowisku zachowuje przypisane leady i respektuje skasowane dane w granicach RPO/RTO.

### Krok 10 — pełny odbiór lokalny, staging i decyzja o wydaniu

1. Automatyczne bramki: `npm run build`, `npm test`, `npm run test:module:migrations`, `test:module:registry`, `test:module:submission`, `test:module:results`, `test:module:leads`, `test:module:deletion`, `test:module:deletion-step-up`, `test:module:sms`, browser fixture Everest/Compensa/UFG, smoke UI i test cold restore. Każdy ma przejść na kodzie i schemacie z tego samego wydania; pominięte testy należy wyjaśnić.
2. Test na lokalnym systemie z użytkownikiem: import z 3–5 wierszami (sukces, brak osoby, zero polis, duplikat, NIP bez REGON), dwa importy tej samej firmy, dokładne A1:L6+ w XLSX, SMS 0/1/2/3, przydzielenie i zwolnienie leada, usunięcie własnego importu przy cudzym przydziale, restart workerów w bezpiecznych punktach. Użytkownik zatwierdza lokalny przebieg po samodzielnym testowaniu.
3. Staging z rzeczywistymi kontami portalowymi: sprawdź działanie poza godzinami, ręczne użycie kont w trakcie automatu, zmianę sesji, brak osoby/PESEL, większą partię i brak podwójnej oferty po niepewnym stanie. Testuj wyłącznie na dopuszczonych danych i sprawach. Zapisz protokół z liczbą przetworzonych wierszy, błędów i rozbieżności; nie ekstrapoluj jednego udanego wiersza na wszystkie typy podmiotów.
4. Przed produkcją sprawdź tabelę bramek P0/P1 z audytu, ciągłość backupów bez automatycznego kasowania i wykonaną próbę restore. Dopiero zielone bramki techniczne plus zatwierdzenie użytkownika lokalnego działania zamykają etap implementacji. Czynności konfiguracyjne VPS/domain wymagają dostępnych zasobów infrastruktury, ale nie blokują kodowania etapów 0–8.

## 5. Zależności, kolejność migracji i rzeczy poza zakresem

- Kolejność prac: **0 → 1 → 2 → 3 i 4 → 5 → 6 → 7 → 8 → 9 → 10**. Krok 5 wymaga V2 snapshotu; krok 8 wymaga gotowego eksportu i reguł leadów. Numer migracji przydzielaj według aktualnego repo w chwili pracy, nigdy nie nadpisuj już zastosowanej migracji.
- Migracje muszą obsłużyć istniejące importy, V1 snapshoty i leady z migracji 052. Backfill zapisuj porcjami, z kontrolą liczby rekordów i możliwością bezpiecznego wznowienia; przed zmianą FK porównaj liczbę leadów i sprawdź pobieranie kilku istniejących wyników.
- Druga automatyzacja, GUS BIR, automatyczne rozpoznawanie wszystkich form prawnych mimo braku osoby w portalu i MFA **nie należą** do tej implementacji. „Bierzemy wszystko” znaczy: każdy poprawny REGON trafia do próby, a niedostępna osoba kończy tylko ten wiersz bez wyniku.
- Potwierdzenie „produkcja” dotyczy rzeczywistej pracy na docelowej infrastrukturze. Istniejący historyczny test jednego wiersza i same fixture przeglądarkowe nie są odbiorem tego planu.

## Stan wykonania

Zakres kodowy kroków 0–8 został zaimplementowany. W kroku 9 zamknięto w repozytorium zabezpieczenia dla scalonych zakresów XLSX, szyfrowania eksportów, rozdzielonych ról PostgreSQL, sandboxa Chromium, loopback bindingów usług oraz przykładowej bramy Nginx. Stan testów i czynności nadal wymagające VPS, domeny, backupu cold restore oraz odbioru użytkownika opisuje [raport realizacji](REALIZACJA_PLANU_ADAPTACJI_2026-10-12.md) i [instrukcja wdrożenia](WDROZENIE_PRODUKCYJNE_I_ROLE_BAZY_2026-10-12.md).
