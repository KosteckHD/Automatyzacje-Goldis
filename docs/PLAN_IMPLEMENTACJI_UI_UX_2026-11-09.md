# Plan implementacji poprawek UI/UX Goldis

Data: 9 listopada 2026. **Status: zmiany wdrożone w kodzie; odbiór funkcjonalny, przeglądarkowy i dostępności pozostaje do wykonania.**

Podstawa: [galeria 35 ekranów](design/goldis/review-2026-11-08/GALERIA_EKRANOW.html), [ocena przy screenshotach](design/goldis/review-2026-11-08/PRZEGLAD_EKRANOW.md), [dane oceny](design/goldis/review-2026-11-08/screen-notes-b.json) oraz pełna ocena heurystyczna z 8 listopada. Ponownie sprawdzono odpowiednie źródła przed napisaniem planu.

## 1. Cel i zakres

Pracownik ma rozumieć następny krok, pewnie uruchomić sprawdzanie, znaleźć wynik i sprawnie obsłużyć firmę. Menedżer ma łatwo przydzielać firmy i zarządzać kontami, również na telefonie.

Z 35 ocenionych widoków **24 mają zastrzeżenia**, a 11 pozostaje wzorcami regresji. Powtarzające się uwagi połączono w **20 zadań**. Obejmują również dostępność, niejednoznaczne CTA i język z pełnego przeglądu.

To naprawy istniejącego produktu. Zachować tożsamość Goldis, osiem technicznych etapów OC, reguły biznesowe, eksporty i historię. Uprościć ich prezentację. Nie usuwać kontroli danych, potwierdzeń, CSRF, grantów, idempotencji, rewizji ani zabezpieczeń po audycie bezpieczeństwa.

Priorytety:

- **P1:** blokada działania lub istotna przeszkoda w głównej ścieżce; zamknąć przed przekazaniem klientowi.
- **P2:** poprawa wygody i czytelności; wykonać w tym pakiecie przed końcowym odbiorem UI/UX.
- **P3:** język i dopracowanie; realizować razem z odpowiednim modułem.

Nie traktować 24 screenshotów jako 24 niezależnych błędów. Nie przypisywać wad produktu niezgodnym historycznym fixture: `completed` zamiast `ready`, niespójnym licznikom lub brakującemu kontraktowi dostępności puli. Nie zamieniać 16 stylistycznych ostrzeżeń detektora w obowiązkowe naprawy.

## 2. Kolejność wykonania

| Pakiet | Zadania | Rezultat | Zależności |
|---|---|---|---|
| A — działanie i podstawowa obsługa | UX-01, UX-02, UX-03, UX-19 | Działające powiadomienia, dostępny wybór firm, czytelny kontakt i przejście klawiaturą do treści | Brak |
| B — droga przez OC | UX-08, UX-09, UX-10, UX-17, UX-18 | Jednoznaczny wybór, podsumowanie, status i pobranie | A dla wyboru firm |
| C — porównywarka | UX-04, UX-05, UX-06, UX-07 | Poprawne stany danych, czytelny start, wygodny wybór plików i osobny kontekst wyniku | UX-04 przed 05–07 |
| D — codzienna praca i odszukiwanie danych | UX-11, UX-12, UX-13, UX-14, UX-15 | Wygodne akcje, rozpoznawalna historia i filtry bez kopiowania UUID | UX-03 przed UX-11; backend UX-13/14 przed ich UI |
| E — administracja i język | UX-16, UX-20 | Jedna sekcja administracji naraz; spójne pojęcia i liczebniki | Słownik pojęć UX-20 uzgodnić technicznie przed redakcją B–D |
| F — odbiór | Kontrole z rozdziału 6 | Nowe screenshoty i przejście zadań użytkownika na jednym buildzie | A–E |

Każdy pakiet ma osobny, przeglądalny zakres zmian. Istniejące zmiany użytkownika zachować. Przed rozpoczęciem karty potwierdzić, że wada nadal występuje; poprawionych już fragmentów nie przepisywać ponownie.

## 3. Karty implementacji

Ścieżki w kartach są względem katalogu głównego repozytorium. Nazwy nowych plików są proponowanym miejscem implementacji. Pliki backendu zmieniają się tylko przy UX-13/14; dla pozostałych zadań plan nie wymaga migracji bazy.

### UX-01 — zakończenie sprawdzania sesji w powiadomieniach · P1

**Dowód:** `c11-notifications.png`; po sukcesie `/api/auth/me` brakuje `setAuthenticated(true)`.

**Pliki:** `apps/web/app/notifications/NotificationWorkspace.tsx`; istniejący harness powiadomień albo nowy `apps/web/scripts/notifications-ui-smoke.cjs`.

**Kroki:**
1. W aktywnej ścieżce sukcesu sesji ustawić rolę, CSRF i `authenticated=true`, następnie pobrać listę. Oddzielić sprawdzanie sesji od ładowania powiadomień.
2. Dodać anulowanie/ignorowanie nieaktualnych odpowiedzi po odmontowaniu lub ponowieniu; odpowiedź 401 listy nadal przełącza do logowania.
3. Błąd sesji pokazuje ponowienie; błąd listy zachowuje powłokę, komunikat i możliwość ponowienia. Udana pusta lista pokazuje pusty stan.
4. Zachować oznaczanie przeczytania, aktualizację licznika i otwieranie właściwej operacji.

