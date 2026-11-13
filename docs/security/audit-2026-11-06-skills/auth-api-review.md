# Przegląd uwierzytelniania i autoryzacji API — 6 listopada 2026

Zakres: aktualne drzewo robocze, a nie tylko HEAD `af512e9502218d336b4b73df0c5f612905c6ac7b`. Przeczytano lokalne skille `conducting-api-security-testing` i `performing-web-application-vulnerability-triage` ze wskazanej biblioteki. Wykonano przegląd źródeł oraz testy syntetyczne istniejących mechanizmów. Nie zmieniano kodu aplikacji, nie czytano `.env`, nie łączono się z bazą klienta ani usługami zewnętrznymi.

## Wynik i granice wniosku

Nie potwierdzono nowego obejścia sesji, granicy tenantów, CSRF ani dostępu administracyjnego w badanych ścieżkach. **Odtworzono konflikt polityki roli auditor z lokalną polityką modułu leadów (CYB-007).** To potwierdzenie zachowania kodu; kwalifikacja jako niedozwolonego dostępu wymaga rozstrzygnięcia obowiązującego kontraktu roli. Sam grant jest wymagany — nie wykazano dostępu anonimowego ani samodzielnego nadania sobie uprawnień.

Sprawdzone testy zakończyły się ostatecznie 63 unikalnymi PASS. To testy jednostkowe/polityki i HTTP z adapterami pamięciowymi; nie stanowią pełnej macierzy 159 tras z prawdziwym PostgreSQL i Redis. Dwóch testów początkowo nie dało się wykonać z powodu `EACCES` na loopback w sandboxie; powtórka tych samych testów w procesie dopuszczającym lokalną sieć zakończyła się 2/2 PASS.

## CYB-007 — niejednoznaczna granica roli auditor w module leadów

**Status:** zachowanie odtworzone; konflikt kontraktu, ryzyko warunkowe. **Priorytet:** P1 — rozstrzygnąć przed odbiorem. **Waga po przyjęciu kontraktu „auditor tylko audyt”: średnia.** Kategorie warunkowe: CWE-863 / OWASP API5:2023.

Źródła:

- `docs/INSTRUKCJA_ADMINA.md:76`: „Auditor czyta dziennik tenanta, ale nie dane operacyjne”.
- `apps/api/src/features/authorization/authorization-policy.ts:164`: auditor otrzymuje wyłącznie `audit:read`; `canPerform('auditor', 'batch:read', ...)` odmawia również dla własnego zasobu w swoim tenantcie.
- `apps/api/src/features/leads/business-leads.service.ts:57–58`: lokalna funkcja `roleCanRead` jawnie dopuszcza auditor. `requireReadAccess` na linii 251 wymaga następnie jedynie grantu `view_results`. `list` (343), `get` (522) i `exportWorkbook` (644) opierają się na tej lokalnej polityce; eksport wymaga dodatkowo `download_results`.
- `apps/api/src/features/authorization/tool-access.ts:41–48`: grant `canViewResults` jest honorowany dla nieadministracyjnych ról; nie ma limitu dozwolonych capability dla auditor.
- `apps/api/src/features/leads/business-leads.controller.ts:23`: kontroler stosuje `SessionGuard`; nie stosuje `PermissionGuard`, więc centralna odmowa operacyjna dla auditor nie dotyczy tej trasy.
- `apps/api/src/features/admin/admin-users.service.ts:589–644`: zmiana roli aktualizuje członkostwo, cofa sesje, usuwa nieodpowiednie przydziały interwencji i grant kasowania, ale nie usuwa grantów narzędzi. Zachowanie tej ścieżki oceniono statycznie, nie wykonano zmiany w prawdziwej bazie.

**Warunki:** aktywna sesja auditor oraz grant OC `canViewResults=true`, np. zachowany po zmianie roli użytkownika, który wcześniej miał ten grant. Bez grantu auditor otrzymuje 403. Dane muszą należeć do tego samego tenanta; nie wykazano obejścia granicy tenantów.

**Reprodukcja:** [reproduce-auditor-leads.cjs](reproduce-auditor-leads.cjs) wywołuje rzeczywisty skompilowany `BusinessLeadService.list` z rolą auditor, rzeczywisty `canAccessTool` oraz rzeczywisty `canPerform`. Zastępuje wyłącznie adaptery zapytań DB i rekordy tool/grant syntetycznymi danymi. Bez grantu wynik to 403; po włączeniu grantu `view_results` odpowiedź zawiera jeden syntetyczny lead, osobę decyzyjną i adres kontaktowy. Równolegle centralna polityka `batch:read` dla tej roli zwraca false. [Wynik i SHA256 badanych plików](auditor-leads-reproduction.json).

