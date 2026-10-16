# Plan implementacji odzyskiwania hasła w Goldis z Resend

Data: 14 października 2026. Status: **implementacja kodu wykonana; produkcyjne włączenie oczekuje na konfigurację właściciela**. Lista poniżej pozostaje kryteriami i zakresem odbioru; rzeczywiste wyniki kroków i testów są w [dzienniku realizacji](REALIZACJA_ODZYSKIWANIA_HASLA_RESEND_2026-10-14.md). Instrukcja dla właściciela domeny: [Resend i home.pl — plan użytkownika](PLAN_UZYTKOWNIKA_RESEND_HOME_PL_2026-10-14.md).

## Cel i zakres pierwszego wydania

Użytkownik odzyskuje konto przez jednorazowy link wysłany na zweryfikowany adres konta. Administrator/manager może zlecić wysłanie tego samego rodzaju linku dla uprawnionego pracownika. Wysłanie wiadomości nie zmienia hasła ani nie wyłącza konta. Dopiero poprawne zatwierdzenie formularza zmienia hasło i unieważnia wcześniejsze sesje.

W pierwszym wydaniu wdrażamy: przypisanie i weryfikację adresów istniejących kont, publiczny reset, reset zlecony przez admina/managera, trwałą wysyłkę Resend, powiadomienia o zmianie i testy. Zaproszenia do zupełnie nowych kont są osobnym kolejnym rozszerzeniem; dotychczasowe tworzenie kont nie może przestać działać w trakcie migracji. MFA pozostaje osobnym zadaniem, a reset hasła nie może go w przyszłości automatycznie usuwać.

## Ustalenia architektoniczne

| Element | Projektowana decyzja |
| --- | --- |
| Publiczny adres aplikacji | Jedno stałe `PUBLIC_APP_ORIGIN`, np. `https://app.example.com`; example.com to przykład |
| Nadawca | `Goldis <powiadomienia@system.example.com>`; domena zweryfikowana w Resend |
| Odbiorca | Indywidualny, zweryfikowany adres użytkownika; nigdy adres firmy z importu |
| Logowanie | Zachowujemy obecny login; e-mail służy do odzyskiwania |
| Ważność resetu | 15 minut od utworzenia tokenu |
| Weryfikacja e-maila | Osobny cel tokenu, 24 godziny; nie daje uprawnienia do resetu przed weryfikacją |
| Token | 32 losowe bajty z CSPRNG, base64url; w tabeli tokenów SHA-256, bez jawnego sekretu |
| Link | `/reset-hasla#token=...`; token z fragmentu odczytuje wyłącznie klient i wysyła w body POST |
| Wysyłka | Resend HTTPS API z backendu; trwała kolejka w PostgreSQL, osobny moduł wysyłki w API |
| Tajna treść kolejki | AES-256-GCM z osobnym wersjonowanym keyringiem i AAD powiązanym z mailId |
| Powtórzenia wysyłki | Ten sam mailId, niezmienny payload i klucz idempotencji; wygasłych linków nie wysyłamy |
| Po udanym resecie | Revokacja wszystkich sesji użytkownika, wyłączenie wszystkich wcześniejszych tokenów, zwykłe ponowne logowanie |
| Lokalne testy | In-memory/fake provider oraz jednorazowe DB/Redis; bez prawdziwej wysyłki i portali |

Fragment URL ogranicza ujawnianie tokenu w logach HTTP i nagłówkach Referer, ale wiadomość, skrzynka odbiorcy i Resend nadal zawierają link. Nie ma podstaw do obietnicy, że token jest widoczny wyłącznie użytkownikowi. Nie zapisujemy go w analityce, logach, localStorage ani sessionStorage.

Trwała kolejka PostgreSQL pozwala uniknąć przekazywania sekretów kont portalowemu workerowi i rozszerzania jego Redis ACL. API ma moduł `AuthMailDispatcher` z obsługą lease, start/stop i konkurujących replik. Nie używamy samodzielnego `setTimeout` po HTTP jako jedynego mechanizmu dostarczenia.