**Odbiór:** po 200/200 użytkownik widzi treść testowego powiadomienia, a nie „Sprawdzam sesję…”. Sprawdzić 200/pusto, 401, 503, błąd sieci i skuteczne ponowienie. Jedno kliknięcie nie wywołuje dwóch mutacji przeczytania. Konto wymagające zmiany hasła nadal respektuje obowiązującą politykę sesji.

### UX-02 — nazwane i wygodne checkboxy firm · P1

**Dowód:** `a04-oc-selection-desktop.png`; AX potwierdził anonimowe checkboxy.

**Pliki:** `apps/web/app/tools/oc-policy-verification/CompanySelection.tsx`, `apps/web/app/tools/oc-policy-verification/automation.css`; test `oc-workspace-ui-smoke.cjs`.

**Kroki:**
1. Powiązać każdy checkbox z nazwą firmy i numerem wiersza przez natywny `label` albo stabilne `id` i `aria-labelledby`; nazwa powinna rozróżniać firmy o tej samej nazwie.
2. Powiększyć obszar aktywacji do całego wiersza/etykiety, z minimalną wysokością 44 px jako standardem produktu. Zostawić natywną obsługę klawiatury.
3. Zachować wybór po ID/numerach używanych obecnie, paginację, wyszukiwanie, limit 500 i tryb tylko do odczytu.

**Odbiór:** AX podaje konkretną firmę; kliknięcie nazwy i Space zaznaczają dokładnie ten sam wiersz. Powrót między stronami nie gubi zaznaczeń. Zbiorczy wybór zachowuje dotychczasowy zakres bieżącej strony. Tryb read-only nie pozwala zmienić wyboru. Sprawdzić 390 px i komputer.

### UX-03 — kontakty i nawigacja między firmami · P1

**Dowody:** `c03-my-results.png`, `c04-pool.png`, `c23-lead-detail.png`. To jeden problem współdzielonego komponentu, nie trzy osobne poprawki.

**Pliki:** `apps/web/app/leads/LeadWorkspace.tsx`, `apps/web/app/leads/leads.css`.

**Kroki:**
1. Ujednolicić użycie `.lead-contact-link` w listach i szczegółach. Dodać reguły bazowe poza media query: osobne wiersze telefonu i e-maila, siatka etykieta–wartość, odstępy oraz zawijanie długich adresów.
2. Nadać `.lead-queue-navigation` układ trzech części: poprzednia firma, kontekst kolejki, następna firma. Na telefonie zawijać te części w logicznej kolejności.
3. Wyróżnić stan braku poprzedniej/następnej firmy jako informację, nie aktywny link. Zachować `returnTo`, filtry, kolejność i zakres przydziału.
4. Nie zmieniać automatycznie statusu rozmowy podczas przechodzenia między firmami. Zachować komunikaty zapisu i konfliktu wersji.

**Odbiór:** etykiety i wartości nigdy się nie stykają. `tel:` i `mailto:` zachowują poprawne cele. Długie kontakty nie rozszerzają strony przy 320/390 px. Pierwsza, środkowa i ostatnia firma mają poprawne akcje. Osoba bez prawa edycji nadal ma widok tylko do odczytu.

### UX-04 — odróżnienie awarii od pustych danych w prowizjach · P2

**Dowód:** `a13-commission-error-mobile.png` wobec prawdziwego stanu pustego `a12`.

**Plik:** `apps/web/app/tools/commission-comparison/workspace.tsx`; proponowany test `apps/web/scripts/commission-workspace-ui-smoke.cjs`.

**Kroki:**
1. Nadać odczytom plików, wersji i historii jawne stany `loading/ready/error`. Rozróżnić brak pierwszego odczytu od nieudanego odświeżenia danych już posiadanych.
2. „Brak opublikowanego słownika” i zero plików pokazywać dopiero po udanym odczycie odpowiedniej kolekcji. Awaria wersji słownika nie jest dowodem jego braku.
3. Dodać przy alercie „Ponów ładowanie”, powtarzający tylko odczyty. Przy nieudanym odświeżeniu zachować ostatnie poprawne dane z informacją o nieaktualności.
4. Ignorować spóźnione odpowiedzi po zmianie wersji/odmontowaniu. Obsłużyć 401 jako wygaśnięcie sesji. Zachować wpisane stawki i istniejący protokół konfliktu rewizji.

**Odbiór:** 503 nie pokazuje instrukcji tworzenia nieistniejącego rzekomo słownika. Po ponowieniu 200 wracają dane bez przeładowania strony. Awaria jednej kolekcji jest opisana przy niej. Ponowienie nigdy nie uruchamia POST analizy, importu lub publikacji.

### UX-05 — wyjaśnienie blokady startu porównania · P2

**Dowód:** `a07-commission-desktop.png` — sam licznik „0 wybranych plików” nie wyjaśnia wymagań.

**Pliki:** `commission-comparison/workspace.tsx`, opcjonalny czysty helper `commission-readiness.ts` w tym katalogu. **Zależność:** UX-04.

**Kroki:**
1. Wyprowadzić jeden model gotowości z danych: uprawnienie, poprawny zakres dat, zaznaczony CRM, co najmniej jeden zaznaczony raport ASF/Warta, aktywny słownik, zakończone odczyty i brak trwającego zapisu.
2. Przy przycisku pokazać brakujące warunki tekstowo, np. „Zaznacz plik CRM oraz raport ASF lub Warty”, wraz z odnośnikiem/fokusem do odpowiedniej sekcji.
3. Powiązać objaśnienie z przyciskiem przez `aria-describedby`. Informacja ma być widoczna bez hovera i możliwa do odczytu mimo disabled przycisku.

