# Goldis — plan napraw, integracji i odbioru bez SMS PZU

Data: 1 października 2026. Dokument przekazania dla agenta kodującego.

**Notatka aktualizacyjna — 2 października 2026:** liczby testów i migrowane wersje w sekcji 2/3 opisują stan w chwili sporządzenia planu. Wykonane prace i bieżące bramki są dopisywane do `POSTEP_IMPLEMENTACJI.md` i `STAN_IMPLEMENTACJI.md`. Dodano migracje 019–020; bieżący schemat planowany dla integracyjnego smoke kończy się na 020. Żadna zmiana tej notatki nie oznacza zaliczenia testów DB/Redis lub etapu I.

## 1. Cel, zakres i warunek zakończenia

Celem tej iteracji jest działająca i sprawdzona integracja panel → API → PostgreSQL → BullMQ → produkcyjny procesor Playwright → prywatny endpoint wyniku → pobranie XLSX, przy zastąpieniu zewnętrznych ekranów PZU/Compensy kontrolowanymi stronami syntetycznymi. Dodatkowo trzeba domknąć obsługę SMS, zgłoszeń administratora, wznowienia po błędach i uruchomienia lokalnego.

Ta iteracja nie wymaga kodu PZU. Agent nie loguje się do PZU ani Compensy, nie wysyła prawdziwych SMS, nie używa rekordu klienta 18001 ani jego danych, nie otwiera rzeczywistych ofert i nie zmienia istniejącej bazy/profilu klienta. W testach używa wyłącznie fikcyjnych firm, syntetycznych numerów i osobnego profilu Chromium. Obserwowane wcześniej selektory i regułę wyboru osoby zachowuje w kodzie.

Nie należy ponownie pisać gotowych modułów importu, parsera OC, eksportu i sesji. Trzeba naprawić opisane granice i podłączyć istniejące elementy do testów rzeczywistego procesora. Testy `pipeline.ts` z fikcyjnymi portami nie zastępują testów `LiveRunProcessor`.

Ukończenie tej iteracji oznacza **odbiór syntetyczny pełnej aplikacji**, a nie odbiór żywych portali ani gotowość do VPS. Bramka live pozostaje oddzielnie otwarta.

Po zakończeniu muszą być spełnione wszystkie warunki:

1. Poprawne żądanie SMS przechodzi rzeczywiste sprawdzanie uprawnień na rzeczywistej testowej bazie.
2. Stary kod/wyzwanie nigdy nie zmienia stanu nowego wyzwania ani zadania.
3. Wygaśnięcie, błędny kod, niepewne dostarczenie i restart mają określone, trwałe stany oraz widoczne działania użytkownika.
4. Jedno dodatkowe żądanie kodu PZU po timeoutcie jest limitowane w DB; kliknięcia w dwóch kartach nie zwiększają liczby wysyłek.
5. Awaria HTTP nie zatrzymuje trwale odświeżania panelu; powiadomienia nie zależą od otwartego importu.
6. Po utracie joba albo restarcie zadanie wraca do bezpiecznego kroku lub trafia do zgłoszenia. Nie pozostaje bezterminowo w aktywnym stanie bez właściciela i bez instrukcji.
7. Niepewny start oferty, zapis i weryfikacja UFG nie są automatycznie klikane drugi raz.
8. Odczytany wynik przetrwa awarię przekazania i restart workera; jego eksport nie wymaga kolejnej akcji w portalu.
9. Panel, API, DB, Redis i jeden worker uruchamiają się według udokumentowanej konfiguracji.
10. Pełny test przez HTTP/BullMQ/Playwright/DB/XLSX przechodzi, a raport zawiera dowody także dla awarii.

## 2. Punkt startowy potwierdzony w kodzie

- `apps/worker/src/live-run.ts` łączy adaptery Everest, Compensy i UFG z zapisem wyniku.
- `apps/worker/src/run-worker.ts` uruchamia procesor live tylko dla `WORKER_LIVE_PORTALS=1`; domyślnie parkuje run w `awaiting_portal_adapter`.
- `apps/web/app/workspace.tsx` ma baner SMS, modal, lokalny licznik i przekazanie kodu z CSRF.
- API/worker mają challenge, interwencje, jednorazowy inbox i wstrzymywanie po timeoutcie.
- PZU ma w platformie 300 sekund od utworzenia wyzwania, Compensa 120 sekund. Rzeczywisty portal może zakończyć ważność wcześniej.
- Testy z ostatniego przeglądu: core 12/12, API 78/78, worker z syntetycznym Chromium 86/86. Są dowodem działania testowanych modułów, nie pełnej integracji produkcyjnego procesora.
- Aktualny skrypt `apps/web/scripts/w3-sms-ui-smoke.cjs` oczekuje starego formularza inline i starego tekstu wygaśnięcia; wymaga aktualizacji do modalu.
- Docker Engine oraz standardowe lokalne adresy panelu/API były niedostępne podczas przeglądu. To bramka środowiska, nie dowód błędu aplikacji.

Dodatkowy błąd odkryty przy przygotowaniu tego planu: w `authorization-guard.ts`, `resolvePermissionResource()` zamienia run na batch tylko dla `route-run` i `query-run`. Dla `body-run` używanego przez POST kodu SMS traktuje runId jako batchId. Istniejący test HTTP SMS podstawia resolver, więc nie wykrywa tej usterki. Naprawa tej granicy jest obowiązkowa przed odbiorem SMS.

## 3. Zasady wykonania i dowodów

- Wykonywać prace według tabeli zależności poniżej. C i E tworzą jeden blok: obsługa ponowienia SMS wymaga trwałej intencji i lease, dlatego nie odbierać C przed zbudowaniem tych mechanizmów w E. Etap oznaczyć jako wykonany dopiero po spełnieniu jego bramki.
- Przed edycją sprawdzić aktualny kod i `AGENTS.md`, jeśli istnieje. Nie zakładać, że numery migracji są nadal wolne: obecnie ostatnia widoczna migracja ma numer 015.
- Nowe migracje są addytywne. Nie przepisywać 001–015. Każdą sprawdzić od pustej bazy i na schemacie po 015 z zachowanymi danymi syntetycznymi.
- Testy usług uruchamiać w osobnej bazie i Redisie, z osobnymi katalogami profilu/wyników. Przed ich usunięciem zweryfikować rzeczywiste ścieżki i identyfikatory zasobów testowych.
- Każdy test integracyjny wymaga rzeczywistych zapisów DB oraz rzeczywistego HTTP tam, gdzie sprawdza granicę HTTP. Mockowanie uprawnień/ORM nie jest dowodem poprawności tej granicy.
- W testach przeglądarkowych przechwycić ruch kontekstu i dopuścić wyłącznie syntetyczne domeny `.test` obsługiwane przez fixtury; wszystkie pozostałe żądania przeglądarki przerwać. Nie zmieniać produkcyjnej walidacji HTTPS ani TLS na potrzeby testów.
- Kod SMS nie trafia do PostgreSQL, Redis, outboxa, plików, logów, screenshotów ani raportu. Job BullMQ nadal ma wyłącznie `{ runId }`.
- Po etapie dopisać do `docs/POSTEP_IMPLEMENTACJI.md`: ID kroku, zmienione pliki, komendę, wynik, liczbę testów, badane granice, ograniczenia i następną bramkę. Bez wartości sekretów i danych klienta.
- Starsze dokumenty są tłem historycznym. Dla tej iteracji źródłem kolejności i odbioru jest ten dokument; aktualny stan produktu aktualizować w `docs/STAN_IMPLEMENTACJI.md`.

### 3.1. Rzeczywista kolejność wykonania

