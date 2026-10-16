# Goldis — gotowość do przekazania klientowi, 15.10.2026

**Werdykt: jeszcze NO-GO dla publicznej produkcji z rzeczywistymi danymi.** Aplikacja ma działające funkcje i solidną część zabezpieczeń. Najwięcej brakuje w odbiorze instalacji, kontroli dostępu do danych, obsłudze awarii i procedurach utrzymania. Warstwa wizualna nie wymaga przebudowy; potrzebuje kilku konkretnych poprawek użyteczności.

Oceniono bieżące drzewo robocze, razem z wcześniejszymi zmianami użytkownika. HEAD `e3a507ea8e534f06d698289bf1165f79691e5a6d` nie reprezentuje całej ocenianej implementacji. Nie zmieniano kodu aplikacji, sekretów, praw dostępu ani danych klienta. Powstały wyłącznie materiały audytu. Testy DB/Redis korzystały z jednorazowych kontenerów, UI z syntetycznych odpowiedzi API. Nie uruchamiano portali live, prawdziwych wysyłek ani całego produkcyjnego procesu.

## Co sprawdzono teraz

| Kontrola | Wynik i granica dowodu |
| --- | --- |
| Build Next.js | PASS. API/core/worker zbudowały się również w regresji. |
| `npm test` z testowym DATABASE_URL i REDIS_URL wskazującymi nieużywany lokalny port | PASS: core 14; API 230; worker 106 PASS / 54 SKIP; pozostałe zestawy 35 PASS. Razem 385 PASS, 54 SKIP. Bez ustawienia DATABASE_URL pierwsza próba zatrzymała się na imporcie modułu DB w sześciu plikach API — to problem powtarzalności uruchomienia testów, nie odtworzony błąd działającej aplikacji. |
| UI security, lead, manager, review, submission, history | Wszystkie 6 smoke PASS. Testują rzeczywisty frontend z atrapą API, więc nie zastępują przepływu z DB/kolejką. |
| Aktualne widoki | 20 zrzutów Chromium: 8 ekranów oraz 2 stany awarii, każdy przy 1440 i 375 px. Brak błędów JS i poziomego overflow całej strony. To emulowane rozmiary okna; nie test fizycznego telefonu ani wszystkich gestów. |
| PostgreSQL — świeża instalacja i odzyskiwanie hasła | PASS, migracje 001–060 i powtórne uruchomienie, jednorazowość/równoległość resetu, unieważnianie sesji, zaszyfrowany outbox. Dostawca poczty testowy. |
| PostgreSQL — rzeczywiste rozdzielone role | PASS: aktualny skrypt ról, migracja kontem migratora, runtime grants, `RUNTIME_DB_PERMISSION_SMOKE_PASS`, niezależne asercje uprawnień API/workera/enrichment. Bez diagnostycznego dodawania TEMP. |
| `test:module:security-db` | FAIL: `MIGRATION_SMOKE_FAILED_users` po częściowym `USER_SCHEMA_SMOKE_PASS`. Cały moduł nie jest odebrany; przyczyna wymaga diagnostyki runnera/scenariusza. Nie ma podstaw, by ten wynik nazywać potwierdzoną podatnością aplikacji. |
| `test:module:backup-restore` | FAIL: `BACKUP_RESTORE_SCHEMA_OR_SENTINEL_MISMATCH`. Po dump/restore test porównuje najnowszą migrację ze stałą 058, mimo aktualnego schematu 060. To nieaktualna asercja w teście; dalsza weryfikacja archiwum eksportów nie została wykonana. Nie dowodzi utraty danych w backupie. |
| Redis — limiter | PASS, rzeczywisty jednorazowy Redis, limity konto/IP i Retry-After. Nie jest to pełny odbiór produkcyjnych ACL ani awarii całego stosu. |
| Dedykowane fixture portali w Chromium | Compensa 29/29 PASS; UFG 14/14 PASS; Everest 7 PASS / 1 FAIL. Bez żądań do rzeczywistych portali. |
| Produkcyjny Compose | PASS dla syntetycznej konfiguracji. Nie oznacza działającego VPS/TLS. |
| Zależności produkcyjne npm | 0 critical / 0 high / 7 moderate. To ścieżki dwóch advisory, nie siedem odtworzonych exploitów. |

