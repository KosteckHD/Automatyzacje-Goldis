# Goldis — plan wykonawczy integracji automatyzacji OC

**Wersja:** 1.0, 29.09.2026  
**Cel:** doprowadzić pierwsze narzędzie platformy od importu Excela do kontrolowanego pobrania wyniku, z dowodem integralności danych na każdej granicy systemu.  
**Zakres obecnej iteracji:** prace możliwe bez dostępu do kodów SMS oraz przygotowanie punktów, które później wymagają testu na żywych portalach.  
**Źródła:** [plan P0–P9](PLAN_IMPLEMENTACJI.md), [stan implementacji](STAN_IMPLEMENTACJI.md) oraz aktualny kod w `apps/` i `packages/core/`. Ten dokument jest instrukcją wykonania, a nie opisem gotowego produktu.

**Wykonanie przez Luna-xhigh:** ścisła lista 113 kroków znajduje się w sekcji 11; bieżący licznik, dowody i blokady agent zapisuje w [dzienniku postępu](POSTEP_IMPLEMENTACJI.md).

> **Uwaga o aktualności:** to plan bazowy z 29.09.2026. Implementacja poszła dalej; opis bieżącego kodu, obsługi SMS i pozostałych bramek jest w [aktualnym stanie implementacji](STAN_IMPLEMENTACJI.md). Nie używaj poniższej tabeli „Działa teraz” jako opisu bieżącej gałęzi.

## 1. Punkt startowy i definicja ukończenia

### 1.1. Stan potwierdzony w repozytorium

| Obszar | Działa teraz | Pozostała luka |
| --- | --- | --- |
| Excel | Import arkusza `Realizacja`, mapowanie pól po nagłówkach, walidacja REGON, zapamiętanie fizycznego numeru wiersza i SHA-256 pliku | Korekty z audytem, wybór zakresu, uzupełnianie REGON z NIP, grupowanie duplikatów |
| Panel/API | Jedno konto administratora, import, podgląd, zadanie dla jednego wiersza, historia i anulowanie oczekującego zadania | Użytkownicy i role, interwencje, SMS, pobranie wyników, pełny audyt |
| Kolejka | BullMQ z `runId` jako jedyną daną joba, pojedynczy worker, ponowne umieszczenie zadań `queued` po utracie joba | Orkiestracja portali, checkpointy po efektach zewnętrznych i wznowienie po dalszych etapach |
| Playwright | Trwały profil Chromium w prywatnym wolumenie, jeden obiekt `BrowserSession` na proces | Zadanie nie wywołuje jeszcze przeglądarki; sesja PZU/Compensy na VPS nie była sprawdzona |
| Everest | Logika wyboru osoby na fikcyjnych wynikach | Żywy adapter, selektory, logowanie i test powiązania osoby z firmą |
| UFG/OC | Parser 12 pól, kontrola liczby wierszy, filtr daty, test na syntetycznym widoku | Pełny odczyt przy przewijaniu/stronicowaniu i połączenie z jobem |
| Wynik | `exportOcWorkbook` i ręczny pilot eksportu | Trwały zapis polis, prywatny magazyn artefaktów, endpoint download |

Przycisk w panelu **nie uruchamia dziś weryfikacji portalowej**. Worker ustawia `awaiting_portal_adapter`. Ręczny pilot wiersza 18001 dał 49 polis OC, z których 3 spełniły filtr daty, ale nie był automatycznym przebiegiem aplikacji.

### 1.2. Warunek uznania automatyzacji za ukończoną

Jeden wskazany, uprawniony rekord przechodzi z panelu przez Everest, Compensę i UFG bez ręcznego przepisywania danych, a operator wpisuje SMS tylko wtedy, gdy portal go żąda. Wynik w bazie jest kompletny względem podsumowania UFG; plik zawiera wszystkie polisy z `Okres ub. do >= referenceDate`; użytkownik pobiera go z panelu. Brak aktualnych polis kończy zadanie bez pliku. Test jest potem powtarzany na małej partii i na VPS. Do tego momentu `completed` nie wolno użyć jako statusu dla zadania, które zatrzymało się przed portalami.

## 2. Niezmienne zasady przepływu danych

1. **Źródło:** oryginalny Excel pozostaje bez zmian. `batchId` wskazuje import; `sourceRowId` i `rowNumber` wskazują dokładnie jeden wiersz. Wartości pochodne mają źródło, czas i autora decyzji.
2. **Tożsamość:** PESEL z Everest przechodzi dalej tylko po zgodności REGON, nazwy działalności i właściwej osoby. Gdy `Osoba Decyzyjna` jest pusta, Everest musi wskazać osobę jednoznacznie. Nie łączyć podobnych nazw na wyczucie.
3. **Numer rejestracyjny:** skonfigurowana wartość `RST22339` służy wyłącznie do wejścia do formularza Compensy. Żadna funkcja ekstrakcji, filtra, deduplikacji ani eksportu OC nie używa jej jako warunku wyboru polisy.
4. **Data:** API zapisuje `referenceDate` raz, przy utworzeniu runu, według `Europe/Warsaw`. Worker i generator używają tej samej daty mimo restartu lub przekroczenia północy. Porównanie końca polisy jest włączne.
5. **Kompletność:** liczba odczytanych wierszy OC musi równać się liczbie OC w podsumowaniu UFG. Niekompletny odczyt nie jest wynikiem zerowym i nie daje pliku.
6. **Powtarzalność:** jednego runu nie wolno wykonać równocześnie dwa razy. Po niepewnym `Zapisz` w Compensie najpierw sprawdzić ofertę, a dopiero potem decydować o ponowieniu. Wynik parsowania i eksport można ponowić bez ponownego tworzenia oferty.
7. **Dane wrażliwe:** kolejka przenosi tylko `runId`. Hasła, SMS i pełne PESEL nie trafiają do logów ani zdarzeń. PESEL jest potrzebny w wyniku biznesowym i dlatego wymaga ograniczonego dostępu do bazy oraz pliku.
8. **Stan końcowy:** `completed` oznacza dodatni, pobieralny plik; `no_matching_policies` oznacza pełen odczyt UFG, zero polis aktualnych i brak pliku; `failed` oznacza jawny błąd z kodem. Samo `awaiting_portal_adapter` nie jest sukcesem.

## 3. Architektura i właściciel prawdy

| Usługa | Odpowiedzialność | Czego nie przechowuje / nie robi |
| --- | --- | --- |
| Next.js/React (`apps/web`) | Logowanie operatora, import, status, interwencja SMS, pobranie pliku | Nie otrzymuje haseł portali; nie wylicza samodzielnie wyniku OC |
| NestJS (`apps/api`) | Autoryzacja, walidacja żądań, zapis importu/runów/wyników, uruchomienie joba, bezpieczne pobranie | Nie steruje ekranami portali; nie zapisuje kodu SMS |
| PostgreSQL | Stan kanoniczny: źródłowe wiersze, pochodzenie korekt, runy, zdarzenia, polisy, artefakty | Nie zawiera hasła portalu ani SMS |
| Redis/BullMQ | Transport identyfikatora zadania i sygnałów operacyjnych | Nie jest źródłem prawdy o wyniku; job nie zawiera danych osobowych |
| Worker Node/Playwright (`apps/worker`) | Jedna sesja przeglądarki na konto, adaptery portali, odczyt UFG, checkpointy | Nie uruchamia wielu równoległych zapisów na jednym koncie |
| Prywatny magazyn plików | Bajty `.xlsx` pod technicznym `artifactId` | Nie wystawia publicznego katalogu ani przewidywalnego URL |
| PZU Everest i CPortal | Zewnętrzne źródła tożsamości i danych UFG | Nie są kontrolowane przez aplikację; ich sesje mogą wygasać |

Na lokalnym Compose istnieją `web`, `api`, `worker`, PostgreSQL i Redis. Reverse proxy HTTPS, role oraz magazyn wyników są pracą przed VPS. Logowanie użytkownika w Chrome **nie** stanowi sesji profilu Chromium workera.

## 4. Kontrakty integracyjne, które trzeba ustalić przed kodowaniem adapterów

### 4.1. Wspólne typy w `packages/core`

Zdefiniować wersjonowane kontrakty, bez kopiowania typów ręcznie między React, API i workerem:

| Kontrakt | Minimalna zawartość | Reguła walidacji |
| --- | --- | --- |
| `RunInputV1` | `runId`, `sourceRowId`, `batchId`, `referenceDate`, `toolId`, `schemaVersion` | UUID, istniejący wiersz i stała data; `toolId = oc-policy-verification` |
| `IdentityMatchV1` | powiązanie z `sourceRowId`, REGON, potwierdzona nazwa, imię i nazwisko, PESEL, metoda dopasowania, wersja adaptera | Tylko jeden kandydat działalności i jednej osoby; brak PESEL w logach |
| `InsuredInputV1` | potwierdzona osoba, PESEL, dane adresowe z przypisanego wiersza, numer rejestracyjny jako wejście formularza | Odrzucić sprzeczną osobę; nie nadpisywać już wypełnionych pól portalu |
| `OcSnapshotV1` | liczba OC z podsumowania, pełne wiersze OC, data odczytu, wersja parsera | `rows.length === totalCount`; każde `coverageTo` jest poprawną datą |
| `RunResultV1` | `runId`, `referenceDate`, liczba wszystkich i aktualnych OC, wskazanie artefaktu albo jawny brak | Dodatni wynik wymaga artefaktu; zero nie tworzy pustego pliku |
| `ErrorCode` | kod i etap, bez treści pól klienta | Stabilny kod obsługiwany przez panel, bez danych osobowych |

Kontrakty są niezależne od HTML portali. Adapter Playwright tłumaczy ekran na te typy. Fixtury syntetyczne implementują ten sam interfejs; tryb testowy jest aktywowany wyłącznie w testach lub osobnym środowisku i nie jest dostępny jako przełącznik produkcyjnego żądania użytkownika.

### 4.2. Macierz granic systemów

| Granica | Identyfikator i dane | Kontrola wejścia | Efekt trwały | Awaria i wznowienie |
| --- | --- | --- | --- | --- |
| Excel → API | Plik, SHA-256, `batchId`, `rowNumber` | Arkusz, nagłówki, rozmiar, typy tekstowe, problemy wierszy | `import_batches` + `source_rows` w jednej transakcji | Błąd importu nie zostawia częściowej partii |
| API → DB → BullMQ | `runId` w jobie | Uprawnienie, gotowy wiersz, jeden aktywny run | `queued` i pierwsze `run_event`; job o `jobId=runId` | Reconcile odbudowuje brakujący job bez nowego runu |
| BullMQ → worker | `runId` | Worker ponownie odczytuje status i wiersz z DB | `validating` i kolejne checkpointy | Nieaktualny/anulowany job kończy się bez portalu |
| Worker → Everest | REGON, nazwa, opcjonalna osoba | Jednoznaczne powiązanie firmy i osoby | Minimalny, chroniony wynik tożsamości | Brak/wiele kandydatów → `identity_review` |
| Worker → Compensa | PESEL właściwej osoby, dane tylko z jej `sourceRowId`, skonfigurowana tablica | Porównanie osoby i wymaganych pól przed `Zapisz` | Identyfikator oferty lub dowód jej istnienia | Niepewny zapis → odczyt oferty przed powtórką |
| UFG → parser | Liczba OC + pełna tabela | Nagłówki, scroll/strony, liczność, pozycja, daty | Zatwierdzony snapshot przypisany do `runId` | Niezgodność → `UFG_INCOMPLETE`, bez eksportu |
| Parser → DB | Snapshot i `referenceDate` | Stabilna kolejność, kompletność, klucz unikalny w runie | Polisy w transakcji, liczby kontrolne | Ponowienie daje te same rekordy, bez dubletów |
| DB → XLSX → magazyn | Tylko zatwierdzone aktualne polisy | Ponowne sprawdzenie daty, liczby i kolumn | Plik pod UUID, SHA-256, metadane artefaktu | Błąd pliku → `EXPORT_FAILED`; polisy zostają w DB |
| Magazyn → API → panel | `artifactId`, `runId` | Sesja, rola, zakres dostępu, zgodność artefaktu z runem | Zdarzenie pobrania bez zawartości pliku | 403/404/503; brak publicznego linku |
| Panel → API → worker (SMS) | `challengeId`, `runId`, portal, kod tylko w pamięci | Właściciel, ważność, jedna aktywna próba | DB przechowuje wyłącznie metadane wyzwania | Utrata przekazania unieważnia próbę; operator otrzymuje nowe żądanie |

### 4.3. API: istniejące i projektowane punkty wejścia

| Endpoint | Stan | Wejście / wyjście | Warunek integralności |
| --- | --- | --- | --- |
| `POST /api/imports`, `GET /api/imports/:id/rows` | Istnieją | Plik oraz podgląd numerowanych wierszy | Import jest transakcyjny; źródłowy plik nie jest nadpisywany |
| `POST /api/runs`, `GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel` | Istnieją | Jeden `batchId` i `rowNumber`, status i zdarzenia | Run wskazuje istniejący wiersz; drugi aktywny run na ten sam wiersz jest blokowany |
| `GET /api/runs/:id/artifact` | Projektowany W2 | Strumień XLSX i nazwa do pobrania | Autoryzacja konkretnego runu, dodatni wynik, gotowy artefakt i kontrola integralności |
| `GET /api/runs/:id/interventions` | Projektowany W3/W5 | Aktywne wyzwania i brakujące dane, bez SMS/PESEL | Widoczność tylko dla uprawnionego operatora |
| `POST /api/auth-challenges/:id/code` | Projektowany W3 | Kod podany przez operatora; odpowiedź o przyjęciu próby | Termin, portal, run, operator, pojedyncze użycie; kod bez trwałego zapisu |
| `PATCH /api/imports/:id/rows/:rowNumber` | Istnieje — propozycja w W4.03 | `proposedRegon`, `reason`, `expectedVersion`; odpowiedź zawiera `correctionId`, stan i nową wersję wiersza | Sesja administratora i CSRF; blokada wiersza w transakcji; stare wersje i druga oczekująca propozycja dostają 409; propozycja jest audytowana, a `regonRaw`/`effectiveRegon` nie zmieniają się przed zatwierdzeniem |
| `POST /api/imports/:id/enrichment` | Projektowany W4 | Zlecenie kontroli NIP → REGON | Tylko wiersze kwalifikujące się; odpowiedź rejestru z pochodzeniem |
| `POST /api/runs/batch` | Projektowany po W4 | Lista wybranych wierszy lub zakres | Serwer deduplikuje grupy kanoniczne; nie przyjmuje arbitralnej listy PESEL |

