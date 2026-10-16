# Plan implementacji napraw bezpieczeństwa Goldis

Data: 8 października 2026. Dokument wykonawczy do [audytu bezpieczeństwa](AUDYT_BEZPIECZENSTWA_2026_10_08.md). Plan dotyczy badanego katalogu roboczego na bazie HEAD `e3a507ea8e534f06d698289bf1165f79691e5a6d`, wraz z istniejącymi zmianami. Przed implementacją trzeba porównać ten stan z aktualnym kodem.

Dokument opisuje proponowane zmiany; nie oznacza ich wdrożenia ani zamknięcia ustaleń. Nie zmienia obecnej macierzy ról bez wyraźnie opisanej decyzji. Nazwy nowych modułów, pól, testów i poleceń poniżej są kontraktem do implementacji, a nie deklaracją, że już istnieją. Wartości limitów oznaczone jako startowe wymagają kalibracji na izolowanym środowisku.

## 1. Zasady wykonania i kolejność

Każdy pakiet należy wykonać w kolejności: test pokazujący oczekiwane zabezpieczenie → implementacja → testy jednostkowe/HTTP → wymagane testy PostgreSQL/Redis/przeglądarki → przegląd zmian → odbiór. Nie oznaczać testu pominiętego jako zaliczonego. Kod wyjścia 0 historycznego `scripts/security-audit-2026-10-08.cjs` potwierdza odtworzenie zachowań audytu, również podatnych; nie stanowi testu skuteczności napraw.

| Pakiet | Zakres | Zależność | Warunek ukończenia |
| --- | --- | --- | --- |
| P00 | Środowisko, kontrakty, testy odbioru | Brak | Bezpieczne, izolowane środowisko i zarejestrowane scenariusze |
| P01 | SEC-01: poświadczenia, sesje, wyścigi | P00 | Reset/cofnięcie nie może zostać nadpisane przez stare żądanie |
| P02 | SEC-02, C-01, macierz ról | P00 | Odczyt zależy od view_results; tenant obowiązuje zawsze |
| P03 | SEC-03/04: limity uwierzytelnienia i proxy | P00; P01 dla współbieżnych sukcesów | Współdzielone liczniki i wiarygodne IP, odmowa przed KDF |
| P04 | SEC-05/06/09: hashe, bootstrap, enumeracja | P01, P03 | Stare konta działają, nowe hashe mocniejsze, błędne loginy wykonują KDF |
| P05 | SEC-08/10: interwencje i cofanie przydziałów | P01, P02 | Jedna polityka statusu/grantu; utrata praw usuwa właściwe przydziały |
| P06 | SEC-07: budżety API, readiness, XLSX | P03; P02 dla zakresu danych | Koszt żądania, probe i parsera jest ograniczony |
| P07 | CSP, clickjacking, cache; regresje JS/SQL injection | P02, P06; zgodna wersja Next | Testy przeglądarkowe i DB oraz nagłówki produkcyjne |
| P08 | Odmowy, metryki i audyt | Kontrakty P01–P06 | Zdarzenia są użyteczne, ograniczone i bez sekretów |
| P09 | Ponowna autentykacja, MFA, bezczynność | P01, P03, P04, P08 | Operacje uprzywilejowane wymagają świeżego potwierdzenia |
| P10 | Produkcyjne wdrożenie i prawa infrastruktury | P03, P06, P08 | TLS, izolacja sieci, konta runtime i ACL zweryfikowane |
| P11 | Zależności npm | P00; przed końcowym odbiorem P07 | Rozstrzygnięte zgłoszenia i zgodne aktualizacje |
| P12 | Odbiór i wdrożenie | Wszystkie pakiety objęte wydaniem | Dowody pozytywne i negatywne, próba rollbacku |

Pierwsze wydanie napraw powinno obejmować P01, P02 i P03. Rozbudowa MFA nie powinna opóźniać usunięcia odtworzonego wyścigu. Aktualizację Next można przygotować wcześniej, ale końcowy odbiór CSP musi dotyczyć wersji rzeczywiście wydawanej. P08 należy rozwijać wraz z naprawami, nie odkładać wszystkich logów na koniec.

### 1.1. Ustalone reguły biznesowe

1. Tenant z uwierzytelnionej sesji jest obowiązkową granicą każdego zasobu. Właściciel, przydział i grant nigdy jej nie znoszą.
2. Rola określa maksymalny zbiór czynności. Grant narzędzia może go ograniczyć; nie daje reviewerowi ani auditorowi czynności operatora/admina.
3. `canExecute`, `canViewResults`, `canDownloadResults` są odrębne. Wyjątek SMS daje minimalne dane potrzebne do obsługi wyzwania, nie ogólny odczyt wyników.
4. `available` pozwala na czynności zgodne z rolą/grantem; `maintenance` zachowuje odczyt, blokuje wykonanie; `disabled` blokuje operacyjny dostęp nieadministratorów. Admin może odczytywać dane wyłączonego narzędzia w swoim tenancie, ale nie wykonywać zadań wyłączonego narzędzia.
5. Hasło w `User` jest globalne. Zmiana/reset hasła cofa sesje użytkownika we wszystkich tenantach. Zmiana roli lub grantu jest ograniczona do tenanta. Globalne wyłączenie `User.status` wymaga globalnego cofnięcia; lokalne wyłączenie członkostwa wymaga cofnięcia lokalnego.
6. Zachować obecne globalne znaczenie operacji wyłączenia konta, jeśli zapisuje `User.status`. Nie zamieniać jej niejawnie w lokalne wyłączenie członkostwa; osobny produktowy zakres wymaga osobnego endpointu i testów.
7. Zachować obecny brak `submission:read` dla reviewera. Naprawa błędnego grantu nie jest rozszerzeniem tej roli. Admin ma anulowanie partii w całym swoim tenancie; operator zachowuje ograniczenie do własnych danych i dozwolonego autorstwa partii.
8. Zasób obcego tenanta lub poza zakresem właściciela: 404 bez ujawnienia danych. Brak uprawnienia do znanej czynności w swoim zakresie: 403, z zachowaniem istniejących reguł ukrywania zasobów. Brak/wygaśnięcie/cofnięcie sesji: 401. Limit: 429 z `Retry-After`. Konflikt wersji mutacji: 409.

## 2. P00 — przygotowanie wykonania i testów

**Pliki:** `scripts/test-module.cjs`, `scripts/test-module.test.cjs`, `scripts/Test-GoldisDatabase.ps1`, `apps/api/scripts/run-db-integration.cjs`, `package.json`; nowy katalog `docs/security/implementation/` na dowody odbioru.

1. Zapisać aktualny SHA, listę zmienionych plików i wersje Node/npm/PostgreSQL/Redis. Nie resetować katalogu roboczego i nie nadpisywać cudzych zmian. W diffie każdej poprawki oddzielić własne zmiany od stanu zastanego.
2. Zachować historyczne JSON/logi audytu. Nowe testy powinny oczekiwać odmowy podatnego zachowania; nie edytować historycznego wyniku tak, aby wyglądał na dowód naprawy.
3. Utworzyć zestawy `security`, `security-db`, `security-redis`, `security-browser` i jawnie zarejestrować ich pliki w module runnera. Obecny manifest modułu auth nie obejmuje automatycznie każdego nowego testu.
4. Dla DB tworzyć wyłącznie tymczasową bazę o losowej nazwie, pod kontrolowanym lokalnym PostgreSQL. Wykorzystać istniejące sprawdzanie loopback i katalogu `/postgres` lub `/template1`; nazwę kasowanej bazy porównać z nazwą utworzoną przez dany proces. Ustawić limit czasu i sprzątać po błędzie.
5. Dla Redis utworzyć osobny kontener/usługę testową z losowym portem i etykietą własności. Nie wykonywać `FLUSHDB` na istniejącym Redis. Testy korzystają z unikalnego prefiksu; cleanup usuwa tylko własne klucze i kontener.
6. Dodać odrębny tryb security do wrappera PowerShell. Nie wykorzystywać `-Automation` do samego uruchomienia Redis: obecny przełącznik włącza również pełny flow. W security jawnie wyłączyć portale/live/browser-provider flow i nie dziedziczyć flag E2E.
7. Dodać uruchomienie migracji nowej bazy i bazy ze starym schematem/hashem. Obecny runner/log zawiera odniesienia do migracji 030; po rozszerzeniu nie może fałszywie informować o migracji do ostatniej wersji. Numer następnej migracji ustalić dopiero po sprawdzeniu katalogu.
8. Przeglądarkę kierować do lokalnie zbudowanego web/API z syntetycznymi danymi. Portale, GUS/MF/UFG i inne zewnętrzne serwisy zastąpić fixture. Test nie może wysyłać wiadomości ani uruchamiać rzeczywistych automatyzacji.
9. Uruchomić bazowy `npm test`, build web oraz potrzebne moduły. Zapisać liczbę pass/fail/skip i uzasadnienie skip. Punkt odniesienia audytu to 224 pass, 37 skip, 0 fail; nowy stan może mieć inną liczbę testów.

**Odbiór:** nowy test rzeczywistej DB/Redis nie może zaliczać się po pominięciu zależności; brak zależności oznacza błąd uruchomienia albo jawny nieukończony odbiór. Runner odmawia użycia adresu produkcyjnego i nie uruchamia flow przy próbie security.

## 3. P01 — SEC-01: atomowość poświadczeń i sesji

**Pliki:** `apps/api/src/session.ts` (także SessionGuard i odczyt principal), `admin.ts`, `db.ts`, `bootstrap-admin.ts`, `runs.ts`, `run-submissions.ts`; testy `session.test.ts` i `session-auth.test.ts`; nowy `credential-mutations.ts`, nowe migracje i testy współbieżności DB. Dokładny zasięg zmian blokad wynika z grafu transakcji opisanym poniżej.

### 3.1. Model wersji i migracja

1. Dodać `users.credential_revision` typu integer, `NOT NULL DEFAULT 1`, z kontrolą dodatniej wartości. Model Sequelize ma tę samą nazwę logiczną i typ. Nie używać JS Number dla nieograniczonego BIGINT bez konwersji.
2. Dodać `user_sessions.credential_revision`, uzupełnić wersją użytkownika, następnie ustawić `NOT NULL`. Migracja nie może cofać wszystkich działających sesji przypadkiem. Backfill wykonać przed uruchomieniem sprawdzania wersji.
3. Każda rzeczywista zmiana/reset hasła zwiększa revision w tej samej transakcji co hash. Zmiana reprezentacji hasha tego samego hasła, np. rehash, nie zwiększa revision i nie cofa sesji.
4. Przy wydaniu sesji zapisywać aktualną revision. Przy odczycie sesji wymagać równości sesja/użytkownik, aktywnego użytkownika i członkostwa oraz braku cofnięcia i ważnego czasu wygaśnięcia. Cookie nie jest źródłem wersji ani roli; podpisany format v2 może pozostać, gdy revision jest sprawdzana w DB.
5. Wszystkie twórcy sesji muszą zapisywać revision przed włączeniem `NOT NULL` bez wartości domyślnej dla tego pola. Dla rolling deploy zastosować etap rozszerzenia schematu i przejściowe uzupełnianie; nie pozwolić, aby stary proces po aktywacji ochrony wydał sesję ze złą wersją.
6. Przepełnienie revision ma powodować kontrolowaną odmowę i alarm, nie zawinięcie do ujemnej wartości. Wdrożenie z mieszanymi wersjami kodu nie jest uznawane za chronione, dopóki stary zapisujący proces nie zostanie zatrzymany.

### 3.2. Wspólna dyscyplina blokad