**Odbiór:** osobno sprawdzić brak CRM, raportu, słownika, prawa uruchomienia, błędne daty, odczyt i awarię. Po spełnieniu warunków start jest aktywny. Serwer nadal waliduje żądanie. Istniejący klucz idempotencji przeżywa niepewne ponowienie startu.

### UX-06 — wybór plików i pusty stan na telefonie · P2

**Dowody:** `a11-commission-mobile.png`, `a12-commission-empty-mobile.png`.

**Pliki:** `commission-comparison/workspace.tsx`, `workspace.module.css`; można wydzielić `CommissionFileSelection.tsx`.

**Kroki:**
1. Na telefonie prezentować nazwę, typ, datę i checkbox w karcie/wierszu, zamiast wymagać przewijania tabeli do nazwy pliku. Cała etykieta wyboru ma mieć wygodny obszar dotyku.
2. Stan pusty przenieść poza szeroką tabelę; pełna instrukcja CRM + raport ma mieścić się w panelu.
3. Współdzielić stan zaznaczeń po `fileId` między wariantami. Dbać o unikalne ID i brak drugiej, ukrytej kopii kontrolki w kolejności fokusu/AX.
4. Po dodaniu plików pozwolić zwinąć duże pola uploadu do „Dodaj pliki”, pozostawiając wybrane pliki i gotowość startu widoczne.

**Odbiór:** przy 320/390 px odczyt i zaznaczenie pliku nie wymagają poziomego przewijania. Długie nazwy się zawijają. Obrót/zmiana viewportu nie gubi wyboru. Upload pozostaje dostępny. Nie powstaje poziomy overflow całej strony.

### UX-07 — wyraźny widok wyniku prowizji i dostępna nawigacja · P2

**Dowód:** `c25-commission-result.png`; dodatkowo sekcje mają obecnie wyłącznie wizualny stan aktywności.

**Pliki:** `commission-comparison/workspace.tsx`, `workspace.module.css`; proponowany `CommissionRunResult.tsx`.

**Kroki:**
1. Rozdzielić prezentację nowej analizy od wyniku. Przy otwieraniu z historii wyświetlać wynik jako główną treść z okresem, stanem, eksportem i powrotem do historii, bez formularza nowego startu nad wynikiem.
2. Zapisać kontekst w URL: `?view=result&runId=...`; pozostałe widoki `analysis/dictionary/history`. Brak parametrów otwiera dotychczasowy domyślny formularz. Nieznane wartości obsłużyć kontrolowanym fallbackiem, a niedostępny wynik komunikatem i powrotem.
3. Linki sekcji oznaczyć `aria-current="page"`; nie dodawać częściowej semantyki tabów bez wymaganej obsługi klawiatury. Obsłużyć Back/Forward i wejście bezpośrednim linkiem. Przy intencjonalnej zmianie widoku przenieść focus do nagłówka.
4. Zachować autoryzację eksportu, anulowanie tylko aktywnej analizy i polling tylko stanów aktywnych. Przejście do wyniku nie może stworzyć nowej analizy. Nie wkładać danych klientów lub wyników do URL/localStorage.
5. Ułożyć sześć metryk w stabilną siatkę, np. 3×2 na typowym desktopie i 2 kolumny na telefonie, bez samotnego szóstego kafla.

**Odbiór:** kliknięcie historii pokazuje wynik nad zgięciem, odświeżenie zachowuje wybór wyniku, a Wstecz wraca do historii. Stany active/completed/failed/404/401 mają osobne poprawne akcje. Użytkownik bez `canDownload` nie otrzymuje przycisku eksportu. Mutacje i fencing backendu pozostają bez zmian.

### UX-08 — jeden następny krok przy wyborze zakresu OC · P1

**Dowody:** `a04-oc-selection-desktop.png`, `a10-oc-mobile.png`; ustalenie z pełnej oceny user flow.

**Pliki:** `apps/web/app/run-submission-launcher.tsx`, `tools/oc-policy-verification/automation-workspace.tsx`, `automation-flow.ts`, `apps/web/app/workspace.tsx`. **Zależność:** UX-02.

**Kroki:**
1. Ułożyć wybór jako tryb „Wszystkie gotowe firmy” albo „Wybrane firmy”. Numery/zakresy wierszy przenieść do opcji zaawansowanej, zachowując obecną funkcję.
2. Zastąpić mylące CTA podglądu „Sprawdź wszystkie…” jednym „Przejdź do podsumowania”. Dopiero podsumowanie ma główne CTA „Uruchom sprawdzanie OC”.
3. Związać przejście z aktualnym wyborem i ważnym podsumowaniem. Zmiana wyboru unieważnia poprzedni podgląd i wymaga jego odświeżenia.
4. Usunąć konkurujące główne CTA w dolnej nawigacji kroku. Nawigacja do innego etapu nie jest wywołaniem startu; blokadę kolejnego działania wyjaśniać przy nim.
5. Zachować osiem etapów, istniejące URL `step`, przywracanie draftu i payloady startu. Oddzielić prezentację od dojrzałej logiki admission/idempotencji.

**Odbiór:** nowy użytkownik widzi jedno główne działanie na aktualnym etapie. Wybór, podgląd i przejście między etapami nie wysyłają żądania startu. Dopiero jawny start tworzy jedno zgłoszenie. Sprawdzić wybór pusty, 1/500/>500, wszystkie gotowe, zaawansowany zakres, stare podsumowanie, Back i odświeżenie.