Każdy nowy endpoint ma walidację schematu, kontrolę uprawnienia do konkretnego importu/runu i stabilny kod błędu. API nie ufa `referenceDate`, PESEL, liczbie polis ani statusowi nadesłanemu przez przeglądarkę operatora. To API ustala datę i stan na podstawie DB. Po wdrożeniu ról samo poprawne cookie nie wystarcza do dostępu do zasobu.

### 4.4. Model stanów i checkpointów

Proponowany przebieg używa istniejących nazw `RunStatus`, z doprecyzowaniem semantyki i ewentualnym dodaniem statusu przeglądu wejścia w migracji W1:

```text
queued → validating → pzu_login → everest_search → compensa_login
       → compensa_form → ufg_verification → reading_oc
       → export_ready → completed
       └─ przy 0 aktualnych OC: no_matching_policies

pzu_login / compensa_login → waiting_for_sms → poprzedni krok logowania
everest_search → identity_review → ponowna ocena osoby
compensa_form → waiting_for_manual_data → compensa_form
dowolny bezpieczny krok → failed albo cancelled zgodnie z regułą wznowienia
```

`awaiting_portal_adapter` jest obecnym technicznym przystankiem; po wdrożeniu W1 produkcyjny run przechodzi dalej tylko wtedy, gdy wymagane adaptery mają pozytywne bramki. `export_ready` oznacza, że kompletne polisy są już w DB, a plik czeka na wygenerowanie albo ponowienie. Błąd eksportu zapisuje `errorCode = EXPORT_FAILED` przy stanie umożliwiającym ponowienie **samego eksportu**; `EXPORT_FAILED` nie jest nazwą statusu. `no_matching_policies` jest końcowy tylko po pełnym odczycie OC.

Checkpoint ma `runId`, `step`, `attempt`, czas, wersję adaptera i opcjonalny identyfikator sprawy w portalu. `last_safe_step` wskazuje, skąd wolno wznowić. Przejścia stanu i `run_events` zapisuje jedna transakcja. Przed skutkiem zewnętrznym worker zapisuje zamiar; po skutku zapisuje potwierdzenie. Jeśli po akcji zewnętrznej brak potwierdzenia w DB, worker sprawdza stan portalu zamiast ponawiać akcję w ciemno. Nie wpisywać do zdarzenia nazwy osoby, PESEL, kodu SMS ani treści oferty.

## 5. Plan zmian w schemacie danych

Istnieją migracje `001`–`006`. Następne numery są propozycją i należy je uzgodnić z aktualnym stanem gałęzi w chwili kodowania. Migracje są addytywne; nie przepisywać starych migracji ani oryginalnego Excela.

| Migracja | Tabele / kolumny | Klucze i ograniczenia | Powód |
| --- | --- | --- | --- |
| `007-run-checkpoints` | `automation_runs`: `schema_version`, `adapter_version`, `last_safe_step`, `external_case_ref`, `heartbeat_at`, `started_at`, `finished_at`; `run_events`: `actor_id`, bezpieczne `metadata` | Niepowtarzalność aktywnego runu; dozwolone przejścia sprawdzane w warstwie usług | Wznowienie, diagnostyka, rozliczenie działań zewnętrznych |
| `008-identities-and-policies` | `run_identities`, `oc_snapshots`, `oc_policies` | FK do `automation_runs`; nagłówek przechowuje liczność UFG, czas i wersję parsera nawet przy 0 polis; unikat `run_id + source_ordinal`; PESEL szyfrowany aplikacyjnie z wersją klucza | Powiązanie osoby, pełna koperta snapshotu i wiersze OC bez dubletów |
| `009-export-artifacts` | `export_artifacts`: `id`, `run_id`, techniczny klucz pliku, nazwa do pobrania, SHA-256, rozmiar, liczba polis, status, czasy | FK do runu, unikat gotowego artefaktu dla wersji wyniku | Pobranie i bezpieczne ponowienie eksportu |
| `010-interventions` | `auth_challenges`, `manual_interventions` | Jedno aktywne wyzwanie na konto/portal, termin ważności; **brak kolumny kodu SMS** | Interwencja operatora i wygaśnięcie prób |
| `011-enrichment-and-entities` | `source_row_corrections`, `registry_lookups`, `canonical_entities`, `entity_source_rows` | FK do źródła, unikat cache dla NIP/wersji odpowiedzi, audyt decyzji | REGON z NIP i deduplikacja po zachowaniu pochodzenia |
| `012-users-and-audit` | `users`, `memberships`/role, `audit_events`, sesje panelu lub ich wersja | Unikat loginu; FK aktora, indeks czasu i celu | Dostęp do PESEL, plików, korekt i interwencji |

**Zasady pól wrażliwych:** pełny PESEL potrzebny do ponownego eksportu przechowywać w postaci szyfrowanej, z identyfikatorem wersji klucza; klucz poza DB i repozytorium. Rozważyć retencję jak najkrótszą zgodną z procesem Goldis. W listach API nie zwracać pełnego PESEL. Nie zapisujemy kodów SMS, haseł ani kopii sesji portali w tabelach. Pełny profil Chromium pozostaje w prywatnym wolumenie workera.

**Zasady migracji i odtworzenia:** osobny test migracji od pustej bazy i od kopii schematu po `006`; backup przed produkcyjną migracją; migracja danych w partiach, jeśli tabela importu urośnie. Po migracji policzyć wiersze, FK i unikatowe indeksy, a `down` testować tylko na danych syntetycznych. Nie kasować istniejących importów w celu zmiany schematu.

## 6. Pakiety wykonawcze w kolejności zależności

Każdy pakiet ma zmianę w kodzie, przypadki brzegowe i osobną bramkę. Nie przechodzi się do żywego portalu tylko dlatego, że kompilacja się udała.

### W0 — Utrwalenie punktu bazowego

**Zmiany:** zapisać wynik `npm test`, buildów trzech aplikacji i `docker compose ps` w protokole bez sekretów; potwierdzić, że `.env`, Excel i `exports/` nie trafiają do Git. W `docs/STAN_IMPLEMENTACJI.md` wpisać listę zweryfikowanych funkcji i znanych luk. Rozdzielić test ręcznego pilotażu od testów automatycznych.

**Bramka W0:** czysta instalacja i migracje do `006` działają; użytkownik widzi jawne `awaiting_portal_adapter`. Błąd już istniejący jest opisany przed kolejnymi zmianami.

### W1 — Kontrakty i pełny przebieg syntetyczny bez portali

**Pliki:** `packages/core/src/`; nowe `apps/worker/src/pipeline.ts`, `ports.ts`, `fixtures/`; rozbudowa `apps/worker/src/run-worker.ts`; testy workera.

**Kroki:**

1. Dodać typy z sekcji 4 i walidację na granicy workera. Zależność od portalu ukryć za `IdentityProvider` oraz `PolicyProvider`/`CompensaProvider`.
2. Zdefiniować czyste przejścia stanu i katalog kodów błędów. Jedna funkcja obsługuje jeden `runId`, lecz adaptery mogą być fikcyjne. `run-worker.ts` nie powinien zakładać, że każde zadanie kończy się po `validating`.
3. Przed etapem odczytać wiersz i `referenceDate` z DB. Na każdym etapie sprawdzić anulowanie i zapisać zdarzenie oraz nowy status w transakcji. Nie wrzucać danych wiersza do joba.
4. Przygotować fikcyjne odpowiedzi: 0/1/wiele osób, 0/1/wiele polis, brak wymaganych pól, wygaśnięta sesja. Wykluczyć przypadkowe włączenie fikcyjnego adaptera w produkcji.
5. Utrzymać jedną instancję `BrowserSession` na proces, lecz fikcyjny przebieg nie musi jej otwierać. Żywy adapter dostanie ją przez konstruktor dopiero w W6–W7.

**Testy:** poprawny syntetyczny run; `identity_review`; brak polis; restart po każdym statusie; ponowne dostarczenie tego samego joba; anulowanie przed etapem zewnętrznym; brak wartości pól klienta w zdarzeniach.

**Bramka W1:** testowy runner wywołuje cały przebieg syntetyczny i zwraca wynik roboczy lub jawną interwencję. Wynik roboczy pozostaje w pamięci testu; produkcyjne `POST /runs` nadal zatrzymuje się w `awaiting_portal_adapter`. Dopiero W2 łączy przebieg z trwałym zapisem i panelem, więc W1 nie ustawia `completed` ani `no_matching_policies` w prawdziwym runie.

### W2 — Zapis pełnego wyniku i udostępnienie Excela

**Pliki:** nowe migracje `008`–`009`, modele w `apps/api/src/db.ts`, moduł wyników w API, połączenie `apps/api/src/export.ts` z DB, endpoint `GET /api/runs/:id/artifact`, link w `apps/web/app/workspace.tsx`.

**Kroki:**

1. Zapisać pełny, zatwierdzony snapshot OC z `runId`, `sourceOrdinal`, wersją parsera i liczbą OC z UFG. Zachować wszystkie wiersze źródłowe, nawet historyczne; aktualność wyliczać względem zamrożonej daty.
2. Przechowywać wynik tożsamości minimalnie. PESEL zaszyfrować przed zapisem; lista runów zwraca wyłącznie dane maskowane albo brak PESEL.
3. W transakcji zapisać polisy i stan gotowości do eksportu. Unikat `(run_id, source_ordinal)` oraz upsert z porównaniem treści chronią przed dubletami przy wznowieniu. Zmiana treści tej samej pozycji po ponowieniu wymaga jawnej niezgodności, a nie cichego nadpisania.
4. Generator czyta wyłącznie zatwierdzone polisy aktualne. Daty zapisuje jako tekst ISO; komórki zaczynające się od formuły traktuje jako tekst. Plik tymczasowy zapisać w prywatnym katalogu i atomowo przenieść pod techniczny identyfikator. Dopiero po gotowym pliku zapisać metadane artefaktu i stan `completed`. Osierocony plik po awarii podlega sprzątaniu.
5. Dla 0 aktualnych polis zapisać `no_matching_policies` bez artefaktu. Dla dodatniego wyniku API pobiera plik przez `runId` po kontroli uprawnienia, nazwy i sumy kontrolnej. UI pokazuje liczbę polis oraz przycisk pobrania.

**Testy:** 0, 1 i 158 polis; data końca wczoraj/dziś/jutro; pełne porównanie 12 pól po ponownym odczycie XLSX; dwa równoległe żądania eksportu; awaria dysku po zapisaniu DB; plik o tej samej nazwie biznesowej w dwóch runach; 401/403 dla pobrania; brak numerów seryjnych Excela w datach.

**Bramka W2:** w izolowanym środowisku testowym `POST /runs` uruchamia syntetyczny przebieg; wynik można pobrać z panelu i odpowiada rekordom w DB pole po polu. Tryb produkcyjny nie używa fikcyjnych danych. Stan `completed` nie istnieje bez gotowego artefaktu; stan bez polis nie ma artefaktu.

### W3 — Kanał SMS i interwencja operatora bez prawdziwego SMS

**Pliki:** migracja `010`; moduł `auth-challenges` w API; kanał wewnętrzny API–worker; workerowy port MFA; komponent interwencji w panelu; testy bezpieczeństwa.

**Kroki:**

1. Worker wykrywa żądanie MFA i tworzy wyzwanie z `challengeId`, portalem, `runId`, terminem, numerem próby oraz identyfikatorem posiadanej sesji. DB przechowuje tylko te metadane.
2. Panel pokazuje aktywne wyzwanie tylko uprawnionemu operatorowi. `POST /api/auth-challenges/:id/code` sprawdza sesję, CSRF, termin, portal i powiązanie z runem; limituje próby. Kod istnieje tylko w pamięci żądania API i workera.
3. Przekazać kod bez trwałej kolejki: proponowany wewnętrzny, niepubliczny endpoint workera uwierzytelniony tokenem usługi i związany z aktywnym wyzwaniem. API oznacza próbę jako zajętą **przed** przekazaniem; przy błędzie transportu unieważnia ją, zamiast próbować ponownie ten sam kod. Worker przyjmuje kod jeden raz i usuwa go z pamięci po wpisaniu.
4. Przy restarcie workera wyzwanie wygasa. Po ponownym starcie worker najpierw sprawdza sesję profilu; nowego SMS żąda tylko wtedy, gdy portal pokazuje MFA. Aktywna sesja jest współdzielona przez kolejne wiersze, bez logowania na każdy rekord.
5. Dodać obsługę błędnego kodu, wygaśnięcia, kilku kart panelu, próby wpisania kodu do obcego runu i anulowania oczekiwania.

**Testy:** `T-SMS-01`–`08` na fikcyjnym ekranie MFA; skan DB, Redis, logów i artefaktów po każdym teście; jednoczesne dwa kody; restart API i workera w momencie przekazania; ponadczasowy kod odrzucony.

**Bramka W3:** kod testowy dociera wyłącznie do właściwej aktywnej sesji i znika po użyciu; przy niepewnym dostarczeniu system prosi o nową próbę. Baza, trwała kolejka i logi nie zawierają kodu. Żywe MFA pozostaje do weryfikacji w W8.

### W4 — Korekty importu, NIP → REGON i duplikaty

**Pliki:** migracja `011`; importer/API w `apps/api/src/`; ekran korekt w `apps/web`; interfejs klienta oficjalnego rejestru z atrapą testową; `packages/core` dla reguł porównania.

**Kroki:**