```powershell
node docs/security/audit-2026-11-06-skills/reproduce-auditor-leads.cjs
```

**Ograniczenia:** nie wykonano prawdziwego loginu HTTP auditor ani zmiany roli w PostgreSQL. Jawne dopuszczenie auditor w module leadów może być zamierzonym wyjątkiem biznesowym. W takim przypadku dokumentacja i centralna macierz ról są niespójne, ale sam wykazany odczyt z grantem nie jest dowodem obejścia obowiązującej polityki. Istniejący test `business-leads.http.spec.ts` zastępuje serwis stubem i sprawdza odmowę auditor wyłącznie dla `allocation-summary`; nie rozstrzyga rzeczywistego `list/get/export`.

**Plan domknięcia:** przyjąć jedną politykę rola × capability dla leadów i pozostałych modułów. Rekomendowana interpretacja obecnej instrukcji administratora: auditor nigdy nie otrzymuje danych operacyjnych, nawet przy starym grancie. Wtedy usunąć auditor z lokalnego dopuszczenia i wprowadzić centralny limit capability wynikający z roli, używany przez katalog, sesję i serwisy. Przy zmianie roli odrzucać lub dezaktywować niezgodne granty z audytem, nie kasować grantów dozwolonych przez nową rolę. Przy celowym wyjątku udokumentować jego zakres oraz zmienić centralny kontrakt i testy przed zamknięciem zgłoszenia.

**Odbiór:** rzeczywisty serwis + HTTP + odizolowany PostgreSQL: auditor bez grantów, ze starym `view_results`, ze starym `download_results`, po zmianie operator→auditor i ponownym logowaniu; list/get/export/navigation/snapshot muszą konsekwentnie spełniać przyjętą politykę. Osobno potwierdzić, że reviewer i operator zachowują dozwolony zakres oraz granicę tenantów. Przy restrykcyjnym kontrakcie oczekiwane 403/404 dla auditor, bez danych i bez wygenerowanego eksportu.

## Potwierdzone mechanizmy obronne

| Obszar | Obserwacja kodu i wybrane dowody |
|---|---|
| CSRF i pochodzenie | `composition/module.ts:31` rejestruje globalny guard. `request-protection.ts:37–45` wymaga dla mutacji zgodnego Origin, dopuszczalnego Sec-Fetch-Site i tokenu CSRF sesji, z jawnym wyjątkiem OriginOnly dla login/reset/logout. Podpis sesji wiąże token CSRF, a cookie i nagłówek są porównywane w `session-principal.ts:96–112`. Test HTTP przeszedł. |
| Podpis sesji | `session-principal.ts:28` losuje 32 bajty CSRF, linie 62–77 sprawdzają podpis stałoczasowo, datę wygaśnięcia i UUID. Rola z cookie nie steruje autoryzacją. Legacy claims bez sessionId nie dają dostępu, ponieważ resolver trwałej sesji go wymaga. |
| Cofnięcie sesji i konta | `identity.repository.ts:126–215` sprawdza sesję po userId/tenantId, revokedAt, czas bezczynności, credentialRevision, aktywnego użytkownika i aktywne członkostwo; bieżąca rola pochodzi z DB. Brak resolvera/DB kończy się odmową lub 503, nie sukcesem. Testy polityki i repozytorium przeszły; pełny DB race pozostaje do odbioru. |
| Role i tenant | `authorization-guard.ts:85` sprawdza tenant przed wyjątkami ownership, przypisania i wspólnego OC. Capability narzędzia jest ponownie sprawdzana przed wpuszczeniem do chronionego zasobu. Macierz role/scope przeszła. |
| Administracja i zespół | Kontrolery stosują SessionGuard i ograniczenie roli. Mutacje wymagają CSRF oraz potwierdzenia związanego z aktorem, sesją, akcją, celem, payloadem i idempotency key. `admin-mutations.repository.ts:28–53` ponownie blokuje aktywnego admina; `team.repository.ts:15–49` blokuje aktywnego managera/admina. Nie znaleziono samodzielnego mass assignment roli w badanych DTO. |
| Odzyskiwanie konta | `account-recovery-tokens.ts:96–139` wiąże token z celem, tenantem, aktywnym kontem i członkostwem, revisions hasła i e-maila, odbiorcą, czasem, stanem consumed/revoked; operacja używa blokad `FOR UPDATE`. `account-recovery.service.ts` stosuje wspólne transakcje i audyt. HTTP kontrakty przeszły; nie wykonano prawdziwej wysyłki maila. |
| Limity | `login-rate-limiter.ts` ma współdzielone budżety login/account/IP, backoff, reauth i recovery, HMAC identyfikatorów oraz odmowę przy błędzie Redis. Testy pamięciowego adaptera przeszły; nie potwierdzono rzeczywistego ACL/Lua w Redis tym zestawem. |
| Result sets | `run-submissions.service.ts:819–840` sprawdza tenant, narzędzie, tombstone, rolę, ownership operatora i osobny grant pobrania. Testy realnego serwisu eksportu i scope przeszły. Brak PermissionGuard w kontrolerze nie jest samodzielnym dowodem BOLA, bo serwis egzekwuje zakres. |