### UX-09 — zwarty układ etapu OC na telefonie · P2

**Dowód:** `a10-oc-mobile.png` oraz powtórzenia nagłówków w `a02`/`c06`.

**Pliki:** `tools/oc-policy-verification/automation-workspace.tsx`, `automation.css`, `CompanySelection.tsx`, powiązane nagłówki w `workspace.tsx`.

**Kroki:** zostawić jeden właściwy nagłówek etapu; kontekst pliku zwinąć do krótkiej belki z rozwinięciem szczegółów; selektor etapu zachować. Wyszukiwanie i wybór zakresu umieścić bezpośrednio przy liście. Nie zmniejszać fontów, aby pozornie skrócić ekran. Zachować fokus nagłówka po przejściu kroku i dostęp do wcześniejszych etapów.

**Odbiór:** brak trzech kolejnych powtórzeń tytułu „Wybór wierszy/firm”. Przy 390×844 główna decyzja etapu jest widoczna bez przewijania przez wielokrotny opis. Długie nazwy plików oraz 200% zoom nie zasłaniają akcji. Lista i komunikaty pozostają w pełni dostępne.

### UX-10 — spójne filtry i paginacja kontroli importu · P2

**Dowód:** `c06-import-detail.png`.

**Pliki:** odpowiedni panel kontroli w `apps/web/app/workspace.tsx`, `globals.css`, `tools/oc-policy-verification/automation.css`.

**Kroki:** nadać wyszukiwaniu, filtrowi i przyciskom wspólną klasę/nazwany komponent z tą samą wysokością. Rozdzielić pasek filtrów nad tabelą i paginację pod nią. Na telefonie łamać całe grupy, nie pojedynczy przycisk „Następna”. Zmiana filtra wraca do pierwszej strony zgodnie z aktualnym kontraktem.

**Odbiór:** 1280/1440 px — oba przyciski paginacji w jednej grupie, pole wyszukiwania nie jest niższe od sąsiednich kontrolek. Przy 320 px kolejność czytania jest poprawna. Zmiana filtra i szybkie wpisywanie nie prezentują starej strony jako nowego wyniku.

### UX-11 — mobilne akcje listy firm · P2

**Dowody:** `c20-my-results-mobile.png`, `c21-pool-mobile.png`.

**Pliki:** `leads/LeadWorkspace.tsx`, `leads/leads.css`, ewentualnie współdzielony `LeadListActions.tsx`. **Zależność:** UX-03.

**Kroki:** przenieść eksport i odświeżanie na telefonie do osobnego wiersza pod tytułem; ujednolicić styl odświeżania i nadać mu nazwę dostępną. Przycisk eksportu powinien mieć czytelną etykietę zamiast trzech wąskich linii. Zachować opis, że eksport obejmuje aktywne filtry, a nie tylko bieżącą stronę.

**Odbiór:** 320/390 px — akcje nie ściskają tytułu ani nie znikają poza ekranem. Eksport zachowuje grant i filtr zakresu, odświeżenie zachowuje filtry/wybór strony zgodnie z obecną funkcją. W trakcie eksportu nie powstają wielokrotne żądania.

### UX-12 — widoczne zarządzanie pracownikiem · P2

**Dowód:** `c13-team.png`.

**Pliki:** `apps/web/app/team/TeamWorkspace.tsx`, `team/team.css`.

**Kroki:** przypiąć kolumnę akcji do prawej krawędzi przewijanej tabeli na desktopie, z nieprzezroczystym tłem i widocznym fokusem; na telefonie umieścić akcję w karcie pracownika. Pomocnicze dane mogą się zawijać. Zachować `aria-expanded`, czyszczenie hasła roboczego i dotychczasowe potwierdzenia/uprawnienia zarządzania.

**Odbiór:** „Zarządzaj” jest dostępne bez przesuwania poziomego przy 1280 px. Po rozwinięciu panel dotyczy właściwego użytkownika. Focus i aktywne pole nie są zakryte sticky kolumną. Zwykły pracownik nadal nie otrzymuje uprawnień managera.

### UX-13 — rozpoznawalne nazwy w historiach · P2/P3

**Dowody:** `c05-imports.png`, `c07-runs.png`, `c09-result-history.png`.

**Pliki UI:** `apps/web/app/history/HistoryList.tsx`, `history.css`, `lib/ui-labels.ts`. **Backend:** `apps/api/src/features/reports/history.repository.ts`, `history.service.ts`, kontrakt odpowiedzi i `history.spec.ts`.

**Kroki:**
1. Kod `oc-policy-verification` prezentować jako „Sprawdzanie OC”.
2. Addytywnie uzupełnić DTO historii przebiegów/wyników o dozwolony kontekst, np. `companyName` i `sourceFileName`, gdy można go uzyskać z aktualnie dostępnych źródeł/snapshotów. Typy historyczne muszą obsłużyć null.
3. W repozytorium odczytać kontekst w jednym ograniczonym zapytaniu, z tenantem i dotychczasową widocznością. Nie wykonywać osobnego fetch/query dla każdego wpisu. Join nie może mnożyć wierszy ani zmienić granic kursora.
4. Tytuł wpisu: firma, pomocniczo plik i numer wiersza. Gdy nazwy brak — uczciwy fallback „Wynik — wiersz 14”. Pełny UUID zostawić w szczegółach/kopiowaniu.
5. Zachować tombstones i reguły kasowania. Nie odtwarzać usuniętych nazw ani kontaktów przez nowe połączenia tabel.