1. Dodać korektę niepewnego REGON z autorem, powodem, poprzednią i nową wartością oraz datą. Pole `regon_raw` pozostaje nienaruszone; `effectiveRegon` jest wartością zatwierdzoną do portali.
2. Kandydat do wzbogacenia ma pusty REGON i NIP z poprawną sumą kontrolną. Pytać oficjalny rejestr najwyżej raz na unikalny NIP w danej wersji danych, z limitem tempa i cache. Klucz rejestru trzymać tylko w sekretach serwera.
3. Porównać NIP, pełną nazwę i REGON odpowiedzi. Przy 0/wielu wynikach, 9/14-cyfrowych jednostkach, różnej nazwie lub niedostępności rejestru zapisać stan do przeglądu; nie wybierać automatycznie pierwszej pozycji.
4. Po wzbogaceniu grupować zgodne podmioty na podstawie identyfikatorów i nazwy. Jeden `canonicalEntityId` może wskazywać wiele `sourceRowId`. Nie scalać tylko dlatego, że nazwa jest podobna. Ten sam NIP z różnymi REGON oraz ten sam REGON z różnymi NIP to konflikt.
5. Dla tej samej partii, firmy kanonicznej i znormalizowanej osoby decyzyjnej istnieje co najwyżej jeden aktywny run. Wszystkie pasujące `sourceRowId` trafiają do mapy runu; inna osoba decyzyjna tej samej firmy otrzymuje odrębny run. Brak osoby decyzyjnej pozostaje osobnym kluczem i nie łączy się z nazwanym leadem. Ponowny import nie modyfikuje historycznego batcha.

**Testy:** `T-REG-01`–`12`, `T-DUP-01`–`07`; NIP z zerem wiodącym; wyczerpany limit rejestru; odpowiedź sprzeczna; powtórne uruchomienie; dwie karty operatora poprawiające ten sam wiersz; zgodność sumy kategorii pustych REGON z badaną kopią Excela.

**Bramka W4 bez klucza:** cała logika przechodzi na atrapach, a brak klucza daje czytelny stan integracji bez uruchomienia portali. **Bramka produkcyjna P0A:** po uzyskaniu dostępu wynik oficjalnego rejestru i ręczna próbka potwierdzają korekty, a oryginalny plik zachowuje SHA-256.

### W5 — Kontrola dostępu, audyt i ochrona danych

**Pliki:** migracja `015-users-memberships-audit.ts`, `apps/api/src/session.ts`, guardy zasobów, `apps/web` ekrany użytkowników i historii, konfiguracja Compose.

**Domyślna macierz W5.01 dla jednego tenanta Goldis:**

| Rola | Zakres |
| --- | --- |
| `admin` | Pełna obsługa importów, zadań, SMS, propozycji i rozstrzygania korekt/konfliktów, audytu, artefaktów oraz użytkowników w tenant Goldis. |
| `operator` | Tworzenie importów; odczyt własnych importów/zadań; start/anulowanie własnego runu; SMS, propozycja korekty i pobranie artefaktu wyłącznie dla własnego zasobu. Bez rozstrzygania korekt/konfliktów ani odczytu audytu. |
| `reviewer` | Odczyt danych i wyników w tenant Goldis; rozstrzyganie korekt i konfliktów oraz odczyt audytu. Bez startu runu, SMS, propozycji korekty, pobrania artefaktu i zarządzania użytkownikami. |
| `auditor` | Wyłącznie odczyt zredagowanego audytu w tenant Goldis; bez listy wierszy źródłowych, PESEL, plików i mutacji. |

Każdy import należy do aktora, który go utworzył; run, SMS, korekta i artefakt dziedziczą właściciela przez `batchId`/`sourceRowId`/`runId`. `admin`, `reviewer` i `auditor` działają w granicy tenanta; identyfikator ownera i rola pochodzą wyłącznie z serwera. To polityka początkowa do weryfikacji z Goldis przed produkcyjnym włączeniem; w testach ma być jawna.

**Kroki:** konto bootstrap zastąpić kontami użytkowników i rolami; przypisać dostęp do importów, runów, SMS, korekt i pobierania plików. Wpisywać audyt dla utworzenia runu, korekty REGON, interwencji, pobrania i anulowania, bez treści PESEL/SMS. Dodać limit logowania, CSRF dla mutacji opartych na cookie, bezpieczne cookie za HTTPS, retencję eksportów i usuwanie danych według ustaleń Goldis. Sprawdzić, czy lista nie ujawnia pełnych PESEL lub ścieżek plików.

**Testy:** operator bez roli nie pobiera cudzego pliku nawet po ręcznym wpisaniu URL; użytkownik nie widzi obcego importu; pobranie i korekta mają ślad; skan logów; próba CSRF; wygaśnięcie sesji podczas oczekiwania na SMS.

**Bramka W5:** każde API sprawdza uprawnienie do konkretnego zasobu, a nie tylko obecność cookie. Uprawnienia obowiązują także przy bezpośrednim wywołaniu endpointu.

### W6 — Adapter PZU Everest

**Zależności:** W1, W3, W5; uprawniona sesja i ekran do testu selektorów. Bez SMS można przygotować interfejs, fixtury i logikę dopasowania, ale nie uznać adaptera live za odebrany.

**Kroki:** rozpoznanie aktywnej sesji w trwałym profilu; wejście do Everest przez wspierany pulpit PZU; logowanie i zgłoszenie MFA tylko przy żądaniu portalu; wyszukanie REGON; odczyt wszystkich kandydatów; wybór działalności po REGON/nazwie i zgodności osoby; PESEL pobrany tylko z wybranej działalności; zapis wersji adaptera i bezpiecznego checkpointu. Selektory po etykietach i strukturze z pilotażu, bez zgadywania wartości klienta. Błędy TLS i brak uprawnienia zatrzymują run bez obchodzenia zabezpieczeń.

**Testy:** 0/1/wiele wyników, konto osoby obok działalności, brak PESEL, niezgodna osoba, wygaśnięcie sesji po wejściu, restart przed odczytem. Jeden wskazany rekord live dopiero przy dostępnej sesji.

**Bramka W6:** `IdentityMatchV1` dotyczy tej samej osoby i działalności; niejednoznaczność nigdy nie prowadzi do W7.

### W7 — Adapter Compensa i kompletny odczyt UFG

**Zależności:** W1–W3 i W6. Bez SMS można zbudować adapter na syntetycznych stronach oraz testować parser w Chromium.

**Kroki:** rozpoznanie sesji CPortal; otwarcie Compensa Komunikacja; `Ubezpieczający`; PESEL z W6 i skonfigurowana tablica jako pola wejścia; sprawdzenie zgodności osoby; wypełnienie tylko pustych wymaganych pól z *tego samego* wiersza; brak powiatu lub konflikt → interwencja; `Zapisz` z identyfikatorem oferty; UFG i szczegóły; otwarcie OC; przewinięcie wewnętrznego kontenera i obsługa stron do stabilnej liczby wierszy; odczyt pełnej tabeli i porównanie z podsumowaniem. Nie przerywać odczytu po pierwszym widocznym ekranie.

**Testy:** wypełnione pola portalu pozostają nienaruszone; brak wymaganej wartości; awaria po `Zapisz`; UFG 0, 1, 158; wirtualizowane wiersze, scroll i stronicowanie; zmiana nagłówka; `Akcje` bez danych; różne tablice rejestracyjne. Test wejściowej tablicy ma potwierdzić, że nie zmienia zbioru wyeksportowanych OC.

**Bramka W7:** kompletny syntetyczny odczyt 158 wierszy i jeden uprawniony live; `UFG_INCOMPLETE` przy 157/158; brak dubletu oferty po symulowanym restarcie.

### W8 — Odporność całej ścieżki i pilotaż live

**Zależności:** W1–W7. W części bez SMS przygotować wstrzykiwanie awarii i procedurę operatora. Część live wymaga dostępnej sesji/MFA.

**Kroki:** restart workera przy każdym checkpointcie; przerwanie sieci; niedostępność Redis/DB; limit portalu; wygasła sesja; błąd UFG; brak miejsca na plik; rotacja klucza szyfrowania; zmiana selektora. Dla każdego przypadku: kod błędu, dopuszczalne ponowienie, odpowiedzialność operatora i dowód, że nie powstała druga oferta ani częściowy plik. Dodać alerty z kodami, bez PII. Następnie uruchomić automatyczny test na wskazanym uprawnionym rekordzie i porównać z ręcznym wynikiem.

**Bramka W8:** każdy run kończy się wynikiem, jawną interwencją albo jawnym błędem. Nie ma cichego pominięcia polisy, ponownego zapisu oferty ani sekretów w logach.

### W9 — VPS i stopniowe zwiększanie partii

**Zależności:** zamknięcie decyzji o dopuszczonym sposobie integracji, W5 i W8.

**Kroki:** HTTPS i reverse proxy; tylko publiczny port aplikacji; DB/Redis/worker w sieci prywatnej; oddzielne konta i uprawnienia wolumenów; backup DB i artefaktów; próba odtworzenia; monitoring zdrowia API, długości kolejki, aktywnego wyzwania, profilu, wolnego dysku i błędów portali; ograniczenie tempa. Na VPS profil Chromium startuje odrębnie od Chrome użytkownika. Sprawdzić: pierwsze MFA, kilka kolejnych wierszy na jednej sesji, restart workera, ponowna kontrola sesji i jej wygaśnięcie. Uruchomić kolejno 1, 10 i 100 wskazanych rekordów po każdej ocenie jakości; nie wysyłać automatycznie całej bazy.

**Bramka W9:** ręczna próbka wyników zgadza się z portalami, backup odtwarza DB i pliki, monitoring wykrywa zatrzymany worker, a konto portalu nie jest blokowane przez tempo.

## 7. Testy integralności i przypadki brzegowe

Każdy test otrzymuje fikcyjne dane, oczekiwany stan DB, oczekiwany kod API i kontrolę pliku. Testy live zapisują tylko zanonimizowany protokół.

| ID | Sytuacja | Wymagany wynik |
| --- | --- | --- |
| `INT-01` | API zapisuje `queued`, Redis jest niedostępny | Reconcile tworzy dokładnie jeden job po powrocie Redis; ten sam `runId` |
| `INT-02` | Ten sam job dociera dwa razy | Co najwyżej jeden aktywny przebieg i brak powtórnego `Zapisz` |
| `INT-03` | Excel ma pusty REGON i poprawny NIP, rejestr zwraca 2 jednostki | Przegląd operatora, żadnego PESEL ani zapytania do Compensy |
| `INT-04` | Dwa źródłowe wiersze mają zgodny NIP/REGON/nazwę | Jedna grupa i jeden run, dwa zachowane `sourceRowId` |
| `INT-05` | Everest ma osobę fizyczną i działalność dla jednego REGON | Wybrana działalność po zgodności; PESEL nie jest brany z niepowiązanego konta |
| `INT-06` | Komplet pól Compensy istnieje, Excel ma inny kod pocztowy | Portalowe pole pozostaje bez zmian; audyt źródła wartości |
| `INT-07` | Worker pada po `Zapisz`, przed UFG | Po starcie szuka istniejącej sprawy; nie tworzy drugiej |
| `INT-08` | UFG podaje 158 OC, parser widzi 157 | `UFG_INCOMPLETE`, zero zatwierdzonych nowych wyników i brak pliku |
| `INT-09` | Polisa kończy się dokładnie w `referenceDate` | Polisa trafia do wyniku |
| `INT-10` | Zadanie zaczyna się przed północą i kończy po północy | Wszystkie filtry i plik używają daty zapisanej przy utworzeniu runu |
| `INT-11` | Polisy mają różne tablice, w formularzu podano `RST22339` | Wszystkie polisy spełniające datę są brane pod uwagę |
| `INT-12` | DB zapisuje polisy, zapis pliku się nie udaje | Polisy pozostają w `export_ready` z kodem `EXPORT_FAILED`; ponowić tylko eksport |
| `INT-13` | Plik jest gotowy, DB pada przed zapisem metadanych | Brak `completed`; osierocony plik jest wykrywany/sprzątany |
| `INT-14` | Obca osoba zna `runId` i `artifactId` | API odmawia szczegółów i pliku bez uprawnienia do zasobu |
| `INT-15` | SMS przychodzi po terminie lub dla innego runu | Brak przekazania do workera; nowe wyzwanie lub jawny błąd |
| `INT-16` | Worker restartuje się przy aktywnej sesji | Najpierw kontrola sesji; bez nowego MFA, jeśli portal ją uznaje |
| `INT-17` | Pola Excela zaczynają się od `=`, `+`, `-` lub `@` | Plik traktuje je jako tekst, bez wykonania formuły |
| `INT-18` | Daty z UFG są niepoprawne lub zmienia się nagłówek | Jawny błąd schematu/daty; bez częściowego `completed` |

## 8. Kolejność odbioru i dowody dla kolejnego agenta kodującego

| Bramka | Możliwa bez SMS? | Minimalny dowód przekazania |
| --- | --- | --- |
| W0–W1: fundament i syntetyczny run | Tak | Diff, testy jednostkowe i integracyjne, przykładowe `run_events` bez PII |
| W2: wynik i pobranie | Tak | Migracje, test ponownego odczytu XLSX, odmowa nieuprawnionego downloadu |
| W3: kanał MFA | Tak, z fikcyjnym kodem | Test pojedynczego użycia, restartu, wygaśnięcia i skan trwałych danych |
| W4: REGON i grupy | Częściowo | Fixtury i raport 287 wierszy; oficjalne odpowiedzi dopiero po dostępie do rejestru |
| W5: kontrola dostępu | Tak | Testy ról, CSRF, retencji i audytu |
| W6–W7: adaptery portali | Częściowo | Syntetyczne strony teraz; selektory i uprawniony live później |
| W8–W9: produkcja | Częściowo | Testy awarii teraz; MFA, zgodność portalowa i VPS później |

**Format przekazania po każdym pakiecie:** lista zmienionych plików i migracji; kontrakty wejścia/wyjścia; wynik testów z nazwą komendy; status bramki `zaliczona / niezaliczona / częściowa`; nierozstrzygnięte przypadki; jednoznaczny następny pakiet. Agent nie oznacza bramki live jako zaliczonej na podstawie fikcyjnego adaptera. Nie zamieszcza prawdziwych PESEL, kodów SMS, haseł ani niezamazanych zrzutów w protokole.

