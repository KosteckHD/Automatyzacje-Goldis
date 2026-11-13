# Goldis — odbiór biznesowy i przygotowanie platformy na następne narzędzia

**Plan realizacji ustaleń:** [pełny odbiór platformy i cyberbezpieczeństwa](PLAN_PELNEGO_ODBIORU_PLATFORMY_2026-11-05.md), [macierz](acceptance/2026-11-05/CHECKLISTA.md) i [protokół](acceptance/2026-11-05/PROTOKOL_ODBIORU.md). Ten audyt opisuje snapshot sprzed dołączenia rzeczywistej porównywarki prowizji. W bieżącym drzewie istnieje już `commission-comparison`; wcześniejsze stwierdzenia o katalogu/trasach i przyszłym drugim narzędziu należy czytać historycznie. Nowy plan obejmuje ten moduł i wymaga ponownego sprawdzenia wcześniejszych ustaleń na kandydacie release.

Data: **5 listopada 2026**. Odbiorca: jedna firma i **2–5 pracowników**. Przedmiot: wartość i kompletność procesu OC, zgodność automatyzacji z panelem, backend, frontend oraz rozszerzenie o następne narzędzie. Dokument uzupełnia [plan VPS i utrzymania](PLAN_VPS_I_UTRZYMANIA_KLIENTA_2026-11-05.md), bez powtarzania jego instrukcji infrastruktury.

## 1. Decyzja o gotowości

**Nie uznaję obecnej całości za gotową do końcowego, samodzielnego odbioru przez klienta.** To rozwinięta aplikacja operacyjna z realną automatyzacją i znaczną częścią wspólnej platformy. Ma podstawy do kontrolowanego pilota po zamknięciu najważniejszych niespójności. Brak końcowego odbioru wynika zarówno z niezamkniętych dowodów, jak i konkretnych przerw w procesie opisanych poniżej.

**Nie trzeba budować aplikacji od początku.** Trzeba doprowadzić obecny proces do spójności i wyraźnie oddzielić wspólną platformę od domeny OC. Drugiego narzędzia nie da się dziś dodać samym rekordem w katalogu, ale można je rozwinąć jako kolejny moduł obecnej aplikacji.

| Zakres | Ocena na dziś | Warunek odbioru |
| --- | --- | --- |
| Demonstracja zakresu produktu | Możliwa, z opisem ograniczeń | Nie utożsamiać demonstracji z odebraną usługą produkcyjną. |
| Pilot pracowników | Warunkowy | Poprawić istotne rozbieżności UI/API/workera; wskazać wersję i odpowiedzialnego operatora. |
| Samodzielna codzienna praca klienta | **Nieodebrana** | Przejść proces od importu do pracy z wynikiem oraz scenariusze błędów na realnym API/DB/workerze. |
| Pełna automatyzacja bez nadzoru | **Brak podstaw do takiej deklaracji** | MFA, niepewne zapisy i niektóre wznowienia wymagają człowieka; przepustowość i udział wyjątków nie są zmierzone. |
| Wspólne konta/admin/audyt dla kolejnego narzędzia | Dobry fundament | Zachować i ujednolicić polityki dostępu i kontrakty. |
| Dowolne kolejne narzędzie przez konfigurację | **Nieobsługiwane** | Potrzebny własny moduł, kontrakt wejścia/wyniku, routing i odpowiedni wykonawca. |

Nie podaję procentu gotowości: liczba funkcji i testów nie mierzy tego, czy pracownik bezpiecznie rozwiąże istotny wyjątek.

## 2. Metoda i granice analizy

Sprawdzono bieżące źródła backendu, workera i frontendu, przepływ danych i uprawnień, dokumenty produktu/odbiorów oraz wyniki kontroli wykonanych wcześniej tego samego dnia. Przegląd podzielono na niezależne analizy backendu, automatyzacji i interfejsu, a następnie porównano połączenia między nimi.

- Nie uruchamiano żywych portali, zadań klienta ani jego bazy. Nie wykonano nowego UAT w przeglądarce i nie oceniano aktualnego wyglądu na podstawie starych screenshotów.
- Wnioski o efektach React, mapowaniu stanów i regułach dostępu wynikają z kodu. Są podstawą do poprawki i odtworzenia wskazanego scenariusza, a nie deklaracją już wykonanego testu przeglądarkowego.
- Dodatkowo sprawdzono zachowanie funkcji filtra daty na syntetycznych danych z istniejącego builda. Nie zmieniano jej implementacji.
- Wcześniejszy dzisiejszy build całej aplikacji: PASS. `npm test`: FAIL na kontroli architektury leadów 42/36. Core: 20 PASS. Osobny runner API: INCOMPLETE po przerwaniu po ok. 16 minutach. Worker: 118 PASS, 6 FAIL, 85 SKIP; cztery błędy EACCES połączeń loopback, dwa nierozstrzygnięte błędy stagingu. Nie są to dowody sześciu usterek produkcyjnych, ale nie dają też zielonego odbioru. [Wyniki](production-readiness/vps-2026-11-05/checks.json).

Rozróżniam: **niespójność implementacji**, **brak dowodu odbioru**, **świadome ograniczenie produktu** oraz **prace potrzebne dopiero do drugiego narzędzia**. Tych kategorii nie należy wrzucać do jednej listy błędów.

## 3. Kontrakt biznesowy pierwszego produktu

Wartość dla firmy powstaje dopiero w całym łańcuchu:

**Excel → przygotowanie i poprawne rozpoznanie firmy → zweryfikowana tożsamość → odczyt OC → zrozumiały wynik → przydział firmy pracownikowi → kontakt i decyzja → raport menedżera.**

Samo powstanie XLSX albo zielony licznik zadań nie dowodzi zakończenia tego procesu. Pracownik powinien wiedzieć, co sprawdzono, na jaki dzień, czego nie ustalono, co wymaga jego decyzji i jaka jest bezpieczna następna czynność.