| Kolejność | Zakres | Warunek przejścia dalej |
|---|---|---|
| 1 | A, następnie B | Punkt bazowy i naprawiona autoryzacja; niedostępna DB pozostawia bramkę B otwartą |
| 2 | C01–C06, potem E01–E09 | Spójny model challenge oraz działające intencje/outbox/lease; migracje uzgodnione razem |
| 3 | C07–C13, następnie E10–E16 | Ponowienia korzystają z trwałych intencji; sprawdzone odzyskiwanie i staging |
| 4 | Wspólny odbiór C i E, potem D | Testy konkurencji/awarii nie opierają się na brakujących mechanizmach z późniejszego etapu |
| 5 | F, następnie G i H | Środowisko odtwarzalne; nowe API mają testy DB/HTTP, a UI testy funkcjonalne |
| 6 | I, następnie J | Pełny procesor i wszystkie otwarte bramki syntetyczne; raport końcowy |

Fixtury i harness potrzebne do wcześniejszej bramki tworzyć przy jej implementacji, według kontraktów I01–I04. Etap I scala je w jeden pełny odbiór; nie odkładać pierwszych testów procesora do końca. Jeżeli środowisko usług jest niedostępne, kontynuować niezależne prace, ale nie ogłaszać zaliczenia zależnych bramek.

### 3.2. Komendy i wymagane skrypty odbioru

Istniejące komendy z katalogu głównego repozytorium:

```powershell
npm test
npm run build
npm run test -w @goldis/api
npm run test:w3-sms-ui-smoke -w @goldis/web
```

Testy przeglądarkowe workera uruchamiać jako `npm run test:playwright -w @goldis/worker`; runner ustawia flagę integracji i uruchamia testy seryjnie, aby profil Chromium był zamknięty przed usunięciem. Nie zapisywać tej flagi ani testowych sekretów w produkcyjnym `.env`. Istniejący smoke UI wymaga działającego środowiska określonego w jego skrypcie; sam build go nie zastępuje.

Agent ma dodać jawne skrypty odbiorcze, proponowane nazwy w głównym `package.json`: `test:db-integration`, `test:sms-ui`, `test:recovery-integration`, `test:platform-flow-no-pzu-sms`. Pierwszy obejmuje guardy, migracje, challenge, outbox i uprawnienia; drugi aktualny panel; trzeci awarie/restarty; ostatni pełny HTTP → kolejka → procesor → XLSX. To są skrypty **do utworzenia**, a nie obecnie dostępne polecenia. Brak usług w wywołanym zestawie odbiorczym kończy się błędem i bezpiecznym komunikatem, nigdy zielonym wynikiem ze wszystkimi testami pominiętymi.

## 4. Ustalone kontrakty zachowania

### 4.1. SMS i ponowienia

Rozdzielić trzy liczniki: wpisanie błędnego kodu, dodatkowe żądanie nowego SMS po timeoutcie i techniczne ponowienie joba. Nie używać jednego pola do wszystkich tych celów.

- Challenge jest jednorazowym przekazaniem kodu do określonego runu, portalu i procesu przeglądarki.
- `claimed` oznacza, że API zajęło wyzwanie; nie wolno go ponownie zająć.
- `submitted` oznacza potwierdzone przyjęcie do inboxa; nie oznacza zaakceptowania przez portal.
- `consumed`, `invalidated`, `expired` są końcowe dla wyzwania. Żadne późne żądanie nie zmienia ich na inny stan.
- Nowy SMS po timeoutcie wymaga jawnej akcji administratora. Dla PZU limit to jedna dodatkowa próba dla tego runu. Sam timeout nie uruchamia logowania, resend ani nowego joba portalowego.
- Limit dodatkowej próby przechowywać jako trwały licznik/intencję w DB, a nie wyliczać wyłącznie z liczby rekordów `status=expired`.
- Istniejący limit pięciu prób wpisania zachować osobno dla runu i portalu. Błędny kod nie powoduje automatycznego żądania następnego SMS.
- Jeżeli portal jednoznacznie pokazuje błędny kod i nadal używa tej samej sesji MFA, poprawienie kodu korzysta z nowego jednorazowego challenge, ale **z tym samym pierwotnym terminem ważności cyklu**. Nie przyznawać kolejnych pięciu minut za błędny wpis.
- Jeżeli portal nie daje jednoznacznego wyniku po wysłaniu, zapisać wynik niepewny i wstrzymać zadanie. Nie powtarzać wartości kodu.
- Licznik platformy zaczyna się przy wykryciu MFA i jest górnym limitem oczekiwania; marker wygaśnięcia portalu może go zakończyć wcześniej.

### 4.2. Zadania i akcje portalu

Zachować jeden właścicielski advisory lock workera i `concurrency: 1`. Dodatkowo każde aktywne wykonanie runu musi mieć trwały identyfikator wykonania/lease; zamknięcie HTTP lub joba nie jest potwierdzeniem efektu w portalu.

Przejście runu, intencja wznowienia i wpis historii są zapisywane razem. Akcja portalu następuje dopiero po trwałej intencji. Po awarii z niepewnym skutkiem automat odczytuje stan tej samej sprawy albo wstrzymuje zadanie. Nie obiecywać gwarancji exactly-once dla zewnętrznego portalu; zapewnić brak ślepego drugiego kliknięcia.

### 4.3. Powiadomienia

Źródłem powiadomień są istniejące `manual_interventions` i powiązane challenge/run. Nie tworzyć drugiego niezależnego źródła prawdy o oczekiwaniu na SMS. Powiadomienie ma być dostępne po zalogowaniu niezależnie od wybranego importu.

Otwarcie lub oznaczenie powiadomienia jako przeczytanego nie rozwiązuje zgłoszenia. Timeout aktywnego SMS zmienia treść tego samego zgłoszenia i ponownie wymaga uwagi.

### 4.4. Reguły pozytywnej ścieżki, których nie zmieniać

1. Korzystać z jednego trwałego profilu i najpierw sprawdzać sesję portalu. Wejście do Everest odbywa się przez skonfigurowany URL i, jeśli portal tego wymaga, Strefę Agenta → usługę Everest. Nie zaczynać każdego runu od wylogowania lub wymuszania logowania.
2. Wyszukać `effectiveRegon` w Szybkim wyszukiwaniu. PESEL odczytać **bezpośrednio z kolumny PESEL/REGON w wierszu typu dokładnie „Osoba fizyczna”**, zgodnie ze wskazaniem użytkownika. Nie otwierać szczegółów konta i nie wybierać PESEL z wiersza działalności jako zastępstwa. Zachować obecne reguły zgodności osoby i firmy oraz blokadę przy sprzeczności numerów.
3. Na stronie głównej Compensy kliknąć **Compensa Komunikacja**, wybrać **Ubezpieczający**, przekazać PESEL z tego runu i skonfigurowany numer wyszukiwania **RST22339**. Nie wybierać innych produktów. Ten numer jest wejściem do wyszukania; nie zastępuje numerów rejestracyjnych polis odczytywanych później z UFG.
4. Sprawdzić dane osoby w otwartym formularzu. Uzupełniać tylko puste wymagane pola z tego samego źródła/zaakceptowanej poprawki; konflikt zatrzymuje zadanie przed zapisem.
5. Zapisać i utrwalić numer tej samej oferty, wykonać kontrolowaną weryfikację UFG, otworzyć **Szczegóły** i odczytać całą tabelę OC, wraz ze scrollem/stronami oraz licznikiem kompletności.
6. Zapisać kompletny snapshot. Oceniać aktualność względem `referenceDate` ustalonej przy stworzeniu runu, a nie daty restartu. XLSX budować z DB i udostępniać przez istniejące uprawnienia; brak aktualnych OC oznacza `no_matching_policies`, bez pustego pliku.

## 5. Etap A — izolowany punkt bazowy

**Pliki:** istniejące skrypty testowe, `package.json`, `docs/POSTEP_IMPLEMENTACJI.md`; przyszła konfiguracja usług testowych.

