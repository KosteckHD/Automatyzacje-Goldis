# Audyt całej platformy Goldis — 8 października 2026

## Ocena i decyzja odbiorowa

**Platforma jest zaawansowanym rozwiązaniem przed odbiorem produkcyjnym. Większość funkcji istnieje i przechodzi testy, ale nie ma podstaw do uznania całej platformy ani automatyzacji za w pełni odebraną.** Najwięcej pracy pozostaje przy potwierdzeniu integracji najnowszych zmian, bezpieczeństwie wdrożenia, odzyskiwaniu po awariach oraz konfiguracji i odbiorze portali.

| Co oceniamy | Ocena szacunkowa | Znaczenie |
| --- | --- | --- |
| Kompletność funkcjonalna platformy | **85–90%** | Import, historie, review, partie, granty, administracja, interwencje, audyt, raporty i eksport mają implementację. Braki dotyczą przede wszystkim wykończenia UI i funkcji ochrony/utrzymania. |
| Gotowość platformy do bezpiecznej eksploatacji produkcyjnej | **60–70%** | Build i testy modułów są zielone. Otwarte pozostają integracje nowego bezpieczeństwa, HTTPS, MFA, backup całości, retencja, monitoring i identyfikowalne wydanie. |
| Kompletność kodu automatyzacji | **80–85%** | Są adaptery PZU/Everest, Compensa, UFG, SMS, checkpointy, kolejka, wynik i eksport. Brakuje zweryfikowanej konfiguracji całego live i dowodów działania na rzeczywistych ekranach. |
| Odbiór całej automatyzacji biznesowej | **NIEZALICZONY** | Nie potwierdzono wspólnego procesu na docelowej instalacji i autoryzowanych danych. Zaliczony fixture adaptera nie zamyka tego odbioru. |
| Praca całkowicie bez operatora | **NIEGOTOWA** | SMS, niejednoznaczna tożsamość, brakujące dane i niepewne akcje portalu zatrzymują proces do interwencji. |

Procenty są oceną inżynierską zakresu, z marginesem 5–10 punktów. Uwzględniają obecność funkcji, jakość dowodów oraz otwarte bramy wydania. Nie są pomiarem pokrycia testami, udziałem odhaczonych historycznych checklist ani formalnym protokołem odbioru. Bramka bezpieczeństwa lub poprawności danych nie przestaje blokować wydania dlatego, że pozostałe funkcje są gotowe.

**Rekomendowany status: platforma do domknięcia i odbioru technicznego; automatyzacja live `DO_ODBIORU_UZYTKOWNIKA`.**

## Zakres i wiarygodność audytu

- Badano aktualne drzewo robocze, włącznie z wcześniejszymi niezatwierdzonymi zmianami. Bazowy HEAD: `e3a507ea8e534f06d698289bf1165f79691e5a6d`. To nie jest identyfikator całej badanej wersji: istotna część kodu istnieje poza commitem.
- Przegląd obejmuje monorepo: core, API NestJS, web Next.js, worker Playwright, schemat/migracje, Compose, skrypty testowe, dokumentację i bramki administracji/automatyzacji/bezpieczeństwa.
- Wykonano świeży build, testy core/API/workera, izolowane testy przeglądarkowe adapterów i UI, test CSP oraz skan zależności. Obejrzano aktualne zrzuty desktop/mobile i sprawdzono wybrane style obliczone przez przeglądarkę.
- UI testowano z syntetycznym API. Adaptery portali używały lokalnych stron fixture i odrębnych profili. Nie wykonywano importów do istniejącej instalacji, ofert w Compensie, zapytań MF/GUS ani operacji na prawdziwych portalach.
- Nie odczytywano prywatnych plików `.env` ani profili sesji. Nie potwierdzono prywatnej konfiguracji działającego wdrożenia.
- Docker Desktop Linux Engine nie odpowiada. Na porcie 5432 działa lokalny PostgreSQL, ale nie kierowano do niego testów ani migracji. API/web/Redis nie nasłuchiwały na standardowych portach 3001/3000/6379 podczas inspekcji.
- Najnowszy opis historycznie sprawdzonego wdrożenia pochodzi z 7 października i dotyczy schematu do **030**. Obecny kod zawiera migracje do **033**. Aktualnego schematu instalacji nie ustalono.