Punktem odniesienia są późniejsze ustalenia z [planu adaptacji 12.10](PLAN_ADAPTACJI_PLATFORMY_DO_USTALEN_2026-10-12.md), a nie wszystkie starsze opisy MVP:

- Jedna organizacja, OC jako pierwsze narzędzie. Każdy import jest nową operacją; deduplikacja wewnątrz importu, bez globalnego blokowania kolejnego sprawdzenia tej samej firmy.
- Wymagane bezpieczne powiązanie z właściwą osobą; brak dopasowania nie może być zastąpiony przypadkowym PESEL.
- Wynik XLSX ma kontrakt `Nazwa_REGON.xlsx`, jeden wiersz danych firmy i listę polis; używa utrwalonych danych wejścia/wyniku. Starszy format nazwy w dokumentach nie jest aktualnym celem.
- Brak polis po filtrze oznacza jawny wynik bez dodatniego leada i pliku dla pojedynczego runu; nie oznacza błędu technicznego.
- Usunięcie przydziału oddaje leada do puli. Usunięcie importu nie ma niszczyć danych leadów już przydzielonych innym pracownikom.
- SMS/korekty obsługuje osoba uruchamiająca. Jest to zapisane ograniczenie, nie automatycznie usterka wymagająca rozszerzenia uprawnień.
- Utrwalono brak automatycznego wygaśnięcia importów, wyników i kopii do czasu uprawnionego usunięcia oraz **RPO ≤24 h, RTO ≤8 h**. Węższa retencja lub inny cel z planu VPS może być propozycją zmiany, a nie cichą podmianą tych ustaleń.

Przed odbiorem potrzebna jest jedna aktualna specyfikacja produktu z powyższymi regułami, ograniczeniami i linkami do dowodów. Repozytorium zawiera liczne dokumenty z różnych etapów; README i instrukcje nie zawsze opisują ten sam stan. Nowy pracownik nie powinien sam rozstrzygać ich sprzeczności.

## 4. Niespójności istotne dla obecnego odbioru

Priorytet A oznacza zamknięcie przed odbiorem zwykłej pracy; B — przed rozszerzeniem platformy lub po świadomej akceptacji ograniczenia. Wskazane linie odnoszą się do drzewa analizowanego 5.11.

### A1. Mechanizm poprawki w panelu nie jest połączony ze wszystkimi rzeczywistymi wyjątkami

Adapter formularza Compensy potrafi zwrócić `waiting_for_manual_data` wraz ze wskazaniem pola. Produkcyjny `LiveRunProcessor` zamienia część tych odpowiedzi na terminalne `failed / MANUAL_DATA_REQUIRED`, bez otwartej interwencji i bez przekazania pola. Dotyczy to m.in. `live-run.ts:413–415` i `:463–465`. `fail()` jedynie ustawia terminalny status (`:153–155`).

Jednocześnie API pozwala poprawiać/wznawiać tylko run w `waiting_for_manual_data` albo `identity_review`, z odpowiednią interwencją: `manual-data.service.ts:30–37`, `run-resume.service.ts:153–163`. Ekran korekty może więc istnieć, lecz nie obsłużyć przypadku, który naprawdę zwrócił portal.

**Skutek biznesowy:** pracownik widzi błąd zamiast wykonalnej instrukcji „popraw pole i kontynuuj”. Powtórzenie całego zadania może być błędnym sposobem odzyskiwania, zwłaszcza jeśli w portalu powstała już sprawa.

**Zamknięcie:** jawna klasyfikacja rezultatów adaptera: terminalnie pominięte, poprawialne, nierozstrzygnięte oraz techniczne. Poprawialny przypadek ma zachować pole, kontekst i bezpieczny checkpoint. Test tej samej orkiestracji, której używa produkcja: pole → interwencja → korekta → wznowienie tego samego runu.

### A2. Niepewny zapis nie ma spójnej ścieżki rozstrzygnięcia przez produkt

`waiting_for_manual_data`/`outcome_uncertain` przy zapisie Compensy kończy się `failed / OFFER_SAVE_UNCONFIRMED` (`live-run.ts:484–486`). UFG `waiting_for_manual_data` przechodzi do `failed / PORTAL_FAILURE` (`:511–513`). API pobiera otwartą interwencję tylko dla trzech nieterminalnych stanów (`runs-read.service.ts:36–38`), chociaż kontrakt ponownego sprawdzenia już przewiduje `OFFER_SAVE_UNCONFIRMED` w `waiting_for_manual_data` (`review/portal-review-contract.ts:15–25`).

**Bezpieczne zatrzymanie jest właściwe.** Problemem nie jest brak automatycznego ponowienia niepewnego zapisu, lecz niepołączenie zatrzymania z kontrolowaną ścieżką uzgodnienia istniejącej sprawy.

**Zamknięcie:** pracownik/operator musi mieć wskazane: co mogło zostać zapisane, kto i jak potwierdza stan, kiedy wolno kontynuować oraz kiedy eskalować. Odebrać brak drugiego zapisu także po restarcie i ponownej dostawie zadania.

### A3. Część interwencji nie niesie informacji wymaganej przez korektę

Rzeczywiste wywołania `pauseForReview` w `live-run.ts`, m.in. `:384–387`, `:408–411`, `:458–461`, nie przekazują `fieldCode`. Repository zapisuje wtedy NULL (`pg-run-repository.ts:325`). API korekty wymaga zgodności `incident.fieldCode` z polem (`manual-data.service.ts:34–37`), a kontrakt wznowienia rozpoznanego pola.

**Skutek:** otwarte zgłoszenie nie zawsze oznacza, że użytkownik może je rozwiązać w panelu. Nie każdy problem tożsamości powinien być naprawiany edycją danych; trzeba odróżnić dozwoloną poprawkę od weryfikacji, która wymaga odrzucenia lub ręcznego uzgodnienia.

**Zamknięcie:** każdy rodzaj interwencji otrzymuje wykonalną, bezpieczną ścieżkę: korekta pola, ponowne sprawdzenie tej samej sprawy, terminalne odrzucenie albo eskalacja. Nie dodawać dowolnej edycji PESEL jako obejścia.