1. Spisać graf blokad dla: login, changePassword, reset, logout, cofnięcie pojedynczej/wszystkich sesji, disable/enable, zmiana roli, set/revoke grant, assignment oraz dopuszczanie run/submission. Uwzględnić istniejące `tenant advisory`, `ToolSettings`, `User`, `TenantMembership`, `ToolGrant`, sesje i interwencje.
2. Zastosować jeden helper transakcyjnej blokady advisory dla globalnego `userId`, ze stałą przestrzenią kluczy i parametryzowanym SQL. Dla czynności actor/target blokować unikalne identyfikatory w ustalonej kolejności sortowania. Kolizja hasha może jedynie dodatkowo serializować, nie osłabiać ochrony.
3. Jeżeli operacja używa istniejącej blokady administracyjnej tenanta, pobiera ją przed bramką użytkowników. Żadna ścieżka trzymająca bramkę użytkownika nie może później czekać na tę blokadę tenanta. Nie wprowadzać blokady całego tenanta do każdego loginu.
4. Bramkę użytkownika pobierać przed blokadami wierszy, które mogą współzawodniczyć z resetem/rolą/grantem. Po jej pobraniu reread aktualnych rekordów. Nie opierać bezpieczeństwa na obiekcie Sequelize pobranym przed transakcją.
5. Zmienić wszystkie konkurujące ścieżki, a nie tylko `changePassword`. Obecny start runu blokuje ustawienia przed użytkownikiem, a admin członkostwo przed użytkownikiem. Dopóki dana ścieżka nie uczestniczy w tym samym protokole, trzeba wykazać brak cyklu grafu blokad; samo dodanie `FOR UPDATE` może wywołać deadlock.
6. Dla przydziału najpierw odczytać minimalny snapshot identyfikatorów, pobrać bramki obecnego/nowego assignee, następnie zablokować interwencję i ponownie zweryfikować snapshot/version. Zmiana snapshotu oznacza retry transakcji lub 409. Nie pobierać najpierw interwencji, a później grantu, gdy równoległe odebranie grantu trzyma grant i czeka na interwencję.
7. KDF i połączenia sieciowe wykonywać poza sekcją blokad. Ustawić ograniczony czas transakcji/lock timeout; retry deadlock tylko dla całej idempotentnej transakcji, z niewielkim limitem. Konflikt poświadczeń nie jest deadlockiem i nie może być automatycznie „naprawiany” zapisem starego hasha.

### 3.3. Zmiana hasła krok po kroku

1. Session/Origin/CSRF i limiter reauth sprawdzają żądanie przed KDF. Pobrać snapshot `userId`, hash i revision; hasło nie może trafić do logów ani kolejki.
2. Zweryfikować obecne hasło i politykę nowego. Wyliczyć nowy hash poza transakcją. Nie ustawiać jeszcze cookie ani `mustChangePassword=false`.
3. Rozpocząć transakcję; pobrać bramkę użytkownika oraz aktualne rekordy użytkownika, członkostwa i sesji żądania według wspólnego porządku.
4. W transakcji ponownie sprawdzić: użytkownik aktywny, członkostwo aktywne, sesja należy do tego user/tenant, nie jest cofnięta/wygasła, revision sesji jest aktualna, snapshot hash i revision odpowiadają aktualnym poświadczeniom.
5. Jeśli sesja została cofnięta/status nieaktywny: 401, bez zapisu i bez cookie. Jeśli poświadczenia zmieniły się w toku: odmówić; dla aktualnej jeszcze sesji można zwrócić stały 409 `credentials_changed`, bez danych hasha. Nie akceptować starego hasła drugi raz na podstawie wcześniejszego wyniku.
6. Zapisać nowy hash i revision+1, ustawić `mustChangePassword=false`, cofnąć wszystkie aktywne sesje użytkownika we wszystkich tenantach. Zachować istniejące powody cofnięcia lub rozszerzyć ich CHECK w migracji.
7. Wydać jedną nową sesję bieżącego tenanta z nową revision i CSRF, o ile członkostwo pozostaje aktywne. Audyt zmiany i cofnięć zapisać w tej samej transakcji bez hashy/haseł.
8. Commit musi zakończyć się przed wysłaniem cookie. Rollback, wyjątek audytu lub konflikt nie wydaje nowej sesji. Opóźniona odpowiedź może zawierać cookie już cofniętej sesji przez kolejny reset; serwer musi taką sesję odrzucić przy użyciu.

### 3.4. Reset administratora i logowanie

1. Reset wymaga aktywnego admina w tenancie celu. Po oczekiwaniu na blokadę ponownie zweryfikować członkostwo/rolę i sesję admina; początkowy guard nie wystarcza, jeśli admin stracił prawa podczas oczekiwania.
2. Hash nowego hasła policzyć poza transakcją. W transakcji reread celu, zwiększyć revision, ustawić `mustChangePassword=true`, cofnąć sesje globalnie. Reset nie wydaje sesji użytkownika.
3. Logowanie po poprawnym KDF również pobiera bramkę użytkownika i reread. Sprawdza aktualny hash/revision, status, członkostwo i `mustChangePassword`. Jeżeli reset nastąpił pomiędzy KDF a zapisem sesji, odmawia wydania sesji na podstawie starego snapshotu.
4. Rehash po loginie zapisuje hash warunkowo: revision i poprzedni hash nadal zgodne. Nigdy nie nadpisuje resetu. Przy zmianie snapshotu można odmówić i poprosić o nowy login; nie domniemywać, że nowy hash oznacza ten sam sekret.
5. Logout i admin revoke uczestniczą w tej samej serializacji z tworzeniem sesji. Wylogowanie może wyczyścić cookie również wtedy, gdy sesja już została cofnięta; nie otwiera dostępu.
6. Po zmianie roli/wyłączeniu członkostwa trwające operacje administracyjne/biznesowe reread praw przy zatwierdzeniu, jeśli ich efekt ma nastąpić po odebraniu uprawnień. W tym pakiecie obowiązkowo objąć zmiany poświadczeń i dopuszczenie pracy; dla pozostałych mutacji zinwentaryzować zakres i domknąć w P02/P05.

### 3.5. Testy i odbiór P01

| Scenariusz na rzeczywistym PostgreSQL | Kolejność wymuszona barierami | Oczekiwany wynik |
| --- | --- | --- |
| Change vs reset | Change kończy KDF; reset commit; change próbuje zapisać | Hash resetu i mustChange=true pozostają; brak nowej sesji change |
| Change vs revoke/logout | Change kończy KDF; revoke commit | Change odrzucone; brak cookie/sesji |
| Login vs reset | Login kończy KDF; reset commit | Nie powstaje sesja starej revision |
| Change vs change | Dwa KDF starego hasła; pierwszy commit | Drugi nie nadpisuje pierwszego |
| Rehash vs reset | Rehash ma stary snapshot; reset commit | Rehash CAS nie zapisuje |
| Admin traci rolę/sesję | Reset czeka; odebranie praw commit | Reset nie dochodzi do skutku |
| Globalne hasło | Aktywne sesje w tenantach A i B; reset w A | Obie stare sesje nieważne |
| Błąd audytu/commit | Błąd po przygotowaniu mutacji | Brak częściowej zmiany i cookie |
| Start runu vs admin/grant | Naprzemienne blokady obu transakcji | Brak deadlock w zaprojektowanym porządku; brak startu po cofnięciu |

Użyć oddzielnych połączeń i barier w testach; nie `sleep` jako jedynego wymuszenia kolejności. Po teście sprawdzać bazę i autentykację nowym/starym hasłem, nie tylko status HTTP. Powtórzyć serię współbieżności z limitem czasu. **SEC-01 zamknięte dopiero po tym odbiorze.**

## 4. P02 — SEC-02, C-01 i dostęp według roli

**Pliki:** `tool-access.ts`, `authorization-guard.ts`, `authorization-policy.ts`, `resource-scope.ts`, `run-submissions.ts`, `authorization-guard.test.ts`, `authorization-policy.test.ts`, `run-submissions.http.test.ts`; testy DB i UI macierzy ról.

### 4.1. Grant odczytu submission

1. Dopisać `submission:read → view_results` w `capabilityForPermission`. Test mapowania obejmuje wszystkie permission actions, aby nowy permission nie trafiał milcząco w `null` bez świadomej klasyfikacji.
2. W `RunSubmissionService` dodać `assertCanRead` oddzielone od `assertCanExecute`. Współdzielić wyłącznie sprawdzenie tenanta, narzędzia i zakresu właściciela, nie końcową capability.
3. `get` i `listItems` przełączyć na kontrolę odczytu. POST preview/create nadal sprawdza wykonanie. Odczyt działa w maintenance bez execute; disabled zachowuje ustaloną regułę admin/nonadmin.
4. Dane zwracać dopiero po autoryzacji. Filtry paginacji oraz count/summary muszą działać na tym samym autoryzowanym zbiorze. Nie najpierw pobierać wszystkich elementów i filtrować w UI.
5. Nie dodawać reviewerowi `submission:read` tylko dlatego, że ma `view_results`. Auditor dalej nie ma operacyjnego odczytu.
6. Dla `cancel` przekazać rolę z aktualnego principal do serwisu i ponownie ją sprawdzić przy mutacji. Admin może anulować cudzą partię swojego tenanta; operator wymaga własnego importu oraz zachowanego ograniczenia autorstwa submission, execute i aktualnego stanu narzędzia. Tenant obcy zawsze odmowa. Zachować `expectedVersion` i idempotencję anulowania.
7. UI powinno pokazywać odczyt według view, akcje według execute; przekierowania i przyciski nie zastępują odmowy backendu. Nie usuwać szczegółowego błędu API na rzecz samego ukrywania przycisku.

### 4.2. Bezwarunkowy tenant dla przydziału — C-01

1. Po załadowaniu resource scope sprawdzić `resource.tenantId === principal.tenantId` przed `canPerform` oraz wszystkimi wyjątkami `isAssigned*`.
2. Brak poprawnego tenanta zasobu nie może oznaczać zasobu globalnego. Zasoby celowo globalne muszą mieć osobną, jawną klasyfikację; nie używać fallbacku actor tenant.
3. Dopiero po tej kontroli rozpatrywać rolę, właściciela/przydział, capability i status narzędzia. Spójność run → batch → tool też należy zweryfikować; grant do tool A nie autoryzuje runu tool B.
4. Utrzymać sprawdzanie aktywnego członkostwa assignee w endpointzie assignment. Test guard ma również działać na ręcznie przygotowanych niespójnych danych, niezależnie od kontroli zapisu.
5. Sprawdzić wszystkie wyjątki: odczyt runu, odczyt/mark_read interwencji, wysłanie SMS. Dla każdego przygotować zasób obcego tenanta przypisany do prawidłowego usera z prawidłowym grantem jego tenanta; wszystkie odmowy.
6. Opcjonalne zabezpieczenie DB przygotować jako osobną migrację po kontroli danych. FK do `users` nie dowodzi członkostwa w tenancie. Dla composite FK potrzebne są rzeczywiste kolumny tenant/assignee i klucze unikalne po obu stronach; jeżeli tenant interwencji jest wyliczany przez run/batch, zaprojektować kontrolowane backfill/denormalizację albo trigger. Nie wpisywać niewykonalnego FK między wynikiem join a tabelą.
7. Przed constraint sprawdzić i raportować istniejące niespójności identyfikatorami, bez danych osobowych. Naprawę danych wykonać jawnie; nie usuwać historii automatycznie.

### 4.3. Macierz obowiązkowych testów

Każdą główną klasę endpointów — import/enrichment, submission/run, interwencje/SMS, artefakty, review, audit, admin, sesje — sprawdzić dla czterech ról, właściciela A/innego usera B, tenanta A/B, aktywnego/wyłączonego członkostwa i trzech stanów narzędzia. Kombinacje grantów to wszystkie osiem wariantów trzech flag; nie testować wyłącznie „wszystko” i „nic”.