- [ ] **A01** Zapisać status repozytorium, najwyższy numer migracji oraz listę działających testów. Zachować istniejące zmiany użytkownika.
- [ ] **A02** Uruchomić obecne testy core/API/workera i pełny build. Dla workera osobno uruchomić wariant `PLAYWRIGHT_INTEGRATION=1` na stronach syntetycznych. Zapisać także pominięte testy.
- [ ] **A03** Przygotować osobny projekt Compose dla testowego PostgreSQL i Redis. Nazwy baz/kolejek/katalogów muszą jednoznacznie wskazywać tę iterację; żadnego współdzielenia wolumenów z aplikacją klienta.
- [ ] **A04** Wygenerować wyłącznie testowe klucze szyfrowania, sekret sesji i sekret usług. Skrypty nie wypisują ich wartości. Testowy czas/datę ustalić jawnie.
- [ ] **A05** Jeżeli Docker nie działa, opisać blokadę i kontynuować testy jednostkowe/syntetyczny Chromium. Nie oznaczać żadnej bramki PostgreSQL/Redis jako zaliczonej na podstawie mocków. Można użyć dostępnych usług lokalnych tylko w nowo utworzonej, odizolowanej bazie/kolejce.

**Bramka A:** odtwarzalny punkt bazowy; znane ograniczenia środowiska; kod nie kontaktuje się z portalami.

## 6. Etap B — rzeczywista autoryzacja przekazania SMS

**Pliki:** `apps/api/src/authorization-guard.ts`, `authorization-guard.test.ts`, `auth-challenges.http.test.ts`, `module.ts`; nowy test integracji resolvera z DB.

- [ ] **B01** Rozdzielić selektory batch i run w resolverze. `route-run`, `query-run` i `body-run` zawsze rozwiązują `runId → automation_runs.batch_id → import_batches.tenant_id/owner_user_id`.
- [ ] **B02** UUID w body nie jest tenantem ani importem podanym przez klienta. Uprawnienia wynikają z aktualnego członkostwa użytkownika i właściciela importu wskazanego przez run.
- [ ] **B03** Zachować maskowanie cudzych zasobów 404, brak sesji 401 i brak uprawnienia do działania w znanym zakresie 403. Nie poszerzać obecnej macierzy ról przy okazji naprawy.
- [ ] **B04** Dodać testy resolvera z realnym ORM: runId różny od batchId, własny run operatora, cudzy właściciel, inny tenant, nieistniejący run, nieprawidłowy UUID.
- [ ] **B05** Dodać test HTTP POST kodu z rzeczywistym `SessionGuard`, `PermissionGuard`, resolverem i modelem DB. Jedynym podstawionym elementem może być końcowe dostarczenie kodu do inboxa; dodatkowy test po etapie I ma użyć rzeczywistego odbiornika.

**Testy B:** własny poprawny SMS 202; cudzy run 404; wygasła sesja 401; brak/błędny CSRF 403; niedozwolona rola 403; brak forwardingu i zmian DB przy każdej odmowie.

**Bramka B:** prawidłowy run z innym ID niż batch przechodzi do claim dokładnie raz; żaden test odbiorczy nie podstawia resolvera uprawnień.

## 7. Etap C — cykl życia SMS, konkurencja i limit resend

**Pliki:** API/worker `auth-challenges.ts`, API `runs.ts`, worker `live-run.ts`, `portal-session.ts`, `code-inbox.ts`, `portal-runtime-config.ts`, `packages/core/src/index.ts`, modele `db.ts`; nowa migracja od kolejnego wolnego numeru.

- [ ] **C01** Dodać jednoznaczne wskazanie bieżącego challenge runu, np. `automation_runs.current_auth_challenge_id` z FK wymuszającym również przynależność challenge do tego runu, oraz częściową unikalność jednego otwartego challenge na run dla statusów `active/claimed/submitted`. Zachować istniejącą unikalność konto+portal. Przed dodaniem indeksu sprawdzić konfliktowe dane; nie usuwać ich automatycznie.
- [ ] **C02** Dodać trwały licznik dodatkowego żądania PZU (`pzu_sms_retry_count`, 0–1) i identyfikator/termin cyklu MFA. Przenoszenie pięciu prób wpisania między challenge pozostaje niezależne od tego licznika.
- [ ] **C03** Ujednolicić kolejność blokad: run → challenge → intervention we wszystkich mutacjach API/workera, także cancel, expiry, restart i outcome. Odczyt challenge bez blokady może służyć tylko ustaleniu runId; relację ponownie sprawdzić pod blokadą.
- [ ] **C04** Naprawić `claim()`: końcowy/zajęty status odrzucać przed jakąkolwiek mutacją czasu. Wygaśnięcie może wstrzymać tylko run czekający na wskazany bieżący challenge. Stary challenge nigdy nie zmienia nowszego runu, licznika ani zgłoszenia.
- [ ] **C05** Oprzeć getForRun, API claim, timeout inboxa i reconciliację na tej samej semantyce wygaszenia. Dla jednej próby powstaje jedno zdarzenie timeoutu i jedno otwarte zgłoszenie. `submitted` nie wygasa jako niewpisany kod; wynik przekazania rozstrzyga osobna ścieżka.
- [ ] **C06** Zajmowanie i przekazanie kodu pozostaje jednorazowe. Duplikat POST w dwóch kartach daje jeden forwarding i jedną odmowę 409. 410 zwracać dla bieżącego, wygasłego wyzwania, także jeśli już oznaczono je `expired`, bez ponownej mutacji. Stary formularz albo `consumed/invalidated` zwraca 409 bez zmian.
- [ ] **C07** Ujednolicić kontrakt `resume-auth`/`resume-review` z workerem. Obecne `SMS_RETRY_QUEUED` nie jest obsługiwane przez gałąź workera sprawdzającą wyłącznie `SMS_RETRY_REQUIRED`. Zastąpić domyślanie się akcji po errorCode trwałą intencją wznowienia; zapis intencji wykonać zgodnie z etapem E.
  - Przy tej zmianie uzgodnić również wspólną macierz stanów. Obecne `resume-review` dla błędu PZU może zapisać `waiting_for_manual_data → everest_search`, którego `packages/core/src/index.ts` nie dopuszcza. Zdefiniować i przetestować właściwy powrót dla każdego rodzaju zgłoszenia; wszystkie mutacje używają wspólnej walidacji, nie bezpośredniego obejścia tabeli przejść.
- [ ] **C08** Administrator zajmuje dodatkową próbę PZU atomowo z intencją wznowienia. Dwa równoległe kliknięcia: jedno przyjęcie, jedno 409; licznik wynosi 1. Awaria kolejki nie zużywa drugi raz próby przy powtórnym dostarczeniu tej samej intencji. Po niepewnym kliknięciu resend nie zwalniać budżetu automatycznie.
- [ ] **C09** Worker przed resend sprawdza bieżący run, lease, intencję i stan portalu. Jeden widoczny, enabled przycisk z konfiguracji pozwala na jedno kliknięcie. Zero dopasowań: jedna próba otwarcia URL wejściowego. Wiele dopasowań, przycisk disabled, 403, nieznany ekran albo nadal stary MFA po wejściu: zgłoszenie i stop. Żadnej pętli logowania.
- [ ] **C10** Rozróżnić wynik akcji SMS: zaakceptowany, jawnie błędny kod, jawnie wygasły kod, niepewny wynik, utrata sesji. Dodać opcjonalne selektory markerów odrzucenia/wygaśnięcia do konfiguracji. Bez zaobserwowanego markera nie uznawać utrzymanego formularza SMS za dowód błędnego kodu.
- [ ] **C11** Jawnie błędny kod pozwala użytkownikowi poprawić wpis w tym samym cyklu bez resend; challenge nadal jednorazowe, termin bez przedłużenia, pięć prób łącznie. Wyczerpanie limitu kieruje do administratora i blokuje dalsze wpisy.
- [ ] **C12** Po restarcie nie odtwarzać wartości kodu ani inboxa. Sprawdzić istniejącą sesję profilu; nową próbę SMS tworzyć dopiero po rzeczywistym markerze MFA. Restart nie zeruje liczników runu. Niepewne wcześniejsze przekazanie pozostaje zgłoszeniem do uzgodnienia.
- [ ] **C13** Zaznaczać opcję zapamiętania urządzenia wyłącznie po jednoznacznym dopasowaniu skonfigurowanego checkboxa w poprawnej ramce. Brak tej opcji pozwala kontynuować, a niejednoznaczność zatrzymuje akcję. Nie dodawać zgadywanych selektorów produkcyjnych.