### A4. Liczniki i wiersze postępu mogą przedstawiać różne chwile

`ResultSetWorkspace` odświeża summary co 4 s (`result-set-workspace.tsx:102–144`), ale pobranie rows zależy od ID zestawu, filtrów i retry, a nie zmian stanu/wersji summary (`:146–163`). Callbacki z rodzica są stabilne. W `RunSubmissionLauncher` `submissionItems` jest pobierane tylko raz przez `loadedItems`, mimo pollingu summary (`run-submission-launcher.tsx:248–253`, render w `:593`).

**Skutek:** ukończony licznik i stare queued/running albo liczby polis w widocznych firmach. Pracownik może uznać gotowy wynik za nieukończony lub ponowić pracę. Mechanizm wynika ze statyki; scenariusz trzeba odtworzyć w przeglądarce.

**Zamknięcie:** odświeżanie spójnej wersji summary i widocznych stron wierszy, ochrona przed starszą odpowiedzią i zachowanie zaznaczeń/filtrów. Nie wystarczy dołożyć bezwarunkowego F5. Test queued → running → SMS/błąd/ukończenie bez interakcji z filtrem.

### A5. Użytkownik dostaje sprzeczną informację o pobieraniu wyników

`AccessWorkspace.tsx:77–82` mówi, że aktywni pracownicy mogą pobierać pliki niezależnie od uruchamiania. `TeamService.access()` również zwraca download=true dla active membership (`team.service.ts:281–282`). Jednak nowy grant tworzony przez managera ma `canDownloadResults=false` (`:327–328`), a download snapshotu wymaga tego osobnego prawa i może zwrócić 403 (`business-leads.service.ts:761–773`).

**To niespójność kontraktu, nie wykazany wyciek danych.** Trzeba ustalić jedną aktualną politykę i wyliczać prezentowane możliwości z rzeczywistych uprawnień. Nie otwierać pobierania wszystkim wyłącznie dla zgodności z tekstem. Jeśli pobieranie pozostaje osobnym grantem, tekst, zarządzanie dostępem i instrukcja muszą to odzwierciedlać.

**Zamknięcie:** nowe konto utworzone przez menedżera, podgląd/pobranie przed i po nadaniu/cofnięciu prawa, także na już otwartej stronie. Test na adminie lub starym koncie nie wystarczy.

### A6. Powrót po wygaśnięciu sesji i odświeżanie po błędzie nie są jednolite

Link „Zaloguj się, aby wrócić do zgłoszenia” prawidłowo niesie `/submissions/:id` (`submission-detail.tsx:151`, `lib/return-to.ts:12`), ale druga allowlista po loginie nie dopuszcza `/submissions/` (`workspace.tsx:423–428`). Następuje powrót do domyślnego ekranu roli zamiast do zgłoszenia; dla pracownika, menedżera i admina jest to dashboard.

W szczególe zgłoszenia kod HTTP znika przy tworzeniu Error (`submission-detail.tsx:48`); refresh nie przełącza właściwie auth po 401, a po nieudanym odświeżeniu polling może nie zostać ponowiony (`:87`, `:115`). Jest ręczny przycisk odświeżania, więc nie jest to całkowity brak odzyskiwania.

**Zamknięcie:** jeden bezpieczny sanitizer używany w linkach i przekierowaniu, wspólna obsługa 401/403/409/503 i retry. Test wygaszenia sesji podczas przeglądania zgłoszenia, firmy, wyniku i importu; powrót także po wymuszonej zmianie hasła.

### A7. Zaliczenie syntetycznej ścieżki nie dowodzi połączenia produkcyjnej

`runPipeline` zachowuje `waiting_for_manual_data` i `fieldCode` (`pipeline.ts:166–168`), podczas gdy osobny `LiveRunProcessor` ma opisane wyżej przejścia terminalne. To dwa różne miejsca decydujące o ważnym zachowaniu.

**Zamknięcie:** testować produkcyjną orkiestrację z podmienionymi adapterami portali. Docelowo jedna orkiestracja ma działać z prawdziwymi i syntetycznymi adapterami. Nie wymaga to wykonywania live w CI. Oddzielne testy parserów/adapterów pozostają potrzebne, lecz nie zastępują procesu panel → API → DB/outbox → worker → API → wynik.

## 5. Co klient może odczytać z wyniku, a czego nie

Trzeba rozdzielić **stan wykonania**, **rezultat sprawdzenia** i **stan pracy handlowej**. „Zakończono zadanie”, „znaleziono polisę” oraz „klient zaakceptował ofertę” to trzy różne informacje.

| Stan / komunikat | Rzeczywiste znaczenie | Wymaganie odbiorowe |
| --- | --- | --- |
| Run `completed` | Dodatni wynik po filtrze oraz gotowy artefakt | Porównać dane z portalem, nie tylko sprawdzić istnienie pliku. |
| `no_matching_policies` | Zero po filtrze daty; snapshot może mieć historyczne polisy i totalCount>0 | Nie opisywać jako dowodu braku jakiejkolwiek polisy w UFG. |
| `IDENTITY_NOT_FOUND` / niejednoznaczność | Nie ustalono bezpiecznie właściwej osoby | Nie przedstawiać jako „brak OC”. |
| `UFG_INCOMPLETE` / błąd portalu | Niepełny lub niewiarygodny odczyt | Brak pozytywnego wyniku nie jest poprawnym zerem. |
| `COMPENSA_PAYER_DATA_SKIPPED` | Uzgodnione pominięcie po rozpoznanym dialogu | Wyjaśnić powód i brak sprawdzenia, bez udawania awarii infrastruktury. |
| `COMPENSA_CUSTOMER_DATA_INCOMPLETE` | Zablokowane wymagane dane w portalu | Oddzielić od pól, które można poprawić i wznowić przez interwencję. |
| `OFFER_SAVE_UNCONFIRMED` | Niepewny rezultat zapisu w zewnętrznym systemie | Najpierw rozstrzygnięcie istniejącej sprawy, bez ślepego nowego runu. |
| Submission `completed` | Wszystkie pozycje są rozliczone; mogą zawierać błędy/pominięcia | Pokazać obok strukturę rezultatów, nie „100% skuteczności”. |
| Lead `ready` | Co najmniej jeden powiązany run completed i wszystkie powiązane runy terminalne | Nie zakładać, że każdy powiązany run zakończył się dodatnim wynikiem. |
| Lead `failed` w podsumowaniu | Może obejmować firmę bez dodatniego runu, również z poprawnym zerem | Nie używać licznika failed leadów jako liczby usterek automatu. |
| Kontakt `offer_accepted` | Zapisana decyzja/status pracy handlowej | Nie jest dowodem zawartej polisy, przychodu ani rozliczenia prowizji. |