| Szczególny przypadek | Oczekiwanie |
| --- | --- |
| Operator view=true, execute=false | Odczyt własnej partii 200; create/execute odmowa |
| Operator view=false, execute=true | Ogólny odczyt partii odmowa; dozwolone wykonanie zgodnie z rolą |
| Download=true, view=false | Nie daje ogólnego odczytu; pobranie tylko według odrębnej polityki artefaktu |
| Reviewer z pełnym grantem | Bez startu/SMS/download/admin/submission:read; obecne review pozostaje |
| Auditor z pełnym grantem | Tylko przewidziany audyt, brak operacyjnych danych |
| Admin i cudzy tenant | Odmowa, również przy przydziale |
| Admin i cudza partia w swoim tenancie | Anulowanie zgodne z polityką i wersją |
| Podmienione role/userId/tenantId w body/cookie | Brak wpływu na principal z DB |
| Cofnięta rola/grant po wejściu do guarda | Mutacja nie zatwierdza efektu na podstawie starego snapshotu |

**Odbiór:** poza pozytywnymi testami HTTP trzeba sprawdzać brak zapisu/jobów/plików po odmowie. Brak przycisku nie jest dowodem poprawnej autoryzacji. C-01 pozostaje w dokumentacji ustaleniem warunkowym historycznie; naprawa nie zmienia go w potwierdzony wcześniejszy atak.

## 5. P03 — SEC-03/04: limitowanie uwierzytelnienia

**Pliki:** `login-rate-limiter.ts`, `session.ts`, `http-bootstrap.ts`, `module.ts`, konfiguracja Compose i przykładowe env; nowy `reauth-rate-limiter.ts` lub wspólny `authentication-budget.ts`; rzeczywisty test Redis i proxy.

### 5.1. Kontrakt liczników i algorytm

1. Pozostawić atomowe Lua i HMAC identyfikatorów. Dodać klucz konta niezależny od IP, oparty o kanoniczną normalizację loginu używaną przez wyszukiwanie konta oraz tenant/context logowania. Nie ujawniać loginu/IP w nazwach kluczy.
2. Oddzielić budżet prób od kosztu KDF. Proponowany start: para login/IP 5 prób/15 min; IP 60/15 min; konto 10 prób/15 min z krótkim backoff 1, 2, 4… do 30 sekund po kolejnych niepowodzeniach. Dodać osobny globalny limit równoległych KDF dobrany benchmarkiem. Wszystkie progi są konfigurowalne, walidowane przy starcie.
3. Klucz konta stosować również dla nieistniejących loginów. Nie tworzyć stałej blokady konta ani automatycznie zmieniać `User.status`. Przekroczenie ma wygasać i nie wydłużać blokady bez końca przy każdym odrzuconym żądaniu.
4. Zdefiniować dokładnie zdarzenia: dopuszczenie próby atomowo rezerwuje próbę; failure aktualizuje backoff; sukces może wyczyścić karę konta/pary, ale nie globalny/IP licznik ruchu. Sukces musi być rzeczywistym zatwierdzonym uwierzytelnieniem, nie samą poprawną weryfikacją przed resetem. Rezerwacja nie może ginąć po crashu procesu.
5. Zdefiniować „okno” jako pierwszy zaakceptowany request + TTL, z TTL bez przedłużania przy każdym żądaniu. Lua atomowo ustala/incrementuje wszystkie budżety i zwraca stan oraz czas do dopuszczenia. W razie odmowy nie dopuścić KDF. Użyć czasu Redis dla wspólnego odniesienia między replikami.
6. Zabezpieczyć wyścig failure/success osobną wersją/generacją stanu próby lub atomowym warunkiem: spóźniony sukces nie czyści kar za próby rozpoczęte po nim. Opisać to w kodzie i przetestować przeplot.
7. Account-only limit oznacza ryzyko czasowego utrudnienia loginu ofiary. Ograniczyć czas kar, dodać monitoring i procedurę admin recovery z silnym potwierdzeniem. Ten etap nie daje pełnej ochrony przed celowym lockout; nie obiecywać jej bez dodatkowego czynnika/challenge.
8. Zwracać stałą odpowiedź 429 i `Retry-After` w sekundach, bez informacji, który klucz istniejącego konta spowodował odmowę. Błąd Redis dla uwierzytelnienia oznacza kontrolowane 503 bez KDF/sesji, z ograniczonym timeoutem; nie przejście na procesowy licznik.
9. Zapewnić TTL, ograniczenie długości klucza i namespace wersji algorytmu. Jeżeli Redis Cluster jest planowany, wszystkie klucze jednego Lua muszą być w jednym hash slot albo trzeba zmienić architekturę; obecny jeden Redis nie potwierdza zgodności z Cluster.

### 5.2. Wiarygodne IP i proxy

1. Udokumentować dwa wspierane tryby: lokalny bezpośredni HTTP na loopback z `trust proxy=0`; produkcyjny HTTPS edge → API dla `/api`, edge → Next dla web. Bezpośrednie API produkcyjne jest niedostępne z Internetu.
2. Preferować bezpośrednie przekazanie `/api` przez edge, aby Next rewrite nie zacierał IP. Jeśli pozostaje ścieżka edge → Next → API, ustalić i przetestować wszystkie hop oraz reguły przekazywania nagłówka; nie przyjmować liczby proxy na podstawie przypuszczenia.
3. Edge usuwa nieufne X-Forwarded-For/Forwarded i ustawia własne. API ufa wyłącznie znanym źródłom proxy/CIDR lub sprawdzonej funkcji zaufania. Samo `trust proxy=true` lub dowolny hop nie stanowi zabezpieczenia.
4. Walidować kanoniczne IPv4/IPv6 i IPv4-mapped IPv6. Wybrać jawną politykę agregacji IPv6, np. /64 dla budżetu sieci z dodatkowym per-user, żeby zmiana host bits nie omijała ochrony. Nie blokować klientów wyłącznie przez dowolny nagłówek.
5. Oddzielić tajny klucz HMAC limitera od klucza podpisu sesji przy następnym rozszerzeniu konfiguracji. Rotacja klucza nie może niejawnie wyzerować ochrony podczas ataku; przejściowo respektować poprzedni namespace albo zatrzymać stare repliki i zachować krótkie ochronne ograniczenie edge.
6. Testować rzeczywistą topologię: dwóch klientów ma różne IP; ten sam klient nie zmienia limitu przez fałszywy XFF; direct path jest niedostępny; różna liczba hop nie daje spoofingu. Nie używać wyłącznie mock `request.ip`.

### 5.3. Reauth / zmiana hasła

1. Przed weryfikacją `currentPassword` zastosować wspólny budżet użytkownika obejmujący wszystkie jego sesje, dodatkowy budżet sesji i IP. Przykładowo 5 błędnych prób użytkownika/15 min, 5 sesji/15 min, 30 IP/15 min; kalibracja nie może uczynić nowej sesji sposobem resetowania limitu usera. Przed KDF atomowo rezerwować miejsce także dla prób w toku, aby równoległa seria nie przechodziła przed zapisaniem pierwszego failure.
2. Sprawdzać Session/Origin/CSRF przed rezerwacją user budget, aby anonimowy nie mógł podać dowolnego userId. IP/global mogą działać wcześniej.
3. 429 zwracać przed KDF; sukces zeruje tylko zgodną generację kar reauth. Nie zdejmuje ochrony kosztu/IP. Późniejsze potwierdzenie MFA i step-up użyje tej samej infrastruktury, z odrębnymi progami.
4. Przy błędnym obecnym haśle nie zapisywać poświadczeń, nie zmieniać mustChange i nie wydawać cookie. Limity działają również w trybie `mustChangePassword`.
5. Ograniczyć kolejkę KDF: brak wolnego miejsca powoduje 429/503 według stałego kontraktu, nie nieograniczoną kolejkę w pamięci. Async scrypt nadal zużywa CPU/pamięć/pulę libuv.

### 5.4. Testy P03

1. Na rzeczywistym Redis wysłać równolegle więcej prób niż limit przez dwie instancje API; liczba dopuszczonych nie może przekroczyć budżetu. Sprawdzić TTL, granicę okna i `Retry-After`.
2. Ten sam login z kilkunastu różnych IP trafia w limit konta; zmiana wielkości liter/normalizacji nie tworzy nowego konta liczników.
3. Poprawne loginy wielu osób za NAT nie blokują wszystkich przez błędnie rozpoznane IP web serwera. Realny wspólny NAT pozostaje wspólnym IP; progi i warstwa account muszą zostać sprawdzone na scenariuszu zwykłej pracy.
4. Awaria Redis/timeout skutkuje odmową kosztownej autentykacji, nie 200 i nie nieograniczonym retry. Proces wraca do działania po odzyskaniu Redis bez restartu pętli reconnect.
5. Po osiągnięciu reauth limitu licznik wywołań scrypt pozostaje niezmieniony; druga sesja tego usera też objęta ochroną.
6. Sprawdzić spóźniony sukces/failure, rotację namespace, pusty/oversized login, wiele losowych loginów i brak kluczy zawierających jawne dane.

**Odbiór:** SEC-03 wymaga obu elementów: rozproszonego licznika konta i testu wdrożonej ścieżki IP. SEC-04 wymaga dowodu braku KDF po 429, nie tylko obecności nagłówka.

## 6. P04 — SEC-05/06/09: hasła i nieujawnianie loginów

**Pliki:** `password-hash.ts`, `password-hash.test.ts`, `bootstrap-admin.ts`, `session.ts`, `admin.ts`, `db.ts`, przykładowe env; nowy `password-policy.ts`, rozszerzone testy hasha, nowe testy bootstrap i benchmark.

### 6.1. Wersjonowany format i mocniejszy scrypt — SEC-05

1. Zachować jawny verifier formatu legacy `scrypt$salt$key` z dokładnie dotychczasowymi parametrami N=16384, r=8, p=1 i istniejącym kodowaniem salt/key. Fixture hasha w teście utworzyć przed zmianą; nie generować „starego” hasha nową funkcją.
2. Zdefiniować nowy format, np. `scrypt$v1$N=131072,r=8,p=1$<salt>$<key>`. Wybrać jedno kodowanie, wymagane długości salt=16 bajtów/key=64 bajty, ścisłą liczbę segmentów i maksymalną długość całego zapisu.
3. Parser dopuszcza tylko znane profile. Nie pozwala na dowolne N/r/p, NaN, ujemne wartości, ogromną sól ani alternatywne kodowanie. Nieznany/zepsuty hash kończy się bezpieczną odmową; dla zewnętrznego błędnego loginu wykonać kontrolowany dummy KDF, nie nieograniczony koszt z DB.
4. Docelowy pierwszy profil: N=2^17, r=8, p=1, z `maxmem` powyżej wymaganej pamięci, np. 256 MiB na wywołanie. Alternatywny dopuszczony profil N=2^14,r=8,p=5 można wybrać dopiero po benchmarku i zapisaniu decyzji. Nie obniżać profilu poniżej zaakceptowanego standardu tylko po to, aby utrzymać dawny RPS.
5. Benchmark uruchomić na obrazie/CPU/RAM docelowego runtime: pojedyncza weryfikacja, współbieżność 1/2/4, p50/p95, RSS, obciążenie, czas odpowiedzi innych endpointów. Początkowo ograniczyć KDF do 2 równoległych na instancję; wyższy limit musi mieścić się w RAM z rezerwą dla API/parsera/DB drivera.
6. Dodać `needsRehash` jako czystą funkcję. Nowe hasła zapisuje aktualny writer. Legacy rehash po poprawnym loginie wykonuje CAS z P01 i żadnego plaintext nie odkłada do późniejszego joba.
7. Nie wykonywać masowej konwersji hashy bez hasła. Konta nieaktywne pozostają legacy do kolejnego poprawnego loginu lub kontrolowanego resetu.
8. Rollout w dwóch wydaniach: A czyta legacy+v1, nadal zapisuje legacy; po wymianie wszystkich replik B zapisuje v1. Od tego momentu rollback wyłącznie do wersji czytającej oba formaty. Przełącznik writera nie usuwa już zapisanych v1.
9. Sprawdzić wszystkie writers: bootstrap, admin create/reset, changePassword i test fixtures. Nie dopuścić, aby jedna ścieżka nadal pisała przypadkowo słabszy format.