**Testy C — jednostkowe i PostgreSQL:**

| ID | Przypadek | Oczekiwany efekt |
|---|---|---|
| C-T01 | Stary `consumed` challenge po terminie, nowy aktywny SMS | 409; brak jakichkolwiek zmian nowego challenge/runu/intervention |
| C-T02 | Stary `invalidated`/`expired` challenge i run oczekujący w innym portalu | 409; bez wpływu na aktualną sesję |
| C-T03 | Kod 1 ms przed/na/po terminie | Decyduje czas serwera; po terminie brak forwardingu i jeden timeout |
| C-T04 | Dwa submit, submit równoległy z cancel/expiry | Maksymalnie jeden forwarding; spójny końcowy stan; brak deadlocku |
| C-T05 | Worker odebrał kod, API nie potwierdziło `submitted` | Kod nie jest wpisywany w portal; wyzerowany bufor; zgłoszenie niepewności |
| C-T06 | Portal przyjął kod, odpowiedź HTTP do panelu zaginęła | Panel odczytuje trwały stan; brak ponownego wysłania kodu |
| C-T07 | Pierwszy timeout, dwa równoległe resume | Jedna intencja dodatkowej próby i maksymalnie jedno kliknięcie resend |
| C-T08 | Drugi timeout / restart / ponowne dostarczenie intencji | Limit trwały; brak kolejnego resend/loginu |
| C-T09 | Jawnie błędny kod, potem poprawny | Nowy handoff, ten sam koniec cyklu, licznik wpisów rośnie; brak resend |
| C-T10 | Nieznany wynik kodu / 403 / nieznana ramka | Bezpieczne wstrzymanie i jedna interwencja |
| C-T11 | Checkbox nieobecny/jeden/dwa, submit jeden/dwa | Zaznaczenie tylko właściwego checkboxa; brak dowolnego kliknięcia |
| C-T12 | Równoległe expiry API/workera i restart | Jedno zdarzenie, jeden open incident, poprawne wskazanie challenge |

W unit testach czas wstrzykiwać jako zależność; nie czekać pięciu minut. Produkcyjne 300/120 sekund pozostają niezmienne. Krótki termin w integracji wynika wyłącznie z testowych zależności.

**Bramka C:** przechodzą C-T01–12 na realnych transakcjach tam, gdzie badana jest konkurencja; timeout nie inicjuje samodzielnie akcji portalu; limit przetrwa restart.

## 8. Etap D — odświeżanie panelu i poprawny modal SMS

**Pliki:** `apps/web/app/workspace.tsx`, wydzielone komponenty/hooki SMS i odczytu statusu, `globals.css`, `apps/web/scripts/w3-sms-ui-smoke.cjs`.

- [ ] **D01** Zastąpić jednorazowy `setTimeout` szczegółów kontrolowanym cyklem, który planuje następny odczyt także po błędzie HTTP/sieci. Jedno żądanie naraz na zasób; następny termin liczyć po zakończeniu poprzedniego.
- [ ] **D02** Przyjąć interwały: szczegóły aktywnego runu 10 s, globalne powiadomienia/lista 20 s; backoff po błędzie 20/40/60 s, maksymalnie 60 s. Reset backoff po sukcesie. Hidden/offline: wstrzymać; po powrocie wykonać jeden odczyt. Logout/unmount/zmiana runu: abort starego żądania i anulowanie timera.
- [ ] **D03** Nie uruchamiać osobnych nakładających się odczytów tego samego runu z listy, modalu i szczegółów. Deduplikować odczyty, ignorować odpowiedź poprzedniego wyboru i pokazywać ostatni znany stan z informacją o problemie połączenia.
- [ ] **D04** Ładowanie challenge nie może zależeć wyłącznie od zmiany runId/status. Po chwilowym błędzie ma się ponowić; otwarcie powiadomienia ma odczytać aktualny challenge. Na 409/410 zaktualizować challenge i run; nie pozostawiać nieskończonego „oczekiwania na wyzwanie”.
- [ ] **D05** 401 zamyka pole kodu, usuwa jego wartość i kieruje do logowania panelu. 403 pokazuje brak uprawnienia. Utrata odpowiedzi POST blokuje powtórzenie wartości do czasu odczytu trwałego stanu, także po ponownym otwarciu modalu.
- [ ] **D06** Zmiana challenge czyści pole i lokalny błąd. `claimed` pokazywać jako przetwarzanie, `submitted` jako dostarczony do workera, zaakceptowanie przez portal dopiero po trwałym wyniku workera. Licznik używa `expiresAt`; tykanie nie wykonuje HTTP i nie przedłuża terminu.
  - API zwraca także `serverNow`. Obliczać pozostały czas z offsetem serwera i zegarem monotonicznym pomiędzy odczytami; po powrocie karty synchronizować. Zegar komputera użytkownika przesunięty o ±10 minut nie może wydłużać ważności ani blokować świeżego challenge. Ostateczne przyjęcie nadal rozstrzyga serwer.
- [ ] **D07** Modal otwiera się z powiadomienia, ma focus początkowy, pułapkę fokusu, ESC/zamknięcie oraz powrót fokusu do przycisku. Zamknięcie modalu nie anuluje zadania. Po timeoutcie użytkownik trafia do zgłoszenia, po akceptacji modal przestaje pokazywać input.
- [ ] **D08** Ujednolicić teksty: wpisanie kodu, błąd wpisu, timeout, niepewne dostarczenie, jedna dodatkowa próba, wykorzystany limit. UI nie pokazuje przycisku akcji, której rola lub stan nie dopuszcza; API pozostaje ostateczną kontrolą.
- [ ] **D09** Zaktualizować istniejący smoke do otwierania modalu z obecnego banera powiadomienia i aktualnych tekstów. Dodać scenariusze opóźnienia, 503, offline/online, dwóch kart, zmiany runu i logoutu. Po G rozszerzyć ten sam zestaw o globalne centrum.
- [ ] **D10** Panel wyświetla rzeczywistą rolę zwróconą przez sesję, zamiast stałego napisu administrator. Widoczność importu/startu/SMS/wznowienia/pobrania wynika z możliwości użytkownika. Elementy bocznego menu bez działającej funkcji są jednoznacznie nieaktywne; nie deklarować ich jako zaimplementowanych.

**Testy D:** pierwsze GET challenge 503, kolejne 200 → pole pojawia się bez reload; błąd GET run → odczyty wracają; bardzo wolny GET → najwyżej jeden in-flight; wybór A→B i późna odpowiedź A → widoczne B; 00:00 blokuje input; POST wysłany raz; brak ruchu HTTP z tykania; dwie karty nie zużywają kodu dwukrotnie; 390 px bez overflow i modal dostępny z klawiatury.

**Bramka D:** nowy modal i odświeżanie przechodzą Playwright smoke. Zanotować liczbę żądań przy znanym czasie obserwacji, nie tylko brak błędów JS.

## 9. Etap E — trwałe wznowienie, odzyskiwanie jobów i wyników

**Pliki:** API `runs.ts`, `run-queue.ts`; worker `run-worker.ts`, `live-run.ts`, `pg-run-repository.ts`, `portal-action-gate.ts`, checkpointy; `worker-results.ts`, `result-forwarder.ts`; nowe moduły outbox/lease/staging; addytywna migracja i modele.