## 9. Decyzje wymagane przed etapem live i VPS

| Decyzja | Dlaczego ma znaczenie | Termin graniczny |
| --- | --- | --- |
| Dopuszczony sposób automatyzacji PZU/Compensy i zakres kont | Określa, czy adaptery UI wolno uruchomić produkcyjnie lub czy trzeba użyć oficjalnego interfejsu | Przed W8 live i masową partią |
| Dostęp do oficjalnego rejestru REGON i reguła wyboru jednostki | Bez tego P0A może być odebrane tylko na fikcyjnych odpowiedziach | Przed produkcyjnym W4 |
| Role i retencja PESEL oraz plików | Wpływa na schemat użytkowników, eksporty, backup i usuwanie | Przed W5/W9 |
| Dostęp operatora do SMS dla profilu workera | Bez tego nie da się potwierdzić logowania i trwałości sesji na VPS | Przed W8 live/W9 |
| Dane VPS: domena, backup, zasoby i miejsce na artefakty | Określa konfigurację HTTPS, wolumenów i test odtworzenia | Przed W9 |

Brak SMS **teraz** nie zatrzymuje W0–W5 ani syntetycznej części W6–W8. Nie wolno jednak przez to uznać adapterów live lub wdrożenia produkcyjnego za gotowe.

## 10. Gotowy zakres pierwszego zadania kodującego

Pierwsze zadanie po zatwierdzeniu tego planu obejmuje **W0 i W1**, bez wywołań PZU, Compensy lub rejestru REGON. To zamyka najważniejszą lukę między istniejącą kolejką a przygotowanymi modułami, zachowując możliwość bezpiecznego testowania bez SMS.

> Pracuj w istniejącym repozytorium Goldis. Przeczytaj `docs/PLAN_WYKONAWCZY_AUTOMATYZACJI.md`, `docs/PLAN_IMPLEMENTACJI.md` i `docs/STAN_IMPLEMENTACJI.md`. Realizuj po jednym kroku z sekcji 11, zaczynając od W0.01. W W1 utwórz wersjonowane kontrakty w `packages/core`, porty adapterów, fikcyjne odpowiedzi i testowy orkiestrator jednego `runId`; produkcyjny worker pozostaw na jawnym `awaiting_portal_adapter` do W2. Nie odczytuj wartości `.env`, nie używaj rzeczywistych danych klientów i nie kontaktuj się z portalami. Nie oznaczaj `completed`, dopóki W2 nie dostarczy trwałego pliku. Zachowaj `runId` jako jedyną daną BullMQ. Po każdym kroku zaktualizuj checklistę i dziennik dowodów; po bramce podaj pliki, wyniki testów i następny krok.

Po W1 agent otrzymuje tylko następny pakiet wraz z wynikiem poprzedniej bramki. Gdy okaże się, że ustalony kontrakt wymaga zmiany, najpierw aktualizuje ten dokument i testy zależnych granic. Nie zmienia równocześnie adaptera live i modelu danych bez wspólnego testu przejścia Excel → API → worker → DB → pobranie.

## 11. Lista kroków dla Luna-xhigh

### 11.1. Sposób wykonywania i mierzenia postępu

Ta lista rozwija W0–W9 z sekcji 6. Agent wykonuje **jeden numerowany krok naraz**, zaczynając od pierwszego niezaznaczonego. Krok można zaznaczyć `[x]` dopiero, gdy istnieje wskazany plik lub zmiana, przechodzi jego test i wpisano dowód do [dziennika postępu](POSTEP_IMPLEMENTACJI.md). Gdy test ujawnia błąd, poprawić go w tym samym kroku; nie przechodzić dalej z czerwonym testem. Po każdym kroku agent ponownie odczytuje status odpowiedniego pakietu i aktualizuje licznik. Po zakończeniu pakietu uruchamia jego bramkę z sekcji 6 i oznacza ją `zaliczona`, `częściowa` albo `wstrzymana zewnętrznie`.

**Stopień wykonania** to liczba zaznaczonych i udokumentowanych kroków podzielona przez liczbę wszystkich kroków w tej sekcji. Dodatkowo raportować procent dla W0–W5 oraz osobno bramki live W6–W9. Procent nie zastępuje bramki: nawet wszystkie odhaczone kroki syntetyczne nie oznaczają ukończenia adaptera live. Krok zależny od SMS, dostępu do rejestru, kont portali lub VPS zostaje pusty z przyczyną w dzienniku. Nie zgadywać wyniku i nie oznaczać go jako wykonany.

**Przed każdą zmianą:** odczytać odpowiedni fragment kodu i testów, `git status --short`, aktualną sekcję planu i ostatni wpis dziennika. **Po zmianie:** uruchomić najwęższy znaczący test; przy bramce pakietu `npm test` i `npm run build`; dla zmiany migracji lub infrastruktury także odpowiedni test Compose. Polecenia nie mogą wypisywać wartości `.env`, haseł, PESEL ani SMS. Aktualny `git status` może zawierać wcześniejsze zmiany — nie usuwać ich i nie przypisywać ich sobie.

### W0 — Stan wyjściowy

- [x] **W0.01** Sprawdzić `git status --short`, listę `apps/`, `packages/`, `docs/` i migracje `001`–`006`; w dzienniku zapisać, które pliki były już zmienione. **Dowód:** lista ścieżek i dat bez zawartości sekretów.
- [x] **W0.02** Sprawdzić `.gitignore` i `git check-ignore` dla `.env`, `docs/BAZA TRANSPORTOWA.xlsx`, `exports/` oraz profilu workera. Nie otwierać wartości `.env`. **Dowód:** wynik „ignorowane / nieignorowane” dla każdej ścieżki.
- [x] **W0.03** Uruchomić `npm test`; zapisać kod wyjścia i liczbę testów dla `core`, `api`, `worker`. **Dowód:** komenda i wynik, bez pełnych danych klienta.
- [x] **W0.04** Uruchomić `npm run build`; zapisać wynik budowy czterech workspace. **Dowód:** sukces albo konkretny błąd bazowy.
- [x] **W0.05** Sprawdzić `docker compose ps` i `/api/health`; potwierdzić, że porty PostgreSQL/Redis nie są publikowane. Nie usuwać wolumenów. **Dowód:** status usług i odpowiedź health.
- [x] **W0.06** Na osobnej, tymczasowej bazie PostgreSQL sprawdzić migracje od pustego schematu do `006` i ich ponowne uruchomienie bez zmian; istniejącej bazy nie dotykać. Zaktualizować `docs/STAN_IMPLEMENTACJI.md` o zweryfikowany punkt bazowy i jawny status `awaiting_portal_adapter`; rozdzielić pilot ręczny od automatycznych testów. **Dowód:** migracje i ponowienie zaliczone na odizolowanej bazie oraz wpis w stanie implementacji.

### W1 — Kontrakty, stan i symulowany orkiestrator

- [x] **W1.01** W `packages/core/src/` dodać `RunInputV1`, `IdentityMatchV1`, `OcSnapshotV1`, `RunResultV1` i typy etapów; zachować istniejące `SourceRow`/`OcPolicy` bez nieuzasadnionej zmiany. **Dowód:** kompilacja `@goldis/core`.
- [x] **W1.02** Dodać walidatory na granicach (UUID, REGON, data ISO, PESEL jako 11 cyfr, liczność OC, kompletność daty końca); testować osobno każdą odmowę. **Dowód:** testy `core` z fikcyjnymi wartościami.
- [x] **W1.03** Opisać i zakodować tabelę dozwolonych przejść statusów z sekcji 4.4; odrzucać cofnięcie z terminalnego stanu i `completed` bez artefaktu. **Dowód:** test tabelaryczny legalnych i nielegalnych przejść.
- [x] **W1.04** W `apps/worker/src/ports.ts` utworzyć interfejsy dostawcy tożsamości, dostawcy Compensa/UFG, repozytorium stanu i zegara; żaden interfejs nie zna selektora HTML. **Dowód:** testowa implementacja portów kompiluje się bez Playwright.
- [x] **W1.05** Dodać fikcyjnego dostawcę Everest z wariantami: brak wyniku, jedna działalność, osoba fizyczna obok działalności, wiele osób, brak PESEL. **Dowód:** testy `identity_review` i jednoznacznego dopasowania.
- [x] **W1.06** Dodać fikcyjnego dostawcę Compensa/UFG: wypełnione/puste pola, 0/1/wiele polis, błąd UFG, niepełna tabela. Wszystkie dane są fikcyjne. **Dowód:** testy kontraktu `OcSnapshotV1`.
- [x] **W1.07** W `apps/worker/src/pipeline.ts` połączyć porty: walidacja → tożsamość → formularz → UFG → wynik roboczy; wstrzyknąć zegar i `referenceDate` z runu. **Dowód:** test pełnego przebiegu na fikcyjnym wierszu.
- [x] **W1.08** Dodać repozytorium checkpointów: zmiana stanu i `run_event` w jednej transakcji albo fikcyjny odpowiednik testowy; ponowny odczyt ma zwracać ostatni bezpieczny krok. **Dowód:** test przerwania między krokami.
- [x] **W1.09** Zabezpieczyć ponowne dostarczenie tego samego `runId`: sprawdzić stan przed pracą i nie uruchamiać drugiego skutku zewnętrznego. **Dowód:** test dwóch prób tego samego joba.
- [x] **W1.10** Wyizolować tryb fikcyjny od produkcji; produkcyjne `POST /runs` nadal kończy na `awaiting_portal_adapter`, bez `completed`. **Dowód:** test API/worker i brak żądania do portali.
- [x] **W1.11** Przetestować ścieżki: niejednoznaczna osoba, zero polis, błędna data, anulowanie przed krokiem, restart runnera. **Dowód:** wyniki testów workera i kody błędów bez PII.
- [x] **W1.12** Uruchomić `npm test` i `npm run build`; w dzienniku wskazać, że W1 daje wynik **roboczy**, a trwały wynik jest zakresem W2. **Dowód:** zaliczona bramka W1.

### W2 — Trwały wynik, XLSX i pobieranie

- [x] **W2.01** Dodać migrację checkpointów `007`, model i test migracji na pustej bazie oraz bazie po `006`; nie zmieniać starych migracji. **Dowód:** oba uruchomienia migracji kończą się bez utraty runów.
- [x] **W2.02** Dodać migrację `008` dla `run_identities`, nagłówka `oc_snapshots` i `oc_policies`; zachować FK, unikat `(run_id, source_ordinal)` i indeks odczytu runu. Nagłówek zachowuje liczność UFG, czas pobrania i wersję parsera także dla 0 polis. **Dowód:** próba zapisania dubletu narusza unikat, 158 pozycji zapisuje się, a pusty snapshot zachowuje licznik 0.
- [x] **W2.03** Dodać szyfrowanie PESEL z wersją klucza pobieranego z konfiguracji; błędna/brakująca konfiguracja zatrzymuje zapis bez ujawnienia wartości. **Dowód:** AES-256-GCM, test round-trip/rotacji klucza, rekord do DB bez jawnego PESEL, fail-closed i smoke na tymczasowym PostgreSQL z kontrolą tabeli oraz bezpiecznego kodu logu.
- [x] **W2.04** Zaimplementować transakcyjny zapis *pełnego* snapshotu OC i liczby z UFG; różna treść tej samej pozycji przy ponowieniu ma zwrócić konflikt. **Dowód:** smoke na tymczasowym PostgreSQL: pełny zapis tożsamości/snapshotu/polis w jednej transakcji, zgodne ponowienie idempotentne, zmieniona treść pozycji daje `SNAPSHOT_CONFLICT`, licznik 0 zachowuje nagłówek, awaria po zapisaniu pierwszego chunku wycofuje wszystkie rekordy.
- [x] **W2.05** Po kompletnym zapisie wyliczyć polisy aktualne z `referenceDate`; zero ustawia `no_matching_policies`, dodatni wynik `export_ready`. **Dowód:** tymczasowy PostgreSQL potwierdził: wczoraj wykluczone, dzień graniczny i jutro uwzględnione; aktualizacja statusu i `run_event` w transakcji; retry nie dubluje zdarzenia; snapshot częściowy blokuje ocenę; zero polis daje `no_matching_policies` bez workbooka.
- [x] **W2.06** Dodać migrację `009` i model `export_artifacts` z `artifactId`, kluczem pliku, SHA-256, liczbą polis i stanem. **Dowód:** tymczasowy PostgreSQL potwierdził FK do właściwego runu, unikalny klucz magazynu, walidację SHA/statusu/liczby oraz dwa artefakty z tą samą nazwą biznesową i niezależnymi identyfikatorami.
- [x] **W2.07** Podłączyć `exportOcWorkbook` do odczytu polis z DB, a nie do danych przekazanych przez przeglądarkę. Utrzymać daty ISO jako tekst. **Dowód:** `exportRunWorkbook(runId)` pobiera wyłącznie zatwierdzone rekordy źródła/tożsamości/snapshotu, odrzuca niekompletny lub niegotowy run; ponownie odczytany XLSX miał wszystkie 15 kolumn zgodne z DB, w tym PESEL/REGON jako tekst, graniczne daty ISO i nazwę z osobą decyzyjną.
- [x] **W2.08** Zapisać plik w prywatnym katalogu przez plik tymczasowy i atomowe przeniesienie; przy awarii usunąć lub wykryć osierocony plik. **Dowód:** Compose ma wyłącznie wewnętrzny wolumen `export_data` dla API; storage zapisuje `.tmp` w tym samym katalogu, fsync, atomowy rename, katalog 0700/plik 0600, walidację klucza bez traversal, cleanup po błędzie oraz wykrywanie osieroconych plików i tempów po restarcie.
- [x] **W2.09** Zapisać metadane artefaktu oraz `completed` dopiero po gotowym pliku. `EXPORT_FAILED` jest kodem błędu przy `export_ready`, więc ponowienie nie wraca do portalu. **Dowód:** smoke na tymczasowym PostgreSQL i filesystem potwierdził publikację XLSX przed metadanymi/`completed`; retry ukończył sam eksport, a awaria między rename i transakcją pozostawiła `export_ready`/`EXPORT_FAILED` i wykrywalny orphan.
- [x] **W2.10** Dodać `GET /api/runs/:id/artifact`: autoryzacja zasobu, nagłówki pobrania, kontrola istnienia i skrótu pliku, brak publicznej ścieżki. **Dowód:** lokalny test HTTP uzyskał 200 dla admina, 401 bez sesji, 403 dla poprawnie podpisanej roli bez uprawnień i 404 bez artefaktu; smoke PostgreSQL zweryfikował SHA-256, brak pliku dla runu niegotowego i wykrycie podmienionych bajtów.
- [x] **W2.11** W panelu pokazać liczbę wszystkich i aktualnych polis, stan `no_matching_policies` oraz pobranie tylko przy gotowym artefakcie. **Dowód:** API zwraca liczniki snapshotu i aktualnych polis według zapisanego `referenceDate` oraz `artifactAvailable`; testy PostgreSQL potwierdziły 1/1, 1/0 oraz gotowość artefaktu. Playwright potwierdził 49/0 bez linku, 49/3 z pobraniem, wybór runu po odświeżeniu i brak overflow na szerokości 390 px.
- [x] **W2.12** W izolowanym środowisku testowym połączyć `POST /runs` z fikcyjnym przebiegiem W1 i trwałym wynikiem W2; produkcja nie może wybrać fikcyjnego dostawcy. **Dowód:** `apps/api/scripts/w2-integration-smoke.cjs` przesłał syntetyczny Excel przez HTTP, odebrał job z samym `runId` na osobnym Redis, uruchomił wyłącznie testowego workera z fake Everest/UFG, zapisał checkpointy/tożsamość/snapshot do osobnego PostgreSQL, wyliczył 2/3 na stałej dacie 29.09.2026, wygenerował i pobrał XLSX ze zgodnym SHA i dwoma wierszami. Testy workera nadal potwierdzają, że `startRunWorker()` używa tylko produkcyjnego walidatora i parkuje w `awaiting_portal_adapter`; fixture nie jest wybierana przez konfigurację produkcyjną.
- [x] **W2.13** Uruchomić `npm test`, `npm run build`, test migracji i test integralności `INT-08`–`INT-13`; zapisać bramkę W2. **Dowód:** `npm test` — core 10/10, API 23/23, worker 25 pass/1 skip; `npm run build` — core/API/worker/Next.js pass. `migration-smoke.cjs` zaliczył 10 trybów (`empty`, `from-006`, `policies`, `pesel`, `snapshot`, `evaluation`, `export`, `artifacts`, `finalize`, `download`) na osobnych bazach syntetycznych; każda została usunięta. Smoke wykrył i naprawił windowsowy glob migracji oraz błędną asercję pełnego schematu. INT-08: niekompletny UFG daje `UFG_INCOMPLETE`, bez wyniku/eksportu; INT-09: koniec polisy równy dacie referencyjnej jest włączony; INT-10: run 23:59 i snapshot 00:01 czasu warszawskiego używają zapisanej daty także w XLSX; INT-11: pełna tabela OC nie jest filtrowana numerem z formularza; INT-12: błąd po publikacji pozwala ponowić wyłącznie eksport; INT-13: plik bez metadanych pozostaje wykrywalnym orphanem i nie ustawia `completed`. `RUN_EXPORT_SMOKE_PASS` porównał 15 kolumn XLSX z rekordami DB pole po polu. Testy syntetyczne; bez portali i danych rzeczywistych.