**Testy:** prawidłowe/błędne hasło legacy i v1, malformed format, za duże parametry, brak alokacji z nieznanego profilu, salt unikalny, stałoczasowe porównanie równych długości, rehash race z resetem, restart/rolling deploy i login starego użytkownika po migracji.

### 6.2. Wspólna polityka i bootstrap — SEC-06

1. Wprowadzić jedną funkcję walidacji nowych haseł używaną przez create/reset/change/bootstrap. Proponowany cel przy braku MFA: minimum 15 znaków; istniejące minimum 14 ujednolicić w API i UI. Maksimum zachować 1024 z dodatkowym jawnym limitem bajtów UTF-8, np. 4096, przed KDF.
2. Zdefiniować „znak” jako Unicode code point i testować znaki wielobajtowe. Nie `trim()` ani nie normalizować samego hasła; spacje są częścią sekretu. Login ma odrębną normalizację.
3. Stare hasła krótsze niż nowa polityka nadal służą do loginu/weryfikacji aktualnego hasła. Polityka dotyczy nadania nowego hasła; nie blokować wszystkich istniejących kont podczas restartu.
4. Odrzucać znane lokalne placeholdery z przykładów oraz oczywiste zakazane hasła według kontrolowanej listy, bez wysyłania plaintext do usługi zewnętrznej. Komunikat podaje warunek, nigdy treść hasła.
5. Bootstrap najpierw ustala, czy seed faktycznie jest potrzebny, pod istniejącą lub nową blokadą bootstrap. Jeśli administrator już istnieje, nie nadpisuje go i nie wymaga resetu tylko dlatego, że w dawnym env jest słaby sekret.
6. Przy pustej bazie brak/niepoprawne hasło powoduje błąd startu z nazwą niespełnionego warunku, bez wartości env. Utworzenie użytkownika, membership i grantów jest atomowe.
7. Pierwszy admin otrzymuje `mustChangePassword=true`. Login do tego konta pozwala wyłącznie na session/self/password-change/logout i niezbędne statusy; nie tworzy pełnego admin dostępu przed zmianą. Zweryfikować, że UI nie zapętla redirect i zmiana jest możliwa.
8. Aktualizacja przykładów env używa placeholdera wymagającego podmiany; sekret przykładowy nie może być automatycznie akceptowany w production. Dokumentacja jasno opisuje pierwszą zmianę, bez przechowywania rzeczywistego hasła.

**Testy:** pusta DB z `x`, 14/15 znaków, 1024/1025 i limit UTF-8, whitespace, brak sekretu, dwa równoległe bootstraps, już istniejący admin, ograniczona sesja mustChange. Nie czytać prywatnych `.env` w teście.

### 6.3. Równa ścieżka błędnej autentykacji — SEC-09

1. Utworzyć jeden poprawny dummy hash aktualnego profilu przy inicjalizacji/konfiguracji testowej. Nie liczyć dummy hasha dla każdego żądania. Nie używać konta rzeczywistego użytkownika.
2. Po limiterze wykonać weryfikację prawdziwego hasha albo dummy dla braku użytkownika/nieprawidłowego rekordu. Gałęzie disabled/brak membership nie mogą zdradzać konta wcześniejszym pominięciem KDF.
3. Dla wszystkich błędnych poświadczeń stosować ten sam status 401, komunikat i strukturę odpowiedzi, bez szczegółów „nie ma użytkownika”, „konto wyłączone” albo „brak tenanta”. Błędy infrastruktury mają oddzielny, stały 503.
4. Pamiętać, że legacy i v1 mogą kosztować inaczej. W okresie migracji benchmarkować tę różnicę; jeśli nadal ujawnia istnienie konta, zaprojektować ograniczone wyrównanie kosztu dla legacy albo szybszą wymuszoną migrację tych kont. Nie twierdzić, że dummy v1 sam zapewnia idealnie stały czas wszystkich starych kont.
5. Test deterministyczny sprawdza liczbę wywołań KDF i odpowiedź. Test czasów porównuje większe próbki na izolowanym runtime i zapisuje rozkład jako dowód pomocniczy; nie używać kruchej asercji „oba żądania mają dokładnie tyle samo ms”.

**Odbiór P04:** brak utraty dostępu legacy, benchmark z budżetem pamięci, bootstrap odmawia słabego hasła w pustej DB, błędne loginy nie mają gałęzi bez KDF poza wcześniejszym limitem/walidacją rozmiaru.

## 7. P05 — SEC-08/10: interwencje, stan narzędzia i przydziały

**Pliki:** `interventions.ts`, `admin.ts`, `tool-access.ts`, `resource-scope.ts`, `authorization-guard.ts`, kod list audytu; nowe testy PostgreSQL list/summary/detail i grantów.

### 7.1. Spójny zakres kolekcji — SEC-08

1. Spisać jeden kontrakt scope: tenant zasobu, zgodność run/batch/tool, rola, owner/assignee, capability, stan narzędzia. Wyprowadzić wspólny builder predykatów SQL z parametrami i odpowiednik kontroli pojedynczego zasobu; nie tworzyć uniwersalnej funkcji pomijającej specyfikę SMS.
2. W zapytaniach list i summary interwencji dołączyć `tools` poprzez rzeczywisty tool runu/importu. Wymagać zgodności ich identyfikatorów. Dla nieadmina dodać `status <> 'disabled'`; dla admina zachować tenant i możliwość odczytu disabled. `maintenance` pozostaje do odczytu.
3. Predykat zastosować przed paginacją/agregacją. Count, summary, lista i szczegóły muszą używać tego samego zakresu. Parametry użytkownika mogą być wartościami bind/replacements; nazwa kolumny i ORDER BY wybierane wyłącznie z allowlist kodu.
4. Zachować ograniczony wyjątek SMS: operator z execute może otrzymać minimalne metadane własnego/przypisanego wyzwania, jeżeli są potrzebne do jego obsługi. Nie dodawać przez to ogólnego `view_results`, odczytu polis, artefaktów czy innych typów interwencji.
5. Dla tego wyjątku dopasować detail/mark_read do listy: klasyfikacja zasobu jako SMS, tenant i owner/assignee, execute oraz tool available dla działania. Odczyt niezbędnych metadanych w maintenance musi być jawnie rozstrzygnięty; przyjąć odczyt do diagnostyki, ale bez submit. Guard nie może wymagać view dla minimalnego SMS i równocześnie pozwalać execute-only zobaczyć pozycję bez możliwości jej otwarcia.
6. Identity review i portal error nadal wymagają odczytu oraz odpowiedniej roli/zakresu. Sama obecność przydziału nie nadaje prawa do zatwierdzania korekt ani wykonywania funkcji admina.
7. Sprawdzić analogiczne kolekcje audytu reviewera, history, review i enrichment. Reviewer nie powinien otrzymywać operacyjnych zdarzeń wyłączonego narzędzia tylko dzięki zachowanemu grantowi. Auditor zachowuje tenantowy audyt według swojej polityki, a admin pełny audyt tenanta.
8. W testach tworzyć rzeczywiste rekordy DB i trzy statusy tego samego tool. Dla listy i summary porównywać również totals, challenge IDs i następny cursor. Brak elementu w liście przy nadal ujawniającym count oznacza nieukończoną naprawę.
9. Sprawdzić plan zapytań i indeksy na reprezentatywnej liczbie syntetycznych rekordów. Nie usuwać predykatu bezpieczeństwa dla poprawienia czasu; w razie potrzeby dodać indeks/migrację.

**Odbiór SEC-08:** nonadmin nie otrzymuje żadnych operacyjnych metadanych disabled tool w każdej ścieżce, admin ma prawidłowy odczyt tenanta, maintenance działa zgodnie z kontraktem, wyjątek SMS nie rozszerza ogólnych praw.

### 7.2. Prawidłowe wyliczenie utraty grantu — SEC-10

1. Przed mutacją instancji Sequelize zrobić niemutowalny snapshot poprzednich flag, np. plain boolean fields. Nie używać drugiej referencji do tego samego modelu jako „before”.
2. Pod właściwymi blokadami z P01 sprawdzić aktywnego admina i celu, tenant/tool, aktualną wersję grantu oraz `expectedVersion`. Stary formularz dostaje 409 i nie powoduje cofnięć przydziału.
3. Obliczyć różnice `old=true && new=false` przed `Object.assign`/save. Podwyższenie praw albo identyczny zapis nie powinny zdejmować przydziałów.
4. Wprowadzić wspólną funkcję wymagań capability dla rodzaju interwencji, zgodną z `canAssignIntervention` i rzeczywistym odczytem/akcją. SMS wymaga execute; identity_review/portal_error wymagają view i właściwej roli. Download sam nie autoryzuje żadnego przydziału.
5. Po zmianie grantu ponownie ocenić możliwość zachowania każdego otwartego przydziału celu dla danego tenant/tool. Utrata execute usuwa SMS; utrata view usuwa interwencje wymagające view, ale nie automatycznie SMS, jeśli execute wystarcza i pozostaje. Całkowite revoke usuwa wszystkie niedozwolone przydziały.
6. Zapisać grant, zwiększenie wersji, zdjęcie właściwych przydziałów i zdarzenia activity/audit w jednej transakcji. Zapis audytu ma zawierać flagi before/after i liczbę zdjętych przydziałów, bez opisów danych osobowych.
7. Historycznych zamkniętych interwencji nie przepisywać. Jeśli potrzebny jest cleanup istniejących otwartych przydziałów, przygotować idempotentne narzędzie dry-run: lista tenant/tool/ID i powód; następnie osobne wykonanie z aktualnym reread i audit. Nie kasować historii.
8. Testować prawdziwą instancję Sequelize, nie model zwracający nowe obiekty po każdej operacji. Równoległe assign i revoke muszą skończyć bez niedozwolonego przydziału, według wspólnego porządku blokad.

| Zmiana grantu | Przydziały do sprawdzenia |
| --- | --- |
| execute true→false, view pozostaje | SMS zdjęty; interwencje czytelne według roli pozostają |
| view true→false, execute pozostaje | Review/error zdjęte; SMS pozostaje tylko zgodnie z minimalnym wyjątkiem |
| download true→false | Bez automatycznego usunięcia przydziałów opartych o view/execute |
| Wszystkie flagi→false lub revoke | Wszystkie otwarte przydziały wymagające tego tool zdjęte |
| Podwyższenie/bez zmian | Brak zdjęcia |
| Ten sam user w tenant B/tool B | Brak zmian w B |
| Błąd audit/save/konflikt wersji | Pełny rollback, bez częściowego zdjęcia |

**Odbiór SEC-10:** test pokazuje rzeczywistą utratę flag na tym samym modelu i właściwe activity records; liczba cofniętych przydziałów odpowiada kontraktowi capability.

## 8. P06 — SEC-07: ograniczenie kosztu HTTP i XLSX

**Pliki:** `http-bootstrap.ts`, `module.ts`, `health.ts`, `imports.ts`, `workbook.ts`, endpointy list/raportów/artifacts i worker callback; nowe moduły budget/probe/parser oraz testy limitów.

### 8.1. Dwie warstwy limitowania API