- [ ] **E01** Dodać trwały outbox wysłania joba: ID dyspozycji, runId, rodzaj intencji, status, numer prób, nextAttemptAt, czas zajęcia/właściciel. Unikalna nierozstrzygnięta dyspozycja dla runu. Outbox zawiera wyłącznie metadane; zero SMS i danych wyniku.
  - Ustalić statusy co najmniej `pending → publishing → published → consumed`, dodatkowo `cancelled`/`blocked`. Publikacja nie jest wykonaniem: worker zajmuje odpowiednią dyspozycję razem z lease i oznacza przyjęcie do wykonania w DB. Reconciler obsługuje utratę Redis także po `published`; brak joba pozwala odbudować tę samą dyspozycję. Jeżeli poprzednie wykonanie już wystartowało, nowa dyspozycja odzyskiwania wynika z checkpointu i budżetu technicznego, nie z kolejnego kliknięcia użytkownika. Zamknięcie poprzedniej dyspozycji musi umożliwiać późniejsze legalne wznowienie tego samego runu.
- [ ] **E02** Create/resume/cancel-safe-recovery zapisują zmianę runu, historię, audyt i dyspozycję w tej samej transakcji. Dispatcher publikuje po commit. Stały jobId wyprowadzony z ID dyspozycji pozwala powtórzyć publikację bez drugiego joba; payload to nadal tylko runId.
- [ ] **E03** Awaria Redis po commit nie cofa arbitralnie runu i nie tworzy nowej intencji po ponownym kliknięciu. Pokazać „wznowienie zapisane, oczekuje na kolejkę”. Dispatcher ponawia techniczne publikowanie z backoff, bez wykonywania loginu.
- [ ] **E04** Dodać per-run lease: losowy executionId/fencing token, workerSessionId, leaseExpiresAt i heartbeat. Start wykonania zajmuje run atomowo; duplikat joba bez prawa przejęcia kończy się bez portalu. Punkt startowy: heartbeat 10 s, lease 60 s, parametry jawne i sprawdzone testem.
- [ ] **E05** Odświeżać lease także podczas pięciominutowego oczekiwania na SMS. Nie trzymać transakcji przez awaitSMS/Playwright/HTTP. Zapewnić osobną dostępną pojemność puli dla heartbeat; obecne max=2 razem z dedykowanym advisory-lock połączeniem wymaga ponownej oceny.
- [ ] **E06** Każde przejście DB i bramka akcji portalu sprawdzają executionId. Po utracie lease worker blokuje kolejne kliknięcia, unieważnia swój waiter i kończy wykonanie. Nie przejmować zadania tylko dlatego, że trwa długo.
- [ ] **E07** Reconciler bada runy bez ważnego właściciela, dyspozycje i BullMQ. Kolejka nie jest źródłem prawdy; zaginiony job jest odbudowywany dla tej samej intencji albo bezpiecznego kroku. Nie stosować automatycznych retry do otwartego zgłoszenia, wykorzystanego SMS lub niepewnej akcji portalu.
- [ ] **E08** Wprowadzić jeden handler błędu procesora. Nieoczekiwany wyjątek zapisuje bezpieczny kod, stan i interwencję/plan technicznego wznowienia. Sam `console.error` z eventu failed nie jest zakończeniem obsługi. Jeżeli DB jest niedostępna, połączenie odzyskiwania po powrocie usług ustala brak lease i rozstrzyga run.
- [ ] **E09** Techniczne powtórzenia operacji bez efektu portalowego ograniczyć do trzech prób łącznie w danym cyklu wznowienia, z opóźnieniami 5 i 15 s. Po wyczerpaniu utworzyć zgłoszenie. Czas oczekiwania na powrót usług może być dłuższy, lecz nie zwiększa liczby akcji w portalu ani budżetu SMS.
- [ ] **E10** Zaimplementować poniższą macierz wznowień. Intencja start/save/UFG zawsze wymaga uzgodnienia tej samej sprawy. Jeśli nie ma potwierdzonego sposobu odnalezienia sprawy, zatrzymać run i pokazać administratorowi potrzebną akcję; nie tworzyć nowej oferty.

| Stan/checkpoint po awarii | Dopuszczalne odzyskiwanie |
|---|---|
| queued/validating | Ponowne odczytanie i walidacja wejścia; żadnej akcji portalowej wcześniej |
| awaiting_portal_adapter w trybie off | Pozostaje zaparkowany; nie inicjować testowego lub live portalu |
| pzu_login/everest_search, bez MFA i bez skutku zewnętrznego | Sprawdzenie zachowanej sesji; bezpieczny odczyt; SMS wyłącznie po markerze |
| waiting_for_sms | Reguły C: właściwe challenge/session, żadnego replay wartości kodu |
| identity_review/waiting_for_manual_data | Tylko jawna akcja administratora; bez automatycznej kolejki portalowej |
| Compensa przed start-intent | Start raz, jeżeli aktualne dane i lease są poprawne |
| compensa_start_intent, brak numeru sprawy | Uzgodnienie istniejącego draftu albo zgłoszenie; zero kolejnego start |
| compensa_offer_draft_open | Otwarcie/uzgodnienie tej samej sprawy; ponowna kontrola danych przed zapisem |
| compensa_insured_save_intent | Odczyt skutku dla tego numeru; niepewność → zgłoszenie |
| compensa_insured_data_saved | Nie klikać Zapisz; przejść do odczytu/weryfikacji UFG tej samej sprawy |
| ufg_verification_intent | Odczyt już uruchomionej weryfikacji albo zgłoszenie; zero drugiego UFG |
| reading_oc z gotowym wynikiem staging | Powtórzenie przekazania wyniku do API; bez portalu |
| export_ready | Finalizacja samego eksportu; bez portalu |
| stan końcowy | Brak akcji portalu; idempotentny odczyt/odpowiedź |

- [ ] **E11** Zabezpieczyć odczytany snapshot przed utratą: po walidacji UFG zapisać szyfrowaną kopertę identity+snapshot w prywatnym stagingu workera przez temp → atomic rename, zanim zadanie przejdzie do reading_oc i nastąpi forwarding. Powiązać AAD z runId/sourceRowId/wersją formatu; użyć wersjonowanego keyringu oraz losowego nonce. Nie używać funkcji walidującej 11 cyfr PESEL do szyfrowania całej koperty.
- [ ] **E12** Nazwa pliku staging jest technicznym UUID; metadane DB wskazują jego integralność i wersję. Linux: plik 0600/katalog 0700; Windows: prywatny katalog i sprawdzona konfiguracja dostępu. Dodać prywatny wolumen staging do konfiguracji workera. API nigdy nie zwraca jego ścieżki.
- [ ] **E13** Restart ładuje tę samą kopertę i przekazuje ją ponownie. API uznaje identyczny już zapisany wynik za idempotentny; zmieniony wynik tego runu zwraca konflikt, bez cichego nadpisania. Utrata odpowiedzi po commit nie powoduje nowego odczytu UFG.
- [ ] **E14** Usunąć staging dopiero po potwierdzeniu trwałego snapshotu i terminalnego wyniku/finalizacji. Usuwanie jest idempotentne; osierocone/temp pliki identyfikować przez techniczne metadane. Nie usuwać danych niepotwierdzonego runu na podstawie samego wieku.
- [ ] **E15** Usunąć zależność odzyskiwania wyniku w API od `WORKER_LIVE_PORTALS`. Bezpieczne dostarczenie/finalizacja wyników musi działać też w izolowanym runnerze testowym. Zdolność do działań portalowych wynika z konfiguracji/właściciela workera i bramek, nie z przypadkowej flagi API.
- [ ] **E16** Jednoznacznie rozpoznana blokada konta/limit logowania wstrzymuje dalsze działania tego konta i portalu, także dla innych oczekujących runów. Zapisać trwałą blokadę i zgłoszenie z bezpiecznym kodem; administrator po sprawdzeniu odblokowuje ją z audytem. Nie wstrzymywać całego systemu dla niezwiązanego konta/tenanta. Restart nie kasuje blokady. Rozpoznawanie działa wyłącznie na skonfigurowanych markerach; nieznany ekran zatrzymuje bieżący run bez zgadywania przyczyny.