Pełny proces i portale pozostają pod kontrolą użytkownika zgodnie z rewizją 2 [planu z 7 października](PLAN_DOMKNIECIA_PLATFORMY_AUTOMATYZACJI_2026_10_07.md). Audyt nie zmienia tego ustalenia ani nie włącza live.

## Świeże dowody

| Sprawdzenie | Wynik | Granica dowodu |
| --- | --- | --- |
| `npm run build` | PASS — core/API/worker/web | Kompilacja; nie odbiór działających usług. |
| Testy core | 13/13 PASS | Reguły danych i kontrakty. |
| Testy API | 159/159 PASS | Testy jednostkowe/kontraktowe i HTTP z zastępczymi zależnościami; nie nowy odbiór PostgreSQL/Redis. |
| Domyślne testy workera | 66 PASS, 37 SKIP | Pominięcia dotyczą testów wymagających przeglądarki. |
| Preflight | 3/3 PASS | Walidacja konfiguracji na syntetycznych wartościach. |
| Runner modułów przez npm | 11/11 PASS | Izolacja, jawne pliki, neutralizacja flag pełnego procesu. |
| Everest browser | 3/3 PASS | Lokalny adapter na fikcyjnych ekranach. |
| Compensa browser | 22/22 PASS | Formularz, sesja i zapis; lokalne fixture. |
| UFG browser | 4/4 PASS | Snapshot, kompletność i reguły OC; lokalne fixture. |
| PZU/session/browser | 19/19 PASS | SMS/iframe/resend/expiry, sesja i tabela wirtualizowana; lokalne fixture. |
| UI: granty, admin, historie, review, audyt, partie, SMS, enrichment | 8 zestawów PASS | Rzeczywisty frontend i syntetyczne odpowiedzi API; responsywność oraz interakcje w zakresie scenariuszy. |
| CSP/security browser | PASS | Blokada inline script bez nonce, zgodność nonce, no-store, anti-frame i sygnał aktywności. |
| `npm audit --json` | 0 critical, 0 high, 7 moderate | Skan znanych zgłoszeń dla zależności; nie pełny test bezpieczeństwa aplikacji. |
| Integracje obecnego schematu PostgreSQL/Redis | BLOCKED | Niedostępny Docker, niewykonane zestawy integracyjne obecnej wersji. |
| HTTPS staging i odbiór live | NIEWYKONANE | Brak dowodu z docelowego wdrożenia. |

W czterech izolowanych zestawach przeglądarkowych wykonano także wszystkie 37 przypadków pominiętych w domyślnych testach workera. Łączne 48 wykonań tych zestawów obejmuje również powtarzające się przypadki nieprzeglądarkowe; nie należy dodawać wszystkich liczb jako liczby unikalnych testów.

Pierwsze dwa błędy własnego harnessu audytu nie były błędami produktu: runner uruchomiono bez wymaganego kontekstu npm, a instrumentacja screenshotów naruszyła warunkowy zapis zrzutu W4. Po poprawieniu sposobu uruchomienia/instrumentacji oba zestawy przeszły. Surowe próby zachowano; wynik końcowy i wyjaśnienia są w [evidence-summary.json](audit-platform-2026-10-08/evidence-summary.json).

## Stan funkcji