1. Zinwentaryzować trasy i nadać klasy kosztu: auth/reauth, zwykły odczyt, paginacja/preview, upload/parse, raport/pobranie, mutacja/start, internal-worker, health. Brak metadanych nowej trasy powinien uruchamiać bezpieczny limit domyślny, nie pełne zwolnienie.
2. Wczesny middleware IP/global działa przed parserem body. Guard Nest uruchamiany po parsowaniu sam nie chroni przed kosztem przyjęcia JSON/multipart. Edge ma dodatkowe limity rozmiaru i połączeń, lecz API egzekwuje własne kontrakty.
3. Warstwa po SessionGuard ogranicza user/tenant oraz klasę endpointu, przed kosztownym query i przed `FileInterceptor`. Nie odczytuje userId/tenant z body. Mutacje nadal wymagają Origin/CSRF.
4. Startowe progi do kalibracji: zwykły read 120/min/user, preview/list 30/min/user, upload 5/10 min/user i 20/10 min/tenant, raport 5/min/user, mutacje 30/min/user. IP ma wyższy limit dopasowany do NAT. Limity biznesowe runów pozostają niezależne i nadal obowiązują.
5. Użyć atomowych liczników Redis, wspólnych dla replik. Awaria zależności ma jasną politykę per klasa: auth/upload/mutacje kosztowne odmawiają 503; read może korzystać wyłącznie z jawnie zaprojektowanego ograniczonego trybu awaryjnego, który nie daje nieograniczonego dostępu. Domyślnie odmowa.
6. Dodać kontrolę współbieżności kosztownych operacji, z ograniczoną kolejką lub natychmiastową 429. Token/lease w Redis ma TTL, właściciela, bezpieczne zwolnienie tylko przez właściciela i ewentualny heartbeat. KDF dodatkowo ma limit lokalnej pamięci procesu. Crash nie może blokować budżetu na zawsze.
7. Dla worker callback zachować Bearer, walidację active execution i istniejący kontrakt Origin. Nadać budżet usługi/runu i osobny body limit 5 MiB; zwykłe JSON pozostają 100 KiB. Nie wyłączać wszystkich zabezpieczeń dla ścieżek zaczynających się od `internal`.
8. Dla paginacji ograniczyć page size, długość/format cursor i czas query. Dla download/report ograniczyć generowanie, rozmiar i concurrency; uwzględnić przerwanie połączenia i streaming/backpressure.
9. Wszystkie 429 mają `Retry-After` i nie zawierają sekretów. Nie umożliwiać zwolnienia z limitu przez dowolny nagłówek „monitor/internal”.

### 8.2. Readiness/liveness

1. Publiczny liveness powinien potwierdzać działanie procesu bez tworzenia nowych połączeń DB/Redis. Nie przekazywać wersji zależności, adresów i szczegółów wyjątków.
2. Readiness zachowuje sprawdzenie zależności, ale korzysta ze współdzielonego klienta Redis z kontrolowanym reconnect i timeout. Zamyka klienta przy shutdown; nie tworzy klienta dla każdego requestu.
3. Wynik readiness cache przez startowe 3 sekundy. Równoległe odczyty wspólnego nieaktualnego wyniku uruchamiają jeden probe na instancję API przez single-flight. Liczba probe przy wielu replikach pozostaje ograniczona ich liczbą; nie zakładać jednego globalnego probe bez wspólnego koordynatora. Zdefiniować maksymalny wiek dobrego wyniku, np. 5 sekund; po nim nie podawać stale „ready” bez ponownego sprawdzenia.
4. Niepowodzenie/timeout daje 503 i krótko cache'owany stan down. Probe ma deadline, np. 2 sekundy, bez nieograniczonego retry. Rzeczywistą wartość dopasować do healthcheck Compose, aby nie wywołać restart storm.
5. Szczegółowa diagnoza dependency/heartbeat jest dostępna w sieci monitoringu albo dla admina, zgodnie z osobną kontrolą. Minimalne readiness może pozostać publiczne, jeśli jest potrzebne edge, ale pod własnym budżetem.
6. Automatyzacje/enrichment mają odrębny stan heartbeat z bounded query. Nie zastępować kontroli zdrowia workera samym ping DB i nie kasować istniejących testów enrichment health.
7. Test jednej instancji: 65 równoległych odczytów w jednym oknie → jeden komplet probe, nie 65 nowych klientów. Po TTL nowy probe; down nie daje fałszywego 200; timeout nie blokuje procesu. Przy wielu replikach oczekiwać najwyżej jednego kompletu na replikę/okno.

### 8.3. Bezpieczna ścieżka importu XLSX

1. Ustawić limity upload przed buforowaniem: jeden plik, 16 MiB compressed, skończona liczba pól/parts i maksymalna długość pól. Sprawdzić rzeczywisty typ kontenera ZIP/XLSX, nie tylko rozszerzenie lub MIME przysłane przez klienta. Nadmiar → 413.
2. Przyjąć plik do katalogu tymczasowego z losową nazwą i ograniczonymi uprawnieniami; ścieżka nie pochodzi z nazwy pliku. Katalog nie jest publiczny, nie pozwala na wykonanie i jest sprzątany po sukcesie, błędzie, timeout, disconnect oraz starcie po crashu.
3. Przed ExcelJS wykonać kontrolę ZIP przy strumieniowym rozpakowywaniu. Startowe granice: 64 MiB faktycznie rozpakowanych danych, 512 entries, 32 MiB na pojedynczy XML, ratio 100:1 po sensownym minimalnym rozmiarze. Wartości sprawdzić na normalnych arkuszach; sam ratio nie jest wystarczającą ochroną.
4. Liczyć faktyczne odczytane bajty. Nie ufać rozmiarom z central directory; przerwać decompression natychmiast po limicie. Odrzucić path traversal, duplikaty/niejednoznaczne nazwy, szyfrowane/nested archiwa oraz nieobsługiwane struktury.
5. Parser XML nie rozwiązuje zewnętrznych encji/DTD i nie pobiera external relationships. Nie wykonywać makr/formuł. Wartości formuł w polach identyfikatorów pozostają niedozwolone zgodnie z obecną walidacją; nie zastępować ich ślepo cached result.
6. Ustalić limity semantyczne niezależne od ZIP: startowo 10 arkuszy, 10 000 wierszy, 200 000 komórek, 32 KiB tekstu pojedynczej komórki. Liczyć strumieniowo elementy XML, również shared strings, przed pełną alokacją modelu ExcelJS, a następnie zweryfikować wynik. Granice mają dotyczyć faktycznej liczby elementów, a nie deklarowanego `dimension` arkusza. Nie mylić ich z obecnym limitem 500 wierszy partii submission.
7. Rozpakowanie i parser uruchomić w osobnym procesie z limitem pamięci i deadline, np. 10 sekund oraz 256 MiB jako punkt startowy. Sam `Promise.race` nie zatrzymuje CPU; po deadline zakończyć proces. Sam `worker_threads.resourceLimits` nie ogranicza całej pamięci zewnętrznych Buffer; w runtime potrzebna izolacja procesu/OS/container i limit współbieżności.
8. Wszystkie etapy decompression/parsing muszą podlegać deadline, nie tylko końcowy ExcelJS. IPC akceptuje tylko walidowany wynik o ograniczonym rozmiarze, nie arbitralne obiekty/ścieżki z child.
9. Zapis importu rozpocząć po walidacji kompletnego wyniku i autoryzacji aktualnego user/grantu. Błąd parsera nie tworzy częściowych batch/rows. Jeżeli zapis jest etapowy, użyć staging i atomowego przełączenia po walidacji.
10. Rozróżnić błędy: przekroczenie rozmiaru/zasobów → 413 `import_limits_exceeded`; niepoprawny workbook → 422 `invalid_workbook`; deadline parsera → 422 `import_parse_timeout`; zajęty budżet → 429. Tekst nie ujawnia lokalnych ścieżek, stack trace ani danych komórek.
11. Testować legalny duży import oraz małe kontrolowane fixture przekraczające poszczególne progi. Nie tworzyć ogromnej bomby ZIP w zwykłym CI ani uruchomionej aplikacji użytkownika. Obniżenie limitów w konfiguracji testu pozwala sprawdzić zatrzymanie decompression małym plikiem.
12. Zmierzyć RSS i CPU przy kilku równoległych uploadach; upewnić się, że po zakończeniu/kill wracają do normalnego poziomu, tokeny i pliki są zwolnione, a API obsługuje zwykłe requesty.

**Odbiór SEC-07:** limity egzekwowane przed właściwym kosztem, nowy Redis test multi-replica, pojedynczy cached probe, ograniczony parser kończony faktycznie po deadline, brak częściowych danych/wycieków plików. Sam limit 16 MiB lub samo 429 w kontrolerze nie zamyka ustalenia.

## 9. P07 — CSP, cache oraz regresje JS/SQL injection

**Pliki:** `apps/web/next.config.ts`, nowy `apps/web/proxy.ts`, layout/strony wymagające dynamic renderingu, `apps/api/src/http-bootstrap.ts`, testy web i endpointów. Przed kodowaniem przeczytać instrukcję `apps/web/AGENTS.md` i przewodnik CSP z dokumentacji zainstalowanego Next.

### 9.1. CSP i clickjacking

1. Zinwentaryzować faktycznie używane źródła skryptów, stylów, obrazów, fontów i połączeń. Obecny panel nie uzasadnia dodawania `*`, zewnętrznych CDN ani dowolnego `https:` do script-src.
2. Zastosować per-request kryptograficzny nonce w Next `proxy.ts`. Ustawić CSP zarówno w przekazanych request headers, aby Next przypisał nonce do swoich skryptów, jak i w response. Przekazać nonce kontrolowanym komponentom Script. Stały nonce w `next.config.ts` nie jest rozwiązaniem.
3. Strony korzystające z nonce muszą być renderowane dynamicznie zgodnie z aktualną dokumentacją Next, np. przez `connection()` w odpowiednim miejscu. Nie cache'ować HTML z nonce między użytkownikami/żądaniami. Sprawdzić App Router, prefetch i client navigation.
4. Matcher obejmuje dokumenty panelu/logowania; omija `_next/static`, `_next/image` i API/upload. Middleware proxy nie może podwójnie buforować dużych importów. `proxyClientMaxBodySize` Next nie zastępuje twardej odmowy 413 API.
5. Startowa polityka produkcyjna: `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'`. Dodać image/font/style wyłącznie według zinwentaryzowanych potrzeb. `upgrade-insecure-requests` tylko w wdrożeniu HTTPS.
6. W production script-src nie zawiera `unsafe-inline` ani `unsafe-eval`. Dev może wymagać `unsafe-eval` dla narzędzi Next, ale konfiguracja jest wyraźnie ograniczona do development i test potwierdza brak dyrektywy w buildzie produkcyjnym.
7. Inline style attributes React/animacji nie uzyskują nonce tak jak style elements. Najpierw ograniczyć je/przenieść do CSS. Jeżeli pozostaną konieczne, jawnie dopuścić `style-src-attr 'unsafe-inline'` przy restrykcyjnej polityce skryptów i osobnym `style-src-elem` z nonce. Nie opisywać takiej konfiguracji jako całkowitego zakazu inline styles.
8. Dodać `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` i kontrolowany Referrer-Policy. HSTS konfigurować na HTTPS edge po weryfikacji domen; nie włączać automatycznie includeSubDomains/preload dla nieprzejrzanej domeny.
9. W staging uruchomić CSP Report-Only i zebrać bounded raporty. Endpoint raportowania ma mały body limit, własny rate limit i usuwa query/PII z URL. Po przejściu testów włączyć enforce; Report-Only sam nie blokuje XSS.
10. Przeglądarkowy odbiór obejmuje login, mustChange, panel każdej roli, import, review, modal/SMS, admin, download i nawigację. Brak błędów hydration i potrzebnych blokad w console; wstrzyknięty inline script/event handler jest blokowany; próba iframe z drugiego lokalnego origin nie osadza panelu.

### 9.2. Prywatne odpowiedzi i sesja w UI