Źródła: `run-evaluation.repository.ts:81–82`, `run-submission-read.repository.ts:157–179`, `business-leads.service.ts:234–242`, `dashboard.repository.ts:46–47`. Raporty administracyjne mają osobny `noPoliciesCount`; trzeba zachować te rozróżnienia we wszystkich agregatach i instrukcji.

**Filtr daty jest konkretną regułą handlową:** `policyMatchesDate` sprawdza wyłącznie `coverageTo >= referenceDate` (`packages/core/src/index.ts:450–455`). Nie sprawdza początku ochrony. Syntetyczna polisa 1.12.2026–1.12.2027 przechodzi dla daty 5.11.2026. Polisa kończąca się 5.11 przechodzi, a kończąca się 4.11 nie przechodzi.

To jest zgodne z utrwalonym filtrem końca okresu; nie zmieniać go automatycznie. Etykiety typu „aktualne polisy” powinny wyjaśniać jego znaczenie. Nie wolno na podstawie tego filtra wnioskować, że ochrona trwa już w dniu odniesienia. Wynik pozostaje snapshotem z określonego czasu, nie ciągłym monitoringiem późniejszych zmian portalu. Panel już pokazuje datę odniesienia; należy ją zachować w dalszym rozwoju.

Kompletność odczytu jest kontrolowana względem tabeli i licznika pokazanego w portalu. Nie jest gwarancją kompletności całego zewnętrznego rejestru ani wszystkich opcjonalnych pól. Dane opcjonalne mogą być puste; nie wolno ich uzupełniać domysłem.

## 6. Automatyzacja jako codzienna usługa dla zespołu

Automat nie jest wyłącznie robotem odczytującym stronę: może otwierać draft/sprawę i zapisywać dane ubezpieczonego w Compensie, a potem wykonywać UFG. Cofnięcie stanu DB nie cofa tych działań. Ochrona intencji zapisu, checkpointy, lease i fencing są wartościowe i muszą pozostać elementem odbioru.

### Przyjęte ograniczenia wymagające instrukcji

- **Jeden wspólny automat i profil.** 2–5 pracowników może używać panelu, ale nie otrzymuje 2–5 równoległych sesji automatyzacji.
- **MFA wymaga reakcji człowieka.** Oczekiwanie w jednym runie może trwać do 5 minut dla PZU i 2 minut dla Compensy; blokuje w tym czasie jedynego wykonawcę. Nie ma pomiaru częstotliwości MFA ani udziału czasu ręcznego.
- **Starter odpowiada za zgłoszenie.** Przypisanie interwencji innemu użytkownikowi nie daje automatycznie uprawnienia do SMS/korekty/wznowienia. Sprawdzane jest `startedByUserId` (`auth-challenge.service.ts:46,129`, `manual-data.service.ts:22`, `run-resume.service.ts:150`). Zastępstwo/urlop wymaga uzgodnionej procedury. Funkcja bezpiecznego przekazania runu byłaby osobnym rozszerzeniem, nie zwykłą zmianą etykiety.
- **Pauza runu** jest żądaniem zatrzymania na bezpiecznej granicy, nie natychmiastowym zamrożeniem portalu. Kontynuację można potwierdzić po uzyskaniu stanu pauzy i zwolnieniu lease.
- **Pauza/anulowanie submission** blokuje dalsze przyjmowanie nieprzyjętych grup. Przyjęte runy mogą kontynuować (`run-submissions.service.ts:979–1010`). Nie utożsamiać tego z pauzą pojedynczego runu.
- **„Cały import” / prepared-set execution** jest trzecim poziomem sterowania: pauza zatrzymuje dalsze porcje, ale już utworzona child submission może pracować mimo parent `paused` (`prepared-set-executions.service.ts:542–570`). Cancel parent próbuje anulować dalsze admission child, lecz błąd tej próby jest tłumiony (`:372–379`). Nie obiecywać na podstawie samego statusu parent, że wszystkie runy już się zatrzymały.
- **Anulowanie runu** jest dozwolone w określonych stanach (`queued`, `awaiting_portal_adapter`, `waiting_for_sms`), nie cofa zapisu w portalu (`run-cancellation.repository.ts:25–28`).
- Niepewnego zapisu i utraconego niezapisanego formularza nie należy automatycznie naprawiać ponownym uruchomieniem. Poprzednie odbiory dokumentują ograniczenia odzyskania niezapisanej sprawy.
- Nowy import może utworzyć nową operację i nowego leada tej samej firmy. To realizuje ustalone zasady, lecz menedżer powinien umieć odróżnić kolejne sprawdzenia i ograniczać niezamierzone podwójne kontakty. Nie wprowadzać globalnej deduplikacji wbrew temu kontraktowi.

### Co jest pozytywnym dowodem, a co nadal jest do wykonania

Dokument odbioru z 17.10 opisuje rzeczywiste pełne przebiegi, porównania XLSX i rozpoznane pominięcie. Oznacza to, że automatyzacja ma dowody działania poza samym mockiem. Nie jest to jednak odbiór każdej ścieżki obecnego formularza i głównej instalacji ani przyszłego VPS.