### W3 — SMS z fikcyjnym kodem

- [x] **W3.01** Dodać migrację `010`: metadane `auth_challenges` i `manual_interventions`, bez kolumny kodu SMS. **Dowód:** `migration-smoke.cjs mfa` na efemerycznym PostgreSQL przeszedł po 009, zachował istniejący run i sprawdził dokładny zestaw kolumn obu tabel, brak kolumn na kod/OTP/sekret/token, FK, unikalność jednego aktywnego wyzwania na konto/portal i jednej otwartej interwencji na run; ORM utworzył syntetyczne metadane wyzwania i interwencji. `npm test`, `npm run build`, `node --check` oraz `git diff --check` przeszły; baza i kontener usunięte. W tabelach są wyłącznie identyfikatory, portal, odcisk konta, identyfikator sesji przeglądarki, krok powrotu, statusy/liczniki/terminy i bezpieczne kody klasyfikacji.
- [x] **W3.02** Worker tworzy wyzwanie z `challengeId`, `runId`, portalem, terminem, próbą i identyfikatorem posiadanej sesji. **Dowód:** `apps/worker/src/auth-challenges.ts` tworzy wyzwanie w transakcji z interwencją operatora, przejściem runu do `waiting_for_sms` i wpisem zdarzenia; identyfikator sesji jest losowym UUID właściciela `BrowserSession`, a konto jest zapisywane jako HMAC/kluczowy odcisk, bez loginu i hasła. Retry tego samego runu zwraca istniejący challenge; drugi run dla tego samego konta/portalu dostaje `AUTH_CHALLENGE_ALREADY_ACTIVE`. Testy workera 31/31 plus 1 pominięty test Chromium — pass; smoke W3.01/W3.02 na PostgreSQL potwierdził unikatowość i atomowy checkpoint; build i `git diff --check` pass. Żaden kod SMS nie jest argumentem ani wartością w zapytaniu.
- [x] **W3.03** Dodać stan `waiting_for_sms` z zapamiętanym krokiem powrotu; restart unieważnia stare wyzwanie. **Dowód:** `createAuthChallenge` atomowo ustawia `waiting_for_sms` i zapisuje `return_step`; reconciliacja startowa unieważnia challenge z poprzednim identyfikatorem sesji, wygasza interwencję, zapisuje zdarzenie i przywraca `pzu_login` albo `compensa_login`. Wygasły challenge dostaje status `expired`; restart z poprzednią sesją dostaje `invalidated`. Testy workera: 33 pass/1 pominięty test Chromium; smoke PostgreSQL utworzył challenge, zasymulował restart i odczytał status/zdarzenie/interwencję; build pass. Pozycja runu jest gotowa do wznowienia na zapisanym kroku; wywołanie portalu pozostaje wyłączone do W6/W7.
- [x] **W3.04** Dodać prywatny endpoint workera do jednorazowego przyjęcia kodu, uwierzytelniany sekretem usługi i związany z `challengeId`; nie publikować portu na VPS. **Dowód:** `POST /internal/auth-challenges/:id/code` wymaga 32+ znakowego sekretu i aktywnego challenge zarejestrowanego w pamięci; odbiornik trzyma kod wyłącznie w buforze pamięci i pozwala go pobrać raz. Testy workera pokrywają brak/błędny token (401), challenge nieaktywny lub ponowne przyjęcie (409), expired (410), zły kod/body (400), typ treści (415), nadmiarowe body (413), brak odbicia kodu w odpowiedzi oraz wyzerowanie bufora przez konsumenta/zamknięcie. Compose udostępnia `3022` wyłącznie wewnętrznie (`expose`), bez `ports`; `docker compose --env-file .env.example config` z wartościami syntetycznymi potwierdził `workerPublishedPorts=0`. `npm test` — core 10/10, API 23/23, worker 38 pass/1 skip; pełny build, `node --check` i `git diff --check` pass. API jeszcze nie przekazuje kodu — to W3.05/06.
- [x] **W3.05** W API dodać `POST /api/auth-challenges/:id/code` z kontrolą sesji, runu, terminu, CSRF i limitu prób. **Dowód:** `apps/api/src/auth-challenges.ts` wiąże body z `challengeId` i `runId`, odrzuca niewłaściwą rolę, brak/niezgodny token CSRF, obce zadanie (403), challenge po terminie (410), zajęty/zużyty challenge, niewłaściwy stan runu i limit prób (409); kształt i cyfrowy kod są walidowane przed odczytem DB. Sesja podpisuje losowy CSRF token; `goldis_csrf` jest double-submit cookie, a `/api/auth/me` zwraca token do klienta. Test HTTP sprawdził 401/403/400/202; test serwisu wszystkie wymagane stany 403/409/410.
- [x] **W3.06** API zajmuje wyzwanie przed przekazaniem; przy niepewnym dostarczeniu unieważnia je. Worker wpisuje kod testowy raz i usuwa go z pamięci. **Dowód:** `AuthChallengeService` w transakcji blokuje wiersz `FOR UPDATE`, zwiększa próbę i zapisuje wyłącznie identyfikator/portal/licznik; potem przekazuje JSON do `WORKER_INTERNAL_URL` z bearer secret. Worker `POST` przyjmuje raz, a prywatny `DELETE` odrzuca oczekujący waiter i czyści bufor. Duplikat jest 409; błąd/timeout dostawy nie powoduje retry, tylko `invalidated`, bezpieczny kod `SMS_DELIVERY_UNCERTAIN` i run `failed`. Testy API/worker oraz efemeryczny PostgreSQL (`migration-smoke.cjs mfa goldis_migration_smoke_w305_20260930`) potwierdziły `claimed → submitted`, attempt=1, brak kodu w zdarzeniach, duplikat 409 oraz fail-closed dla niepewnego transportu. Kontener usunięty.
- [x] **W3.07** Panel pokazuje portal, termin i pole na kod tylko przy aktywnym wyzwaniu; po odpowiedzi usuwa wpisaną wartość ze stanu React. **Dowód:** `GET /api/auth-challenges?runId=...` zwraca wyłącznie ID, portal, status, termin i licznik prób; panel odczytuje CSRF ponownie z `/api/auth/me`, filtruje wejście do cyfr, wyłącza formularz po wygaśnięciu lub przekazaniu i czyści stan kodu zaraz po submit. `npm run build -w @goldis/web` oraz `npm run test:w3-sms-ui-smoke -w @goldis/web` — pass w Chromium na mock API: refresh, cyfry-only, wygaśnięcie i schowanie pola, CSRF header po refresh, wyczyszczenie inputu po 202; zero błędów JS. Test syntetyczny.
- [x] **W3.08** Dodać przypadki błędnego kodu, limitu prób, dwóch kart operatora i anulowania runu podczas MFA. **Dowód:** `T-SMS-01` — prawidłowo przekazany, lecz odrzucony przez portal kod zużywa próbę, zamyka interwencję z `SMS_CODE_REJECTED` i wraca na zapisany krok logowania; `T-SMS-02` — licznik kumuluje się pomiędzy wyzwaniami, piąta odrzucona próba kończy run jako `SMS_ATTEMPT_LIMIT`, a kolejnej próby nie da się utworzyć; `T-SMS-03` — dwie równoległe karty na tym samym wyzwaniu dają jedno przekazanie, drugi submit dostaje 409; `T-SMS-04` — anulowanie podczas MFA ustawia run na `cancelled`, unieważnia challenge, zamyka interwencję z `RUN_CANCELLED` i wysyła jedno unieważnienie do workera; `T-SMS-05` — endpoint anulowania wymaga sesji/CSRF, a panel wysyła nagłówek CSRF. Testy na fikcyjnym kodzie, bez portali. Pełny smoke transakcji na efemerycznym PostgreSQL zaliczony; `npm test` i `npm run build` zaliczone; lokalny Playwright smoke potwierdził formularz i anulowanie. W trakcie bramki poprawiono jawne typowanie parametrów dat/statusu w PostgreSQL oraz sprawdzanie limitu przed statusem runu.
- [x] **W3.09** Przetestować dwie kolejne fikcyjne firmy na jednej sesji oraz restart z zachowanym profilem. **Dowód:** `T-SMS-07` — dwie syntetyczne firmy są obsłużone na tej samej stronie PZU i jednym `BrowserSession`; licznik promptów MFA pozostaje równy 1; `T-SMS-08` — po zamknięciu i utworzeniu nowego `BrowserSession` z tym samym katalogiem profilu stan zalogowania zostaje zachowany, trzecia firma nie wywołuje nowego promptu. `PLAYWRIGHT_INTEGRATION=1 npm test -w @goldis/worker` — 43/43 pass w lokalnym Chromium; profile testowe usunięte. Test dotyczy syntetycznej strony, bez sesji ani danych portali.
- [x] **W3.10** Skanować DB, Redis/BullMQ, logi i artefakty po teście z unikalnym fikcyjnym kodem. **Dowód:** `T-SMS-06` używa wyłącznie syntetycznego markera `684203`: po przepływie API→worker inbox skan wszystkich wierszy `auth_challenges`, `manual_interventions` i `run_events` nie znajduje kodu; przechwycone metody logowania nie zawierają markera; dedykowany tymczasowy katalog artefaktów jest skanowany; oddzielny efemeryczny Redis/BullMQ test serializuje job wyłącznie z `runId` i przechodzi wszystkie klucze/wartości Redis bez markera. API/worker potwierdzają jednorazowy odbiór i wyzerowanie bufora. PostgreSQL i Redis działały bez woluminów; testowe katalogi i kontenery usunięte.
- [x] **W3.11** Uruchomić testy i build, zapisać bramkę W3 jako syntetyczną; nie deklarować sprawdzonego MFA PZU/Compensy. **Dowód:** `npm test` — core 10/10, API 34/34, worker 42/43 (domyślnie pominięty test Chromium); osobno `PLAYWRIGHT_INTEGRATION=1 npm test -w @goldis/worker` — 43/43 bez pominięć; `npm run build` — wszystkie workspace pass; Playwright UI smoke — pass; PostgreSQL `migration-smoke.cjs mfa` — pass; Redis `test:w3-sms-redis-smoke` — pass; skan danych W3.10 — pass. W3 zaliczono wyłącznie syntetycznie. Żadnego kodu/SMS w prawdziwym PZU ani Compensie nie testowano; adaptery portali nadal nie są podłączone.

### W4 — NIP, korekty i grupy podmiotów