**Testy E:** commit przed publikacją i awaria Redis; publikacja przed ACK outboxa i restart API; utrata joba; dwa dispatchery; dwa joby jednego runu; drugi worker; lease aktywny przez 300 s SMS; utrata DB/heartbeat przed kliknięciem; crash przed/po start, Zapisz i UFG; wyjątek adaptera; timeout forwardingu przed/po commit API; crash po staging; tamper szyfrogramu; restart eksportu. Liczyć akcje w fixturze i rekordy DB: żadna niepewna akcja nie jest powtarzana.

**Bramka E:** każdy badany run osiąga wynik końcowy albo otwarte zgłoszenie z dopuszczalną akcją. Po odtworzeniu usług nie zostaje aktywny run bez właściciela i bez planu odzyskania.

## 10. Etap F — spójna konfiguracja lokalna i kontenerowa

**Pliki:** `compose.yaml`, `compose.local-browser.yaml`, `.env.example`, nowe przykłady konfiguracji lokalnej i skrypty uruchomienia/preflight, `run-worker.ts`, `portal-runtime-config.ts`, API health/readiness, README.

- [ ] **F01** Rozdzielić dokumentowane uruchomienie: (a) wszystkie usługi w Compose z headless workerem; (b) PostgreSQL/Redis w Compose i API/web/worker na Windows z widoczną przeglądarką. W obu jeden właściciel tego samego skonfigurowanego profilu; żadnego równoległego uruchamiania wariantów na jednym koncie.
- [ ] **F02** Compose przekazuje do workera `WORKER_LIVE_PORTALS` z domyślnym 0, wewnętrzną ścieżkę konfiguracji, PZU_LOGIN/PASSWORD, COMPENSA_LOGIN/PASSWORD, keyring i poprawny URL API. Konfigurację selektorów montuje read-only; profil/staging prywatnie i trwale. Nie wymagać sekretów portali przy trybie off.
- [ ] **F03** Przykład konfiguracji Windows zawiera także DATABASE_URL, REDIS_URL, WORKER_INTERNAL_URL, WORKER_RESULT_API_URL, PUBLIC_APP_ORIGIN, absolutne ścieżki oraz WORKER_HEADLESS=0. Nie skopiować nazw hostów kontenerowych `api`, `worker`, `postgres` do konfiguracji procesów hosta. Nie umieszczać prawdziwych wartości w przykładzie.
- [ ] **F04** Dodać skrypt uruchomienia, który ładuje wskazany lokalny plik środowiska bez wypisywania, wykonuje migracje przed API i uruchamia procesy z właściwym środowiskiem. Zatrzymanie skryptu zamyka jego procesy i przeglądarkę; nie zabija innych procesów Node/Chrome.
- [ ] **F05** Preflight trybu off sprawdza DB, Redis, keyring i prywatny kanał. Preflight live dodatkowo sprawdza poświadczenia, istniejący plik konfiguracji, schema, HTTPS/origins i jawne selektory. Odrzuca znaczniki `data-verified-*`, puste wartości i wieloznaczne ogólne akcje typu `smsCodeSubmit: button` jako konfigurację gotową do odbioru.
- [ ] **F06** Opcjonalne selektory `smsFrame`, postLoginLanding, remember/resend/error muszą mieć walidację typu i wartości. Brak zaobserwowanego checkboxa/reklamy nie powinien blokować podstawowego off/fixture uruchomienia; nie oznaczać tych selektorów jako potwierdzonych live.
- [ ] **F07** Rozdzielić liveness i readiness. Readiness panelu/API uwzględnia DB/Redis; gotowość automatyzacji uwzględnia świeży heartbeat workera, obsługiwany tryb i poprawną konfigurację. UI pokazuje konkretny brak usługi oraz stan „portale wyłączone”. Nie ujawnia URL z loginem, sekretów i ścieżek profilu.
- [ ] **F08** Sprawdzić `docker compose config --quiet`, start/stop obu wariantów w trybie off, health oraz dostęp HTTP. Wyświetlanie pełnego `docker compose config` może ujawnić podstawione sekrety — raportować wyłącznie wynik i bezpieczne nazwy brakujących ustawień.

**Testy F:** brak każdego wymaganego ustawienia daje czytelną nazwę błędu; tryb off startuje bez portal credentials; niedopuszczona flaga/schema odrzucana przed portalem; off nie otwiera żadnego URL portalu; worker niedostępny/Redis niedostępny widoczne w readiness; restart zachowuje profil i staging; drugi właściciel profilu jest blokowany.

**Bramka F:** odtwarzalne uruchomienie lokalne w trybie off i konfiguracja środowiska fixture gotowa dla runnera I. Pełny flow fixture odbiera etap I. Flaga realnego live pozostaje 0 po testach.

## 11. Etap G — globalne centrum powiadomień i zgłoszeń

**Pliki:** nowy moduł API interwencji/powiadomień w `module.ts`, `authorization-policy.ts`/guard; `db.ts` i migracja read-state/revision; nowe komponenty panelu oraz `workspace.tsx`.

- [ ] **G01** Dodać listę zgłoszeń niezależną od batchId: proponowane `GET /api/interventions?status=open&limit=20&cursor=...` i licznik `GET /api/interventions/summary`. Filtry portal/kind dozwolone i walidowane; limit 1–100; stabilny cursor `(createdAt, interventionId)`.
- [ ] **G02** SQL filtruje tenant i owner zgodnie z istniejącym prawem do runu. Administrator widzi tenant; operator własne runy. Reviewer widzi tylko dozwolone metadane zgłoszeń i nie dostaje pola wpisania SMS/wznowienia portalu. Auditor nie dostaje operacyjnego centrum SMS. Nie pobierać wszystkich rekordów i nie filtrować dopiero w React.
  - Lista i summary nie mają runId w URL: dodać jawne uprawnienie odczytu zgłoszeń i kontekst listy z aktualnej sesji. Resolver pojedynczej interwencji rozwiązuje `intervention → run → batch`, także dla oznaczenia odczytu. Nie wykorzystywać `new-batch` ani dostarczonego przez klienta tenantId do obejścia resolvera. Listę, licznik i cursor sprawdzać tą samą macierzą uprawnień.
- [ ] **G03** DTO zawiera interventionId, runId, batchId, rowNumber, kind, portal, reasonCode, status, revision, createdAt/updatedAt oraz możliwości canSubmitSms/canResumeReview. Dla aktywnego SMS dodatkowo challengeId/expiresAt/status, bez kodu. Tenant/owner muszą być rozwiązane po stronie serwera.
- [ ] **G04** Używać bezpiecznej whitelisty DTO; nie zwracać PESEL, danych osoby, loginu portalu, ścieżek i accountKey. Dodać revision/updatedAt interwencji i osobny read-state użytkownika `(interventionId,userId,seenRevision)`.
- [ ] **G05** `POST /api/interventions/:id/read` z CSRF oznacza odczytaną wersję. Odczyt powiadomienia nie rozwiązuje problemu. Zmiana aktywnego SMS na timeout zwiększa revision i ponownie pokazuje uwagę bez utworzenia drugiego open incident.
- [ ] **G06** Panel po logowaniu pokazuje licznik i listę zgłoszeń nawet bez wybranego importu. SMS otwiera modal dla właściwego runu; zgłoszenie błędu otwiera szczegóły i działania. Przejście nie wymaga ponownego importowania pliku.
- [ ] **G07** Stary link/powiadomienie zawsze najpierw odczytuje aktualny stan. Zamknięte zgłoszenie pokazuje wynik/zamknięcie, a nie stary input. Zachować kontrolowany polling D i odrębność „przeczytane” od „rozwiązane”.

**Testy G:** brak importu w URL i aktywny SMS widoczny; dwa importy w jednym tenant; cudzy tenant/owner niewidoczny; brak uprawnienia nie otwiera kodu; odczyt utrzymuje się po refresh; timeout ponownie sygnalizowany; zamknięte zgłoszenie znika z open; 100+ rekordów bez duplikatów przy paginacji; dwa runy nie mieszają challenge.