Brakuje jednego końcowego protokołu obecnego release łączącego konta pracowników, aktualny panel, rzeczywiste API/DB/Redis, produkcyjny procesor, MFA, wynik, przydział i obsługę wyjątków. Nie trzeba powtarzać całej starej kampanii po każdej poprawce; trzeba pokryć ryzyka danej zmiany i cały reprezentatywny proces.

## 7. Backend — co zachować i gdzie przebiega granica platformy

| Obszar | Ocena |
| --- | --- |
| Identity/auth/tenant/sesje | W dużej mierze wspólne i przydatne dla nowych modułów. Nie tworzyć drugiego systemu kont. |
| Tool/ToolGrant/ToolSettings | Realny rejestr i prawa per tenant/tool/user, CAS wersji i kontrola admission. Dobry fundament. |
| Audyt, działania uprzywilejowane | Wspólny mechanizm, transakcje, payload fingerprint i replay protection. Nowe typy akcji/zasobów wymagają jawnego rozszerzenia. |
| Outbox, lease, fencing, idempotencja | Wartościowe wzorce odporności. Bieżący kod wykonawczy pozostaje OC; wzorzec wspólny nie znaczy dowolny procesor. |
| Import/preparation/grouping | Model danych firmowych NIP/REGON, kontaktów i arkusza Realizacja. Reużywalny tylko, jeśli następne narzędzie rzeczywiście ma tę domenę. |
| Runs/submissions/results/leads | Dużo reguł biznesowych OC; nie traktować ich nazw jako dowodu generyczności. |

W kodzie istnieją zabezpieczenia istotne dla 2–5 osób: preview fingerprint i idempotencja, run/outbox w transakcji, blokady i wersje, SKIP LOCKED przy przydziałach, audyt zmian i fence spóźnionego workera. To więcej niż demonstracyjny CRUD. Nie ma podstaw, by zastępować tę konstrukcję mikroserwisami tylko ze względu na liczbę pracowników.

Wymagany jest natomiast aktualny odbiór współbieżności i awarii: dwóch menedżerów nie może dostać tego samego leada; cofnięty grant musi działać również przy otwartym ekranie; przerwanie między publikacją pliku a commit DB nie może dać fałszywego completed. Obecne testy nie zamykają wszystkich tych dowodów dla końcowego wydania.

### Najważniejsze sprzężenia z OC

| Miejsce | Fakt w aktualnym kodzie | Skutek dla następnego narzędzia |
| --- | --- | --- |
| `packages/core/src/index.ts:98,252` | RunInputV1 ma literal OC; validator odrzuca inne toolId. | Sam seed nowego Tool nie uruchomi zadania. |
| `packages/core/src/index.ts:35–66` | RunStatus zawiera pzu_login, everest_search, compensa_form, reading_oc. | Kroki domeny mieszają się ze wspólnym lifecycle. |
| `run-admission.service.ts:50,75`, `canonical-run-service.ts:103` | Settings/grant/admission i runy wskazują OC. | Nowy wykonawca potrzebuje własnego handlera/admission. |
| `run-submissions.service.ts:38` | Stały toolId i reguły grup OC. | Nie jest dowolnym workflow batchowym. |
| `imports/workbook.ts:35,65–75` | Parser arkusza Realizacja i pól firmy; endpoint z toolId nadal używa tego parsera. | Raport z innym formatem wymaga własnego parsera/DTO. |
| `results.model.ts:97,105,151` | Artefakt związany z runem i policyCount; rodzaje sourceType ograniczone. | Raport bez polis nie powinien udawać wyniku OC. |
| `dashboard.repository.ts:53,68,99` | Dashboard filtruje OC. | Nie pokaże automatycznie nowej domeny. |
| `notifications.service.ts:13` | result_ready kieruje do OC. | Nowy wynik wymaga właściwej trasy i rodzaju powiadomienia. |
| `teams/team.service.ts:21` | Panel menedżera zarządza OC. | Generyczny admin i prostszy panel menedżera mają różne możliwości rozbudowy. |
| Worker: `ports.ts:34–40`, kolejka `oc-verification` | Porty to ustalenie tożsamości i odczyt OC; portal IDs i DB constraints PZU/Compensa. | Adaptery są wymienne wewnątrz domeny OC, nie dla każdej automatyzacji. |

### Bezpieczeństwo rozbudowy

OC ma świadomy wyjątek wspólnego podglądu wyników w organizacji (`tool-access.ts:27–44`, `resource-scope.ts:5–10`). Nie kopiować go automatycznie do kolejnego narzędzia. Nowy moduł powinien domyślnie wymagać jawnych uprawnień; testować A-only, B-only, oba i cofnięty grant.

Guard kolekcji nie zastępuje scope w SQL: tenant/owner/tool/grant muszą ograniczać listę **przed** count i paginacją (`authorization.repository.ts:72–75`). Nowy kontroler skopiowany z leadów bez jego serwisowych kontroli nie będzie automatycznie bezpieczny.

Canonical entities są współdzielone w tenancie. Przed użyciem ich przez drugi moduł trzeba zdecydować, czy korekta danych przez B wpływa na A, czy oba używają wersjonowanego wspólnego katalogu i własnych snapshotów. Usuwanie i restore muszą objąć nowe tabele, artefakty, audyt i zachowane wyniki — dopisanie jedynie FK nie jest kompletną integracją.

Nie stwierdzono wycieku między dwoma działającymi narzędziami; drugiego procesu jeszcze nie ma. To konkretne miejsca wymagające ochrony podczas jego dodawania.

## 8. Frontend — dojrzałe elementy i potrzebne uporządkowanie

Warto zachować: podgląd przed uruchomieniem, osobną zgodę na start, unieważnianie starego preview, idempotentną obsługę niepewnej odpowiedzi, wersjonowany szkic per użytkownik/tenant/import, filtry i powrót do listy, kontrolę focus w nawigacji oraz oddzielenie prywatnego downloadu od renderowania wyniku. Nie ma powodu robić ponownie całego wyglądu platformy.

