# Plan wykonania automatyzacji OC w Playwright

**Stan: 30.09.2026.** Ten plan zastępuje węższy plan samej sesji PZU. Celem jest jedna działająca aplikacja: import wskazanego wiersza → PZU/Everest → Compensa → UFG → wynik Excel, uruchamiana z panelu Goldis i korzystająca z trwałej sesji przeglądarki na komputerze operatora.

> **Uwaga o aktualności:** lista „Co już jest, a czego brakuje” poniżej opisuje punkt startowy sprzed podłączenia `LiveRunProcessor`. Bieżące zmiany, gotowość obsługi SMS i niezweryfikowane bramki są opisane w [stanie implementacji](STAN_IMPLEMENTACJI.md).

## Decyzja techniczna: przeglądarka na komputerze operatora

Pierwszy działający wariant uruchamia **widoczne okno Chromium/Chrome sterowane przez Playwright na komputerze operatora** (`headless: false`) z osobnym stałym katalogiem `worker-profiles/local-portals/`. Katalog jest już objęty `.gitignore`. Operator loguje się tam do PZU i ewentualnie Compensy oraz przekazuje SMS tylko wtedy, gdy portal go wymaga. Kolejne zadania używają tego samego procesu i profilu; po restarcie proces otwiera ten sam profil i sprawdza, czy portal nadal akceptuje sesję. Profil wymaga prywatnych uprawnień do plików i nigdy nie może być uruchomiony równolegle przez drugi proces.

Zwykła, już otwarta karta w codziennym Chrome **nie jest domyślnym punktem podłączenia**. Playwright ostrzega przed automatyzacją głównego profilu Chrome i przed jednoczesnym otwarciem dwóch instancji na tym samym katalogu. `connectOverCDP` działa tylko do przeglądarki udostępniającej endpoint debugowania i daje słabszą integrację; Chrome od wersji 136 nie respektuje zdalnego debugowania na domyślnym katalogu profilu. Jeśli użytkownik już pracuje w specjalnie uruchomionej przeglądarce z osobnym profilem i lokalnym endpointem CDP, można dodać tryb podłączenia jako opcję po odbiorze głównego wariantu. Nie przenosić ciasteczek z codziennej przeglądarki.