**Odbiór:** dwie różne firmy o tym samym numerze wiersza są rozpoznawalne. Stare wyniki i wyniki po usunięciu źródła nadal się otwierają. Paginacja nie duplikuje wpisów. Negatywne testy tenantów i ról potwierdzają niezmieniony zakres; eksport i cele linków nadal wskazują te same zasoby.

### UX-14 — wybór importu w korektach zamiast kopiowania UUID · P2

**Dowód:** `c16-review.png`.

**Pliki UI:** `apps/web/app/review/ReviewPage.tsx`, proponowany `review/ImportPicker.tsx`, `review.css`. **Backend:** `apps/api/src/features/review/review.controller.ts`, `review.service.ts`, `review.repository.ts` i testy HTTP modułu.

**Kroki:**
1. Dodać do modułu review odczyt `GET /api/review/import-options` z `search`, `toolId`, `limit` i kursorem. Zwracać tylko `batchId`, nazwę pliku i datę. Opcje wyprowadzać z importów dostępnych w zakresie kolejki danego użytkownika, nie z pełnego katalogu tenantów.
2. Ograniczyć wyszukiwanie i limit (domyślnie 20, maksymalnie 50; fraza maksymalnie 120 znaków). Parametryzować SQL i escapować wzorce LIKE; powiązać kursor z filtrami.
3. W UI użyć dostępnego combobox/listbox z wyszukiwaniem po nazwie i dacie, obsługą pustego wyniku, ładowania, błędu i wyczyszczenia. Po wyborze zapisać dotychczasowy `batchId` w URL.
4. Narzędzie wybierać z listy dozwolonych nazw/kodów. Istniejący bezpośredni link z `batchId` nadal ma działać bez ponownego wyboru.

**Odbiór:** recenzent znajduje import po nazwie bez kopiowania adresu. Operator widzi wyłącznie swój dozwolony zakres. Możliwa obsługa klawiaturą. Zmiana filtra resetuje kursor; Back przywraca filtry. Nowy endpoint nie rozszerza prawa do importów poza widoczność kolejki.

### UX-15 — polskie opisy zdarzeń audytowych · P2

**Dowód:** `c17-audit.png`.

**Pliki:** `apps/web/app/audit/AuditPage.tsx`, `apps/web/app/admin/page.tsx`; proponowany współdzielony `apps/web/app/lib/audit-labels.ts`.

**Kroki:** wprowadzić katalog opisów zdarzeń i typów zasobów; w tabeli pokazać np. „Przydzielono firmy”, a kod `lead.allocated` oraz pełne ID w szczegółach. Filtrowanie nadal wysyła oryginalne kody. Nowe/nieznane zdarzenie ma czytelny fallback i zachowany kod.

**Granica uprawnień:** dla auditora używać metadanych już zwracanych przez audit API: polski typ zasobu i skrócone ID. Nie pobierać firm, kontaktów ani nazw zasobów operacyjnych dodatkowym lookupem. Czytelność audytu nie jest zgodą na rozszerzenie dostępu.

**Odbiór:** istniejące filtry i paginacja działają bez zmiany semantyki. Nieznany kod nie znika. Audytor nie wykonuje nowych zapytań do endpointów operacyjnych. Zdarzenia i metadane zapisane w DB nie są przepisywane.

### UX-16 — jedna sekcja administracji naraz · P2

**Dowody:** `c18-admin.png`, `c22-admin-mobile.png`.

**Pliki:** `apps/web/app/admin/page.tsx`, `apps/web/app/admin.css`; przy wydzielaniu sekcji `apps/web/app/admin/sections/*`.

**Kroki:**
1. Z istniejących siedmiu sekcji zrobić widoki wybierane nawigacją. Zachować adresy `#resources`, `#accounts`, `#operations`, `#interventions`, `#automation`, `#audit`, `#reports`; domyślnie resources.
2. Zastąpić śledzenie aktywnej sekcji na podstawie scrolla stanem odczytanym z hash. Obsłużyć bezpośredni link, hashchange i Back/Forward.
3. Wyświetlać jeden obszar roboczy naraz. Wydzielić interwencje z zagnieżdżenia w operacjach, aby można je było otworzyć samodzielnie. Nagłówek i nawigacja pozostają wspólne.
4. Bezpieczne filtry i wybór konta zachować w stanie rodzica. Pola haseł czyścić po wyjściu z sekcji. Trwającej mutacji nie wysyłać ponownie podczas przełączenia. Dotychczasowe step-up i potwierdzenia nadal obowiązują.
5. Dane tylko do odczytu pobierać dla aktywnego obszaru, z anulowaniem nieaktualnych żądań. Nie robić pełnej przebudowy uprawnień ani publicznych tras.

**Odbiór:** wszystkie siedem sekcji otwiera się bezpośrednim linkiem. Na telefonie nie widać naraz formularzy kont, operacji, audytu i raportów. Przełączenie sekcji nie zapisuje danych. Nie gubi się wybór konta, a hasło nie pozostaje w ukrytej sekcji. Po potwierdzonej operacji odświeżają się właściwe dane.

### UX-17 — czytelne podsumowanie zgłoszenia · P2

**Dowód:** `c10-submission.png`.

**Pliki:** `apps/web/app/submissions/[id]/submission-detail.tsx`, `run-submissions.css`; proponowany helper prezentacji liczników w tym module.