Logi, zrzuty i skrypty: [audit-production-2026-10-15](audit-production-2026-10-15/). Surowe logi `*.log` są lokalne i ignorowane przez Git. Pomiar widoków: [ui-results.json](audit-production-2026-10-15/ui-results.json).

## Najpierw zamknąć przed wydaniem

### R01 — P1: historyczne pliki z sekretami mają zbyt szerokie prawa

Aktualny odczyt ACL potwierdza, że `.env` i `.env.compose.local` dziedziczą `Modify` m.in. dla `BUILTIN\Użytkownicy`. `.env.local` jest ograniczony do właściciela, SYSTEM i administratorów. Inne uprawnione lokalne konta mogą czytać lub podmieniać stare pliki. Nie wykazano pobrania ich przez anonimowe HTTP.

**Do zamknięcia:** ograniczyć ACL wszystkich używanych kopii, usunąć zbędne kopie po ustaleniu ich roli i ocenić potrzebę rotacji używanych sekretów. Zachować stare klucze potrzebne do odszyfrowania istniejących danych. Na produkcji osobne konto usługi i sekrety z ograniczonym odczytem.

**Odbiór:** zwykłe drugie konto nie odczytuje ani nie zmienia plików, aplikacja działa z docelowym kontem. To problem lokalnej instalacji i procesu przygotowania sekretów; nie dowód identycznych ACL przyszłego VPS.

### R02 — P1, decyzja produktu: cofnięcie grantu OC nie odbiera wspólnych wyników