- [x] **W4.01** Dodać migrację `011` i modele korekt, odczytów rejestru, podmiotów kanonicznych oraz powiązań źródłowych. **Dowód:** `apps/api/src/migrations/011-regon-entities.ts` dodaje `effective_regon` i backfill z istniejącego znormalizowanego REGON, historię propozycji korekt z autorem/powodem/review, cache rejestru po parze NIP+SHA wersji danych (bez surowej odpowiedzi) oraz encje kanoniczne/powiązania źródeł. Modele Sequelize dodane w `apps/api/src/db.ts`. Smoke `migration-smoke.cjs registry` na efemerycznym PostgreSQL po migracjach 001–011: FK source/entity, jeden pending correction na rekord, jeden cache lookup na NIP+wersję, unikalny NIP/REGON encji, odrzucenie sprzecznych identyfikatorów i zachowanie zera wiodącego; migracja rerun stabilny. `npm test -w @goldis/api` — 34/34; migracja, DB i kontener usunięte. Nie odczytywano ani nie zmieniano źródłowego Excela.
- [x] **W4.02** Dodać `effectiveRegon` jako wartość pochodną; `regon_raw` i źródłowy Excel pozostają niezmienne. **Dowód:** `deriveEffectiveRegon` w `packages/core/src/index.ts` wybiera poprawny REGON z importu lub zatwierdzonej korekty, odrzuca błędną korektę i zwraca surową wartość bez zmian. Parser/import zapisują oba pola, podgląd API ujawnia osobno `regonRaw` i `effectiveRegon`, a walidacja startu, worker, dopasowanie Everest, zapis snapshotu oraz eksport używają wyłącznie `effectiveRegon`; brak tej wartości blokuje run bez zastępowania jej przez `regonRaw`. Testy obejmują pustą wartość operacyjną przy istniejącym REGON surowym. `npm test`: core 11/11, API 34/34, worker 44 pass/1 skip; `npm run build` — pass. Efemeryczny PostgreSQL bez wolumenu: smoki `registry`, `snapshot`, `evaluation`, `export`, `finalize`, `download`, `mfa` — pass; migracje do 011 i ponowienie stabilne. `node apps/api/scripts/w2-integration-smoke.cjs goldis_migration_smoke_w402_e2e` — pass na syntetycznym Excelu: import → run z jobem `runId` → 3 pozycje snapshotu → 2 aktualne → pobrany XLSX zgodny SHA. PostgreSQL i Redis działały bez wolumenów, a kontenery usunięto. Nie testowano portali ani rzeczywistych rekordów.
- [x] **W4.03** Zaimplementować korektę operatora z powodem, aktorem, datą i kontrolą wersji wiersza. **Dowód:** migracja `012-source-row-version.ts` dodaje `row_version` z wartością początkową 1 i ograniczeniem dodatniości. `PATCH /api/imports/:id/rows/:rowNumber` wymaga sesji administratora i CSRF; payload ma tekstowy REGON, powód 3–1000 znaków oraz oczekiwaną wersję. Serwis blokuje wiersz `FOR UPDATE`, rejestruje propozycję i zwiększa wersję w jednej transakcji; wartość źródłowa i operacyjna pozostają bez zmian do przyszłego zatwierdzenia. `migration-smoke.cjs corrections` na PostgreSQL: dwa równoległe żądania tej samej wersji dały jedno przyjęcie i jedno 409; ponowienie starej wersji 409; aktywna propozycja 409; wadliwy REGON/powód 400; rekord audytu zawiera autora, powód i czas. HTTP test potwierdza 401 bez sesji, 403 bez CSRF/rolą bez uprawnień i udane przekazanie autora z sesji. Obecny model ma jedno konto, więc aktorem jest `bootstrap-admin`; identyfikator użytkownika zastąpi go po wprowadzeniu kont w W5.
- [x] **W4.04** Zastosować istniejącą walidację `normalizeNip` do wierszy z pustym REGON; nie dopisywać utraconego zera na podstawie domysłu. **Dowód:** `assessRegonEnrichmentEligibility` kwalifikuje wyłącznie pusty `regonRaw`, brak `effectiveRegon` i poprawny checksumowo NIP; zachowuje wiodące zero NIP. Pusty lub niepoprawny NIP trafia do kontroli, 8-cyfrowy REGON z kodem możliwej utraty zera nie jest wysyłany do wyszukania, a istniejący REGON jest pomijany. Import podaje liczbę kwalifikujących się i wymagających przeglądu; podgląd pokazuje powód kwalifikacji. `npm test` — core 12/12, API 35/35, worker 44 pass/1 skip; `npm run build` — pass. Syntetyczny przepływ Excel→import→podgląd→eksport na PostgreSQL/Redis: 2 wiersze, 1 z poprawnym REGON i 1 kandydat NIP z zachowanym zerem — pass. Nie wykonano zapytania do rejestru ani portali; kontenery efemeryczne usunięto.
- [x] **W4.05** Utworzyć `RegistryProvider` i fikcyjne odpowiedzi: 0, 1, wiele podmiotów, błąd, limit. **Dowód:** `apps/api/src/registry-provider.ts` definiuje port `lookupByNip`, surową listę kandydatów i metadane `providerName`, `providerVersion`, `dataVersion`, `fetchedAt`; `RegistryProviderError` rozróżnia limit, niedostępność, timeout i błędną odpowiedź, z opcjonalnym czasem ponowienia dla limitu. `registry-provider.test.ts` używa izolowanego fake provider, który nie ma klienta HTTP i nie jest rejestrowany w `AppModule`; potwierdza 0/1/2 kandydatów, zachowanie metadanych, pojedyncze wywołanie NIP, błąd dostawcy i HTTP 429 jako typowany limit. `npm test` — core 12/12, API 39/39, worker 44 pass/1 skip; `npm run build` — pass dla core/API/worker/Next.js. Żadnych zapytań sieciowych ani danych rzeczywistych.
- [x] **W4.06** Dodać limit równoległości, timeout, cache z terminem i ograniczone ponowienie dla odczytu rejestru. **Dowód:** `RegistryLookupService` normalizuje/checksumowo waliduje NIP przed wywołaniem provider, łączy równoległe zapytania o ten sam NIP, ogranicza równoległe żądania (domyślnie 3), stosuje timeout z `AbortSignal`, cache sukcesów z TTL i limitem 1000 wpisów oraz nie cache'uje błędów. Ponawia tylko typowane błędy `RATE_LIMITED`/`UNAVAILABLE`, najwyżej 2 razy; respektuje `Retry-After` z górnym limitem i używa rosnącego backoff dla 5xx. Testy obejmują 429 z capem czasu, 503 z dokładnie 3 próbami łącznie, timeout/abort bez retry, limit równoległości, 8 identycznych zapytań → 1 provider call, TTL na granicy, odrzucenie NIP i błędnej odpowiedzi oraz ograniczenie rozmiaru cache. `npm test` — core 12/12, API 46/46, worker 44 pass/1 skip; `npm run build` — pass dla core/API/worker/Next.js. Cache jest efemeryczny w procesie API; nie wykonano wywołań sieciowych.
- [x] **W4.07** Walidować NIP, nazwę i długość REGON z odpowiedzi; przypadki sprzeczne i wiele jednostek kierować do przeglądu. **Dowód:** `assessRegistryResult` normalizuje i porównuje checksumowo poprawny NIP oraz nazwę po NFKC/wielkości liter/spacji/interpunkcji; dopuszcza REGON wyłącznie jako tekst 9/14 cyfr, zachowując zera. `T-REG-04`: zero kandydatów → `not_found`. `T-REG-05`: wiele wyników, jawny marker jednostki lokalnej lub relacja parent → `ambiguous`, bez wyboru. `T-REG-06`: niezgodny NIP/nazwa → `manual_review` z kodem konfliktu. `T-REG-10`: 9- i 14-cyfrowy REGON przechodzą bez zmiany; 8/13 cyfr, liczba, brak nazwy/NIP i wadliwy kształt wyniku trafiają do przeglądu. Funkcja nie zapisuje danych ani nie zmienia `effectiveRegon`. `npm test` — core 12/12, API 52/52, worker 44 pass/1 skip; `npm run build` — pass dla core/API/worker/Next.js. Wszystkie kandydatury są syntetyczne.
- [x] **W4.08** Zapisać wartość pochodną z nazwą rejestru, czasem, wersją odpowiedzi i stanem decyzji, bez nadpisania źródła. **Dowód:** migracja `013-regon-enrichment-audit.ts` dodaje append-only historię z `source_row_id`, checksumowo poprawnym NIP-em, providerem i wersją, etykietą/hash wersji danych, SHA-256 odpowiedzi, liczbą wyników, decyzją/powodem, REGON-em przed/po, flagą zastosowania i wersją wiersza. Transakcja blokuje `source_rows` `FOR UPDATE`, sprawdza wersję i ponownie kwalifikuje pusty REGON; tylko decyzja `matched` aktualizuje `effective_regon`, nigdy `regon_raw` ani importowe `regon`. Zapis audytu i cache NIP+wersja jest w tej samej transakcji; cache trzyma wyłącznie status/liczbę/hash/termin, bez surowej odpowiedzi. Stara wersja dostaje 409; istniejąca propozycja korekty blokuje automatyczne zastosowanie. PostgreSQL smoke migracji 001–013 potwierdził matched, not_found, ambiguous, mismatch, brak surowych danych, historię i jeden zapis/409 dla równoległych wersji 1; migracja rerun stabilny. `npm test` i pełny build przechodzą. Wyłącznie syntetyczny provider.
- [x] **W4.09** Zbudować grupy tylko dla zgodnych identyfikatorów i nazwy; sprzeczny NIP/REGON lub podobna nazwa to odrębny konflikt. **Dowód:** `assessEntityGrouping` wymaga poprawnego identyfikatora, wspólnego NIP-u lub REGON-u i zgodnej nazwy po ścisłej normalizacji. T-DUP-01 daje jedno dopasowanie; T-DUP-02 pozwala wskazać brakujący identyfikator do uzupełnienia; T-DUP-03/04 kodują konflikt tego samego NIP/różnego REGON i tego samego REGON/różnego NIP; T-DUP-05 pozostawia podobną nazwę z innymi identyfikatorami jako nowy podmiot. Różnica nazwy, wiele kanonicznych dopasowań, błędne/puste identyfikatory → jawny konflikt; heurystyczne scalanie nie występuje. `npm test` — core 12/12, API 59/59, worker 44 pass/1 skip; `npm run build` — pass dla core/API/worker/Next.js. To pure resolution logic; utrwalanie grup i konfliktów należy do W4.10.
- [ ] **W4.10** Utrwalić grupowanie i połączenia runów bez utraty identyfikatorów źródła. Migracja `014-canonical-run-groups.ts` ma dodać otwarte konflikty grupowania, `canonical_entity_id` i hash osoby decyzyjnej do runu oraz tabelę `run_source_rows`; backfill ma zachować wiersz główny dotychczasowych runów. Serwis grupowania blokuje wiersz i encje w transakcji, tworzy link albo jawny konflikt i jest idempotentny. Start z dwóch zgodnych wierszy tej samej osoby ma zwrócić jeden aktywny run z dwoma linkami; inne osoby tej samej firmy mają oddzielne runy z tym samym podmiotem kanonicznym; konflikt blokuje kolejkę. **Testy:** migracja pusta i z zastanym runem, rerun migracji, dwa żądania równoległe, duplikat tej samej osoby, różna osoba, różny identyfikator, podobna nazwa bez ID, blokada konfliktu oraz kontrola, że job BullMQ przenosi tylko `runId`. **Bramka:** smoke PostgreSQL+Redis na fixture syntetycznym; nie oznaczać kroku bez przejścia od DB do mapy i joba.
- [ ] **W4.11** Dodać API i ekran przeglądu wartości REGON, historii wzbogacenia, oczekujących propozycji korekt i konfliktów kanonicznych. Przegląd ma stronicować po 50 wierszy, pokazywać REGON źródłowy i operacyjny, pochodzenie operacyjnego REGON-u, wynik/nazwę dostawcy/wersję, powód kontroli, stan i powód korekty oraz przyczynę konfliktu. Propozycja ma wysyłać CSRF i `expectedVersion`; pozostaje propozycją i nie zmienia `effective_regon`. Nie zwracać NIP/PESEL w tym kontrakcie; nieuprawniona rola nie ma odczytu ani korekty. **Testy:** 401 bez sesji, 403 dla roli bez uprawnień, nieaktualna wersja 409, agregaty najnowszego audytu, mapowanie źródła, widok konfliktu, propozycja bez mutacji raw/effective, odświeżenie panelu po zapisie oraz widok mobilny. **Bramka:** PostgreSQL sprawdza kontrakt `/enrichment`, a Playwright panel na fikcyjnych odpowiedziach.
- [ ] **W4.12** Na fikcyjnym rejestrze rozliczyć wszystkie kategorie 287 pustych REGON w badanej kopii arkusza i potwierdzić SHA-256 oryginału. **Dowód:** suma kategorii = 287, bez zmian pliku.
- [ ] **W4.13** Po uzyskaniu dostępu podłączyć oficjalny rejestr i porównać ręcznie próbkę. **Dowód:** protokół bez sekretu API; do tego czasu krok pozostaje pusty jako zależny zewnętrznie.
- [ ] **W4.14** Uruchomić `T-REG-*`, `T-DUP-*`, testy całego repo i build. Rozdzielić bramkę syntetyczną od produkcyjnej P0A. **Dowód:** wpis w dzienniku ze statusem obu bramek.

### W5 — Użytkownicy, autoryzacja i audyt