| Obszar | Co jest | Co pozostaje do zamknięcia |
| --- | --- | --- |
| Import i walidacja | XLSX/Realizacja, wymagane kolumny, ograniczenia uploadu i ZIP/XML, walidacja REGON/NIP, oddzielna wartość źródłowa i operacyjna. | Pomiar pamięci/czasu na dużym wejściu, odbiór limitów pod obciążeniem; parser nie ma osobnego procesu z twardym limitem RSS. |
| Korekty i konflikty | Kolejki review, wersje/CAS, decyzje, grupowanie podmiotów, konflikty identyfikatorów. | Aktualna macierz ról z prawdziwą DB, wyścigi decyzji i benchmark szerokich grup na docelowym sprzęcie. |
| Rejestr NIP → REGON | MF VAT i GUS BIR, batch, trwały budżet, HMAC cache, joby, retry/cancel i osobny worker. | Konfiguracja dostawcy, klucz BIR/HMAC w docelowym środowisku, odbiór rzeczywistych odpowiedzi i ograniczeń. Brak wyniku MF nie dowodzi nieistnienia firmy. |
| Partie i zadania | Preview zakresu/listy, explicit confirmation, trwały submission, deduplikacja, outbox, kolejka, anulowanie i wznawianie. | Potwierdzenie aktualnych grantów/sesji po migracjach bezpieczeństwa na DB; integracyjne awarie granic modułów. |
| Administracja | Użytkownicy, role, niezależne granty, sesje, reset/disable, ustawienia, przydział interwencji, centrum operacyjne. | MFA/recovery/step-up, pełna macierz czterech ról oraz produkcyjna topologia proxy. |
| SMS/interwencje | Jednorazowy bufor kodu, termin/próby, modal, ręczny resend, przydział i korekty danych. | Odbiór aktualnych ekranów portali i polityki wznowienia; jawna decyzja, czy produkt ma być całkowicie bezobsługowy. |
| Wynik i eksport | Walidowany snapshot, 12 pól OC, filtr daty, jawny wynik zerowy, atomowy zapis pliku, metadane/hash, prywatne pobranie. | Integracyjne awarie dysku/DB/API, uzgadnianie osieroconych plików, retencja i backup całego magazynu. |
| Historie/audyt/raporty | Listy i filtry, scope tenant, audit pobrania przez artifactId, agregaty i kody powodów. | Odbiór spójności liczb i uprawnień na obecnej wersji DB, testy szerokich okresów i obciążenia. |
| Interfejs | Spójny kierunek Goldis, lokalne fonty, mobilna nawigacja, modale z obsługą focus, stany błędów. | Potwierdzona regresja kontrastu enrichment, niepełne pokrycie motywem nowych kart admina, drobne cele dotykowe, visual/a11y regression. |
| Eksploatacja | Compose, trwałe wolumeny, preflight, health/heartbeat i manifest API. | HTTPS, konta o małych prawach, Redis ACL, non-root API/web, alerty, pełny restore, release/rollback i CI. |

## Ustalenia według priorytetu

P0 oznacza bramkę uniemożliwiającą uznanie wskazanego zakresu za gotowy. P1 należy zamknąć przed produkcją. P2 oznacza pracę do wykończenia lub udokumentowanego ograniczenia. **Brak dowodu odbioru nie jest tutaj deklaracją potwierdzonego exploitu.**

### A01 — P0: pełny proces live nie ma odbioru

**Typ:** brak konfiguracji i dowodu. **Dotyczy:** automatyzacji OC.

W repozytorium są `config/portal-selectors.example.json` oraz obserwacja formularza SMS PZU. Przykład zawiera `UNVERIFIED` i `example.invalid` dla dalszych ekranów. Loader świadomie odrzuca taki plik. Implementacja walidacji konfiguracji nie dowodzi poprawności selektorów na portalu. Nie sprawdzono prywatnego pliku live ani nie można potwierdzić istnienia kompletnego zestawu poza repozytorium.