Główna praca dotyczy spójności zachowania: A4–A6, wspólna obsługa sesji/błędów i jednolita informacja „co się dzieje, co mogę zrobić”. Dostępność i responsywność mają testy historyczne, lecz ręczny odbiór aktualnego procesu przez pracowników pozostaje osobnym zadaniem.

Wspólny AppShell jest częściowy: `PlatformRouteFrame`, nowsze ekrany leadów/dashboard/team i duży `Workspace` mają własne mechanizmy sesji/nawigacji. Nie sama długość pliku jest problemem; problemem jest już wykazana różnica zachowania 401 i bezpiecznych powrotów.

Przed drugim narzędziem uporządkować:

- **Jeden kontrolowany rejestr narzędzi w frontendzie:** toolId → trasy workspace/results, możliwości, etykiety i renderer. Nie ufać dowolnym URL/ścieżkom pochodzącym z danych użytkownika.
- **Jeden katalog:** `tool-catalog.tsx:36–44` linkuje wyłącznie OC, a starszy wariant w `workspace.tsx:1175–1182` powiela ten warunek. Nowy Tool może obecnie dostać kartę bez działającego wejścia.
- **Dashboard i historia per faktyczny tool:** `DashboardWorkspace.tsx:162` kieruje operację do OC mimo jej toolId; `HistoryList.tsx:407,431` ma filtr/otwarcie tylko OC.
- **Platformowa nawigacja i opcjonalna nawigacja modułu:** „Moje firmy” i „Pula firm” nie muszą być głównymi ekranami raportu niezwiązanego z leadami.
- **Auth/root landing poza OC:** strona wejścia importuje duży `Workspace` z elementami automatyzacji. To sprzężenie i koszt rozwoju/bundle, a nie zmierzony problem szybkości przy pięciu osobach. Domena OC powinna ładować się na swojej trasie.
- **Wspólny kontener operacji, osobny renderer wyniku:** ID, nazwa narzędzia, stan, postęp i akcje mogą być wspólne; policyCount, formularz 8 kroków i tabela OC należą do OC.
- **Wspólny session/capability provider i klient API:** zachować HTTP status, anulowanie żądań i retry; uprawnienia nadal egzekwuje backend. Nie stosować globalnego cache danych bez uwzględnienia konta, tenanta, narzędzia i cofniętego dostępu.

## 9. Minimalny kierunek przygotowania następnego narzędzia

Nie znamy jeszcze celu i formatu następnego modułu. Nie należy projektować uniwersalnego silnika wszystkich możliwych workflow. Potrzebny jest mały, sprawdzalny kontrakt, który obsłuży OC i jeden kolejny rzeczywisty przypadek.

| Warstwa wspólna | Odpowiedzialność modułu narzędzia |
| --- | --- |
| Konta, tenant, sesje, role, podstawowy audyt | Własne akcje biznesowe i uprawnienia do specyficznych danych. |
| Katalog i kontrolowany rejestr metadanych | toolId, wersja, nazwa, możliwości, trasy i stan dostępności. |
| Przyjęcie operacji, idempotencja, kolejka, lease/fence jako wzorce | Walidator wejścia, admission, procesor, zasady współbieżności i bezpiecznego retry. |
| Wspólny stan wykonania i historia zdarzeń | Domenowy step i result/outcome; OC zachowuje własne kroki PZU/Compensa. |
| Bezpieczny magazyn plików i autoryzowany download | Schemat wyniku, renderer, format i zasady eksportu, również poprawny wynik bez pliku. |
| Kontener dashboardu/historii/powiadomień | Projekcje biznesowe i przejście do właściwego wyniku. |
| Mechanizm kasowania, journala i kopii | Jawne włączenie wszystkich danych/plików modułu do grafu kasowania i restore. |

Przykładowe wspólne pola operacji: `operationId`, `tenantId`, `toolId`, `toolVersion`, `actorId`, `inputSchemaVersion`, `status`, `step`, `outcome`, `progress`, `resultRef`, czasy i identyfikator idempotencji. To kierunek kontraktu, nie zlecenie natychmiastowej migracji każdej obecnej tabeli. Oddzielić stan „wykonanie zakończone” od wyniku „dodatni/zero/pominięte/błąd/niepewny skutek”.

Rejestr wykonawców i rendererów powinien być kontrolowany przez kod aplikacji. Rekord w `tools` opisuje udostępnienie i prawa, nie dostarcza wykonywalnego kodu lub dowolnej ścieżki importu.

### Wariant A — nowe narzędzie importujące i tworzące raport

Użyć obecnych kont, grantów, audytu, idempotencji i bezpiecznego magazynu plików. Dodać własny feature module, parser/DTO i wynik. Parser Realizacja stosować tylko przy zgodnym formacie. Nie uruchamiać raportu przez `pzu_login`, nie wpisywać sztucznego policyCount i nie wymuszać PESEL. Podłączyć katalog, historię, powiadomienie i download do właściwej trasy. Dodać dane do kasowania/restore.

### Wariant B — inna automatyzacja portalowa

Jeśli realizuje nadal ten sam proces ustalenia osoby i odczytu OC, obecne porty adapterów mogą być częściowo użyteczne. Jeżeli cel/wynik jest inny, nowy moduł powinien mieć własną maszynę stanów i kontrakty. Wspólne pozostają wzorce outbox, lease, fence, retry i interwencji.

Współbieżność i blokady muszą odnosić się do rzeczywiście wspólnego zasobu: konta portalu/profilu, nie wyłącznie nazwy kolejki. Dwa narzędzia używające tego samego konta mogą kolidować mimo osobnych kolejek. Nowy portal ID może wymagać zmian DB CHECK, sekretów, formularza interwencji i monitoringu; nie sprowadza się do dopisania selektorów.

### Dowód rozszerzalności

W środowisku testowym wykonać prosty drugi moduł referencyjny bez dostępu do portali, na sztucznych danych. Musi mieć własną trasę, wejście, wynik, stan błędu, historię, powiadomienie i download. Konta A-only/B-only/oba/bez dostępu nie mogą przekraczać praw. Żadna akcja nowego modułu nie może kierować do OC ani wymagać tabel polis.