Źródła: [Playwright `launchPersistentContext` i `connectOverCDP`](https://playwright.dev/docs/api/class-browsertype), [zmiana Chrome dotycząca zdalnego debugowania](https://developer.chrome.com/blog/remote-debugging-port).

**Granica obietnicy:** można usunąć zbędny SMS przy każdym wierszu. Nie można obiecać jednego SMS na zawsze: PZU lub Compensa mogą wygasić sesję albo ponownie zażądać MFA.

## Co już jest, a czego brakuje

| Obszar | Obecny kod | Luka do zamknięcia |
| --- | --- | --- |
| Start zadania | Panel/API, PostgreSQL, BullMQ, `runId`, historia | `run-worker.ts` parkuje poprawny run w `awaiting_portal_adapter`; nie uruchamia Playwright |
| Przeglądarka | `BrowserSession` ma trwały profil i kartę na portal | Konfiguracja widocznego trybu Windows, jeden właściciel profilu, wiarygodna kontrola sesji po restarcie |
| PZU/Everest | `PzuEverestSession`, `EverestIdentityProvider` i testy syntetyczne | Żywe selektory, przejście do Everest, podłączenie do joba, trwały zaszyfrowany checkpoint osoby |
| SMS | Panel, API, challenge i `OneTimeCodeInbox` | Powiązanie z żywą kartą Playwright, atomowy cykl i wznowienie tego samego runu |
| Compensa | Sesja, asystent formularza, checkpoint `Zapisz`, UFG reader na fixture | Żywe selektory, wiarygodne wyszukanie istniejącej sprawy, połączenie modułów |
| OC i eksport | Parser, kontrola liczności, filtr daty, zapis snapshotu i eksport w API | Przekazanie zweryfikowanego wyniku z workera do API i pełny automatyczny przebieg |

## Docelowy przebieg jednego `runId`

```text
Panel: wybór istniejącego importu i wiersza → POST /runs → BullMQ(runId)
Worker: walidacja → otwarcie tego samego profilu Playwright
PZU: kontrola ważnej sesji → ewentualny login/SMS → Everest → REGON → potwierdzona osoba/PESEL
Compensa: kontrola sesji → ewentualny login/SMS → formularz → checkpoint przed Zapisz
UFG: potwierdzenie sprawy → jedna weryfikacja → pełna tabela OC → kontrola liczności
API: zaszyfrowana tożsamość i snapshot → filtr wg referenceDate → Excel albo jawne zero polis
Panel: stan zadania, ewentualna interwencja, pobranie pliku
```

Każda interwencja, restart lub ponowne uruchomienie wraca do **tego samego `runId` i ostatniego bezpiecznego checkpointu**. Nie używa `POST /runs` do wznowienia. Nie tworzy nowej oferty, jeżeli wynik wcześniejszego `Zapisz` jest niepewny.

## Kolejność implementacji

### Etap 1 — lokalny tryb widocznej przeglądarki

**Kod:** `apps/worker/src/browser.ts`, `run-worker.ts`, nowa lokalna konfiguracja uruchomieniowa, `.env.example`, dokumentacja uruchomienia.

1. Rozszerzyć `BrowserSession` o jawny tryb `headless: false`, zachowując obecny wariant kontenerowy. Katalog profilu podać jako absolutną ścieżkę Windows w ignorowanym `worker-profiles/`.
2. Uruchamiać `web`, `api` i `worker` jako procesy Node na komputerze operatora, a PostgreSQL i Redis z lokalnego Compose dostępne tylko na `127.0.0.1`. Lokalny wariant wyłącza kontenerowego workera. API kieruje jednorazowy kod do odbiornika na `127.0.0.1:3022`.
3. Przy starcie workera zająć profil na wyłączność; drugi proces z tym samym kontem/profilem ma odmówić startu. Utrzymać `concurrency: 1`. Po zamknięciu okna lub procesu profil pozostaje na dysku.
4. Udostępnić operatorowi jasne stany: „przeglądarka gotowa”, „wymagane logowanie/SMS”, „sesja ważna”, „portal niedostępny”. Nie zapisywać zrzutów zawierających dane klienta.

**Odbiór:** widoczne okno otwiera się na komputerze operatora; ponowne uruchomienie workera otwiera ten sam profil; jednoczesny drugi worker jest odrzucony. Kod produkcyjnego pipeline pozostaje ten sam dla trybu lokalnego i późniejszego VPS.

### Etap 2 — sprawdzanie sesji zamiast ponownego logowania

**Kod:** `portal-session.ts`, `pzu-session.ts`, `compensa-session.ts`, testy sesji.

1. Przed każdym runem wejść na chroniony ekran odpowiedniego portalu i potwierdzić odpowiedź serwera po przekierowaniach. Sam zachowany DOM lub obecność cookie nie oznacza ważnej sesji. Gdy sesja jest ważna, przejść od razu do pracy.
2. Logować się tylko po jednoznacznym `login_required`. SMS tworzyć tylko po jednoznacznym `waiting_for_sms`. `unknown`, odmowa, timeout i zmiana ekranu mają zatrzymać run z kodem błędu, bez kolejnych prób logowania.
3. Zastąpić procesowe `loginAttempted` jawnym limitem próby dla cyklu uwierzytelnienia. Po błędnym kodzie lub restarcie najpierw ponownie odczytać ekran; nie zakładać, że trzeba znowu wysłać login albo nowy SMS.

**Odbiór:** trzy kolejne fikcyjne firmy przy ważnej sesji = jeden profil, zero dodatkowych loginów i challenge. Restart z ważną sesją = zero dodatkowych SMS. Wygasła sesja = najwyżej jedna kontrolowana próba.

### Etap 3 — żywy adapter PZU/Everest

**Kod:** `everest-identity-provider.ts`, `pzu-session.ts`, wersjonowana konfiguracja selektorów.

1. Na uprawnionej sesji obejrzeć realne ekrany: wejście PZU, ewentualne przejście do Everest, formularz loginu/MFA, wyszukiwanie REGON, lista wyników i karta osoby. Zapisać tylko selektory i wersję adaptera, bez treści danych osobowych.
2. Dla jednego wskazanego wiersza wyszukać REGON, porównać REGON, nazwę działalności i osobę według obecnych reguł `IdentityMatchV1`; przy niejednoznaczności zatrzymać na `identity_review`.
3. Utrwalić potwierdzoną tożsamość z PESEL w szyfrowanym checkpointcie przed przejściem do Compensy. Po restarcie użyć checkpointu, bez ponownego wyszukiwania w Everest.

**Odbiór:** jeden ręcznie porównany rekord daje zgodny kontrakt tożsamości; wynik niejednoznaczny nie uruchamia Compensy. Kolejny run na ważnej sesji PZU nie prosi o SMS.

### Etap 4 — SMS i produkcyjny procesor runu

**Kod:** `run-worker.ts`, `pipeline.ts`, `ports.ts`, nowy PostgreSQL `RunRepository`, `auth-challenges.ts`, `code-inbox.ts`, panel.

1. Zastąpić parkowanie w `awaiting_portal_adapter` produkcyjnym procesorem, który wczytuje run i wiersz z DB, kontroluje anulowanie, zapisuje stany atomowo i używa tych samych instancji `BrowserSession`/adapterów dla kolejnych jobów.
2. `createAuthChallenge()` ma być jedynym właścicielem przejścia do `waiting_for_sms`; usunąć drugie przejście z `pipeline.ts`. Zarejestrować identyfikator w inbox przed udostępnieniem challenge panelowi. W razie błędu transakcji unieważnić wpis inbox.
3. Po przekazaniu kodu worker czeka na trwały stan `submitted` przed wpisaniem go w portal. Następnie sprawdza, czy karta nadal pokazuje właściwy formularz MFA, wpisuje kod raz, zapisuje wynik i kontynuuje ten sam `runId`. Kod pozostaje wyłącznie w pamięci do użycia i jest czyszczony.
4. Wygaśnięcie, błędny kod, anulowanie i restart zamykają stare challenge. Gdy potrzebna jest kolejna próba, panel oferuje „Wznów uwierzytelnianie” dla **tego samego runu**. Bez tej akcji nie generować kolejnych próśb SMS w pętli. Reconciliacja po restarcie najpierw sprawdza zachowany profil, a dopiero potem stan portalu.

**Odbiór:** pełna ścieżka panel → kod → worker → PZU → Everest; poprawny, błędny, podwójny i wygasły kod; dwie karty panelu; restart podczas MFA. Jeden aktywny challenge na konto i portal, brak kodu w DB, Redis i logach.

### Etap 5 — żywa Compensa, formularz i zapis

**Kod:** `compensa-session.ts`, `compensa-form.ts`, `compensa-offer-saver.ts`, `compensa-offer-checkpoint.ts`.

1. Odebrać na żywym portalu selektory CPortal/Compensa i kontrolę sesji. Compensa może mieć osobne MFA; używa tego samego profilu przeglądarki, lecz osobnego challenge i karty.
2. Otworzyć „Compensa Komunikacja”, ustawić `Ubezpieczający`, PESEL potwierdzonej osoby i skonfigurowany numer `RST22339`. Wypełnić tylko puste wymagane pola; sprzeczne imię, nazwisko lub PESEL i brak pewnego powiatu kierują do interwencji.
3. Przed `Zapisz` zapisać identyfikator sprawy i zamiar. Po kliknięciu potwierdzić zapis. Po timeoutcie lub restarcie najpierw wyszukać tę samą sprawę; przy niepewnym wyniku zatrzymać run do przeglądu, bez drugiego kliknięcia.

**Odbiór:** jeden wskazany formularz przechodzi do zapisanej sprawy. Test przerwania przed i po `Zapisz` dowodzi braku drugiej oferty.

### Etap 6 — UFG, pełny odczyt OC i wynik

**Kod:** `compensa-ufg.ts`, `oc.ts`, `pipeline.ts` oraz istniejące `apps/api/src/oc-snapshot-store.ts`, `run-evaluation.ts`, `export-finalizer.ts`.

1. Na potwierdzonej sprawie uruchomić UFG tylko raz, otworzyć szczegóły i odczytać wszystkie wiersze OC, również ukryte przez wewnętrzne przewijanie. Stronicowanie dodać, jeśli wystąpi na żywym ekranie.
2. Porównać liczbę odczytanych wierszy z podsumowaniem UFG i sprawdzić 12 pól oraz daty. Niekompletny widok to błąd, nie wynik zerowy.
3. Przekazać zatwierdzony snapshot do API przez prywatny, uwierzytelniony kanał bez logowania danych osobowych. API zapisuje go atomowo, ocenia polisy według `referenceDate` runu i generuje plik, jeśli są aktualne OC. Retry eksportu wykonuje tylko eksport.
4. Panel pokazuje `completed` z plikiem, `no_matching_policies` po pełnym odczycie albo konkretny błąd/interwencję. Zaktualizować tekst, który dziś mówi, że portale nie są podłączone.

**Odbiór:** jeden automatyczny run od przycisku do pobrania Excela; liczność OC zgodna z UFG; ręczne porównanie pól wskazanego rekordu; po restarcie brak ponownego `Zapisz` i UFG.

### Etap 7 — stabilizacja i uruchomienie seryjne

1. `npm test`, `npm run build`, testy Playwright na fixture oraz smoke PostgreSQL/Redis. Następnie live test na jednym uprawnionym rekordzie i porównanie z portalem. Dane osobowe, SMS, hasła i niezamazane zrzuty nie trafiają do repozytorium ani raportu.
2. Wykonać trzy kolejne rekordy w jednej sesji, zamknąć i uruchomić worker ponownie, wykonać następny rekord, a potem sprawdzić zachowanie po realnym wygaśnięciu sesji. Rejestrować liczbę wywołań loginu i challenge, nie wartości SMS.
3. Dopiero po odbiorze jednego i kilku rekordów uruchomić małą partię. Każdy run ma zakończyć się wynikiem, jawną interwencją albo błędem; żadnych cichych pominięć i duplikatów ofert.

## Definicja działającej wersji

- Operator uruchamia wskazany wiersz z panelu; Playwright wykonuje PZU/Everest, Compensę, UFG i eksport bez ręcznego przepisywania danych.
- Przy ważnej sesji kolejne wiersze nie wywołują nowego loginu ani SMS. Zamknięcie i ponowne otwarcie workera nie usuwa profilu.
- Gdy portal żąda MFA, operator przekazuje kod tylko dla aktywnego challenge, a run rusza dalej od tego samego punktu. Nie powstaje seria nowych runów ani wyzwań.
- Pełny wynik OC jest zgodny z podsumowaniem UFG, a plik zawiera tylko polisy z `Okres ub. do >= referenceDate` zapisaną przy starcie runu.
- Awaria po `Zapisz` lub podczas UFG nie tworzy drugiej oferty/weryfikacji. Niepewność jest widoczna i wymaga rozstrzygnięcia przed ponowieniem.

## Pierwszy pakiet prac w kodzie

Zacząć od etapów 1–4 jako jednego pionowego przekroju: widoczna przeglądarka z trwałym profilem → jeden wskazany run → PZU/Everest → SMS, jeśli potrzebny → trwały checkpoint tożsamości. To daje od razu praktyczny dowód ograniczenia SMS i usuwa `awaiting_portal_adapter`. Następnie dołączyć Compensę/UFG i eksport do tego samego procesora, zamiast pisać osobny jednorazowy skrypt.