- [x] **W5.01** Ustalić macierz uprawnień dla importu, startu runu, SMS, korekty, audytu i pobrania. Zapisać role i właściciela danych w kodzie/testach. **Dowód:** `apps/api/src/authorization-policy.ts` definiuje role `admin`, `operator`, `reviewer`, `auditor`, akcje i zakres `owned`/`tenant`; owner zasobu jest wiązany z `batchId` → run/SMS/korekta/artefakt, każdy dostęp wymaga tego samego tenanta. Admin pełny w tenant, operator własne zasoby i bez zatwierdzania/audytu, reviewer odczyt i rozstrzygnięcia bez run/SMS/artefaktu, auditor wyłącznie audyt. `authorization-policy.test.ts` pokrywa wszystkie role, akcje wrażliwe, obcy owner i obcy tenant; `npm test -w @goldis/api` — 64/64. Polityka jest kontraktem; egzekwowanie w sesji i guardach następuje w W5.03–W5.04. Zakres jest wstępny do produkcyjnego odbioru Goldis.
- [ ] **W5.02** Dodać `015-users-memberships-audit.ts` dla `tenants`, `users`, `tenant_memberships` i `audit_events`, a modele Sequelize w `db.ts`. Migracja tworzy tenant `goldis`, nie tworzy użytkownika z hasłem domyślnym i nie zgaduje właściciela wcześniejszych importów: starsze `import_batches` zachowują `tenant_id=NULL` i `owner_user_id=NULL` do kontrolowanej migracji konta bootstrap w W5.03. Wymusić dozwolone role/statusy, znormalizowaną nazwę użytkownika, minimalną długość hasha hasła, jednoczesną obecność albo brak tenanta i właściciela oraz złożony FK właściciela do członkostwa w tym samym tenantcie. Metadane audytu muszą być obiektem JSON i DB ma odrzucać zakazane klucze w całym zagnieżdżonym JSON, bez względu na wielkość liter (PESEL, NIP/REGON, imię/nazwisko, adres, kontakt, hasło, SMS, cookies, tokeny, sekrety/credential). Nie zapisywać surowego hasła, kodu SMS ani danych portalu.
  **Testy DB:** `users-empty` migruje od pustej bazy do 015, sprawdza tenant i modele, poprawnego użytkownika/członkostwo/audyt, odrzuca niepoprawną rolę/status/krótki hash, niedozwolone klucze zagnieżdżone i mieszane wielkości liter; ponowienie `umzug.up()` nie zmienia stanu. `users` stosuje 001–014, wstawia syntetyczny batch/wiersz/run, migruje do 015 i sprawdza, że wszystkie stare dane oraz nieprzypisany stan ownership przetrwały; następnie przypisuje batch do poprawnego członkostwa i potwierdza odrzucenie połowy pary tenant/właściciel oraz właściciela należącego do innego tenanta. Uruchomić `node --check apps/api/scripts/migration-smoke.cjs`, oba smoke’y `users-empty` i `users` na osobnych, wyrzucalnych bazach, pełne `npm test`, `npm run build` i `git diff --check`. **Bramka:** W5.02 pozostaje otwarty do przejścia obu rzeczywistych smoke PostgreSQL, ich stabilnego rerun oraz przeglądu braku sekretów w schemacie/audycie; sama kompilacja nie zalicza migracji.
- [ ] **W5.03** Zastąpić bootstrapową sesję z `role=admin` identyfikatorem użytkownika i tenanta (`userId`, `tenantId`) w `apps/api/src/session.ts`; podpisany token nie jest źródłem roli ani aktora. `SessionGuard` ma odczytać aktualną aktywną rolę przez członkostwo w tej samej firmie i status użytkownika, a `actorRef` wyliczać jako `userId`; błąd DB kończy żądanie fail-closed. Login wyszukuje aktywnego użytkownika i członkostwo Goldis, weryfikuje scrypt hash, aktualizuje `last_login_at` i wydaje sesję/CSRF. `BootstrapAdminService` przy pierwszym starcie, pod blokadą transakcyjną PostgreSQL, tworzy tylko pierwszego administratora z `GOLDIS_ADMIN_USER/PASSWORD`; zapisuje hash, nie sekret, nie nadpisuje żadnego istniejącego konta i w tej samej transakcji przypisuje stare importy bez właściciela do tego pierwszego konta (stary produkt miał jedno konto bootstrap). Do zakończenia W5.04 utrzymać chronione endpointy admin-only, żeby samo uwierzytelnienie operatora nie dawało dostępu do cudzych zasobów.
  **Testy:** różne fikcyjne `userId` zwracają różne role z resolvera; claim `role=admin` i `actorRef` w tokenie operatora nie podnoszą uprawnień; brak/wygaśnięcie sesji, wyłączony user/członkostwo, zły tenant i niedostępna baza kończą się odmową; login wydaje token bez roli i hasła oraz z user/tenant ID; hasło w bazie ma losowany hash, poprawny secret działa, błędny nie. Smoke PostgreSQL W5.02 ma dodatkowo sprawdzić faktyczne zapytanie roli, login i wyłączenie konta. **Bramka:** W5.03 pozostaje otwarty do zaliczenia migracji W5.02 oraz testu resolvera/loginu na PostgreSQL; testy izolowane z atrapą potwierdzają logikę, ale nie relacje DB.
- [ ] **W5.04** Dodać `PermissionGuard` i deklaratywne `RequirePermission(action, resourceSelector)` dla każdego endpointu operacyjnego. Resolver batch/run ma znaleźć tenant i ownera przez `run.batchId → import_batches`; kontrola działa dla `batchId` w URL/query/body, `runId` w URL/query/body i nowego importu. Klasyfikować akcje zgodnie z W5.01: admin tenant-wide; operator własne batch/run/SMS/korekty/eksporty, może tworzyć batch; reviewer odczytuje i przegląda dane tenanta, bez startu/SMS/korekty/pobrania; auditor nie ma dostępu do danych operacyjnych. Nowy import zapisuje `tenantId` i `ownerUserId` z aktywnej sesji w tej samej transakcji co wiersze. Listy runów wymagają batchId sprawdzonego w guardzie; endpoint SMS wymaga właścicielskiego runu. Brak zasobu, obcy tenant lub cudzy owner zwraca 404 bez potwierdzania istnienia; brak akcji w tej samej firmie zwraca 403. `/auth/me` nadal zwraca wyłącznie własną rolę/CSRF. **Testy:** HTTP operator tworzy batch i zapisuje własne ID; direct URL obcego batch/run/artefaktu i SMS daje 404; reviewer czyta batch/run i enrichment, ale dostaje 403 przy korekcie/artefakcie; auditor nie odczytuje operacyjnego endpointu; admin działa w tenant; granica tenantów zawsze 404. Smoke `users` wykorzystuje prawdziwe FK PostgreSQL i `resolvePermissionResource` dla batch oraz run; sprawdzi niedostępny tenant/właściciela. Uruchomić pełne `npm test`, build oraz DB smoke. **Bramka:** nie zaznaczać bez przejścia HTTP oraz PostgreSQL, bo testy z atrapą nie dowodzą mapowania Sequelize/FK.
- [ ] **W5.05** Dodać wspólną ochronę żądań i limit logowania. Globalny `RequestProtectionGuard` w `AppModule` ma dla każdej mutacji (`POST/PUT/PATCH/DELETE`) wymagać dokładnego `Origin` zgodnego z `PUBLIC_APP_ORIGIN` i odrzucać `Sec-Fetch-Site` inne niż `same-origin`. Gdy żądanie ma cookie `goldis_session`, wymaga ważnej podpisanej sesji oraz zgodności tokena z cookie `goldis_csrf` i nagłówkiem `X-CSRF-Token`; jedyny wyjątek `OriginOnly` to wylogowanie, które nadal wymaga Origin i tylko czyści własne cookies. Jawnie dopiąć nagłówek CSRF w panelu do importu, tworzenia runu, anulowania, korekty i submitu SMS. Login pozostaje bez sesji/CSRF, ale wymaga Origin i licznika Redis. `LoginRateLimiter` ma atomowym Lua ograniczać do 5 prób na 15 minut dla pary HMAC(login, IP) oraz do 60 prób na 15 minut dla HMAC(IP); Redis nie przechowuje loginu ani IP wprost. Po poprawnym uwierzytelnieniu usuwa licznik pary; przekroczenie zwraca 429 i `Retry-After`; awaria Redis blokuje login odpowiedzią 503. Zachować cookie sesji `HttpOnly`, `SameSite=Strict`, `Secure` przy `NODE_ENV=production`; cookie CSRF jest czytelne dla kodu panelu, ale nie zawiera danych osobowych. Ustawić publiczny origin w środowisku Compose; na VPS musi być origin HTTPS panelu, nie adres API.
  **Testy:** Nest HTTP: GET bez Origin działa; POST bez Origin, z obcym Origin albo `Sec-Fetch-Site=cross-site` → 403; login z prawidłowym Origin przechodzi do logiki logowania; mutacja z sesją bez tokenu, błędnym cookie lub nagłówkiem → 403; poprawne double-submit przechodzi; wylogowanie wygasłej sesji z dozwolonym Origin działa. Endpointy import/start-run muszą odrzucić CSRF przed usługą i przyjąć prawidłowy nagłówek. Testy limiter’a: 5 dopuszczonych, 6. odmówiona z `Retry-After`, reset udanego loginu, 60 prób/IP i 61. odmówiona, klucze bez surowego loginu/IP, Redis down → 503. Uruchomić `npm test -w @goldis/api`, `npm test`, pełny build, UI smoke oraz `node --check apps/api/scripts/login-rate-limit-redis-smoke.cjs`. **Bramka:** zaznaczyć dopiero po uruchomieniu smoke Lua na odizolowanym Redisie; test atrapy nie sprawdza semantyki skryptu Redis. Do produkcji ponadto skonfigurować `PUBLIC_APP_ORIGIN` z HTTPS.
- [ ] **W5.06** Użyć istniejącego `audit_events` przez wspólną funkcję `recordAuditEvent`. Zapis ma zawierać UUID aktora z aktywnej sesji, tenant, nazwę akcji, typ/ID zasobu, wynik, czas i losowy `requestRef`; nie wolno kopiować treści formularza, pliku, uzasadnienia korekty, kodu SMS, PESEL ani pól firmy/osoby do metadanych. Helper przyjmuje tylko płaskie metadane skalarne i przed ORM odrzuca klucze dotyczące danych osobowych/sekretów; ograniczenia migracji 015 pozostają drugą kontrolą. Zdarzenia `import.created`, `run.created`, `run.cancelled`, `regon.correction.proposed` i wynik `sms.submitted` mają być w tej samej transakcji co zapis źródłowy; utworzenie runu logować tylko przy faktycznie nowym runie, a ponowienie idempotentnego POST nie może duplikować wpisu. Niepewne przekazanie SMS zapisać z `outcome=failed`, bez kodu. `artifact.downloaded` zapisać dopiero po weryfikacji pliku i przed wysłaniem odpowiedzi; awaria zapisu audytu blokuje pobranie odpowiedzi 503.
  **Testy:** helper odrzuca zagnieżdżone/non-scalar metadane i wrażliwe klucze; HTTP download zapisuje właściwego aktora/tenant/resource bez wartości wrażliwych; migration smoke `users-empty` oraz `users` przez helper utrwala wszystkie dozwolone akcje/outcome, potwierdza aktora i pusty metadata, odrzuca klucze niedozwolone przez DB oraz wycofuje event razem z rollbackiem transakcji. Uruchomić `node --check apps/api/scripts/migration-smoke.cjs`, API/pełne testy i build. **Bramka:** pozostawić krok otwarty do prawdziwego smoke PostgreSQL po migracji 015; test HTTP/mock nie dowodzi FK i ograniczeń DB.
- [ ] **W5.07** Dodać retencję dla importów, wyników, profilu i plików zgodnie z decyzją Goldis; procedurę usuwania przetestować na fikcyjnych danych. **Dowód:** wygasły artefakt znika z magazynu i API.
- [x] **W5.08** Ukryć pełny PESEL i ścieżki plików w listach, błędach, odpowiedziach API oraz panelu. Globalny interceptor JSON usuwa pola PESEL oraz ścieżek magazynu i maskuje 11-cyfrowe wartości PESEL oraz ścieżki Windows/POSIX w tekstach; globalny filtr błędów zachowuje bezpieczny kontrakt wyjątków Nest, a błędy 500 nie zwracają treści wyjątku. Import zapisuje wyłącznie bezpieczną nazwę bazową, nie ścieżkę klienta; błędy parsera nie przekazują treści wyjątku; nagłówek pobierania maskuje PESEL i nie zawiera ścieżki. Eksport XLSX nadal zawiera PESEL wymagany do pracy, ale PESEL nie występuje w nazwie pliku ani JSON-ie panelu. **Dowód:** `public-output.test.ts` sprawdza helper oraz prawdziwe HTTP 200/400/500, brak jawnego syntetycznego PESEL i ścieżek oraz zachowanie zwykłych etykiet; `artifact-download-headers.test.ts` sprawdza nazwę pobrania; API testy przechodzą. W5.08 zaliczono syntetycznie, bez skanowania danych Goldis.
- [x] **W5.09** Sprawdzić wygaśnięcie sesji operatora podczas oczekiwania na SMS i podczas pobierania. Wygaśnięta podpisana sesja kończy odczyt/submit SMS oraz pobranie odpowiedzią 401 przed wywołaniem usługi lub zapisem audytu; zaakceptowane albo zajęte wyzwanie SMS nie może być ponownie użyte po zalogowaniu, ponieważ service wymaga statusu `active` i atomowego claimu. **Dowód:** `auth-challenges.http.test.ts` odrzuca wygasłą sesję przed `submitCode`; `artifact-download.http.test.ts` odrzuca pobranie i nie zapisuje audytu; `auth-challenges.test.ts` potwierdza, że ponowne wysłanie zużytego kodu kończy się 409. W5.09 zaliczono syntetycznie.
- [ ] **W5.10** Uruchomić testy autoryzacji dla każdej roli i `npm test`/`npm run build`; zaliczyć W5 tylko po bezpośrednich testach API. **Dowód:** tabela odmów i wynik komend.

### W6 — Everest, osobny odbiór syntetyczny i live