Taki przekrój jest testem architektury. Nie jest gotowym nowym produktem do pokazania klientowi ani powodem budowania frameworka pluginów. Jeśli przejdzie bez zmian w auth i wnętrzu OC, uzyskamy praktyczny dowód jakości podziału.

## 10. Jak ocenić wartość biznesową i koszt obsługi

Nie ma jeszcze podstaw do obietnicy „X firm/h” ani „Y% oszczędności”. Nie znamy dziennego wolumenu ani udziału wyjątków w rzeczywistej próbce klienta. Liczba zalogowanych osób nie określa obciążenia portali.

Pilot powinien trwać uzgodniony okres, np. 3–5 dni pracy, z reprezentatywnymi przypadkami i znanym sposobem pomiaru. Dla live używać tylko uprawnionych kont i uzgodnionych danych. Awarii zapisu nie testować przez improwizowane eksperymenty na sprawach klienta — od tego są kontrolowane fixture.

| Wskaźnik | Co mierzyć i jak go interpretować |
| --- | --- |
| Lejek danych | Wiersze wejścia → poprawne/wymagające korekty → unikalne grupy → rzeczywiście sprawdzone → dodatnie/prawidłowe zera/pozostałe. Nie porównywać bezpośrednio count wierszy z count runów. |
| Jakość | Prawidłowa firma/osoba, zgodność licznika i danych polis, daty, źródło kontaktów, poprawny eksport. Nie mierzyć jakości samym procentem HTTP 200. |
| Przepustowość | Czas kolejki, aktywnego wykonania i całości; mediana i p95 osobno dla przebiegów bez interwencji oraz z interwencją. |
| Praca człowieka | Minuty SMS, korekt, uzgodnień niepewnego zapisu, weryfikacji wyniku i wsparcia technicznego. |
| Użyteczność | Czy pracownik kończy zadanie bez programisty, ile popełnia pomyłek i kiedy traci kontekst. |
| Wykorzystanie handlowe | Przydzielone → podjęty kontakt → decyzja; definicja statusów i okres. Nie przedstawiać ręcznego offer_accepted jako automatycznie zweryfikowanej sprzedaży. |
| Koszt jednostkowy | Infrastruktura + utrzymanie + rzeczywisty czas obsługi / ustalona jednostka użytecznego wyniku. Koszt per plik pomija poprawne zera i pracę nad wyjątkami. |
| Oszczędność | Porównanie ręcznej i wspomaganej pracy na równoważnej próbce, z wliczeniem kontroli i obsługi błędów. |

Nie znaleziono w repo dowodu ceny pojedynczego wywołania UFG ani innych portalowych opłat; nie należy ich dopisywać do modelu jako faktu. Ewentualne koszty i uprawnienia wynikają z umów klienta.

Do komercyjnego przekazania potrzebne są: opis zakresu, ograniczeń i odpowiedzialności; instrukcja pracownika/menedżera/operatora; zasady zgłaszania błędów; dostępność osoby do MFA; godziny wsparcia; utrzymanie zmian portali; właściciel kont/danych; odebrana kopia i restore. Cena samego VPS nie jest ceną utrzymania tej usługi.

## 11. Biznesowy odbiór użytkowników — scenariusze obowiązkowe

Wykonawcy: nowy pracownik, doświadczony pracownik, menedżer i operator techniczny, z co najmniej dwoma odrębnymi kontami. Testować identyfikowalnego kandydata release, a nie różne wersje UI i workera. Zapisać expected/actual, wynik, osobę i bezpieczny dowód bez danych klientów.

| ID | Scenariusz | Warunek zaliczenia |
| --- | --- | --- |
| U01 | Nowe konto, pierwsze hasło, wejście do pracy | Pracownik rozumie dostęp; widoczność, wykonanie, podgląd i pobieranie odpowiadają prawom. |
| U02 | Import z duplikatem, złym NIP, brakiem REGON i konfliktem | Liczniki są zrozumiałe, źródło zachowane, brak samoczynnego startu i nieuzgodnionego łączenia firm. |
| U03 | Wybór na kilku stronach/filtrach, F5 i zmiana danych po preview | Zakres pozostaje spójny; stare preview i zgoda tracą ważność. |
| U04 | Niepewna odpowiedź po Start, ponowienie kliknięcia | Jedno zgłoszenie i jeden dopuszczony run na grupę, bez nowej przypadkowej operacji. |
| U05 | Aktualizacja aktywnego procesu | Liczniki, statusy widocznych firm i wynik aktualizują się zgodnie, bez F5/zmiany filtra. |
| U06 | Poprawna osoba, brak osoby i niejednoznaczna osoba | Brak arbitralnego wyboru; poprawna dalsza czynność dla każdej sytuacji. |
| U07 | Dodatnie OC, puste UFG, stare polisy i przyszły początek | Dokładna zgodność z filtrem i źródłem; poprawne zero odróżnione od błędu. |
| U08 | Niepełny odczyt tabeli/błąd portalu | Brak pozornego zera/pełnego wyniku, czytelna przyczyna i następny krok. |
| U09 | Poprawialne pole Compensy | Interwencja → dozwolona korekta → wznowienie tego samego runu, bez utraty kontekstu. |
| U10 | Niepewny zapis i restart w tej granicy | Uzgodnienie istniejącej sprawy, brak drugiego zapisu i brak ślepego ponownego startu. |
| U11 | SMS poprawny, błędny, wygasły, resend i nieobecność startera | Limity działają, nie ma ponownego logowania zamiast resend; znana procedura dla braku uprawnionej osoby. |
| U12 | Pauza/anulowanie runu, submission oraz „Całego importu” | Pracownik zna zakres każdego poziomu i wie, które przyjęte zadania/porcje kontynuują; działania zewnętrzne nie są przedstawiane jako cofnięte. |
| U13 | Mieszana partia: dodatni wynik, zero, pominięcie, błąd | Zakończenie rozliczonej partii nie oznacza „wszystko sprawdzono”; raport pokazuje rzeczywisty podział. |
| U14 | Jednoczesny przydział dwóm osobom i zapis kontaktu | Brak podwójnego przydziału; konflikty wersji nie nadpisują cudzej decyzji. |
| U15 | Zwolnienie przydziału i usunięcie importu innej osoby | Lead wraca do puli; zachowany przydzielony wynik pozostaje czytelny zgodnie z kontraktem. |
| U16 | Drugi import tej samej firmy i ponowienie tej samej próby | Nowy zaakceptowany import zachowuje odrębność operacji, a ponowienie odpowiada zasadom idempotencji; użytkownicy nie mylą wyników z poprzednim snapshotem/kontaktem. |
| U17 | Wygaśnięcie sesji, wymuszona zmiana hasła, 503 i cofnięty grant | Bezpieczny powrót do właściwej strony; sieć nie udaje wylogowania; cofnięte uprawnienia są respektowane. |
| U18 | Backup/restore i dzień pracy po odzyskaniu | Brak odtworzenia skasowanych danych i starych reset linków; kontrola pending/niepewnych runów; nowe MFA zgodnie z instrukcją. |