Wspólny odczyt historycznych wyników OC dla aktywnego operatora/managera bez indywidualnego grantu jest jawną, testowaną polityką w `tool-access.ts`; nie klasyfikowano tego jako luki. Publiczne odpowiedzi health zawierają ograniczony status, bez haseł, URL baz i stack trace — nie potwierdzono wycieku sekretów.

## Wykonane testy

Po wspólnym buildzie wykonanym w zadaniu głównym uruchomiono istniejący dist, bez konkurującej przebudowy:

```powershell
$testFiles = @(
  'apps/api/dist/features/auth/session.guard.spec.js',
  'apps/api/dist/features/auth/auth.session.spec.js',
  'apps/api/dist/features/auth/auth.service.spec.js',
  'apps/api/dist/features/auth/login-rate-limiter.spec.js',
  'apps/api/dist/features/authorization/authorization-guard.spec.js',
  'apps/api/dist/features/authorization/authorization-policy.spec.js',
  'apps/api/dist/features/authorization/resource-scope.spec.js',
  'apps/api/dist/features/authorization/tool-access.spec.js',
  'apps/api/dist/infrastructure/http/request-protection.http.spec.js',
  'apps/api/dist/features/identity/identity.repository.spec.js',
  'apps/api/dist/features/admin/manager-revocation.http.spec.js',
  'apps/api/dist/features/submissions/run-submission-result-set.spec.js'
)
node --test --test-reporter=spec $testFiles
```

Pierwszy przebieg: 53 testy, 51 PASS, 2 błędy infrastrukturalne `connect EACCES 127.0.0.1`; powtórzono tylko dwa pliki HTTP z uprawnieniem do loopback: **2/2 PASS**.

```powershell
node --test --test-reporter=spec apps/api/dist/features/account-recovery/account-recovery.http.spec.js apps/api/dist/features/account-recovery/auth-mail-config.spec.js apps/api/dist/features/account-recovery/auth-mail-crypto.spec.js apps/api/dist/features/account-recovery/recovery-email.spec.js
```

Dodatkowy przebieg: **10/10 PASS**. Testy używały własnych syntetycznych wartości, kontrolerów, adapterów pamięciowych i serwerów loopback. Zsumowanie powtórki nie zwiększa liczby unikalnych testów: łącznie **63**. Reprodukcja CYB-007 jest dowodem zachowania do triage, a nie testem akceptacji poprawki.

## Pozostały zakres odbioru

1. Pełna macierz HTTP wszystkich tras: brak sesji, każda rola, obcy użytkownik, obcy tenant, cofnięta sesja/grant i wyłączone konto, z rzeczywistym serwisem i DB.
2. Dwa równoczesne resetowania hasła i weryfikacje e-maila, ponowne użycie tokenu i zmiana konta/grantu pomiędzy guardem a zatwierdzeniem mutacji, na odizolowanym PostgreSQL.
3. Redis: prawdziwe Lua, TTL, ACL, odmowa przy awarii i przepływ przez produkcyjny reverse proxy. Nie wnioskować o tym z PASS adaptera pamięciowego.
4. Dla leadów, dashboardu, powiadomień i result sets testować realne serwisy; stub kontrolera potwierdza kontrakt HTTP, lecz nie zakres danych.
5. Zweryfikować ostateczną politykę danych operacyjnych dla auditor/reviewer, następnie dodać regresję całej rola × capability. Domknięcie CYB-007 nie wymaga domniemywania intencji z pojedynczej funkcji lub pojedynczego starszego planu.