**Skutek:** poprawny build nie oznacza możliwości uruchomienia rzeczywistej weryfikacji. **Zamknięcie:** kompletna wersjonowana konfiguracja PZU/Everest/Compensa/UFG, weryfikacja na docelowych ekranach i kontrolowany odbiór biznesowy z wynikiem porównanym do portalu. Odbiór live wykonuje się na odrębne zlecenie użytkownika.

### A02 — P1: najnowsze bezpieczeństwo i migracje nie są odebrane integracyjnie

**Typ:** brak dowodu. **Dowody:** migracje 031–033, `session.ts`, `admin.ts`, `authorization-guard.ts`, `login-rate-limiter.ts`, [raport wdrożenia bezpieczeństwa](SECURITY_IMPLEMENTATION_STATUS_2026_10_08.md).

Kod zawiera rewizje poświadczeń/blokady, niezależne granty pobrania, nowe limitery i idle timeout. Nie należy ponownie przedstawiać dawnych luk SEC-01–SEC-10 jako nadal odtworzonych w tej wersji: poprawki istnieją. Nie ma jednak nowego potwierdzenia ich zachowania na PostgreSQL/Redis.

**Zamknięcie:** izolowane upgrade od 030 do 033 i rerun; próby starej bazy/rollbacku; `security-db` oraz `security-redis`; równoczesny login/reset/change-password; cofnięcie konta/grantu podczas operacji; cztery role i dwa tenanty; awaria i recovery Redis, proxy spoofing i odrzucenie wygasłej sesji. Każdy moduł z własnym syntetycznym seedem.

### A03 — P1: brak MFA/recovery i świeżego potwierdzenia administracji

**Typ:** brak implementacji. **Dotyczy:** sesji i administracji.

Idle timeout 30 minut jest zaimplementowany. Brakuje TOTP/recovery oraz step-up przed uprzywilejowanymi zmianami. Dialog „potwierdź” w UI potwierdza zamiar, lecz nie jest ponownym uwierzytelnieniem.

**Zamknięcie:** enrollment, kody recovery, limity prób, utrata urządzenia, unieważnianie sesji oraz krótka ważność step-up dla resetu hasła, ról/grantów i innych wskazanych zmian.

### A04 — P1: brak domkniętego profilu produkcyjnego

**Typ:** brak implementacji/konfiguracji. **Dowody:** `compose.yaml`, Dockerfile API/web/worker.

Compose odseparowuje sieć danych i nie publikuje PostgreSQL/Redis w bazowym profilu. Jednocześnie API uruchamia migracje tym samym użytkownikiem DB co aplikację; Redis nie ma skonfigurowanych ACL; API/web nie deklarują użytkownika runtime non-root. `APP_ENV` domyślnie pozostaje development dla backendu/workera. Brakuje HTTPS/edge i odbioru secure cookies/proxy na staging.

**Zamknięcie:** osobne konto migratora/runtime, ograniczone prawa DB i Redis, non-root API/web, jawne production env, TLS/origin/trusted proxy i black-box test staging. Lokalny profil development można zachować osobno.

### A05 — P1: kopia całego systemu i procedura odtworzenia są niepełne

**Typ:** brak dowodu/procedury. **Dowód historyczny:** dump/restore DB 030 oraz syntetycznego eksportu.

Dotychczasowy test nie dowodzi odtworzenia obecnej DB, rzeczywistego magazynu eksportów i kluczy PESEL/stagingu w jednej zgodnej wersji. Utrata klucza uniemożliwia odczyt szyfrowanych danych nawet przy poprawnej kopii DB.

**Zamknięcie:** spójny backup DB 033, eksportów i keyringu; bezpieczna kopia konfiguracji; restore do odrębnej instalacji; próby brakującego/złego/starego klucza; porównanie hashy i praw pobrania; określone RPO/RTO, harmonogram i alert błędu kopii. Nie wykonywać testu restore przez nadpisanie istniejącej instalacji.

### A06 — P1: regresja kontrastu w panelu enrichment