Przydział, usuwanie, restart i 401/503 sprawdzać najpierw syntetycznie na izolowanej instalacji. Rzeczywiste portale odbierać w uzgodnionym, nadzorowanym zakresie. To, że ścieżka bez błędu została pokazana klientowi, nie zamyka U09–U12.

## 12. Kolejność prac i warunki zakończenia

| Pakiet | Praca | Odbiór |
| --- | --- | --- |
| O1 — kontrakt produktu | Ujednolicić definicje rezultatów, pobierania, pauzy, nadzoru, dat i dokumentacji; zachować obowiązujące ustalenia | Właściciel potrafi wskazać, co dokładnie klient kupuje i co jest ograniczeniem. |
| O2 — spójność procesu | A1–A3 i A7: produkcyjna orkiestracja, interwencje, korekty i uzgodnienie zapisu | Test przez rzeczywisty produkcyjny procesor z adapterami fixture, potem adekwatny nadzorowany odbiór live. |
| O3 — spójność panelu/praw | A4–A6: postęp, powrót po sesji, błędy/retry i prawa pobierania | Testy UI z aktualnym API i świeżymi kontami, także po cofnięciu praw. |
| O4 — kandydat wydania | Zielone wymagane kontrole, wyjaśnione SKIP i brakujące wyniki, wersja obrazów; połączenie z planem VPS | Jeden identyfikowalny release, nie zbiór październikowych PASS. |
| O5 — pilot i odbiór biznesowy | U01–U18 w adekwatnym środowisku, pomiar czasu i pracy ręcznej | Protokół klienta, lista zaakceptowanych ograniczeń, instrukcja i operator. |
| R1 — podstawa drugiego modułu | Oddzielić platformowe lifecycle/session/routes od OC, rejestr modułów i kontrakty wyników | Drugi moduł referencyjny działa bez pól polis i bez zmian w logowaniu/wnętrzu OC. |
| R2 — rzeczywiste następne narzędzie | Najpierw jego cel, dane wejścia/wyjścia i uprawnienia, potem implementacja | Własne kryteria biznesowe i test izolacji A/B oraz kasowania/restore. |

O1–O5 są pracą nad odbiorem dzisiejszego produktu. R1–R2 nie powinny blokować wydania OC, jeśli jego własny zakres jest poprawny i odebrany. Nie rozbudowywać teraz wszystkiego „na zapas”; nie rozpoczynać też kopiowania wielkiego modułu OC jako drugiego narzędzia.

Nie blokują samodzielnie odbioru: monolit, brak plugin loadera, nazwy domenowe OC, niewydzielony każdy repository i brak mikroserwisów. Blokują: niespójne prawa, niebezpieczna lub niewykonalna obsługa istotnego wyjątku, fałszywa informacja o stanie/wyniku oraz brak odebranego środowiska i odzyskiwania.

**Warunek końcowy:** klient i jego pracownicy potrafią przejść normalny proces, odróżnić poprawne zero od błędu, rozwiązać wspierany wyjątek, wiedzą kiedy eskalować i nie potrzebują programisty do zwykłych czynności. Operator potrafi utrzymać i odtworzyć tę samą wersję. Gotowość następnych narzędzi potwierdza odrębny przekrój modułu, nie sama obecność katalogu.

## Źródła i dowody

- [Ustalenia biznesowe 12.10](PLAN_ADAPTACJI_PLATFORMY_DO_USTALEN_2026-10-12.md), [stan adaptacji](REALIZACJA_PLANU_ADAPTACJI_2026-10-12.md).
- [Odbiór automatyzacji 17.10](ODBIOR_AUTOMATYZACJI_2026-10-17.md), [logowanie portali 18.10](FLOW_LOGOWANIA_PORTALI_2026-10-18.md).
- [Odbiór formularza 21.10](ODBIOR_FORMULARZA_OC_8_KROKOW_2026-10-21.md), [odbiór UX 22.10](ODBIOR_UI_UX_USER_FLOW_2026-10-22.md).
- [Plan VPS i utrzymania](PLAN_VPS_I_UTRZYMANIA_KLIENTA_2026-11-05.md), [dzisiejsze kontrole techniczne](production-readiness/vps-2026-11-05/checks.json).
- [Metoda, hashe źródeł i przykład filtra](production-readiness/product-2026-11-05/evidence.json).
- Kod: [produkcyjna orkiestracja](../apps/worker/src/features/execution/live-run.ts), [korekty](../apps/api/src/features/interventions/manual-data.service.ts), [wyniki w UI](../apps/web/app/result-set-workspace.tsx), [uprawnienia zespołu](../apps/api/src/features/teams/team.service.ts), [katalog](../apps/web/app/tools/tool-catalog.tsx), [kontrakty core](../packages/core/src/index.ts).