## Kolejność prac agenta

Każdy krok ma zostać wykonany i odnotowany z wynikiem testów. Numery nowych migracji wybrać po sprawdzeniu aktualnej listy; w audytowanym stanie ostatnia była 059.

### A01. Utrwalić punkt odniesienia i zależności

- [ ] Sprawdzić stan Git, instrukcje repozytorium, istniejące zmiany i najnowsze migracje. Nie nadpisywać cudzych zmian.
- [ ] Założyć dziennik wykonania z checklistą A01–A17, numerami migracji i dowodami.
- [ ] Potwierdzić nazwy domeny aplikacji, nadawcy i Reply-To z dokumentu użytkownika. Do czasu potwierdzenia stosować przykłady wyłącznie w dokumentacji/testach.
- [ ] Uruchomić istniejące moduły auth/security jako bazę; przejrzeć `apps/web/AGENTS.md` i właściwe lokalne przewodniki Next przed kodowaniem nowych stron.

**Odbiór:** znamy punkt startowy; brak prawdziwych haseł/tokenów w dzienniku; wiadomo, które testy wymagają naprawy.

### A02. Naprawić błędy blokujące reset i testy DB

- [ ] W `apps/api/src/admin.ts` i `team.ts` zastąpić metadatum `credentialReset`, które odrzuca `audit.ts`, bez osłabiania filtra poświadczeń.
- [ ] Wspólną logikę zapisu nowego hasła, zwiększenia `credentialRevision`, revokacji sesji i audytu przygotować w serwisie, z którego skorzystają istniejące ścieżki i nowy reset. Zachować dotychczasowe kontrakty odpowiedzi i logowania po własnej zmianie hasła.
- [ ] W `docker/postgres/ensure-runtime-roles.sh` przyznać TEMPORARY wyłącznie migratorowi albo usunąć użycie tabel tymczasowych w migracji wymagającej tego prawa.
- [ ] Zaktualizować `migration-smoke.cjs` do obecnego `bootstrapAdminOnce`, zamiast usuniętej klasy `BootstrapAdminService`.
- [ ] Poprawić brak FROM w `runtime-permissions-smoke.cjs` i odbiór rzeczywistych uprawnień ról.
- [ ] Odtworzyć oba istniejące resety na jednorazowej DB: zapis hasła, revokacja, audyt, transakcja i replay potwierdzenia.

**Odbiór:** istniejący reset nie wycofuje poprawnej operacji przez audit metadata; migracje od pustej bazy wykonują się rolą migratora bez korekt w fixture. Dowody problemów: [audyt 14.10](AUDYT_BEZPIECZENSTWA_KONT_DANYCH_ADMINA_2026-10-14.md).

### A03. Dodać konfigurację i adapter wysyłki

- [ ] Utworzyć `auth-mail-config.ts`, `auth-mail-provider.ts` i `resend-mail-provider.ts`.
- [ ] Adapter ma wstrzykiwany klient HTTP/fetch, timeout, limit odpowiedzi, klasyfikację 429/5xx/błędów trwałych oraz bezpieczne kody błędów.
- [ ] Produkcja używa wyłącznie ustalonego endpointu Resend; użytkownik formularza nie przekazuje URL dostawcy, nadawcy, tematu ani odbiorcy.
- [ ] Provider testowy nie wysyła wiadomości; ewentualny tryb capture jest ograniczony do lokalnego development/test i nie loguje tokenów do współdzielonych logów.
- [ ] `GOLDIS_PASSWORD_RECOVERY_ENABLED=0` na czas migracji. Po włączeniu wymagane są poprawny provider, keyring, nadawca i origin HTTPS. Brak sekretu nie powoduje przełączenia produkcji na capture.

Projektowane ustawienia:

```dotenv
GOLDIS_PASSWORD_RECOVERY_ENABLED=0
GOLDIS_EMAIL_PROVIDER=disabled
PUBLIC_APP_ORIGIN=https://app.example.com
GOLDIS_EMAIL_FROM=Goldis <powiadomienia@system.example.com>
GOLDIS_EMAIL_REPLY_TO=pomoc@example.com
RESEND_API_KEY_FILE=/run/secrets/resend_api_key
AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION=1
AUTH_MAIL_ENCRYPTION_KEYS_BASE64_FILE=/run/secrets/auth_mail_keyring
```

Po konfiguracji i odbiorze: provider `resend`, recovery `1`. Keyring kolejki generuje agent przy wdrożeniu; nie jest to klucz Resend i nie wolno używać tu hasła admina/SESSION_SECRET. Wywołania do dostawcy: [Resend Send Email](https://resend.com/docs/api-reference/emails/send-email).

**Odbiór:** testy adaptera obejmują sukces, timeout, niepoprawną odpowiedź, błąd zwracany w body, 429 i 5xx; żadna odpowiedź dostawcy nie ujawnia klucza/linku użytkownikowi.

### A04. Dodać schemat danych i uprawnienia

- [ ] Do `users` dodać nullable `recovery_email`, `recovery_email_normalized`, `recovery_email_verified_at`, wersję `recovery_email_revision` oraz pola oczekującego adresu `pending_recovery_email`/`pending_recovery_email_normalized` i osobną `pending_recovery_email_revision`. Samo zlecenie zmiany adresu zwiększa wersję oczekującego wniosku; wersja zweryfikowanego adresu rośnie dopiero po jego potwierdzonej zmianie.
- [ ] Unique partial index dla niepustego normalizowanego adresu odzyskiwania. W jednej organizacji każdy adres jest przypisany do jednego konta; konflikt przy potwierdzaniu musi być atomowo odrzucony. Zweryfikowany adres zajmuje unikalność; konkurujące oczekujące zgłoszenia rozstrzyga transakcja potwierdzenia.
- [ ] Ustalić normalizację: trim, walidacja długości i składni, normalizacja domeny; jawnie przyjąć case-insensitive adresy kont w tym produkcie. Nie usuwać kropek ani `+tag`, nie stosować reguł Gmail do innych dostawców.
- [ ] Utworzyć `account_recovery_tokens`: id, userId, tenantId, purpose (`password_reset`/`email_verify`), tokenHash UNIQUE, credentialRevision, emailRevision, pendingEmailRevision nullable dla weryfikacji, fingerprint adresu docelowego, createdAt/expiresAt/consumedAt/revokedAt; FK, CHECK i indeksy porządkowania.
- [ ] Utworzyć `auth_mail_outbox`: mailId, cel, tokenId nullable, userId/tenantId, zaszyfrowany payload, keyVersion, stan, attemptCount, nextAttemptAt, leaseUntil, leaseOwner, providerMessageId, kod błędu, createdAt/expiresAt/submittedAt. Bez jawnego URL/tokenu/hasła.
- [ ] Rozszerzyć `db.ts`, granty SQL wyłącznie dla `goldis_api`, dozwolone akcje audytu i ich CHECK w nowej migracji. Workerzy nie otrzymują praw do tabel ani pełnego SELECT nowych pól kont.
- [ ] Odbiór migracji od pustej oraz obecnej bazy, ponowne wykonanie i integralność indeksów.

**Odbiór:** istniejące konta działają z nullable adresem; żadnego importowania kontaktów klientów do pól odzyskiwania; runtime API nie otrzymuje DDL.

### A05. Zaimplementować tokeny i wspólne blokady

- [ ] Tokeny generować CSPRNG; rozdzielić purpose i długość życia.
- [ ] Odczyt zawsze sprawdza purpose, expiry, użycie/revokację, aktywność użytkownika i członkostwa, snapshot poświadczeń/adresu oraz aktualny cel adresu.
- [ ] Wszystkie operacje zmiany hasła/adresu/utworzenia i zużycia linku korzystają z `lockUsersInTransaction` i zgodnej kolejności blokad.
- [ ] Sam GET strony, prefetch i skaner poczty nie zużywają tokenu. Dwukrotne równoległe POST tego samego linku mogą zakończyć zmianę tylko raz.
- [ ] Anonimowe ponowienie zgłoszenia nie unieważnia już wysłanego, ważnego linku. Dopuszczamy ograniczoną liczbę ważnych linków w budżecie; wszystkie tracą ważność po skutecznej zmianie hasła. Zapobiega to blokowaniu odzyskiwania przez osobę znającą e-mail.
- [ ] Revokacja konta, zmiana hasła i potwierdzona zmiana adresu unieważniają powiązane stare tokeny oraz oczekującą wysyłkę.

**Odbiór:** testy wygaśnięcia, zamiany celu, zmiany adresu/rewizji, disabled account, innego tenant i konkurujących transakcji.

### A06. Zaimplementować przypisanie i weryfikację e-maila

- [ ] `PUT /api/auth/recovery-email` wymaga zalogowanej sesji, origin/CSRF i obecnego hasła, z limiterem reauth. Zapisuje oczekujący adres i zleca link weryfikacyjny.
- [ ] `POST /api/auth/verify-recovery-email` przyjmuje token, kontroluje origin i atomowo potwierdza adres; nie musi wymagać tej samej przeglądarki ani aktywnej sesji.
- [ ] Przy pierwszym przypisaniu publiczny reset jest dostępny dopiero po weryfikacji. Przy zmianie zachować poprzedni zweryfikowany adres do czasu udanego potwierdzenia nowego.
- [ ] Link sprawdza dokładnie oczekujący adres i rewizję żądania; nowy wniosek o zmianę unieważnia starszą weryfikację.
- [ ] O zmianie powiadamiać poprzedni oraz nowy adres. Samo żądanie na niezweryfikowany adres nie daje mu dostępu do konta.
- [ ] Admin może rozpocząć przypisanie z potwierdzeniem uprzywilejowanej operacji; manager tylko dla operatora we własnym tenant. Nowy adres nadal wymaga weryfikacji.
- [ ] `GET /api/auth/me` udostępnia właścicielowi stan i jego adres; listy ogólne nie mogą niepotrzebnie ujawniać adresów odzyskiwania.

**Odbiór:** migracja istniejących kont nie wylogowuje wszystkich i nie blokuje logowania; test przejęcia odzyskiwania przez podmianę adresu kończy się odmową.

### A07. Dodać limity publicznych żądań

- [ ] Rozszerzyć `login-rate-limiter.ts` o osobną przestrzeń resetów/weryfikacji. Zostawić budżety logowania i reauth.
- [ ] Początkowe wartości do odbioru: cooldown 60 s dla adresu; maks. 3 zgłoszenia/15 min dla adresu, 10/15 min dla IP; limity potwierdzania tokenów oraz wspólny budżet wysyłki.
- [ ] Klucz adresu jest HMAC z odrębnym prefiksem, obliczany identycznie dla istniejących i nieistniejących kont. Nie przechowywać jawnego e-maila w kluczu Redis.
- [ ] Account/cooldown suppressuje wysyłkę przy takim samym 202; IP/global limit może zwrócić 429 niezależnie od istnienia konta. Awaria Redis daje ogólną odmowę/503, bez nieograniczonej wysyłki.
- [ ] Zweryfikować IP na rzeczywistym łańcuchu Nginx → Next → API, z próbą fałszowania X-Forwarded-For.

**Odbiór:** brute force i spam są ograniczone, nie można sprawdzić istnienia konta na podstawie statusu/cooldown, kilku pracowników za NAT nie jest niespodziewanie odcinanych.

### A08. Dodać publiczne żądanie resetu

- [ ] `POST /api/auth/forgot-password` przyjmuje tylko `{ email }`, z limitem body i walidacją pól.
- [ ] Publiczny endpoint nie wymaga SessionGuard. Użyć `OriginOnly` z zachowaniem globalnej kontroli origin/fetch-site, aby również przeterminowane cookie nie blokowało odzyskiwania.
- [ ] Sprawdzać zweryfikowany adres, aktywne konto i aktualne członkostwo w tenant Goldis. Nie wysyłać dla disabled/unverified/nieistniejących kont.
- [ ] Odpowiedź 202 dla wszystkich poprawnych składniowo adresów: „Jeśli istnieje aktywne konto z tym adresem, wyślemy link do ustawienia nowego hasła”. Brak identyfikatora użytkownika, roli, adresu zastępczego czy stanu wysyłki w odpowiedzi.
- [ ] Nie czekać na HTTP Resend przed odpowiedzią. Unikać łatwej różnicy czasu znane/nieznane konto; mierzyć wielokrotne próby przy tych samych limitach.
- [ ] Utworzenie tokenu i rekordu outbox jest jedną transakcją. Link budować z konfiguracji, nigdy z Host/X-Forwarded-Host/URL przekazanego przez klienta.

**Odbiór:** dla prawidłowych adresów istniejących/nieistniejących/disabled odpowiedź ma ten sam kształt; brak sprawdzania poczty w trakcie request.

### A09. Dodać zatwierdzenie nowego hasła

- [ ] `POST /api/auth/reset-password` przyjmuje tylko `{ token, newPassword }`; bez userId/roli/nowego adresu e-mail.
- [ ] Weryfikować body i format tokenu przed kosztownym KDF. Sprawdzić wstępnie ważność, wyliczyć hash przez istniejący ograniczony `password-hash.ts`, a następnie ponownie zweryfikować wszystko w transakcji.
- [ ] Pod blokadą użytkownika i tokenu zapisać hash, zwiększyć `credentialRevision`, ustawić `mustChangePassword=false`, odwołać wszystkie sesje użytkownika, zużyć bieżący token i odwołać pozostałe linki.
- [ ] W tej samej transakcji dodać bezpieczny audyt i outbox powiadomienia o zmianie hasła. Nie czekać w transakcji na Resend.
- [ ] Błąd DB/audytu powoduje pełny rollback. Błąd późniejszej wysyłki powiadomienia nie wycofuje hasła.
- [ ] Nie tworzyć automatycznie nowej sesji. Czyścić cookie przeglądarki i kierować do zwykłego logowania. Przed ustawieniem hasła nie ufać sesji innego użytkownika otwierającego link.
- [ ] Zachować obowiązkowe origin oraz kontrolę tokenu jako uprawnienia do resetu; endpoint nie obchodzi przyszłego MFA.

**Odbiór:** hasło działa, stare hasło/sesje/linki nie działają, token nie może zostać użyty drugi raz, dwa równoległe żądania nie robią dwóch resetów.

### A10. Zaimplementować trwałe wysyłanie i szablony

- [ ] Dodać `auth-mail-crypto.ts` oraz `auth-mail-outbox.ts`; payload HTML/text, odbiorca, From i Reply-To są szyfrowane i niezmienne dla mailId.
- [ ] Dispatcher rezerwuje zadania krótką transakcją `FOR UPDATE SKIP LOCKED`, ustawia lease i zwalnia DB przed żądaniem do Resend.
- [ ] Po restarcie wygasły lease może przejąć inna replika. Wysyłka ma stały klucz idempotencji `goldis-auth-mail/<mailId>`; timeout po przyjęciu wiadomości przez dostawcę prowadzi do retry tego samego payloadu, nie tworzenia nowego tokenu.
- [ ] Retry 429/timeout/5xx z backoff/jitter i Retry-After; błędy konfiguracji/odbiorcy kończą się stanem failed. Wszystkie ponowienia mieszczą się w ważności linku i w oknie idempotencji dostawcy.
- [ ] Bezpośrednio przed wysyłką ponownie sprawdzić status konta/tokenu/rewizji. Jeśli do wygaśnięcia resetu zostało mniej niż 2 minuty, anulować zadanie; użytkownik może poprosić ponownie. Nie wydłużać ważności wysłanego tokenu w tle.
- [ ] `submitted` oznacza przyjęcie przez API Resend, nie dostarczenie do skrzynki. Po przyjęciu lub zakończeniu wygasłego zadania usuwać zaszyfrowaną treść linku z DB. Krótką retencję samych metadanych ustalić operacyjnie.
- [ ] Szablony: weryfikacja adresu, reset, hasło zmienione, adres zmieniony. HTML + plain text; link, czas ważności i informacja co zrobić, jeśli odbiorca nie zlecał operacji; bez haseł, PESEL i polis.

Idempotencja Resend ma obecnie okno 24 h; dla linków 15-minutowych retry kończy się wcześniej. [Resend Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

**Odbiór:** crash/restart, przejęcie lease i timeout nie mnożą wiadomości; zaszyfrowany payload nie jest czytelny w zrzucie DB bez keyringu; nie wysyłamy linków już nieważnych.

### A11. Dodać zlecanie resetu w administracji

- [ ] Dodać `POST /api/admin/users/:userId/password-reset-link` i odpowiednik `/api/team/users/:userId/password-reset-link`.
- [ ] Oba wymagają sesji, CSRF, świeżego potwierdzenia `privileged-actions.ts`, idempotency key i aktualnej kontroli aktora/celu w transakcji.
- [ ] Rozszerzyć listę dozwolonych akcji i ograniczenia DB dla nowych operacji. Manager może obsługiwać wyłącznie operatorów własnego tenant, nigdy admina/managera innej organizacji.
- [ ] Odbiorca pochodzi ze zweryfikowanego rekordu konta, nie z body endpointu. Brak adresu oznacza czytelny komunikat o konieczności jego przypisania.
- [ ] Zlecenie zapisuje audyt i outbox; odpowiedź może mówić „zlecono”, nie „dostarczono”. Replay tego samego potwierdzenia nie tworzy drugiego zadania.
- [ ] Dotychczasowy reset hasła tymczasowego zachować jako kontrolowaną ścieżkę przejściową; jej ewentualne usunięcie następuje dopiero po migracji kont i odrębnej decyzji.

**Odbiór:** role/tenant/confirmation/CSRF chronią endpoint, klient nie może podmienić odbiorcy ani nadać roli przez link.

### A12. Zaimplementować UI

- [ ] W `apps/web/app/workspace.tsx` dodać „Nie pamiętam hasła” przy formularzu logowania.
- [ ] Utworzyć `/odzyskaj-haslo`, `/reset-hasla` i `/potwierdz-email`, niezależne od konieczności zalogowania i ramki panelu.
- [ ] W `/account` dodać ustawianie adresu, stan „niezweryfikowany/zweryfikowany”, ponowienie weryfikacji i zmianę z obecnym hasłem.
- [ ] W admin/team dodać stan adresu i przycisk wysłania linku, z obecnym dialogiem potwierdzenia operacji.
- [ ] Obsłużyć stany: wysyłanie, ogólne przyjęcie zgłoszenia, limit, brak/wygaśnięcie/zużycie linku, polityka hasła, sukces i awaria usługi.
- [ ] Token z fragmentu trzymać tylko w pamięci komponentu; po odczycie usunąć fragment z paska przez history.replaceState. Odświeżenie po tym kroku wymaga ponownego otwarcia linku — wyjaśnić w komunikacie.
- [ ] Nie dodawać analityki/trackerów do stron z linkami. Dla tych stron no-store i Referrer-Policy: no-referrer; zachować istniejący CSP/nonce.
- [ ] Dostępne etykiety i focus, status aria-live, password-manager/autocomplete=new-password, mobilny układ i spójny język.

**Odbiór:** pełny przepływ w rzeczywistej przeglądarce, także z cudzą aktywną sesją/starym cookie i w nowym urządzeniu, bez ujawnienia tokenu w URL żądań/logach.

### A13. Audyt, metryki i ograniczenie sekretów

- [ ] Dodać akcje audytu dla przypisania/weryfikacji adresu, zlecenia i zakończenia resetu; w metadanych tylko niezbędne niesensytywne identyfikatory/statusy. Sprawdzić literalne typy i CHECK DB.
- [ ] Limity, failed jobs, oldest pending age i błędy konfiguracji raportować jako liczniki; nie zapisywać tokenów, body formularzy, haseł ani pełnych adresów w logach.
- [ ] Nie dodawać na próbę automatycznego zapisu wszystkich anonimowych zgłoszeń do audytu DB; agregować i ograniczać telemetrię.
- [ ] Sprzątać zużyte/wygasłe tokeny i payloady outbox z ustaloną retencją. Nie kasować zapisów audytu wbrew aktualnej polityce/journalowi.
- [ ] W health/admin rozróżnić działającą aplikację od zdegradowanej wysyłki. Awaria maila nie wyłącza wszystkich pozostałych funkcji platformy.

**Odbiór:** logi i eksport metryk nie zawierają sekretów; obsługa ma sposób wykrycia niedziałającej wysyłki.

### A14. Podłączyć sekrety i wdrożenie

- [ ] Dodać mapowanie Resend/keyringu do `compose.yaml`, overlay produkcyjnego, `load-runtime-secrets.sh` i skryptów generowania sekretów.
- [ ] Zaktualizować `.env.example`, `.env.windows.example`, walidator runtime, preflight, test fixture Compose i dokumentację ustawień.
- [ ] Klucz Resend montować wyłącznie w API; portal/enrichment worker i frontend go nie otrzymują. Keyring kolejki również tylko dla modułu wysyłki.
- [ ] Uzupełnić allowlistę grantów SQL i test jej odmów. Brak potrzeby rozszerzania praw BullMQ portalowego workera.
- [ ] `scripts/test-module.cjs` ma usuwać nowe sekrety z dziedziczonego środowiska; dodać jawny moduł `password-recovery`, wariant DB i browser, z fake provider.
- [ ] Backup uwzględnia wersjonowany keyring outbox w chronionej części; w `deploy/backup/restore.sh` i lokalnej procedurze restore dodać kontrolowany krok odwołania wszystkich tokenów odzyskiwania/weryfikacji i anulowania ich outbox, zakończony przed startem dispatchera/readiness. Nie odtwarzać do życia wykorzystanych wcześniej linków z backupu.

**Odbiór:** Compose z fixture ma właściwe mounty, prawdziwe klucze nie trafiają do Git/obrazu/logów; po restore nie zaczyna się wysyłka historycznych resetów.

### A15. Testy bezpieczeństwa i awarii

Minimalna macierz odbioru:

| Scenariusz | Oczekiwany wynik |
| --- | --- |
| E-mail znany/nieznany/disabled/unverified | Jednakowa publiczna odpowiedź; wysyłka tylko dla uprawnionego konta |
| Nieprawidłowy format i dodatkowe pola | Walidacja przed kosztowną pracą; bez dowolnego wysyłania wiadomości |
| Fałszywy Host/X-Forwarded-Host | Link nadal prowadzi do skonfigurowanej domeny |
| Token weryfikacji użyty jako reset | Odmowa |
| Token wygasły/zużyty/cofnięty | Odmowa bez zmiany hasła |
| Dwa równoległe resety | Jedna skuteczna zmiana i spójny audyt |
| Stare hasło i sesje po resecie | Odmowa |
| Zmiana hasła/adresu lub disabled po wysłaniu linku | Stary link nie działa |
| Anonimowe ponowienie zgłoszenia | Nie odbiera ważności linkowi właściciela |
| Obcy origin, brak tokenu, manager wobec admina | Odmowa |
| Opóźniony outbox i crash między wysłaniem a zapisem stanu | Idempotentne retry, brak wygasłych maili |
| Resend 429/timeout/5xx/błąd trwały | Kontrolowane retry/status; brak wycieku odpowiedzi dostawcy |
| Niepowodzenie audytu/DB | Pełny rollback hasła i zużycia tokenu |
| Awaria maila z powiadomieniem po resecie | Hasło pozostaje zmienione, powiadomienie oczekuje |
| Konto bez e-maila po migracji | Dotychczasowe logowanie nadal działa |
| Cofnięcie dostępu aktora w czasie admin reset-link | Operacja nie przechodzi po zmianie uprawnień |
| Worker próbuje odczytać tokeny/keyring | Odmowa DB/brak zamontowanego sekretu |
| Odtworzenie backupu | Stare linki/outbox nie odzyskują ważności |

- [ ] Unit, fixture HTTP, rzeczywista jednorazowa PostgreSQL i Redis, browser smoke.
- [ ] Istniejące auth/security/admin/team/Compose/preflight oraz pełny build po finalnych zmianach.
- [ ] Jedna prawdziwa wysyłka i reset na syntetycznym koncie po konfiguracji właściciela; bez rzeczywistych danych klientów.

**Odbiór:** każda pozycja ma wynik i dowód; SKIP bez decyzji nie oznacza PASS. Kryteria bezpieczeństwa tokenów odpowiadają [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html); szczegóły kolejek i migracji wyżej są projektem dla Goldis.

### A16. Przenieść istniejące konta

- [ ] Właściciel dostarcza listę login → indywidualny adres, bez haseł.
- [ ] Najpierw przypisać/weryfikować adres admina podczas normalnie uwierzytelnionej sesji, później pozostałych kont.
- [ ] Sprawdzić duplikaty i brak dostępu do skrzynek; nie oznaczać adresów jako zweryfikowane tylko dlatego, że wpisano je w tabelę.
- [ ] Nie wymuszać resetu na wszystkich pracownikach jednocześnie.
- [ ] Dla jedynego admina przygotować kontrolowaną procedurę offline z VPS: sprawdzenie właściciela, lokalna komenda/serwis do zmiany hasła przez istniejący hash/revision/revocation/audit, bez publicznego backdoora i bez wpisywania jawnego hasła do historii poleceń.

**Odbiór:** właściciel ma działającą skrzynkę odzyskiwania; utrata dostępu do poczty nie wymaga otwierania niezabezpieczonego endpointu.

### A17. Włączenie i obsługa po wdrożeniu

- [ ] Przejść checklistę DNS/Resend/HTTPS z planu użytkownika.
- [ ] Włączyć provider i funkcję dla testowego konta/środowiska, odebrać wiadomości i logowanie.
- [ ] Włączyć funkcję docelowo po migracji wymaganych kont, monitorować błędy/queue age oraz limity Resend.
- [ ] Udokumentować rotację klucza API, keyringu, reagowanie na spam, błędny adres i niedostępność Resend.
- [ ] Rollback funkcji: wyłączyć publiczne zgłoszenia i wysyłkę, odwołać niewykorzystane linki. Zachować bezpiecznie dane migracji; nie cofać haseł/rewizji/sesji z backupu.

**Odbiór końcowy:** użytkownik odzyskuje swoje konto, admin zleca link wyłącznie uprawnionemu użytkownikowi, sekrety pozostają po stronie backendu, stare sesje i linki nie działają.

## Elementy poza pierwszym wydaniem

Podpisane webhooks dostarczenia/bounce/complaint i panel statusów poczty, zaproszenia nowych kont oraz MFA. Brak webhooka nie blokuje samej wysyłki: rozróżniamy jednak „przyjęto przez Resend” i „dostarczono”. Jeśli webhooks zostaną dodane, wymagają osobnego endpointu z weryfikacją podpisu i replay protection; nie można po prostu globalnie wyłączyć origin/CSRF dla całego API.

## Granice odpowiedzialności

Agent przygotowuje kod, migracje, testy, szablony, konfigurację i instrukcję. Właściciel wybiera realną domenę, zarządza DNS i kontem Resend, osadza klucz na VPS, dostarcza adresy pracowników oraz odbiera prawdziwe wiadomości. Programowanie i testy fixture nie wymagają gotowego DNS; prawdziwa wysyłka wymaga wykonania planu użytkownika.