**Kroki:** wyróżnić trzy liczniki dotyczące tej samej jednostki — pozycji/wierszy: zakończone, w toku, wymagające działania. Jawnie zmapować istniejące statusy: m.in. zakończone z polisami/bez polis, oczekujące/pracujące oraz błędy/kontrola. Pominięte i anulowane pokazać osobno, żeby suma była rozliczalna. Liczbę grup, wybranych wierszy i przyjętych wykonań przenieść do rozwijanych szczegółów; nie sumować liczników grup z pozycjami. Zastąpić „Przyjęte runy” zrozumiałą nazwą.

**Odbiór:** mieszane fixture obejmujące completed, no_matching_policies, failed, waiting_attention, waiting/running, cancelled i skipped są rozliczone dokładnie raz. Nie zmienia się status zgłoszenia ani możliwość anulowania. Definicje liczników są widoczne w pomocy, a nie odgadywane z koloru.

### UX-18 — czytelna etykieta pobrania na złotym tle · P2

**Dowód:** `c08-run-detail.png`.

**Pliki:** `apps/web/app/workspace.tsx` i reguły `.download-link` w aktywnych arkuszach `globals.css`/`styles/theme.css`.

**Kroki:** ustalić jedną regułę akcji pobierania z ciemnym tekstem na złotym tle, zgodną z głównymi CTA. Ograniczyć selektor do właściwego komponentu, nie nadpisywać wszystkich linków. Dopracować hover, focus-visible, disabled/busy.

**Odbiór:** kontrast rzeczywiście renderowanej pary tekst/tło co najmniej 4,5:1 dla zwykłego tekstu; fokus widoczny na obu powierzchniach. Cel pobrania i autoryzacja bez zmian. Nie zmienia się kolor nawigacji lub drugorzędnych linków.

### UX-19 — działające przejście klawiaturą do treści · P2

**Dowód:** `b04-skip-focus.png` i test Tab → Enter → Tab z pełnej oceny.

**Pliki:** `apps/web/app/layout.tsx`, rzeczywiste regiony `main` na stronach, `platform-route-frame.tsx`; proponowany wspólny `apps/web/components/ui/MainRegion.tsx`.

**Kroki:** usunąć cel `main-content` z wrappera zawierającego sidebar. Umieścić go na jednym faktycznym obszarze treści każdej aktywnej trasy, z `tabIndex=-1`. Ujednolicić ten wzorzec we własnych powłokach stron oraz wariantach loading/error/login. `PlatformRouteFrame` nie może tworzyć drugiego regionu ani duplikować ID. Zachować działające pułapki fokusu i Escape menu mobilnego.

**Odbiór:** Tab → Enter na skip linku przenosi focus do treści, a następny Tab trafia do pierwszej akcji treści, nie logo/sidebaru. Sprawdzić dashboard, listę firm, OC, porównywarkę i admin oraz zmianę trasy bez pełnego odświeżenia. W DOM jest dokładnie jeden cel o tym ID.

### UX-20 — wspólny język, liczebniki i techniczne szczegóły · P3

**Dowody:** pełny przegląd, `c05`, `c07`, `c09`, `c10`, `c17`.

**Pliki:** `apps/web/app/lib/ui-labels.ts`; proponowane `tool-labels.ts` i `plural-pl.ts`; miejsca prezentacji w dashboard/history/workspace/submissions/admin.

**Kroki:** ustalić rozróżnienie: „firma” jako obiekt pracy, „import” jako plik źródłowy, „sprawdzanie” jako czynność, „zadanie firmy” jako wykonanie dotyczące konkretnego wiersza. W zwykłych ekranach ograniczyć „lead/run/worker/rewizja” do sytuacji, w których termin jest rzeczywiście potrzebny; szczegóły techniczne rozwijać. Nie zmieniać kodów statusów i parametrów API. Dodać odmianę liczebników przez polskie reguły liczby; stosować do plików, zadań i pozycji. Zachować precyzyjne znaczenie daty odniesienia i komunikaty o niepewnym skutku operacji.

**Odbiór:** wspólna czynność ma tę samą nazwę na dashboardzie, w historii i szczegółach. Sprawdzić odmianę dla 0, 1, 2, 4, 5, 11, 12, 14, 21, 22 i 102. Maszynowe kody i identyfikatory pozostają dostępne w szczegółach diagnostycznych; nie znikają z audytu.

## 4. Stan wdrożenia

Zmiany poniżej są zapisane w kodzie roboczym. Status „wdrożono” oznacza implementację, nie potwierdzenie działania na gotowym buildzie. Kryteria odbioru z rozdziału 6 pozostają wymagane przed przekazaniem aplikacji klientowi.