1. Wczesny middleware API ustawia `Cache-Control: private, no-store` dla odpowiedzi sesji i danych użytkownika/operacyjnych, również 401/403/404 i błędów mutacji. Nie polegać na tym, że kontroler błędu wykona dekorator nagłówka.
2. Zachować bardziej restrykcyjne istniejące nagłówki artefaktów/SMS, Content-Type i Content-Disposition. `Vary: Cookie` może być dodatkowe, ale nie zastępuje no-store.
3. Publiczny liveness ma własną jawną politykę, niezależną od prywatnych danych. Publiczne statyczne zasoby web nadal mogą być cache'owane zgodnie z hashem pliku.
4. Edge/CDN nie cache'uje prywatnych `/api` ani HTML sesji. Testować odpowiedź rzeczywistego edge, nie wyłącznie lokalnego kontrolera. Upewnić się, że Next server fetch/cache nie współdzieli danych principal między requestami.
5. Po logout/cross-tab revoke UI czyści stan wrażliwych danych i reaguje na 401. Nawigacja back może odtworzyć pamięć/bfcache; no-store nie stanowi samodzielnego dowodu usunięcia stanu. Na powrót do chronionej strony ponownie potwierdzić sesję i usunąć dane przy odmowie.
6. Test dwóch kolejnych użytkowników w tym samym browser context oraz dwóch odrębnych sesji przez proxy: odpowiedź/HTML/cache użytkownika A nie trafia do B. Test obejmuje logout → back i odświeżenie.

### 9.3. Regresje JS injection / stored XSS