- [x] **W6.01** Obejrzeć aktualne `identity.ts` i testy; zachować regułę REGON + nazwa + osoba przy pustej `Osoba Decyzyjna`. Testy jednostkowe pokrywają zero, jeden i wiele kandydatów, nieznany typ konta, brak PESEL i nazwę/osobę niezgodną z wierszem; pusta osoba decyzyjna przechodzi wyłącznie przy jednym zgodnym wyniku.
- [x] **W6.02** Wprowadzić interfejs sesji PZU korzystający z istniejącej jednej `BrowserSession`; metoda `ensureAuthenticated` najpierw sprawdza bieżący ekran. Fikcyjna aktywna sesja nie powoduje ponownej nawigacji ani wpisania poświadczeń.
- [x] **W6.03** Na lokalnej fikcyjnej stronie odtworzyć ekran zalogowany, wylogowany, SMS, brak dostępu, ekran nierozpoznany i błąd nawigacji; testy nie łączą się z PZU ani nie omijają TLS.
- [x] **W6.04** Zaimplementować ścieżkę wejścia PZU → Everest i zgłoszenie `waiting_for_sms` tylko wtedy, gdy ekran tego wymaga. Fikcyjny formularz logowania wykonuje jedną próbę, zatrzymuje się na markerze SMS i pozostawia kod pusty.
- [x] **W6.05** Dodać wyszukanie REGON i odczyt wszystkich wyników; mapować HTML do `IdentityMatchV1` dopiero po sprawdzeniu typu konta i nazwy działalności. Test odczytuje osobę oraz działalność z równoległych wyników, a wyszukiwarka otrzymuje wyłącznie REGON.
- [x] **W6.06** Przy niezgodności nazwy, wielu osobach, braku PESEL lub niewidocznym polu zwracać wynik przeglądu, bez wywołania Compensy. Testy pipeline potwierdzają, że niezgodna/niejednoznaczna tożsamość nie przechodzi do dostawcy polis.
- [x] **W6.07** Ograniczyć logowanie adaptera do nazwy kroku, wersji selektora i kodu błędu; nie wypisywać pól osoby. Test przechwytuje logi z unikalnym syntetycznym PESEL i nie znajduje jego wartości.
- [x] **W6.08** Przetestować restart przed i po pobraniu osoby; wznowienie przed checkpointem ponawia Everest, a po checkpointcie używa utrwalonej `IdentityMatchV1` i nie odpytuje ponownie PZU.
- [ ] **W6.09** Przy dostępnej uprawnionej sesji sprawdzić żywe selektory na jednym wskazanym rekordzie, bez obejścia TLS/MFA. **Dowód:** zanonimizowany protokół; do czasu sesji krok pozostaje pusty.
- [ ] **W6.10** Porównać na żywo REGON, nazwę i osobę z przypisanym wierszem; potwierdzić `IdentityMatchV1`. **Dowód:** ręczny przegląd bez zapisania PESEL w dokumencie.
- [x] **W6.11 — bramka syntetyczna** Worker testowany z `PLAYWRIGHT_INTEGRATION=1`: 59/59 pass, bez skipów, w tym fikcyjny Chromium, sesje i testy identity/pipeline; pełne `npm test` oraz `npm run build` przechodzą. To nie zalicza selektorów ani zgodności live; W6.09–W6.10 pozostają niezaznaczone do czasu uprawnionej sesji.

### W7 — Compensa i UFG, osobny odbiór syntetyczny i live

- [x] **W7.01** Przygotować fikcyjną stronę CPortal z modalem `Compensa Komunikacja` i formularzem `Dane ubezpieczonych`; wyłącznie syntetyczne wartości. `apps/worker/test-fixtures/compensa-portal.html` odtwarza kafel, modal REGON/PESEL + rejestracja, sekcję ubezpieczonych oraz późniejsze przyciski UFG i tabelę OC. Test Chromium przechodzi od kafla do formularza i sprawdza pola fixture; nie łączy się z Compensą.
- [ ] **W7.02** Dodać `ensureAuthenticated` dla Compensy z rozpoznaniem istniejącej sesji i wyzwaniem W3 przy MFA. Wspólne `PortalSession` i `CompensaPortalSession` już rozpoznają aktywną sesję i stan `waiting_for_sms`; brakujący warunek odbioru to wywołanie trwałego `createAuthChallenge` z produkcyjnego workera oraz wznowienie po ręcznym kodzie. **Dowód:** test aktywnej sesji pomija login, a test challenge dowodzi pełnego przepływu API → worker → powrót do Compensa.
- [x] **W7.03 — syntetycznie** `CompensaFormAssistant` ustawia rolę `Ubezpieczający`, wpisuje PESEL z `IdentityMatchV1` oraz skonfigurowaną tablicę `RST22339`. Test fake page sprawdza pola; numer rejestracyjny nie trafia do ekstrakcji ani filtra OC.
- [x] **W7.04 — syntetycznie** Przed gotowością formularza asystent uzupełnia brakujące pola osoby z potwierdzonej `IdentityMatchV1`, a każde niepuste i sprzeczne imię, nazwisko lub PESEL zwraca `identity_review`. Test potwierdza, że przy konflikcie przycisk `Zapisz` nie jest klikany.
- [x] **W7.05 — syntetycznie** Zostawić istniejące wypełnione pola adresowe; puste wypełnić z tego samego `sourceRowId`; pusty powiat bez źródła zwraca `waiting_for_manual_data/COUNTY`. Chromium testuje także inny kod pocztowy i zachowanie ręcznie uzupełnionego powiatu.
- [x] **W7.06 — syntetycznie** Puste `Nazwisko rodowe` nie blokuje gotowości formularza, jeśli pozostałe wymagane pola są poprawne. Test fixture potwierdza brak blokady bez kliknięcia `Zapisz`.
- [x] **W7.07 — bramka syntetyczna** Przed `Zapisz` trwale zapisać numer otwartego draftu w `external_case_ref`, a zamiar zapisu wraz ze zdarzeniem audytowym w jednej transakcji (`last_safe_step=compensa_insured_save_intent`). Po potwierdzeniu zapisu przejść do `compensa_insured_data_saved`. Po timeoutcie wznowienie najpierw uzgadnia ten sam numer sprawy: wynik zapisany zapisuje checkpoint bez drugiego kliknięcia; wynik nierozstrzygnięty wstrzymuje run; ponowny klik jest dozwolony wyłącznie po autorytatywnym potwierdzeniu braku zapisu. Testy fikcyjnego Chromium i repozytorium SQL obejmują retry, konflikt numeru, rollback audytu i licznik kliknięć. **Ograniczenie:** selektor potwierdzenia i wiarygodne wyszukiwanie draftu muszą być potwierdzone na dozwolonej sesji Compensy przed podpięciem adaptera produkcyjnego.
- [x] **W7.08 — syntetycznie** `CompensaUfgReader` wymaga zgodnego identyfikatora sprawy i checkpointu dopuszczającego weryfikację; otwiera UFG tylko wtedy, gdy podsumowanie nie jest jeszcze widoczne, odczytuje liczbę OC i pozycje, a retry korzysta z istniejącego wyniku. Fake CPortal testuje dokładnie jedno kliknięcie, odmowę checkpointu, inną sprawę i niedopasowanie 4/3. Live case i reguły portalu pozostają do odbioru.
- [x] **W7.09 — scroll i wirtualizacja** `apps/worker/src/oc.ts` przewija najbliższy wewnętrzny kontener, zbiera wirtualizowane wiersze po unikalnym L.p. i kończy odczyt dopiero po uzyskaniu licznika z podsumowania lub stabilnym braku postępu na końcu. Kontrole liczby zapobiegają zwróceniu częściowego snapshotu. Na dostarczonym zrzucie widać scrollbar wewnątrz modalu, nie kontrolki stronicowania; paginację dodamy tylko wtedy, gdy zostanie potwierdzona w uprawnionym widoku.
- [x] **W7.10 — bramka syntetyczna parsera** Parser mapuje 12 pól danych po nazwach nagłówków (a nie indeksie kolumny), wymaga pełnego zestawu 13 nagłówków, waliduje wszystkie wiersze/datę/licznik i odrzuca 157/158, powtórzone L.p., konflikt treści, zmieniony schemat i złą datę. Chromium testuje 158/158, zmianę kolejności kolumn oraz nieznany nagłówek; `oc.test.ts` pokrywa niekompletność, daty i duplikat. Bramka live jest osobna.
- [x] **W7.11 — kontrakt syntetyczny** `readOcSnapshot` zwraca cały zweryfikowany `OcSnapshotV1` bez filtrowania po dacie, tablicy ani AC/ASS. `pipeline.ts` przekazuje go dalej po walidacji, a `selectCurrentPolicies` używa wyłącznie `referenceDate`. Test sprawdza inkluzywną granicę daty i różne tablice. Produkcyjny worker nie jest jeszcze połączony z tym readerem.
- [ ] **W7.12** Przy dostępnej uprawnionej sesji wykonać jeden live przebieg Compensy/UFG i porównać liczbę wierszy z podsumowaniem. **Dowód:** zanonimizowany protokół; bez sesji krok pusty.
- [ ] **W7.13** Po żywym przebiegu sprawdzić ręcznie próbkę 12 pól i eksport, bez zapisywania danych klienta w repo. **Dowód:** protokół zgodności, bez PII.
- [ ] **W7.14** Uruchomić `T-COM-01`–`10`, `T-OC-01`–`12`, `T-XLS-01`–`07` i build; oznaczyć oddzielne bramki syntetyczną/live W7. **Dowód:** wyniki testów.

### W8 — Awaria, wznowienie i pilot automatyczny

- [ ] **W8.01** Dla każdego checkpointu W6–W7 rozpisać, czy krok jest odczytem, zapisem czy niepewnym skutkiem zewnętrznym. **Dowód:** tabela retry w kodzie/dokumentacji.
- [ ] **W8.02** Wstrzyknąć przerwanie przed i po `Zapisz` oraz przed i po UFG; wznowienie sprawdza stan sprawy. **Dowód:** zero dodatkowych ofert i weryfikacji.
- [ ] **W8.03** Zasymulować awarię DB przed checkpointem; worker przerywa przed następną akcją w portalu. **Dowód:** `T-RES-06`.
- [ ] **W8.04** Zasymulować awarię Redis po zapisie runu; reconcile przywraca zadanie raz. **Dowód:** `T-RES-05`, `INT-01`.
- [ ] **W8.05** Zasymulować timeout i niepełną tabelę UFG; częściowy wynik nie daje `completed`. **Dowód:** `T-RES-08`, `INT-08`.
- [ ] **W8.06** Zasymulować brak miejsca na plik; polisy pozostają, a retry wykonuje tylko eksport. **Dowód:** `T-RES-07`, `INT-12`.
- [ ] **W8.07** Zasymulować limit, blokadę konta i zmianę selektora portalu; zatrzymać odpowiednią kolejkę i pokazać operatorowi kod błędu. **Dowód:** brak lawiny ponowień.
- [ ] **W8.08** Skanować logi, DB, kolejkę i artefakty pod kątem haseł, kodów SMS i pełnych PESEL; poprawić wycieki przed kolejną bramką. **Dowód:** protokół skanu bez podawania wartości sekretów.
- [ ] **W8.09** Przy dostępnej sesji wykonać automatyczny pilot na wierszu 18001 i porównać z ręcznym odczytem dla **nowej** daty odniesienia. Nie zakładać, że liczba aktualnych polis nadal wynosi 3. **Dowód:** zanonimizowane porównanie pole po polu.
- [ ] **W8.10** Uruchomić `T-RES-01`–`09`, `T-SEC-05`–`08`, pełne testy i build; oznaczyć bramkę syntetyczną i live osobno. **Dowód:** wyniki oraz lista otwartych ryzyk.

### W9 — VPS i próba małych partii

- [ ] **W9.01** Spisać parametry VPS, domenę, limity pamięci/dysku, operatorów, backup i retencję; nie umieszczać haseł w dokumencie. **Dowód:** zatwierdzona konfiguracja wdrożeniowa.
- [ ] **W9.02** Dodać reverse proxy HTTPS i przekierowanie HTTP; opublikować tylko zamierzone porty. **Dowód:** test TLS i skan portów spoza VPS.
- [ ] **W9.03** Umieścić PostgreSQL, Redis, worker i wewnętrzny kanał SMS wyłącznie w sieci prywatnej Compose. **Dowód:** brak dostępu z Internetu.
- [ ] **W9.04** Skonfigurować prywatne wolumeny DB, eksportów i profilu Chromium z uprawnieniami kont serwisowych. **Dowód:** restart kontenerów zachowuje dane, obcy kontener nie czyta profilu.
- [ ] **W9.05** Wdrożyć migracje od aktualnego schematu i sprawdzić ich ponowne uruchomienie bez zmian danych. **Dowód:** protokół migracji oraz liczba importów/runów przed i po.
- [ ] **W9.06** Włączyć backup DB i artefaktów, wykonać odtworzenie w osobnym środowisku oraz porównać SHA-256 przykładowego pliku. **Dowód:** test odtworzenia `T-OPS-04`.
- [ ] **W9.07** Monitorować health API, kolejkę, workera, wygaśnięcia sesji, wolny dysk i błędy portali; przetestować alert przez zatrzymanie workera. **Dowód:** alert dociera przy `T-OPS-05`.
- [ ] **W9.08** Na VPS sprawdzić pierwsze logowanie/MFA profilu workera, kolejne wiersze na jednej sesji, restart i wygaśnięcie sesji. **Dowód:** `T-SMS-07`–`08` na żywo; bez SMS krok pusty.
- [ ] **W9.09** Po potwierdzeniu dozwolonej integracji uruchomić 1 wskazany rekord, porównać wszystkie pola i statusy. **Dowód:** `T-E2E-01`, bez PII w protokole.
- [ ] **W9.10** Po odbiorze jednego rekordu uruchomić 10 wskazanych, sprawdzić każdy wynik albo jawną interwencję, zużycie zasobów i tempo. **Dowód:** `T-E2E-03`, `T-OPS-07`.
- [ ] **W9.11** Po odbiorze 10 uruchomić 100 wskazanych; porównać ręcznie próbkę i brak duplikatów ofert. **Dowód:** `T-E2E-04`–`05`.
- [ ] **W9.12** Przetestować rollback aplikacji, retencję i pełne odtworzenie; zapisać protokół odbioru W9. **Dowód:** `T-OPS-06`–`08`; bez tego nie zwiększać skali.