**Typ:** potwierdzony defekt UI. **Lokalizacja:** `apps/web/app/enrichment-jobs.css:1`, `:17`, globalny motyw i kolejność importów w `layout.tsx:10`.

`.enrichment-job-panel` ma tło `#fbfcfd`; nagłówek i część opisu dziedziczą `#f2eee5`. Z pomiaru obliczonych stylów: **1,127:1**. Wiersze jobów mają biały background i jasny tekst: **1,158:1**; część opisów/czasu ma **2,455:1**. Są to teksty informacyjne, a nie tylko wyłączone przyciski. Problem potwierdzono na zrzutach i w aktywnym fixture dostawcy.

Dla zwykłego tekstu kryterium AA wymaga co najmniej 4,5:1, a dla dużego 3:1. [W3C — Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

**Skutek:** operator z trudnością odczytuje instrukcje i stan wzbogacania. **Zamknięcie:** zastąpienie legacy kolorów tokenami, właściwa kolejność/zakres CSS, kontrola kontrastu aktywnego/disabled/offline/error i test wizualny desktop/mobile. Zrzuty fixture zawierają komunikaty „synthetic request”; te komunikaty są ograniczeniem fixture, nie zgłoszeniem błędu rzeczywistego API.

### A07 — P1: brak operacyjnych alertów i polityki retencji

**Typ:** brak domkniętej implementacji/ustaleń. **Dotyczy:** utrzymania, danych i wyników.

Health oraz centrum operacyjne istnieją, ale nie znaleziono wdrożonego kanału alarmowania o martwym workerze, wieku kolejki/outboxu, błędzie backupu, braku dysku i zmianie portalu. Retencja nie ma zatwierdzonych okresów i pełnej procedury obejmującej importy, PESEL, snapshoty, XLSX, staging, audyt i kopie.

**Zamknięcie:** ustalenie okresów z właścicielem danych, dry-run/liczniki, blokady dla aktywnych procesów, audyt usuwania, metryki/alerty z deduplikacją i sprawdzone dostarczenie alarmu do wskazanego odbiorcy. Sam status w otwartym panelu nie zastępuje alertu.

### A08 — P1: brak aktualnego odbioru awarii granic storage/DB/API

**Typ:** brak dowodu oraz brak operacyjnego uzgadniania.

Eksport zapisuje plik przed metadanymi DB. To chroni przed gotowym wpisem bez pliku, ale crash po publikacji przed commit może zostawić orphan. `findOrphanedArtifacts` jest zaimplementowane i testowane, lecz w przejrzanym kodzie wywołują je tylko testy; nie ma podłączonego zadania operacyjnego.

**Zamknięcie:** pojedyncze modułowe próby disk-full/readonly, błędu po rename, rollbacku DB, utraty odpowiedzi API i restartu delivery; uzgadnianie orphanów z okresem ochronnym, licznikami i dry-run. Powtórka eksportu/dostarczenia ma dać jeden prawidłowy wynik bez ponownej akcji portalu.

### A09 — P2: wykończenie interfejsu i pokrycie testów wizualnych

**Typ:** potwierdzona niespójność i luka w weryfikacji.

Nowe `.admin-runtime-manifest`/`.admin-enrichment-strip` pozostają jasnymi kartami w ciemnym interfejsie (`admin.css:10`). Ich własny ciemny tekst jest czytelny — nie przypisano im automatycznie tego samego błędu kontrastu co A06. Motyw nie pokrywa jeszcze wszystkich nowych elementów.

Na mobile linki nawigacji historii/audytu mają około 19 px wysokości. To kandydat do poprawy celów dotykowych, nie automatyczny werdykt naruszenia: należy sprawdzić odstępy i wyjątki kryterium. [W3C — Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

Globalny reduced-motion sprowadza wszystkie animacje i transition do `.01ms`; warto zastosować celowe warianty pozostawiające informację o zmianie stanu. Nie wykazano przez to utraty działania funkcji.

**Zamknięcie:** pokrycie tokenami nowych kart, większe pola dotykowe w odpowiednich widokach, spójne komunikaty operatora, a11y/contrast oraz wizualne regresje. `workspace.tsx` i `admin/page.tsx` skupiają wiele odpowiedzialności; dalsze wydzielanie komponentów powinno towarzyszyć zmianom, bez zbędnej przebudowy ukończonych funkcji.

### A10 — P2: wydajność i limity nie mają docelowego SLA

**Typ:** częściowy dowód historyczny.

Grupowanie jest indeksowane. Historyczny syntetyczny test wskazał jednak **443 SQL dla grupy 40**; kod rozstrzyga powiązane rekordy kolejno. Nie jest to dowód niedopuszczalnego czasu na docelowym sprzęcie, lecz konkretny koszt do pomiaru. Import ma preflight i ograniczenie współbieżności, ale parser działa w procesie API. Brakuje benchmarku dużego importu, szerokich grup, raportów i kosztu KDF.

**Zamknięcie:** ustalić maksymalny import/partię i czas reakcji; pomierzyć p95, RSS, DB pool i liczbę SQL na sprzęcie docelowym. Dopiero według wyniku wdrożyć bulk albo izolację parsera i potwierdzić semantykę konfliktów.

### A11 — P2: wydanie i dokumentacja nie identyfikują jednej wersji

**Typ:** brak procesu i niespójność dokumentacji.

Manifest ma bezpieczne fallbacki/null, ale Compose/Dockerfile nie wypełniają automatycznie wersji/commitu/digestu całego wydania. Nie znaleziono CI w repozytorium ani jednego zestawu bramek wydania obejmującego wszystkie istotne moduły. `npm test` nie wykonuje smoke UI ani przeglądarkowych adapterów domyślnie. Dokumenty zachowują historyczne otwarte checkboxy i informację 030 obok późniejszych poprawek 033.

**Zamknięcie:** checkpoint przetestowanego kodu, manifest release z faktycznymi obrazami/schema/config, bramki CI z oddzielnymi izolowanymi modułami, instrukcja rollout/rollback oraz jedna aktualna macierz odbioru. Historyczne wyniki zachować jako historię, nie jako stan dzisiejszej wersji.

### A12 — P2: pozostają zgłoszenia zależności moderate

**Typ:** potwierdzony wynik skanu; nie potwierdzony exploit aplikacji.

Skan raportuje 7 pakietów na ścieżkach `uuid` oraz `sprintf-js` i ich rodziców (ExcelJS/Sequelize/Umzug). Nie oznacza to siedmiu niezależnych exploitów. Istnieją [decyzje zależności](security/DEPENDENCY_DECISIONS_2026_10_08.md).

**Zamknięcie:** utrzymywać ocenę osiągalności, właściciela wyjątku i termin ponownego przeglądu; aktualizować zależności w kompatybilnym zakresie z regresjami. Nie traktować automatycznej sugestii downgrade major jako bezpiecznej naprawy.

## Techniczny audyt UI

System wizualny wyraźnie odpowiada produktowi Goldis: logo, lokalna typografia, tokeny, ciemne powierzchnie i złote akcenty. **Spójność produktu: PASS z lokalną regresją A06/A09.** Mechaniczny detector zwrócił 14 ostrzeżeń z dwóch wzorców akcentowanych obramowań. Nie policzono ich jako 14 defektów: część to legacy CSS nadpisany przez motyw, a część świadome elementy marki. Dowód runtime ma pierwszeństwo nad samą heurystyką detektora.

| Wymiar | Ocena 0–4 | Wniosek |
| --- | --- | --- |
| Dostępność | 2 | Nazwy kontrolek, focus trap i focus return działają w sprawdzonych scenariuszach; A06 powoduje duży problem czytelności. |
| Wydajność interfejsu | 2 | Lokalny build działa, fonty są lokalne; brak docelowego pomiaru interakcji/bundle/obciążenia. Ocena wstępna. |
| Responsywność | 3 | Sprawdzone scenariusze 320–1920 px bez overflow strony; tabele mają kontrolowany scroll. Pozostają cele dotykowe. |
| Motyw/tokeny | 2 | Działający system tokenów, ale legacy enrichment i nowe karty administracji nie są w pełni pokryte. |
| Spójność implementacji | 3 | Czytelne stany i produktowy system; lokalny dryf CSS oraz zbyt mała kontrola wizualna testów. |
| **Razem** | **12/20** | Do wykończenia przed wydaniem; nie jest to wynik certyfikacji WCAG. |

W zaobserwowanych zrzutach nie znaleziono nienazwanych widocznych kontrolek. Nie potwierdzono pełnej obsługi czytników ekranu, fizycznego urządzenia dotykowego ani całej macierzy zoom/text-spacing. Emulacja viewportu i test klawiatury nie dowodzą tych aspektów.

Kolejność pracy UI: `$impeccable harden` dla A06 i stanów błędów, `$impeccable adapt` dla odpowiednich celów dotykowych, `$impeccable document` dla utrwalenia systemu, a na końcu `$impeccable polish`. Ocena całej platformy nie wymaga jej redesignu.

## Co trzeba zrobić, aby skończyć automatyzację

1. **Ustalić kontrakt biznesowy obsługiwanych podmiotów.** Resolver tożsamości potwierdza zgodną działalność gospodarczą/osobę, REGON/nazwę i poprawny PESEL. Dla spółek, wielu dopasowań lub rozbieżności nie należy zakładać automatycznej obsługi wszystkich przypadków. To wymaga decyzji o zakresie i osobnego kontraktu danych.
2. **Domknąć jakość wejścia.** Poprawny effective REGON, dane osoby/adresu/kodu/miasta i dostępny powiat muszą pochodzić z zatwierdzonych źródeł. Import nie zapewnia samodzielnie wszystkich danych potrzebnych formularzowi. Compensa zachowuje istniejące dane i zatrzymuje się przy braku powiatu; to świadoma interwencja.
3. **Skonfigurować i odebrać rejestr.** Dostawca pozostaje domyślnie disabled. BIR wymaga klucza i konfiguracji HMAC, MF ma ograniczenie pokrycia. W fabryce wybiera się jeden provider — automatyczny fallback MF→BIR nie jest obecnie zaimplementowany. Jest potrzebny tylko wtedy, gdy tak zdefiniowano wymaganie biznesowe.
4. **Zweryfikować pełne selektory portali.** Osobno PZU SSO/SMS, nawigacja i wyniki Everestu, Compensa login/start/form/zapis/numer sprawy oraz UFG/modal/wirtualizowana tabela i wszystkie pola OC. Część obserwacji SMS PZU już istnieje; nie oznacza odbioru całego portalu.
5. **Odebrać sesje i SMS.** Wykazać reużycie profilu, reentry, expiry, rejected code, resend i restart. SMS wymaga ręcznego przekazania w aktualnym produkcie. Pełna bezobsługowość wymaga osobnej uzgodnionej strategii dostarczania kodów albo obsługiwanej integracji uwierzytelnienia; samo przełączenie flagi nie zapewnia tego zachowania.
6. **Odebrać idempotencję rzeczywistych akcji.** Jedna sprawa/oferta i jedna autoryzowana weryfikacja na zadanie, także po timeoutcie „Zapisz”, restarcie i wygaśnięciu lease. Nierozstrzygnięty zapis musi trafić do kontroli, nie do ślepego retry. Lokalne fixture tego mechanizmu są zaliczone; brak odbioru live.
7. **Porównać rzeczywisty wynik.** Tożsamość, numer sprawy, kompletna liczba wierszy, 12 pól OC i filtr daty odniesienia; jawny wynik zerowy oraz pobranie właściwego XLSX. Weryfikować wartości, nie tylko końcowy status „completed”.
8. **Domknąć bramy utrzymania.** Bezpieczeństwo DB/Redis, storage recovery, backup kluczy/eksportów, retencja i alerting muszą działać również dla automatyzacji, nie tylko panelu.
9. **Przeprowadzić odbiór biznesowy przez użytkownika.** Po przygotowaniu modułów zapisać wersję wydania, scenariusze, wynik porównania, liczniki działań portali i akceptację. Audyt nie uruchamia takiego pilotażu ani serii.

Automatyzację można uznać za kompletną w modelu **automatyczny przebieg poprawnych danych + kontrolowana obsługa wyjątków**. Jeśli wymaganie brzmi „każdy rekord bez człowieka”, obecny zakres tego nie spełnia: SMS i niejednoznaczne dane pozostają zależnościami. Nie należy usuwać tych zatrzymań kosztem poprawności tożsamości i braku podwójnych ofert.

## Kolejność domknięcia i kryteria przekazania

| Etap | Zakres | Mierzalny warunek zakończenia |
| --- | --- | --- |
| 1 | Środowisko izolowanych testów + A02 | DB 033 upgrade/rerun, security-db i Redis PASS; macierz ról/tenantów i konkurencji bez nieautoryzowanych skutków. |
| 2 | A06/A09: wykończenie UI | Kontrast aktywnych tekstów zaliczony, motyw kart spójny, scenariusze 320/768/1920 px i klawiatura PASS, brak regresji stanów błędów. |
| 3 | A03/A04: ochrona i staging | MFA/recovery/step-up, HTTPS/cookie/proxy, małe prawa runtime i testy staging PASS. |
| 4 | A05/A07/A08: utrzymanie | Pełny restore 033+exports+keys, fault injection, retencja dry-run i dostarczone alarmy; uzgodnione RPO/RTO. |
| 5 | A10/A11/A12: wydanie | Docelowe pomiary, zidentyfikowane obrazy/schema, CI modułów, aktualna instrukcja i utrzymane decyzje zależności. |
| 6 | Konfiguracja i odbiór automatyzacji | Oddzielne kontrakty modułów odebrane; następnie świadomie zlecony odbiór live i biznesowa akceptacja użytkownika. |

Nie ma wiarygodnej podstawy do podania terminu kalendarzowego bez działającego środowiska integracyjnego, dostępu do ekranów portali i decyzji o zakresie bezobsługowości. Wąskim gardłem są dowody i konfiguracja docelowa; platforma nie wymaga pisania większości funkcji od nowa.

## Artefakty audytu

- [Wynik końcowy i granice testów](audit-platform-2026-10-08/evidence-summary.json)
- [Skan zależności](audit-platform-2026-10-08/npm-audit.json)
- [Pomiar kontrastu wybranych nieprzezroczystych powierzchni](audit-platform-2026-10-08/contrast-findings.json)
- [Mechaniczne ostrzeżenia UI](audit-platform-2026-10-08/ui-detector.json)
- [Panel wzbogacania — desktop](audit-platform-2026-10-08/screenshots/registry-desktop.png)
- [Panel wzbogacania — 320 px](audit-platform-2026-10-08/screenshots/registry-mobile-320.png)
- [Administracja — mobile](audit-platform-2026-10-08/screenshots/admin-mobile.png)
- [Harness audytu](audit-platform-2026-10-08/run-audit.cjs) i logi w tym samym katalogu. Zrzuty i instrumentację odseparowano od wcześniejszych referencji wizualnych.

W ramach audytu dodano raport i jego dowody. Nie wdrożono napraw funkcji, nie migrowano istniejącej bazy i nie włączono dostawców ani portali.