| Karta | Stan w kodzie | Zakres wykonanej implementacji / ograniczenie |
|---|---|---|
| UX-01 | Wdrożono | Sesja 200 przełącza widok na powiadomienia; lista ma stany błędu, ponowienia i pustej odpowiedzi; odczyt nie dubluje mutacji, a 401 wraca do logowania. |
| UX-02 | Wdrożono | Checkbox firmy ma nazwę firmy i wiersz, cała etykieta jest klikalna; paginacja i limit wyboru pozostają bez zmian. |
| UX-03 | Wdrożono | Kontakty mają stały układ etykieta–wartość, a szczegóły firmy prowadzą między pozycjami kolejki bez zmiany statusu kontaktu. |
| UX-04 | Wdrożono | Odczyt plików, wersji, słownika i historii rozróżnia ładowanie, pusty wynik i błąd; ponowienie zachowuje ostatnie poprawne dane. |
| UX-05 | Wdrożono | Formularz analizy zawiera zakres dat, komunikat gotowości i CTA zablokowane do czasu spełnienia wymagań. |
| UX-06 | Wdrożono | Wybór plików ma osobne karty mobilne, jawny pusty stan i odzyskiwanie po błędzie odczytu. |
| UX-07 | Wdrożono | Wynik ma własny widok z podsumowaniem, komunikatem błędu i przyciskiem powrotu; wynik jest dostępny z adresu URL i ma focus nagłówka. |
| UX-08 | Wdrożono | CTA wyboru firm i zakresu kieruje do podsumowania; dopiero osobne potwierdzenie uruchamia sprawdzanie. |
| UX-09 | Wdrożono | Etapy OC zwijają kontekst pomocniczy, a układ mobilny zachowuje kontekst aktywnej firmy i operacji. |
| UX-10 | Wdrożono | Filtry i osobne kontrolki stron znajdują się przed odpowiednimi tabelami; selektory i przyciski mają wygodny obszar aktywacji na telefonie. |
| UX-11 | Wdrożono | Akcje na liście firm są dostępne w widoku mobilnym, także po zmianie statusu i w kolejce. |
| UX-12 | Wdrożono | Akcja zarządzania pracownikiem pozostaje widoczna na desktopie i w karcie mobilnej; liczebniki korzystają ze wspólnego helpera. |
| UX-13 | Wdrożono z ograniczeniem danych | Historia pokazuje narzędzie, nazwę źródłowego pliku, wiersz i zwijane ID. Nie dołączono nazwy firmy przez dodatkowy odczyt tabel operacyjnych ani odtworzenie danych po usunięciu źródła. |
| UX-14 | Wdrożono | Korekty pobierają importy widoczne dla roli z parametryzowanego, ograniczonego endpointu; UI ma wyszukiwanie, ponowienie, stronicowanie i synchronizację wyboru z URL. |
| UX-15 | Wdrożono | W audycie są polskie etykiety; oryginalne kody i pełne identyfikatory pozostają dostępne w szczegółach bez dodatkowego lookupu. |
| UX-16 | Wdrożono | Administracja pokazuje jedną z siedmiu sekcji, obsługuje hash i historię przeglądarki, ładuje dane zależne od sekcji i odświeża kolejkę po zapisie. |
| UX-17 | Wdrożono | Podsumowanie zgłoszenia rozdziela zakończone, trwające i wymagające działania pozycje od pominiętych/anulowanych; szczegóły nie sumują grup z wierszami. |
| UX-18 | Wdrożono | Akcja pobrania ma ograniczony styl, widoczny fokus i etykietę odróżniającą ją od nawigacji. Kontrast wymaga potwierdzenia po renderze. |
| UX-19 | Wdrożono | Skip link wskazuje pierwszy faktyczny obszar treści w aktywnym `main` i usuwa ewentualne duplikaty ID po zmianie trasy. Obsługę trzeba potwierdzić na każdej trasie i wariancie ekranu. |
| UX-20 | Wdrożono w kluczowych ścieżkach | Wspólne nazwy i helper odmiany liczebników są użyte w nawigacji, historii, zespole, porównywarce i zgłoszeniach; kody techniczne zachowano w diagnostyce. Pełny przegląd pozostałych tekstów jest częścią końcowego odbioru. |

**Nie wykonano jeszcze testów, builda ani ponownego przeglądu screenshotów.** W repozytorium są zmiany niezwiązane z tym pakietem; należy je zachować przy dalszej pracy. Po weryfikacji uzupełnić statusy kart i tabelę odbioru, zamiast uznawać implementację za automatycznie zaakceptowaną.

## 5. Powiązanie z każdym screenshotem mającym uwagi

| Screenshot | Zadania |
|---|---|
| a04 — wybór firm | UX-02, UX-08 |
| a07 — formularz prowizji | UX-05 |
| a10 — OC mobile | UX-08, UX-09 |
| a11 — pliki prowizji mobile | UX-06 |
| a12 — pusty stan mobile | UX-04, UX-06 |
| a13 — błąd odczytu | UX-04 |
| c03 — moje firmy | UX-03 |
| c04 — pula firm | UX-03 |
| c05 — historia importów | UX-13, UX-20 |
| c06 — kontrola importu | UX-09, UX-10 |
| c07 — historia przebiegów | UX-13, UX-20 |
| c08 — szczegóły zadania | UX-18 |
| c09 — historia wyników | UX-13 |
| c10 — zgłoszenie | UX-17, UX-20 |
| c11 — powiadomienia | UX-01 |
| c13 — pracownicy | UX-12 |
| c16 — korekty REGON | UX-14 |
| c17 — audyt | UX-15 |
| c18 — administracja | UX-16 |
| c20 — moje firmy mobile | UX-11 |
| c21 — pula mobile | UX-11 |
| c22 — administracja mobile | UX-16 |
| c23 — szczegóły firmy | UX-03 |
| c25 — wynik prowizji | UX-07 |

Dodatkowo: skip link → UX-19, dostępny stan sekcji prowizji → UX-07, odmiany i nazewnictwo → UX-20. Priorytet UX-03 podniesiono względem samej oceny wizualnej karty, ponieważ dotyczy podstawowego ekranu codziennej pracy i wcześniej wskazanego problemu user flow.

Widoki bez istotnych zastrzeżeń są próbą kontrolną: a01/a09 dashboard, a02 upload, a08 słownik, c01/c19 logowanie, c02 katalog, c12 konto, c14 dostępy, c15 raporty, c24 historia prowizji. Kontrolować je po zmianach wspólnych CSS i nawigacji; nie przebudowywać ich dla samej zmiany wyglądu.