1. Przygotować payloady jako syntetyczne wartości nazw firm, loginów, powodów błędu/korekty, danych XLSX i odpowiedzi providerów: tag HTML, cudzysłowy, event handlers, zamknięcie script, `javascript:` oraz Unicode. Nie uruchamiać ich na rzeczywistych portalach.
2. Wprowadzić wartości przez rzeczywiste API/parser fixture i otworzyć wszystkie miejsca ich prezentacji: workspace, review, historia, interwencje, audit i admin. Testować tekst/DOM, brak dialogów, brak nowych requestów do kontrolowanego adresu i brak zmiany globalnego znacznika JS.
3. Nie zastępować escapowania React ręcznym „usuwaniem znaków”. W razie przyszłej potrzeby HTML wymagać osobnego, sprawdzonego sanitizera i allowlist. `sanitizePublicOutput` nie jest sanitizerem HTML.
4. Testować linki/returnTo: względny dozwolony adres, `//host`, backslash, encoded separators, obcy origin i `javascript:`. Po odbiorze dozwolone linki nadal działają, a odrzucone nie nawigują poza aplikację.
5. Dodać prostą kontrolę nowych niebezpiecznych sinków (`dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, `srcDoc`) jako sygnał review. Wyjątki muszą mieć opis przepływu danych; wyszukiwanie tekstu nie jest pełną analizą taint.

### 9.4. Regresje SQL injection

1. Zinwentaryzować wszystkie raw queries API/workerów i dynamiczne sort/filter fragmenty. Dla każdej wartości wskazać ORM/bind/replacements. Składnię SQL wybierać tylko z dozwolonych fragmentów kodu.
2. Przez HTTP na izolowanym PostgreSQL sprawdzić filtry historii, audytu, review/interwencji i identyfikatory: apostrofy, komentarze, boolean payload, encodings, `%`/`_` dla LIKE oraz niepoprawne cursor/sort. Użyć danych w dwóch tenantach, aby wykryć przypadkowe rozszerzenie zakresu.
3. Payload ma być traktowany jako wartość albo odrzucony 400. Nie może zmieniać zbioru poza semantyką filtra ani wykonywać drugiego statementu. Sprawdzić zawartość tabel i log błędów bez ujawniania payloadu z danymi wrażliwymi.
4. Nie stosować realnego `pg_sleep`/destrukcyjnego payloadu poza małym izolowanym testem z timeout; do odbioru zwykle wystarczy kontrola wartości, zakresu i braku dodatkowego statementu.
5. Brak potwierdzonego injection w audycie nie uzasadnia przebudowy poprawnych zapytań na konkatenację ani nowego własnego escapera. Każda zmiana query z P02/P05 musi zachować parametryzację.

**Odbiór P07:** enforce CSP w produkcyjnym buildzie, negatywny iframe/inline-script test, nagłówki również na błędach, rzeczywiste stored-XSS i SQL-filter testy. Wynik brzmi „brak injection w sprawdzonych scenariuszach”, nie gwarancja braku każdej możliwej podatności.

## 10. P08 — audyt odmów i obserwowalność

**Pliki:** `audit.ts`, migracje ograniczeń action/resource types, moduły auth/budget, konfiguracja logów i metryk; dokument procedur reagowania.

1. Zdefiniować katalog zdarzeń: login failed/succeeded, throttled, reauth failed/succeeded, credential conflict, session revoked, grant denied/changed, import rejected/timeout, probe down oraz zdarzenia MFA z P09. Dla każdego określić actor nullable, tenant, resource i dozwolone metadata.
2. `login.failed` już istnieje w typach; zacząć go rzeczywiście wywoływać. Dla nowych action zaktualizować zarówno TypeScript union, jak i pełny CHECK constraint w DB. Nie usuwać poprzednich dozwolonych actions w nowej migracji.
3. Anonimowy login nie wskazuje dowolnego istniejącego userId w audit. Tenant pochodzi z kontekstu logowania aplikacji, nie z dowolnego body. Gdy tenant nie jest znany, użyć ograniczonego logu/metryki systemowej; nie dopasowywać go przez ujawniające konto wyszukiwanie.
4. Nigdy nie zapisywać haseł, hashy, cookie, CSRF, OTP, SMS, sekretów providerów, pełnego payloadu importu ani URL z PII. Respektować istniejący filtr sensitive keys; nazwy nowych metadata nie mogą go omijać przez pozornie bezpieczne aliasy.
5. Do korelacji używać requestId i HMAC fingerprint o ograniczonej retencji. W metrykach nie stosować raw login/IP ani unbounded userId jako labels; pozwoliłoby to atakującemu generować kardynalność.
6. Zdarzenia masowych odmów agregować/próbkować w ograniczonym oknie; nie wykonywać INSERT dla każdego requestu anonimowego atakującego. Zdarzenia administracyjnych mutacji zapisywać kompletne, transakcyjnie i bez próbkowania.
7. Awaria logowania telemetrycznego nie zmienia odmowy w sukces. Dla wymaganych audit records mutacji admin/hasła błąd powoduje rollback zgodnie z dotychczasowym kontraktem. Dla błędnych anonimowych loginów nie wywoływać lawiny retry DB.
8. Ustalić alerty: wzrost failures konta z wielu IP, wzrost 429/503 auth, credential conflicts, readiness down, import kill/RSS, zmiany admin/grant. Startowe progi oprzeć o baseline normalnego ruchu; alert posiada ograniczenie częstotliwości i deduplikację.
9. Przygotować lokalny dashboard/raport i runbook: jak cofnąć sesje, sprawdzić audit i odizolować usługę. Integracja wysyłająca email/Slack wymaga osobnego zakresu/autoryzacji; plan nie wysyła wiadomości.
10. Testy logów przechwytują syntetyczne sekrety i sprawdzają ich nieobecność w JSON/stack/metadata. Test pod obciążeniem potwierdza bounded liczbę insertów/labels i prawidłowe zdarzenie po odmowie.

**Odbiór:** odmowy dają użyteczne ślady, metadata przechodzi filtr DB/aplikacji, flood nie tworzy nieograniczonego audytu, żaden syntetyczny sekret nie pojawia się w dowodach.

## 11. P09 — ponowna autentykacja, MFA i bezczynność

To wzmocnienie z audytu, a nie naprawa odtworzonego obejścia MFA. Proponowany wariant wykonawczy: TOTP dla adminów, z recovery codes i świeżym step-up dla operacji uprzywilejowanych. Jeżeli organizacja wybierze istniejące SSO/passkeys, trzeba zastąpić poniższy mechanizm równoważnym kontraktem; nie implementować dwóch niepowiązanych systemów.

**Pliki:** `session.ts` (odczyt sesji i SessionGuard), `session-auth.test.ts`, `admin.ts`, `audit.ts`, `db.ts`, migracje; nowe moduły MFA/step-up, endpointy i ekrany security. SMS portalu nie jest MFA panelu.

### 11.1. Step-up i sesja

1. Dodać do sesji `last_reauthenticated_at` oraz sposób potwierdzenia, zapisywane wyłącznie przez backend. Żądanie nie może ustawić timestampu w body/cookie.
2. Potwierdzenie wymaga aktualnej sesji/credential revision, Origin/CSRF, limitera P03, hasła i — po aktywacji — drugiego czynnika. Zapis świeżości następuje transakcyjnie, pod bramką użytkownika.
3. Świeżość startowo 5 minut dla resetu hasła innych kont, zmian ról/grantów, wyłączenia kont i zarządzania MFA. Każdy endpoint ma jawny guard i ponowną kontrolę przy commit. Sam świeży login hasłem bez wymaganego MFA nie spełnia pełnego step-up.
4. Brak świeżego potwierdzenia → 403 z kodem `reauthentication_required`, pozwalającym UI otworzyć formularz. Nie wykonywać części mutacji przed tym wynikiem. Po udanym step-up ponowienie mutation respektuje `expectedVersion`/idempotency.
5. Dodać idle timeout startowo 30 minut, zachowując absolute lifetime 8 godzin. Najpierw sprawdzić idle expiry względem dotychczasowego last_seen, dopiero potem go aktualizować. Background polling nie powinien bez końca udawać aktywności użytkownika; rozdzielić `last_seen` techniczne i `last_activity` zgodnie z jawną polityką.
6. Dla idle expiry cofnąć sesję z poprawnym powodem; rozszerzyć CHECK `revoke_reason`, jeśli dodawany jest nowy. Aktualizacje last_activity można agregować, ale nie dopuścić do nieograniczonego przesunięcia granicy na skutek opóźnionego zapisu.

### 11.2. Enrollment TOTP

1. Dodać oddzielny stan pending/active MFA. Tajny seed generować kryptograficznie i szyfrować AEAD z osobnym kluczem/key version, z userId jako związanym kontekstem. Klucz nie jest SESSION_SECRET ani jawne env w repo; przygotować procedurę rotacji.
2. Enrollment wymaga świeżego step-up hasłem, aktywnej sesji i CSRF. QR/seed pokazać tylko w tej procedurze, z no-store; nie logować ani umieszczać w query URL.
3. Pending seed wygasa np. po 10 minutach i nie włącza MFA przed weryfikacją poprawnego kodu. Nowe enrollment zastępuje stare pending, nie aktywny czynnik bez potwierdzenia.
4. TOTP zgodny z RFC 6238: uzgodniony algorytm biblioteki, krok 30 sekund, okno tolerancji ±1 krok. Bibliotekę wybrać po przeglądzie utrzymania/API; nie pisać własnej kryptografii.
5. Zapisywać zaakceptowany krok i atomowo odrzucać ponowne użycie. Przy dwóch równoległych requestach z tym samym OTP tylko jeden może przejść. Ograniczyć przesunięcie zegara; nie przyjmować dowolnego timestampu klienta.
6. Po aktywacji wygenerować np. 10 recovery codes, każdy o co najmniej 128 bitach losowości. Pokazać je raz, przechowywać tylko skróty oraz status użycia. Użycie kodu jest jednorazową atomową operacją; regeneracja unieważnia poprzednie.
7. Zmiana/wyłączenie MFA wymaga świeżego istniejącego drugiego czynnika lub formalnej procedury odzyskania przez uprawnionego admina. Cofnąć stare/pending sesje i zapisać audit; sama znajomość hasła nie może usuwać MFA po jego aktywacji.

### 11.3. Login z drugim czynnikiem i recovery

1. Po poprawnym haśle dla MFA usera nie wydawać zwykłej sesji. Utworzyć ograniczony pending challenge z losowym identyfikatorem, hashem identyfikatora w DB, TTL np. 5 minut i snapshot credential revision/tenant/user.
2. Pending cookie HttpOnly/Secure/SameSite nie jest akceptowane przez SessionGuard. Posiada wyłącznie endpoint verify/cancel, kontrolę Origin i własny mechanizm CSRF związany z challenge. Nie przyjmować userId/tokenu z query.
3. Verify ma limit user/challenge/IP/global. Przed wydaniem sesji reread user/status/member/revision i challenge, atomowo skonsumować challenge oraz kod/krok. Reset/revoke w toku unieważnia pending; challenge nie może wydać sesji po zatwierdzonym resecie.
4. Nowa pełna sesja ma zarejestrowany drugi czynnik i świeżość. Nie odtwarzać trwającej sesji po wygaśnięciu pending na podstawie samego cookie.
5. Recovery code podlega tym samym limitom, jednorazowości i reread. Błędy OTP/kodu/challenge mają jednolity komunikat bez sekretów. Logi nie zawierają seed ani kodu.
6. Przed obowiązkowym MFA przygotować przynajmniej dwóch adminów z działającym czynnikiem, wydrukowaną/zabezpieczoną procedurą recovery i próbą odzyskania na staging. Włączać przez okres enrollment, następnie enforcement; nie blokować jedynego admina bez procedury.
7. Testy obejmują clock boundary, zły/ponowny OTP, równoległe użycie, expired challenge, reset podczas pending, downgrade factor, dwa recovery requests, kradzież pending cookie, brak step-up i idle boundary.

**Odbiór P09:** hasło nie daje pełnej sesji MFA usera, pending nie autoryzuje API, replay nie przechodzi, operacje admin wymagają świeżego potwierdzenia, recovery działa bez nieformalnego obejścia.

## 12. P10 — produkcyjne wdrożenie i najmniejsze uprawnienia

**Pliki:** `compose.yaml`, nowy overlay produkcyjny, Dockerfile usług, `http-bootstrap.ts`, `migrate.ts`, konfiguracja env/preflight i instrukcja wdrożenia. Lokalny Compose pozostaje osobnym trybem; sam fakt HTTP loopback nie jest dowodem podatnego produkcyjnego wdrożenia.

### 12.1. Edge, TLS i sekrety

1. Utworzyć jawny profil produkcyjny z `NODE_ENV=production`, HTTPS i dokładnym `PUBLIC_APP_ORIGIN`. Origin nie może być wyliczany z kontrolowanego przez klienta Host/X-Forwarded-Host.
2. Edge terminujący TLS kieruje `/api` do API, pozostałe ścieżki do web, zgodnie z P03. Ogranicza body/connection/timeouts, usuwa nieufne forwarding headers i ustawia własne. Nie publikuje internal-worker endpoints na zewnątrz.
3. API/worker/enrichment/PostgreSQL/Redis nie mają publicznych ports. Sieci rozdzielić według potrzeb; dostęp edge do API nie powinien dawać dostępu do DB. Usługa worker internal jest dostępna wyłącznie API po uwierzytelnieniu.
4. Sprawdzić po prawdziwym HTTPS: HttpOnly, Secure, SameSite=Strict, scope Path/Domain, Origin/CSRF, cookie expiry i brak sesji po cofnięciu. Nie wystarczy odczytać warunek `NODE_ENV` z kodu.
5. Walidacja produkcyjna odmawia startu bez wymaganych silnych, odrębnych sekretów. Zawiera nazwy wymaganych ustawień, nigdy ich wartości. Sekrety przechowywać w mechanizmie deployment secrets lub chronionych plikach, nie w Git/obrazie.
6. Nie publikować dev servera ani diagnostycznych stack traces. Katalogi eksportów, staging i profili workerów nie są publicznym root web. Kontenery mają użytkownika bez uprawnień root tam, gdzie pozwala runtime; zapis tylko do niezbędnych volumes/tmp.
7. Rotację session/worker/DB/Redis/MFA kluczy opisać osobno: które sesje/challenges/jobs wygasną, okres zgodności czytnika, wymiana wszystkich replik, test odzyskania. Nie zmieniać klucza szyfrowania danych bez zachowania kluczy historycznych i migracji.
8. Test black-box ze staging sprawdza publiczne porty, spoof XFF, cookies, nagłówki cache/CSP i odmowę internal route. Testy obciążenia/fault injection nadal wyłącznie na izolowanych danych.

### 12.2. PostgreSQL: migrator i runtime

1. Zinwentaryzować tabele/sekwencje/funkcje wykorzystywane przez API, worker i enrichment. Worker zapisuje bezpośrednio do DB; nie zakładać, że potrzebuje tylko SELECT.
2. Utworzyć konto właściciela/migracyjne do DDL i osobne konta runtime API/worker/enrichment bez SUPERUSER, CREATEDB, CREATEROLE, uprawnień do schematów systemowych ani dowolnego tworzenia funkcji.
3. Przenieść `node .../migrate.js` z komendy startu API do osobnego jednorazowego zadania migracyjnego, wykonanego przed uruchomieniem nowych usług. Runtime nie otrzymuje hasła migratora. Zablokować równoległe migracje.
4. Nadać konkretne prawa DML i USAGE sekwencji/schematu. `ALTER DEFAULT PRIVILEGES` ustawić dla rzeczywistego właściciela tworzącego przyszłe obiekty; nie pomijać istniejących tabel. Usunąć zbędne PUBLIC privileges i kontrolować search_path.
5. Audit powinien mieć INSERT/SELECT według potrzeb, bez UPDATE/DELETE dla runtime, jeżeli obecne ścieżki tego nie wymagają. Funkcje SECURITY DEFINER, jeśli użyte, muszą mieć przypięty search_path, minimalnego właściciela i ściśle ograniczone EXECUTE.
6. Na staging uruchomić wszystkie legalne ścieżki na nowych kontach: import, kolejka/outbox, session/admin, audit/report, enrichment, artifact i migrator. Portale korzystają z fixture. Brak uprawnień w legalnej ścieżce jest błędem planu grantów, nie powodem do przywrócenia superuser runtime.
7. Negatywne testy runtime: CREATE/DROP/ALTER, zmiana ról i UPDATE/DELETE audit odmawiają. Nie wykonują realnie destrukcyjnej operacji na produkcji.
8. Rozdzielenie kont ogranicza skutki kompromitacji, ale nie daje samo tenant isolation w DB. Wprowadzenie RLS wymaga osobnej analizy połączeń/pool i nie jest udawane przez te granty.

### 12.3. Redis ACL i izolacja

1. Ustalić namespaces: auth/reauth/API budgets, sesje/pending jeśli użyte, cache, BullMQ i worker. Oddzielić użytkowników ACL usług według rzeczywistych potrzeb kluczy/commands.
2. Włączyć uwierzytelnienie i usunąć niechroniony dostęp do domyślnego użytkownika. Redis nie ma publicznego portu; ACL nie zastępuje izolacji sieci/TLS, gdy sieć jest nieufna.
3. Zinwentaryzować komendy BullMQ/Lua. Allowlist musi pozwalać na potrzebne EVAL/EVALSHA i komendy wywoływane przez skrypt, z prawidłowym zakresem keys. Nie wyłączać Lua, psując atomowość limitów, ani nie nadawać `+@all ~*` każdej usłudze.
4. API nie dostaje CONFIG/FLUSHALL/FLUSHDB/ADMIN, jeśli nie potrzebuje. Worker nie może czytać auth namespace. Test ACL sprawdza zarówno prawidłowe kolejki/limity, jak i odmowę obcego klucza/administracji.
5. Rotacja haseł odbywa się ze zgodnym okresem przejściowym i wymianą klientów. Budżety auth nie są kasowane przez rotację/zmianę config. AOF/backup i polityka pamięci nie mogą po cichu usuwać kluczy limitera podczas ataku; określić zachowanie przy OOM.
6. Do testów ACL użyć wyłącznie testowej instancji i prefiksu. Nie wykonywać masowego czyszczenia wspólnego Redis.

**Odbiór P10:** runtime działa z ograniczonymi prawami, próby niedozwolone odmawiają, produkcyjne cookie i origin sprawdzone po HTTPS, direct API/DB/Redis/worker niedostępne z zewnątrz, healthchecks zgodne z nowymi timeoutami i ACL.

## 13. P11 — zależności zgłoszone przez npm audit

**Pliki:** root/workspace `package.json`, `package-lock.json`, dokument decyzji o zgłoszeniach. Snapshot audytu: 9 podatnych pakietów, 2 high i 7 moderate; nie jest to dziewięć odtworzonych ataków.

1. Przed zmianą odświeżyć `npm audit --json` i `npm ls` w aktualnym stanie. Zapisać wynik z datą, aby nie mieszać nowych advisory z historycznym JSON. Komunikacja npm może wymagać sieci; nie stosować automatycznie sugerowanego fix.
2. Dla każdego advisory zapisać identyfikator, pakiet, ścieżkę transitive dependency, warunek podatności, osiągalność runtime/build/CLI i decyzję. „Brak wywołania w przeglądzie” nie oznacza naprawionego pakietu.
3. Next 16.3.7: wybrać aktualną poprawioną zgodną wersję na podstawie oficjalnego advisory/release i świeżego skanu. Historyczny skan wskazywał 16.3.8; nie traktować tego numeru jako zawsze aktualnego. Zachować App Router, a CSP odbierać na docelowej wersji.
4. Osobno rozstrzygnąć warunki Next: brak `images.remotePatterns` ogranicza wskazane SSRF, a brak Pages Router SSG/ISR ogranicza wskazane cache poisoning. Nie rozciągać tej oceny na pozostałe zgłoszenia Next.
5. `source-map-js` 1.2.1: aktualizacja zgodna z łańcuchem PostCSS do wersji naprawionej, historycznie 1.2.2. Sprawdzić resolution lockfile i build CSS/source maps; nie wystarczy zmiana pojedynczego pola w manifest.
6. `uuid` 8.3.2 przez ExcelJS/Sequelize: sprawdzić rzeczywiste wywołania v3/v5/v6 i buffer. Preferować aktualizację parent w zgodnej wersji. Major override uuid wymaga testu wszystkich używanych API; nie stosować go w ciemno ani nie downgrade'ować rodzica.
7. `sprintf-js` przez argparse/ts-command-line/Umzug: sprawdzić zgodny patch parent i osiągalność formatting input. Uruchomić migracje nowej/starej DB oraz rollback na testowej DB. Brak wejścia HTTP może uzasadnić ograniczony wyjątek, ale nie usunięcie zgłoszenia z raportu.
8. Po małej spójnej zmianie odtworzyć instalację `npm ci`, wykonać build/test i celowane scenariusze zależności. Nie uruchamiać `npm audit fix --force`; raport wskazywał również niezgodne major/downgrade propozycje.
9. Nierozwiązany advisory ma jawny właściciel, uzasadnienie warunku, ograniczenie ekspozycji i termin przeglądu. Dla osiągalnego high wymagającego naprawy nie deklarować gotowości wydania na podstawie samego wyjątku.
10. Porównać skan po zmianie i opisać remaining findings. Nie pisać „0 podatności”, jeśli pakiety nadal są zgłaszane albo test osiągalności został pominięty.

**Odbiór P11:** lockfile zawiera rzeczywiste wersje, aplikacja/migrator/parser działają, każdy wpis skanu ma rozstrzygnięcie, brak nieświadomej zmiany major.

## 14. P12 — odbiór, migracje i wydanie

### 14.1. Minimalny zestaw dowodów

| Dowód | Co musi zawierać |
| --- | --- |
| Unit/HTTP | Liczba testów, brak fail, scenariusze odmowy i brak skutków ubocznych |
| PostgreSQL | Reset/change/login/rehash races, macierz tenant/role, list/summary disabled, grant/assignment concurrency |
| Redis | Dwie repliki, TTL, atomowość, account many-IP, reauth przed KDF, outage/recovery, ACL |
| Przeglądarka | Cztery role, mustChange, CSP enforce, stored XSS, iframe, logout/back, oddzielne sesje |
| Wydajność | KDF p95/RSS, legalny XLSX i kontrolowane limit fixtures, concurrency/probe bez lawiny |
| Migracje | Pusta/stara DB, istniejące sesje/legacy hash, constraints, rollback do zgodnego readera |
| Wdrożenie | Real HTTPS, forwarding spoof, cookie/cache headers, brak publicznych usług wewnętrznych |
| Zależności | Przed/po npm audit, wersje i decyzja dla każdego advisory |

Raport odbioru zapisuje: SHA i dirty state, wersje/runtime, tryb testu, fixture, scenariusz, oczekiwanie, wynik, log oraz ograniczenia. Brak wykonania testu rzeczywistej zależności oznaczyć jako otwarty. Dowody używają syntetycznych danych i sekretów.

### 14.2. Kolejność migracji i wdrożenia

1. Sprawdzić backup i odtworzenie na izolowanej DB. Backup produkcyjny przechodzi istniejącą procedurę operatora; nie wpisywać jego zawartości ani sekretów do raportu.
2. Nadać kolejne numery migracji po aktualnym maksimum, obecnie 030. Rozdzielić rozszerzenie schematu revision, backfill/constraints, audit enums i późniejsze MFA/idle. Nie edytować historycznej wykonanej migracji.
3. Najpierw rozszerzyć schemat wstecznie zgodnie, potem wgrać kompatybilnych readers/writers, potem wymienić wszystkie stare repliki i włączyć ochronę revision. Jeżeli zgodny rolling deploy nie jest możliwy, zaplanować krótkie okno maintenance zamiast pozornego bezpieczeństwa mixed-version.
4. Zwiększony koszt hasha wdrożyć według oddzielnych etapów reader-first z P04. Nie uruchamiać writera v1, dopóki każde możliwe rollback/runtime nie czyta v1.
5. Wdrożyć limity i topologię proxy wraz z testem poprawnego IP. Nowy namespace Redis oraz wymiana klucza mają zachować ochronę w okresie przejściowym; nie usuwać starych liczników natychmiast, jeśli nadal są potrzebne.
6. Najpierw staging z legalnym ruchem/fixtures i fault tests; CSP Report-Only, następnie enforce. Odczyt i utrata grantów wymagają rzeczywistego odbioru DB przed wydaniem.
7. Deployment migracji odbywa się pojedynczym migratorem, potem aplikacje na nowych runtime accounts. Weryfikacja smoke: login starego konta, change/reset, role denial, maintenance/disabled, health i legalny import. Portale live pozostają wyłączone w tym odbiorze.
8. MFA wdrożyć później w enrollment mode, po przygotowaniu recovery; enforcement dopiero po potwierdzeniu gotowości administratorów. Nie połączyć pierwszego wydania SEC-01 z przymusowym nieprzetestowanym MFA.
9. Po wydaniu monitorować 401/403/409/429/503, KDF latency, memory, import timeout, readiness, DB locks i martwe przydziały. Alarmy powinny rozróżniać poprawną odmowę ataku od regresji legalnej pracy.
10. Zaktualizować instrukcję admina, README, stan/dziennik implementacji i nowy raport odbioru. Oznaczać konkretny ID jako zamknięty po jego dowodach, nie wszystkie po samym buildzie.

### 14.3. Rollback i awarie

| Sytuacja | Bezpieczna reakcja |
| --- | --- |
| Błąd nowego writera hash | Wyłączyć rehash/writer v1; wrócić do wersji czytającej legacy+v1; nie kasować nowych hashy |
| Błąd migracji/backfill | Zatrzymać dalsze wdrożenie; nie uruchamiać ochrony z niekompletnymi danymi; naprawić/odtworzyć według próby staging |
| Błąd revision/lock | Ograniczyć zmiany poświadczeń/starty, wrócić do poprawionej kompatybilnej wersji; nie świadomie przywracać wyścigu P1 jako docelowego rozwiązania |
| Za restrykcyjny limit | Podnieść skalibrowany próg/zmniejszyć koszt legalnej operacji, zachowując skończony budżet; nie wyłączać całego limitera |
| Redis down | Kontrolowane 503 dla auth i kosztownych mutacji, działający liveness, ograniczony probe; bez fail-open |
| CSP blokuje legalny ekran | Tymczasowe Report-Only dla konkretnego rollout z monitoringiem i terminem poprawki; nie dodawać globalnego unsafe-inline do script-src |
| Problem nowych DB/ACL grants | Przywrócić poprzedni sprawdzony profil ograniczonych praw albo skorygować potrzebny grant; nie przekazywać migratora API |
| Utrata MFA key/admin factor | Procedura recovery/key rotation z zachowaniem szyfrowanych historycznych seeds; brak nieudokumentowanego bypass |

Destrukcyjny down migration usuwający revision/MFA/audit history po rozpoczęciu produkcyjnego zapisu nie jest zwykłym rollbackiem aplikacji. Domyślnie pozostawić rozszerzony schemat i wycofać kod do zgodnej wersji. Powrót do backupu wymaga analizy utraty danych od momentu backupu.

### 14.4. Polecenia i integracja runnera

Istniejące polecenia dostępne obecnie:

```powershell
npm test
npm run build -w @goldis/web
npm run test:module:auth
npm run test:module:submission
npm run test:module:review
npm run test:module:audit-reports
npm run test:module:runner
npm audit --json
```

Poniższe nazwy są do dodania w P00 — nie są obecnie gotowymi komendami. Wrapper ma tworzyć własne usługi, czyścić flagi live i sprzątać wyłącznie własne zasoby:

```powershell
npm run test:module:security
npm run test:module:security-db
npm run test:module:security-redis
npm run test:module:security-browser
```

`npm test` nie buduje web i sam nie realizuje integracji DB/Redis/browser. Historyczny skrypt dowodowy nie może być jedynym testem odbioru. Pełny flow automatyzacji i portale wymagają odrębnego odbioru pod kontrolą użytkownika, poza tym planem testów security.

## 15. Checklista wykonawcza i pokrycie audytu

Każdy pakiet ma w dzienniku własny wpis: zakres → pliki/migracje → wykonane testy → wyniki/skip → ryzyko/rollback → otwarte punkty. Przekazanie kolejnej osobie/agentowi powinno podawać ostatni wykonany krok, nie samo „pakiet gotowy”.

| Ustalenie audytu | Gdzie implementować | Dowód wymagany do zamknięcia |
| --- | --- | --- |
| SEC-01 | P01, §3.1–3.4 | Wszystkie istotne przeploty z §3.5 na PostgreSQL, brak nowej stale sesji |
| SEC-02 | P02, §4.1 | Execute-only denial, view-only read, role/owner/status/tenant HTTP+DB |
| SEC-03 | P03, §5.1–5.2 | Many-IP account limit, Redis multi-replica, prawdziwe IP i spoof rejection |
| SEC-04 | P03, §5.3 | User/session/IP limit; 429 przed wywołaniem scrypt |
| SEC-05 | P04, §6.1 | Legacy/v1 compatibility, benchmark, CAS rehash, reader-first/rollback |
| SEC-06 | P04, §6.2 | Pusta DB odmawia słabego bootstrap, existing admin bez overwrite, mustChange |
| SEC-07 | P06, §8.1–8.3 | Early budget, cached probe, bounded decompression/parser, brak partial import |
| SEC-08 | P05, §7.1 | List/summary/detail disabled na DB, maintenance/admin/SMS exceptions |
| SEC-09 | P04, §6.3 | KDF w każdej błędnej gałęzi, stała odpowiedź i pomiar pomocniczy |
| SEC-10 | P05, §7.2 | Prawdziwy mutowalny model, właściwe rodzaje unassign, race i rollback |
| C-01 | P02, §4.2 | Cross-tenant denial dla trzech typów przydziału mimo grantu |
| CSP/clickjacking | P07, §9.1 | Produkcyjny nonce/enforce i negatywne testy iframe/skryptów |
| Private cache | P07, §9.2 | Nagłówki sukces/błąd, brak danych A u B, logout/back |
| MFA/reauth/idle | P09, §11.1–11.3 | Challenge/replay/recovery/step-up/expiry z rzeczywistą DB |
| Monitoring odmów | P08 | Zdarzenia, bounded flood i brak sekretów w dowodach |
| Production config | P10, §12.1 | HTTPS/origin/cookie/network/forwarding na staging |
| Minimalne DB/Redis prawa | P10, §12.2–12.3 | Legalne operacje działają, nadmiarowe DDL/keys/commands odmawiają |
| npm findings | P11 | Skan po zmianie i decyzja dla każdego advisory/łańcucha |
| JS/SQL injection | P07, §9.3–9.4 | Rzeczywisty browser stored-XSS oraz HTTP→PostgreSQL filter tests |

### 15.1. Warunki rozpoczęcia następnego pakietu

1. Migracje i wspólne modele wymagane przez pakiet są zatwierdzone oraz przetestowane na starej i nowej DB.
2. Kontrakt uprawnień/statusów/błędów jest zapisany i jego zmiana nie wynika przypadkiem z refaktoryzacji.
3. Poprzedni pakiet nie pozostawia otwartego krytycznego testu, od którego zależy bezpieczeństwo nowego.
4. Wspólny helper nie jest kopiowany do kolejnej ścieżki; nowe użycie ma test integracji, a zmiana helpera regresje wszystkich klientów.
5. Konfiguracja testowa nie uruchamia portali, providerów live ani istniejącej DB/Redis użytkownika.

### 15.2. Warunki zakończenia implementacji

- [ ] SEC-01–SEC-10 i C-01 mają osobne pozytywne dowody skutecznej naprawy, z ograniczeniami metody.
- [ ] Macierz rola × grant × owner/assignee × tenant × status obejmuje sukcesy oraz odmowy i brak skutków ubocznych.
- [ ] Reader legacy/v1 oraz deployment/rollback sprawdzono przed włączeniem silniejszego writera.
- [ ] Limity na Redis są atomowe, mają TTL, działają między replikami i przed kosztowną operacją.
- [ ] Import ma limity compressed/uncompressed/elementów/czasu/pamięci oraz cleanup.
- [ ] CSP, cache, cookies, proxy i izolacja zostały sprawdzone na właściwej ścieżce staging HTTPS.
- [ ] MFA/recovery, jeśli objęte wydaniem, mają gotową i przećwiczoną procedurę przed enforcement.
- [ ] Skan zależności nie ma nierozstrzygniętych wpisów, a pozostałe wyjątki są jawne.
- [ ] Wszystkie skip, niewykonane testy i odstępstwa są wskazane; brak nieuzasadnionego statusu „bezpieczna produkcyjnie”.
- [ ] Instrukcja admina, stan implementacji i nowy raport odbioru zgadzają się z rzeczywistym wdrożeniem.

## 16. Źródła decyzji technicznych

Najważniejszym źródłem lokalnych problemów pozostaje [audyt i jego dowody](AUDYT_BEZPIECZENSTWA_2026_10_08.md). Progi rate limiting/importu, idle i świeżości w tym planie są propozycją dla Goldis, nie uniwersalnymi wartościami narzuconymi przez poniższe źródła.

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html): throttling, polityka hasła i ponowne potwierdzenie tożsamości; przyjęte minimum 15 dotyczy nowego hasła w modelu bez MFA.
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): profile scrypt i migracja kosztu; benchmark ustala budżet wdrożenia, nie obniża wymagania kryptograficznego.
- [Express: za proxy](https://expressjs.com/en/guide/behind-proxies/): zaufanie do adresów/hop i ryzyko nagłówków z nieufnego klienta.
- [Lokalna dokumentacja CSP używanego Next](../node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md): per-request nonce, proxy i rendering dynamiczny. Po aktualizacji Next ponownie sprawdzić dokumentację tej wersji.
- [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238): TOTP; enrollment, recovery, rate limits i polityka wdrożenia są oddzielnym projektem aplikacji.
- Oficjalne advisory i łańcuchy zależności są podlinkowane w sekcji zależności audytu; wersję naprawczą ustalić ponownie w chwili realizacji P11.