**Bramka G:** administrator potrafi znaleźć i obsłużyć wszystkie zgłoszenia swojej firmy z platformy bez znajomości batchId. Nie rozszerzać tej iteracji o wysyłanie email/push ani zewnętrznego SMS.

## 12. Etap H — administrator faktycznie rozwiązuje brakujące dane

Sam przycisk „Wznów po sprawdzeniu” nie rozwiązuje brakującego adresu/powiatu ani utraty kontekstu oferty. Należy doprowadzić zgłoszenia do stanu, z którego wznowienie ma sens.

**Pliki:** moduł API interwencji, `runs.ts`, nowe per-run overrides i wersja wejścia, `pg-run-repository.ts`, `compensa-form.ts`, komponent szczegółów zgłoszenia; migracja.

- [ ] **H01** Zapisać przy zgłoszeniu bezpieczny fieldCode, np. ADDRESS/POSTAL_CODE/CITY/COUNTY/EXPECTED_PERSON, zamiast wyłącznie ogólnego MANUAL_DATA_REQUIRED. Nie kopiować wartości klienta do metadanych zdarzeń.
- [ ] **H02** Dodać kontrolowane poprawki wejścia runu z osobnym źródłem, autorem i wersją. Oryginalnego Excela ani źródłowych surowych pól nie nadpisywać. API proponowane: `PATCH /api/runs/:id/manual-data` z `expectedVersion`, whitelistą pól i powodem. Dostęp administratora, CSRF, stan oczekiwania na interwencję.
- [ ] **H03** Dozwolone pola tej iteracji: adres, kod pocztowy, miasto, kod/opcja powiatu i oczekiwane imię+nazwisko przed zatwierdzeniem identity. Walidować długości/format i kontekst sourceRowId. Powiat musi odpowiadać opcji istniejącego selecta w portalu; nie zgadywać wartości.
- [ ] **H04** Nie dopuścić ręcznego wpisania PESEL zamiast wyniku PZU ani zmiany osoby po utworzeniu oferty. REGON korygować istniejącym procesem zatwierdzenia danych źródłowych. Zmiana tożsamości po intencji startu/zapisu wymaga rozstrzygnięcia sprawy, nie automatycznej podmiany danych.
- [ ] **H05** Przy niepewnym draftcie/sprawie pokazać przyczynę i instrukcję uzgodnienia. Możliwość przypisania numeru sprawy, jeśli dodana, wymaga późniejszej walidacji tej samej osoby i sprawy w portalu; sam numer wpisany przez administratora nie dowodzi skutku zapisu ani nie pozwala ponownie kliknąć UFG.
- [ ] **H06** Resume-review wymaga odpowiedniej poprawki albo potwierdzenia uzgodnienia i zapisuje audyt. Dwukrotne równoczesne poprawki/resume: expectedVersion/CAS i jedna intencja. Administrator widzi, czy wznowienie jest dopuszczalne i dlaczego.

**Testy H:** puste dane → dokładny fieldCode; poprawka przechodzi po walidacji; oryginalne wejście niezmienione; druga stara wersja 409; cudzy administrator/tenant odmowa; puste/nieznane county nie jest wybierane; zmiana osoby po start-intent odrzucana; resume bez rozwiązania nadal pozostawia jawny problem bez nowej oferty.

**Bramka H:** na syntetycznym runie brak pola można uzupełnić w platformie i wznowić to samo zadanie bez nowego draftu; konflikty tożsamości pozostają blokadą przed zapisem.

## 13. Etap I — odbiór pełnego procesora bez kontaktu z portalami

**Pliki:** nowy `apps/worker/src/live-run.test.ts`; nowe testy realnej DB/HTTP; nowy runner integracyjny, np. `apps/api/scripts/platform-flow-no-pzu-sms-smoke.cjs`; fixtury Playwright; skrypty npm.

- [ ] **I01** Przygotować fixtury ekranów: PZU login/iframe SMS/Strefa Agenta/Everest/reklama/wyniki; Compensa home/kafel/dialog/formularz/numer oferty/potwierdzenie/UFG/tabela OC. Każda istotna akcja ma licznik i deterministyczny wynik. Dane są syntetyczne.
- [ ] **I02** Utworzyć prawdziwy `BrowserSession` w prywatnym katalogu testowym. Na `browser.open()` ustawić routing fixtur przed nawigacją; wszystkie zewnętrzne żądania abort. Wstrzyknąć config domen `.test` i syntetyczne credentials w runnerze testowym. Nie dodawać trybu fake do produkcyjnego endpointu POST run.
- [ ] **I03** Jednostkowe testy `LiveRunProcessor` mają używać jego rzeczywistej logiki etapów, a nie wyłącznie `pipeline.ts`. Umożliwić wstrzyknięcie clock/policy i zależności testowych bez osłabiania produkcyjnych bramek.
- [ ] **I04** W integracji uruchomić rzeczywiste API z AppModule/guardami, rzeczywistą testową bazę po wszystkich migracjach, Redis/BullMQ, prywatny odbiornik kodu oraz osobny Worker wywołujący produkcyjny procesor z fixture BrowserSession. Testowy worker konstruuje zależności w osobnym entrypoincie skryptu; nie przełącza fake/live żądaniem klienta.
- [ ] **I05** Przez HTTP zalogować testowego użytkownika, zaimportować syntetyczny XLSX, uruchomić run i poprzez formularz panelu przekazać syntetyczny kod do iframe. Po zaakceptowaniu wykonać rzeczywistą kolejkę i cały procesor do eksportu. SMS jest lokalnym tekstem testowym, nie kodem z PZU.
- [ ] **I06** Zweryfikować DB: runId/sourceRowId/referenceDate, zaszyfrowana identity, kompletność snapshotu, liczba polityk i artefakt. Pobrać XLSX przez sesję użytkownika i odczytać plik ponownie; porównać wszystkie eksportowane pola, daty i liczność z DB/fixture.
- [ ] **I07** Powtórzyć positive flow dla drugiego runu w tym samym profilu i dla kolejnego po restarcie syntetycznej sesji. Fixture określa, czy sesja jest nadal akceptowana; jeśli wygasła, platforma pokazuje jedno nowe wyzwanie.
- [ ] **I08** Wykonać macierz poniżej z kontrolowanym fault injection na granicach. Test nie może kończyć się jedynie asercją statusu: sprawdza akcje portalu, DB, joby, widoczność w panelu i pobrany wynik/brak pliku.