[tool-access.ts:23](../apps/api/src/tool-access.ts#L23) nadal przyznaje operatorowi/managerowi wspólny odczyt i pobieranie OC bez grantu, z grantem `false` oraz przy wyłączonym narzędziu. To jawna reguła aplikacji w obrębie organizacji, nie obejście między tenantami. [export.ts:38](../apps/api/src/export.ts#L38) zawiera w zwykłym pobieranym XLSX PESEL i dane kontaktowe; szyfrowanie magazynu nie ogranicza późniejszego kopiowania pobranego pliku.

**Do zamknięcia:** klient ma zatwierdzić, czy każdy operator powinien mieć ten zakres. Jeśli nie, ograniczyć odczyt/eksport do uzgodnionego przydziału i niezależnych uprawnień. Jeśli tak, opisać ten model w ekranie dostępów i instrukcji. Ustalić, które role rzeczywiście potrzebują PESEL-u w eksporcie.

**Odbiór:** operator A/B, odebrany grant, zmieniony przydział, wyłączone narzędzie i obcy tenant mają jawne oczekiwane wyniki testów. Obecnej polityki nie należy zmieniać bez uzgodnienia.

### R03 — P1 dla publicznego dostępu: ochrona kont uprzywilejowanych

[session.ts:247](../apps/api/src/session.ts#L247) loguje hasłem; MFA do portali nie jest MFA Goldis. Ponowne hasło dla wielu zmian administracyjnych działa, lecz [admin.ts:580](../apps/api/src/admin.ts#L580) nadal przyjmuje zmianę ustawień narzędzia bez świeżego potwierdzenia. Lista w [privileged-actions.ts:16](../apps/api/src/privileged-actions.ts#L16) nie obejmuje tej operacji. Przejęta sesja admina ma więc możliwość zmiany limitów i włączania przyjęć bez ponownego hasła.

**Do zamknięcia:** objąć ustawienia potwierdzeniem związanym z celem, payloadem, wersją i idempotency key. MFA było wcześniej odłożone — nie traktuję tego jako zgody na jego implementację. Przed publicznym wydaniem rekomenduję MFA dla admin/manager; przy utrzymaniu odroczenia ustalić dostęp VPN/zaufana sieć i akceptację ryzyka. Zalecenie: [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

**Odbiór:** przejęta zwykła sesja bez świeżego potwierdzenia nie zmienia ustawień; podmiana parametrów unieważnia potwierdzenie. Sposób ograniczenia dostępu do kont uprzywilejowanych jest przyjęty przez właściciela.

### R04 — P1: czerwone bramki wydania wymagają rozstrzygnięcia

`security-db` nie kończy całego scenariusza `users`. Zwykła regresja pomija 54 scenariusze workera. Uruchomione osobno fixture Compensa/UFG są zielone, ale Everest ma czerwony test w [everest-identity-provider.test.ts:244](../apps/worker/src/everest-identity-provider.test.ts#L244): oczekuje `invalid_pesel` dla numeru syntetycznego, który przechodzi `isValidPesel`. Zgodność sumy kontrolnej i bieżącej funkcji potwierdzono niezależnie. To wskazuje na błąd danych testowych, a nie dowodzi przepuszczania niepoprawnego PESEL-u przez automat.

Osobny test backupu także jest czerwony: [migration-smoke.cjs:4456](../apps/api/scripts/migration-smoke.cjs#L4456) porównuje najnowszą migrację ze stałą `058-preserved-lead-results.js`, choć tryb używa już 060. Dump i odtworzenie poprzedzają tę asercję, ale cały odbiór i kolejne kontrole plików nie dochodzą do PASS.

**Do zamknięcia:** zdiagnozować nieukończony DB smoke, poprawić fixture i oczekiwanie wersji backupu, mieć jawny zestaw wymaganych testów wydania. Uporządkować testową konfigurację `npm test`, aby czyste środowisko nie wymagało domyślania się DATABASE_URL. Nie nadawać PASS całej integracji na podstawie częściowego komunikatu.

**Odbiór:** wszystkie bramki wybranego zakresu kończą się kodem 0, pominięcia mają uzasadniony zakres i odrębne dowody. Dodać powtarzalny pipeline/bramkę release; nie znaleziono wersjonowanej konfiguracji CI w `.github`.

### R05 — P1: brak odebranego środowiska i jednoznacznego wydania

Istnieją [Compose](../compose.production.yaml), walidacja konfiguracji, Nginx, kontrola origin, manifest i instrukcje. Nie dostarczono potwierdzenia docelowego VPS/domeny/TLS/registry. Bardzo duża część ocenianej implementacji nadal jest poza zatwierdzonym commitem.

Przykład `.env.production.example` istnieje lokalnie, ale jest ignorowany przez regułę `.env.*` i nie jest śledzony w Git; wyjątki obejmują tylko `.env.example` i `.env.windows.example`. Czysty checkout nie dostanie więc obecnego szablonu wymaganego w instrukcji wdrożenia. Należy wersjonować bezsekretowy szablon z osobnym wyjątkiem albo przenieść go do śledzonego katalogu konfiguracji.

**Do zamknięcia:** przegląd zmian i czysty commit, obrazy z jednego commita przypięte digestami, migracja, konfiguracja hosta i zewnętrzny test HTTPS. Zweryfikować cookies, CSRF, spoofing XFF, niepubliczne API/DB/Redis/parser, restart i rzeczywisty rollback zgodny ze schematem. W lokalnym wariancie API nadal binduje `0.0.0.0`, a Next startuje bez `-H 127.0.0.1`; nie używać lokalnego startu jako publicznej produkcji. Zauważony PostgreSQL na wszystkich interfejsach wymaga osobnej kontroli hosta, nie dowodzi publicznej dostępności bazy Goldis.

**Odbiór:** wydanie można wskazać SHA/digestem, wdrożyć na czystym hoście i odtworzyć po nieudanej aktualizacji. Dowody testów dotyczą dokładnie tego wydania.

### R06 — P1: backup, odtworzenie i alarmy muszą działać operacyjnie

Kod szyfrowania/manifestów, journal kasowań oraz [procedura restore](../deploy/backup/README.md) są przygotowane. Brak odebranego cold restore kompletnej instalacji na innym hoście, kopii poza hostem, harmonogramu/retencji i zmierzonych RPO/RTO. [Runbook](OPERATIONS_AND_INCIDENTS.md) nadal pozostawia wybór kanału alarmów i operatora. Działający healthcheck nie powiadomi sam operatora.

**Do zamknięcia:** ustawić zewnętrzny magazyn, opiekuna kluczy, harmonogram i monitoring wieku kopii; wykonać odtworzenie wraz z plikami, kluczami, aktualnym journalem i unieważnieniem linków recovery. Alarmy dla offline workera, zaległej kolejki, błędów portali/rejestru, dysku i certyfikatu muszą dotrzeć do konkretnej osoby.

**Odbiór:** kontrolowana awaria wywołuje odebrany alarm; druga maszyna odzyskuje syntetyczną instalację w zmierzonym czasie, bez przywrócenia usuniętych danych. Sam PASS testu kryptografii lub odtworzenia jednorazowej bazy nie zamyka tej bramki.

### R07 — P1: aktualny odbiór biznesowy automatu i reprezentatywna partia

Nie zaczynamy od zera: [test live z 10.10](TEST_CALEGO_FLOW_LIVE_2026-10-10.md) dokumentuje udany pojedynczy wiersz, 49 polis w snapshot i 3 w ówczesnym XLSX. Nie potwierdza to jednak dzisiejszego eksportu, nowych leadów/przydziałów, całej partii ani zmian od tego testu.

**Do zamknięcia:** odebrać aktualny proces import → przygotowanie → rejestr → portale/SMS → wynik → lead → przydział → eksport. Sprawdzić sukces, brak osoby/PESEL/polis, niejednoznaczność, SMS wygasły, awarię dostawcy i restart przy zapisie/UFG/publikacji. Pomiary reprezentatywnej partii wyznaczają limit pierwszej produkcji, czas oczekiwania i wymagania VPS. Pierwsza produkcja jest skonfigurowana pod MF VAT; GUS nie jest brakującą funkcją obowiązkową tego zakresu.

**Odbiór:** brak podwójnego zapisu/UFG po wznowieniu, zgodność snapshot/API/aktualnego Excela/leadu, izolacja rekordów i ról, uzgodniony limit partii oraz procedura zatrzymania. Testy live wymagają osobnego nadzorowanego odbioru; nie wykonywano ich w tym audycie.

### R08 — warunek zakresu: produkcyjne odzyskiwanie konta

Mechanizm i test świeżej bazy są gotowe; starszy błąd `credentialReset` nie powinien być powielany jako aktualny bloker. [password-change.ts](../apps/api/src/password-change.ts) centralizuje zmianę i bezpieczny audyt. Jednak prawdziwa domena, nadawca/DNS Resend, skrzynki i dostarczenie nadal nie są odebrane; funkcja domyślnie jest wyłączona.

**Do zamknięcia:** jeżeli klient otrzymuje samoobsługę — skonfigurować dostawcę, zweryfikować firmowe adresy, dostarczenie, wygasanie i awarie dostawcy/Redis. W pilocie bez poczty konieczna jest sprawdzona procedura odzyskania przez administratora i konkretny kontakt pomocy. Nie obiecywać działającej wysyłki na podstawie samego UI.

## UX i poziom wykończenia

Ocena: spójny produkt z rozpoznawalnym czarno-złotym wyglądem; główne działania są czytelne, formularze mają etykiety, drawer mobile i potwierdzenia partii są zaimplementowane. Najważniejsza praca to dopracowanie stanów i języka.

| ID / priorytet | Potwierdzony problem i wpływ | Zmiana oraz odbiór |
| --- | --- | --- |
| U01 / P2 | [workspace.tsx:237](../apps/web/app/workspace.tsx#L237) pobiera tylko `.data` z hooka gotowości. Po HTTP 503/braku sieci hook ustawia `unknown`, lecz ekran wyświetla stale „Sprawdzanie gotowości usług…”. Odtworzone na desktop/mobile. | Wyświetlać checking/unknown/offline oddzielnie, komunikat i ponowienie; awaria nie wygląda jak trwające ładowanie. `$impeccable harden`. |
| U02 / P2 | [tool-catalog.tsx:32](../apps/web/app/tools/tool-catalog.tsx#L32) przy błędzie pokazuje alert i jednocześnie pusty katalog z sugestią nadania dostępu. Użytkownik może błędnie zgłosić utratę uprawnień. | Osobne stany loading/error/empty/ready i „Spróbuj ponownie”. Test 503 nie pokazuje informacji o braku grantów. `$impeccable harden`. |
| U03 / P2 | [workspace.tsx:1073](../apps/web/app/workspace.tsx#L1073) mówi, że osoba decyzyjna jest opcjonalna; [preparation-analysis.ts:78](../apps/api/src/preparation-analysis.ts#L78) wyklucza jej brak jako `PERSON_REQUIRED`. Import bez osoby jest technicznie dopuszczalny, ale przekaz nie wyjaśnia skutku dla automatu. | „Opcjonalna przy imporcie; wymagana do automatyzacji OC”, przykład poprawnego arkusza i szybka instrukcja poprawy. Pokazać liczbę gotowych/pominiętych przed startem. `$impeccable clarify`, `$impeccable onboard`. |
| U04 / P2 | [ReviewPage.tsx:218](../apps/web/app/review/ReviewPage.tsx#L218) wymaga UUID importu skopiowanego z URL oraz ręcznego `oc-policy-verification`. To utrudnia codzienną pracę klienta. | Wybór importu po nazwie/dacie, narzędzia po nazwie; identyfikatory w szczegółach technicznych. `$impeccable clarify`. |
| U05 / P2 | Powrót po logowaniu jest nierówny: historia zachowuje `returnTo`, [LeadWorkspace.tsx:171](../apps/web/app/leads/LeadWorkspace.tsx#L171) i dashboard prowadzą do `/`. Użytkownik po wygaśnięciu sesji traci miejsce pracy. W LeadWorkspace błąd odczytu sesji także może wyglądać jak wylogowanie. | Wspólna obsługa 401/403/503 i bezpiecznego `returnTo`, zachowanie kontekstu strony/filtrów. `$impeccable harden`. |
| U06 / P2 | Małe linki dodatkowe mają 17–23 px wysokości; część kontrolek tabel poniżej zalecanych 44 px. Zakładki review mają role ARIA, ale brak obsługi strzałek/powiązania paneli. | Zwiększyć obszary dotykowe i sprawdzić klawiaturę/zoom/kontrast. Sam pomiar małego linku nie jest dowodem naruszenia WCAG, bo istnieją wyjątki dotyczące odstępów i linków w tekście. `$impeccable adapt`. |
| U07 / P3 | Duży nagłówek i rozbudowany blok interwencji przesuwają podstawowy upload poniżej pierwszego ekranu. W przykładzie mobile jest ponad ekran przewijania przed polem pliku. Starsze globalne CSS są nadal nadpisywane motywem i osobnymi tokenami leadów. | Skrócić nagłówek narzędzia, zachować widoczny kontekst aktualnego kroku i ujednolicić tokeny przy końcowym porządkowaniu. Nie wymaga zmiany identyfikacji wizualnej. `$impeccable distill`, na końcu `$impeccable polish`. |

Nie proponuję blokować wydania przebudową dashboardu, kolejnymi animacjami ani wdrożeniem nieodebranych dodatkowych narzędzi. W katalogu działa dedykowany interfejs OC; nowe moduły wymagają osobnego kompletnego przepływu albo wyraźnego statusu niedostępności.

### Techniczna ocena interfejsu — ograniczona do sprawdzonej próbki

| Wymiar | Ocena 0–4 | Uzasadnienie |
| --- | --- | --- |
| Dostępność | 2 | Etykiety, focus i mobile drawer są; pozostają zakładki, małe cele i pełny odbiór klawiatury/kontrastu. Nie jest to certyfikacja WCAG. |
| Wydajność UI | 3 | Build przechodzi, paginacja/polling są kontrolowane; brak błędów JS w próbce. Brak pomiarów na finalnym VPS i dużych danych. |
| Responsywność | 3 | Brak overflow strony w 375/1440, osobny smoke partii obejmuje 320–1920; dotyk na urządzeniu pozostaje niesprawdzony. |
| Motyw i tokeny | 2 | Spójny wygląd końcowy, ale kilka warstw starego CSS i zdublowane tokeny. |
| Spójność implementacji | 3 | Główne przepływy i potwierdzenia są rzeczywiste; błędy statusów i techniczne filtry wymagają poprawy. |
| Razem | **13/20** | Ocena jakości próbki frontendu, nie procent gotowości produkcji ani gwarancja bezpieczeństwa. |

Detektor zgłosił 16 ostrzeżeń o bocznych akcentach obramowań. Po sprawdzeniu kontekstu nie uznaję ich za 16 defektów: większość oznacza stan aktywny/ostrzeżenie, co jest zgodne z obecnym projektem. Globalne `prefers-reduced-motion` używa `.01ms`; warto docelowo ograniczać konkretne animacje, ale nie wykazano tu utraty funkcjonalności. Brak PRODUCT.md/DESIGN.md jest luką dokumentacji, nie podstawą do przeprojektowania aplikacji.

## Kolejność domknięcia

1. **Dostęp i sekrety:** R01–R03; potwierdzić model wspólnych wyników z klientem.
2. **Bramki techniczne:** R04 i U01–U03/U05; mieć wiarygodny zielony zestaw wymagany do wydania.
3. **Staging z docelowymi obrazami:** R05, R08; pełny przepływ na syntetycznych danych i role.
4. **Utrzymanie:** R06; kopia poza hostem, odtworzenie i dostarczony alarm, właściciel incydentu.
5. **Odbiór narzędzia i ograniczony start:** R07, U04/U06, końcowe `$impeccable polish`; klient wykonuje swoje codzienne zadania bez prowadzenia przez autora.

Przed danymi klienta trzeba również potwierdzić poza repozytorium zasady dostępu osób utrzymujących system, retencję/eksporty, odpowiedzialność za dane i kanał wsparcia. Audyt kodu nie ustala, jakie uzgodnienia organizacyjne już istnieją.

## Zależności i źródła

Aktualny skan jest w [npm-audit-production.json](audit-production-2026-10-15/npm-audit-production.json). Dwa źródłowe advisory: [uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). Pierwsze dotyczy wybranych metod UUID i bufora, drugie nieograniczonej precyzji formatu. Nie odtworzono osiągalnego exploitu w Goldis. Utrzymać decyzję o wyjątkach/przeglądzie; nie stosować automatycznego niezgodnego downgrade z `audit fix --force`.

Starsze ustalenia trzeba czytać wraz z poprawkami: grant TEMP migratora i runtime smoke są dzisiaj zielone, reset/recovery ma nowy wspólny helper, Compose ma healthchecki i aktualny wzór Nginx ma limit uploadu. Nie są raportowane ponownie jako nierozwiązane błędy.