## 6. Testy i końcowy odbiór

### Odbiór każdego pakietu

1. Przed kodowaniem przeczytać lokalne dokumenty używanej wersji Next z `node_modules/next/dist/docs/`, zgodnie z `apps/web/AGENTS.md`. Przed UI edit przeczytać aktualne wymagania craft-floor skilla Impeccable. To nie są komendy do automatycznego uruchomienia skanera na końcu samego planowania.
2. Użyć istniejących harnessów: `oc-workspace-ui-smoke`, `lead-ui-smoke`, `history-ui-smoke`, `review-ui-smoke`, `admin-ui-smoke`, `tool-grants-ui-smoke`, `run-submission-ui-smoke`, `security-browser-smoke`. Dodać tylko brakujące, istotne scenariusze powiadomień i prowizji. Jawnie dołączyć je do runnera/CI; samo utworzenie pliku nie wystarcza.
3. Przetestować zachowanie realnych komponentów na kontrolowanych odpowiedziach API, z poprawnymi aktualnymi DTO. Nie zastępować testowanego UI atrapą. Dla UX-13/14 wykonać również testy prawdziwego API/repozytorium na izolowanym PostgreSQL, w tym zakresy tenantów i ról.
4. Po zmianach zbudować web i zmieniony backend. Build i testy korzystające z tego samego `dist/.next` uruchamiać sekwencyjnie; nie czyścić outputu podczas pracy innego runnera.
5. Każdą istotną poprawkę zamknąć scenariuszem, który zawodzi przed nią i przechodzi po niej. Nie dopisywać testów sprawdzających wyłącznie obecność konkretnej klasy CSS.

### Macierz wizualna

- Komputer 1440×1040 i laptop 1280×800: główna akcja widoczna, spójne wysokości kontrolek, akcje tabel w zasięgu.
- Telefon 390×844 oraz kontrola wąskiego 320 px: brak poziomego overflow całego dokumentu; dopuszczalny lokalny scroll prawdziwych tabel danych. Wybór plików i akcje główne dostępne bez takiego scrolla.
- Klawiatura: skip link, kolejność Tab, Space checkboxa, Enter akcji, Escape zamknięcia menu/dialogu, przywrócenie fokusu.
- 200% zoom, długie nazwy firm/plików, brak kontaktów, wiele kontaktów, puste listy, błędy 401/403/404/409/503 i niepewne ponowienie.
- Role: operator, manager, reviewer, auditor i admin — zgodnie z właściwymi trasami. Ukrycie kontrolki nie zastępuje odmowy API.

### Scenariusze użytkownika do zamknięcia prac

1. **Pracownik:** logowanie → moje firmy → kontakt → zapis decyzji → następna firma → powrót z zachowaniem filtrów.
2. **Operator OC:** import → kontrola → wybór → podsumowanie → jeden jawny start → informacja o stanie/interwencji → wynik i dozwolony eksport.
3. **Osoba rozliczająca prowizje:** pliki CRM + raport → jasna gotowość → start → wynik → historia → ponowne otwarcie wyniku i odświeżenie linku. Osobno awaria odczytu i ponowienie bez ponownego startu.
4. **Menedżer:** pula → podsumowanie przydziału → przydział → lista pracownika; zarządzanie kontem bez szukania ukrytej kolumny.
5. **Recenzent/audytor/admin:** znalezienie importu bez UUID, czytelny audyt w swoim zakresie, wejście bezpośrednio do sekcji administracji. Brak rozszerzenia uprawnień.

Fixture UI dowodzi prowadzenia użytkownika, a nie rzeczywistego powodzenia portali LIVE lub poprawności wyliczeń. Odbiór połączonego stosu i nadzorowane próby LIVE pozostają odrębnymi elementami ogólnego odbioru aplikacji.

### Dowody po implementacji

Zapisać do nowego katalogu datowanego odbioru: wersję/identyfikator builda, listę zmienionych plików, wyniki testów i nowe screenshoty odpowiadające bazowym. Wykonać jeden zbiorczy przegląd desktop/mobile; poprawić znalezione problemy w jednym pakiecie i potwierdzić raz. Nie nadpisywać galerii z 8 listopada.

Rekord dla zadania: `ID`, stan `PLAN/IMPLEMENTED/VERIFIED`, pliki, wynik kryteriów, testy, screenshot przed/po, ograniczenia. Do VERIFIED potrzebne są spełnione kryteria, nie tylko poprawna kompilacja. Docelowy stan: wszystkie 20 zadań zweryfikowane, 24 widoki z uwagami mają odpowiedź w odbiorze, a 11 widoków kontrolnych nie ma regresji.

## 7. Wdrożenie i wycofanie

Zmiany prezentacji wdrażać pakietami, po ich odbiorze. Backend UX-13/14 powinien być addytywny i zgodny ze starszym klientem; pola kontekstu opcjonalne, nowe filtry opcjonalne. Po tym wdrażać UI korzystające z rozszerzeń. Przewidywany zakres nie wymaga migracji danych; jeśli implementacja ujawni taką potrzebę, opisać ją przed realizacją osobno.

Wycofanie dotyczy konkretnego pakietu UI i zgodnych rozszerzeń API, bez cofania poprawek bezpieczeństwa, danych, grantów lub rewizji. Bez zmian masowych w danych klienta. Nie wracać do starszego wydania zawierającego naprawione luki tylko po to, aby wycofać wygląd.