| ID | Scenariusz | Minimalny dowód |
|---|---|---|
| I-T01 | Pełen pozytywny flow z MFA | Jeden run, jeden start, jeden zapis, jedno UFG, pełny plik zgodny z DB |
| I-T02 | Zachowana sesja w drugim runie | Bez wzrostu liczby loginów/SMS przy akceptowanej sesji fixture |
| I-T03 | Timeout pierwszego SMS i jedno wznowienie | Zgłoszenie, 300 s w konfiguracji, jedna dodatkowa intencja/akcja |
| I-T04 | Timeout drugiego SMS | UI/API blokują następne wznowienie, brak akcji portalowej |
| I-T05 | Dwie karty i stary kod | Jeden forwarding; późny stary formularz bez skutku |
| I-T06 | Reklama PZU obecna/nieznana | Znana zamknięta raz; nieznana zatrzymuje run przed przypadkowym kliknięciem |
| I-T07 | Brak wyniku, obca osoba/firma, wiele osób, brak PESEL | Interwencja; zero startów Compensy i zero plików |
| I-T08 | Brak oczekiwanej osoby w wejściu | EXPECTED_PERSON/review; jawne rozwiązanie zgodnie z H, bez wyboru na wyczucie |
| I-T09 | Dane Compensy puste/sprzeczne | Puste → formularz administratora; sprzeczne → blokada przed Zapisz/UFG |
| I-T10 | Powiat/adres poprawiony w platformie | Ten sam run/sprawa, source pozostaje surowe, jeden zapis |
| I-T11 | 0 OC / 0 aktualnych OC | Pełny snapshot; no_matching_policies; brak pustego XLSX |
| I-T12 | 49 i 158 wierszy, scroll, przestawione kolumny | Pełna liczność i poprawne mapowanie pól |
| I-T13 | Niepełny UFG/duplikat/błędna data/zmieniony nagłówek | Zgłoszenie lub jawny błąd; zero częściowych eksportów |
| I-T14 | Awaria po start/save/UFG-intent | Brak ślepej drugiej akcji; sprawa uzgodniona albo zgłoszenie |
| I-T15 | Redis zniknął po commit create/resume | Po powrocie jeden job tej samej dyspozycji, bez drugiego resend |
| I-T16 | API znika przed/po zapisie wyniku | Staging przetrwa; ten sam wynik/artefakt po wznowieniu; zero nowych akcji portalu |
| I-T17 | Restart przed/po identity i po odczycie UFG | Zgodność checkpointów i trwałego wyniku; bez danych z innego runu |
| I-T18 | Dwaj właściciele/duplikaty jobów | Jedno wykonanie uprawnione do kliknięć, brak dubletów |
| I-T19 | Północ Europe/Warsaw i koniec polisy w referenceDate | Data runu stała; dzień graniczny włącznie |
| I-T20 | Obcy tenant, nieuprawnione pobranie, wygaśnięta sesja panelu | 401/403/404 zgodnie z kontraktem; brak danych/forwardingu |
| I-T21 | Globalne zgłoszenie przy innym/brak importu | Właściwy modal/run, skuteczne rozwiązanie bez reload/importu |
| I-T22 | Sekret/kod/PESEL w logach, Redis i public API | Brak wartości SMS/sekretów; PESEL tylko w chronionej kopercie/DB i uprawnionym XLSX |
| I-T23 | Utrata DB/lease przed akcją w portalu | Zero kolejnego kliknięcia; odzyskiwanie ustala checkpoint lub zgłoszenie |
| I-T24 | Brak miejsca na staging albo XLSX | Bez częściowego wyniku; snapshot już zapisany pozwala ponowić sam eksport |
| I-T25 | Limit logowania/blokada konta | Inne runy tego konta nie logują się; inne konto działa; restart zachowuje blokadę |
| I-T26 | MFA Compensy po utrwaleniu numeru oferty | Właściwe powiadomienie i portal, po kodzie ta sama oferta; brak nowego startu |

- [ ] **I09** Wprowadzić awarie przez sterowane zależności/fixture i faktyczne zatrzymanie testowego procesu/usługi w testach crash. Nie zastępować restartu jedynie ponownym wywołaniem funkcji.
- [ ] **I10** Zaliczyć zaległe bramki obecnych funkcji na DB/Redis: mapowanie users/memberships, ownership, audyt rollback, korekty/enrichment/grupowanie, migracje i Lua limiter. Zrewidować wersje dotychczasowych migration-smoke, ponieważ część kończy na 009/012 zamiast obecnym pełnym schemacie.

**Bramka I:** I-T01–26 mają wynik i dowód. Każdy nieuruchomiony przypadek jest oznaczony jako nieodebrany z konkretną przyczyną. „Testy przechodzą” bez realnego procesora i guardów nie spełnia bramki.

## 14. Etap J — dokumentacja, checklisty i końcowe przekazanie

- [ ] **J01** Uruchomić pełny build, testy core/API/workera, wszystkie syntetyczne testy Chromium, aktualny smoke SMS/powiadomień i integrację pełnego flow. Powtórzyć tylko zestawy uzasadnione końcowymi zmianami.
- [ ] **J02** Sprawdzić migracje od pustej DB i od 015, ponowne wykonanie bez zmian oraz zachowanie legacy runów/zdarzeń. Dowód nie wymaga migracji bieżącej bazy klienta.
- [ ] **J03** Zapisać protokół odbioru: commit/stan roboczy, wersje, testId, komendy, wynik, liczność, liczbę akcji portalu, hash artefaktu, bramki pominięte. Nie zapisywać danych pól klienta ani kodów.
- [ ] **J04** Zaktualizować README, STAN_IMPLEMENTACJI i POSTEP. Usunąć sprzeczne bieżące stwierdzenia „niepodłączony”/„gotowy produkcyjnie”; starsze checklisty oznaczyć jako historyczne. Liczba ukończonych kroków nie jest procentem gotowości do pracy live.
- [ ] **J05** Zamknąć tylko zasoby utworzone na potrzeby testów. Pozostawić WORKER_LIVE_PORTALS=0 i nie zmieniać profilu klienta. Raport końcowy musi rozdzielać: kod zaimplementowany, test syntetyczny zaliczony, test integracji usług zaliczony, żywy portal nieodebrany.

**Końcowa bramka tej iteracji:** A–J zaliczone, pełna aplikacja działa na syntetycznych ekranach, a każda awaria ma odtwarzalny, bezpieczny wynik. To jest punkt gotowości do późniejszego nadzorowanego testu PZU.

## 15. Oddzielna bramka późniejsza — wymaga PZU, teraz nie wykonywać

Poniższe pozostaje otwarte i nie może być oznaczone jako ukończone przez tę iterację:

1. Potwierdzenie rzeczywistego markeru MFA, właściwego inputa i jednoznacznego submit w ramce PZU. Obecne ogólne `button` nie jest potwierdzonym selektorem akcji.
2. Potwierdzenie rzeczywistego checkboxa zapamiętania urządzenia oraz zachowania po restarcie. Portal decyduje o zaufaniu do urządzenia; trwały profil nie daje gwarancji.
3. Potwierdzenie wygaśnięcia i przycisku resend oraz warunków jego dostępności. Nie wywoływać wielu logowań w celu wymuszania ekranów.
4. Potwierdzenie selektorów reklamy, jeśli reklama faktycznie się pojawi, i ekranów odmowy. Nie zgadywać selektorów w konfiguracji live.
5. Jeden nadzorowany przebieg z panelu dla autoryzowanego rekordu: PESEL z „Osoba fizyczna”, Compensa Komunikacja, właściwe dane i RST22339, ta sama oferta, UFG, kompletność wyniku i pobranie XLSX. Przed startem uzgodnić istniejące szkice z wcześniejszego pilotażu.
6. Mała seria w jednej sesji, restart i wygaśnięcie sesji na rzeczywistych portalach. Dopiero później VPS, HTTPS, backup, monitoring i odbiór konfiguracji produkcyjnej.

## 16. Gotowy prompt przekazania agentowi kodującemu

> Pracuj w istniejącym repozytorium Goldis-Automatyzacje. Wykonaj `docs/PLAN_NAPRAW_I_ODBIORU_BEZ_SMS_PZU.md`, zachowując istniejący kod i zmiany użytkownika. Przestrzegaj dokładnej kolejności z sekcji 3.1, w tym wspólnego bloku C/E. Zacznij od punktu bazowego oraz błędu resolvera `body-run`; następnie napraw cykl SMS, konkurencję i limit ponowienia wraz z outboxem/lease/odzyskiwaniem i trwałym stagingiem wyników, odświeżanie/modale, konfigurację uruchomienia, globalne zgłoszenia i formularze administratora. Nie kontaktuj się z PZU/Compensą, nie używaj rzeczywistych SMS/danych klienta ani profilu klienta. Testuj rzeczywisty LiveRunProcessor, guardy, PostgreSQL, Redis, HTTP i XLSX na izolowanym środowisku oraz syntetycznych ekranach Playwright z zablokowanym ruchem zewnętrznym. Po każdym etapie zapisz pliki i dowody testów w docs/POSTEP_IMPLEMENTACJI.md. Bramka nieuruchomiona pozostaje otwarta; mocki nie zastępują testu DB/HTTP. Nie oznaczaj produktu jako gotowego live ani nie wykonuj sekcji 15. Kończ dopiero po zaliczeniu kryteriów A–J lub po udokumentowaniu rzeczywistej blokady, wykonując wcześniej wszystkie niezależne prace. Raport końcowy rozdziela implementację, testy modułów, integrację syntetyczną i nadal otwartą bramkę PZU.
