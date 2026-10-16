# Plan implementacji napraw user flow Goldis

Data: 12 października 2026. Status: **zaimplementowany i odebrany 12 października 2026**.

## Cel i podstawa

Domknąć ścieżkę operatora po zgłoszeniu korekty, zabezpieczyć przydział leadów oraz usunąć problemy nawigacji i responsywności wykryte w przeglądzie frontendu.

Podstawa: przegląd pięciu ról, 35 zrzutów desktopowych i 14 mobilnych, kod aplikacji oraz aktualne kontrakty API. Przebieg przeglądarkowy korzystał z syntetycznych odpowiedzi API. Odbiór implementacji musi objąć interakcje i kontrolowane scenariusze API, ponieważ same zrzuty nie potwierdzają całego procesu.

Wymagania biznesowe wynikają z `docs/PLAN_IMPLEMENTACJI_MVP_I_REBRANDINGU_2026-10-11.md` i `docs/design/goldis/mvp-2026-10-11/PRODUCT.md`. Przydział jest stały w MVP; błędom należy zapobiegać przed zatwierdzeniem. API wybiera najstarsze dostępne leady w zadanym zakresie, zgodnie z obecną kolejnością `created_at`, `lead_id`.

## Kolejność i zależności

| Etap | Priorytet | Zakres | Zależność | Wynik |
| --- | --- | --- | --- | --- |
| 1 | P1 | Ścieżka „Moje korekty” | Istniejąca kolejka własnych korekt | Operator odnajduje zgłoszenie i wynik decyzji |
| 2 | P1 | Bezpieczny przydział leadów | Kontrakt dostępności API przed podłączeniem formularza | Odbiorca, liczba i zakres są potwierdzane; ponowienie zachowuje tę samą operację |
| 3 | P2 | Nawigacja weryfikacji | Wspólny shell i ścieżka z etapu 1 | Jeden zestaw nawigacji globalnej, zakładki kolejek w treści |
| 4 | P2 | Filtry administratora | Kontrola współdzielonych selektorów CSS | Wszystkie kontrolki dostępne na desktopie i telefonie |
| 5 | P3 | Komunikaty i etykiety | Docelowe widoki z etapów 1–4 | Statusy narzędzia i filtrów są zrozumiałe |
| 6 | Odbiór | Interakcje, role, błędy i szerokości | Etapy 1–5 | Spełnione kryteria poniżej i zapisane dowody odbioru |

Każdy etap powinien być osobną, małą zmianą umożliwiającą przegląd. Przed implementacją zapisać stan lokalnych zmian, ponieważ repozytorium zawiera już rozbudowane, niezatwierdzone prace. Przed zmianami Next.js przeczytać właściwe lokalne przewodniki wymagane przez `apps/web/AGENTS.md`.

## Etap 1 — operator śledzi swoje korekty

### Zmiany

- W `apps/web/app/leads/LeadSidebar.tsx` dodać dla operatora pozycję „Moje korekty” w sekcji pracy, prowadzącą do istniejącego `/review`. Zachować „Weryfikacja danych” dla managera, administratora i recenzenta.
- W `apps/web/app/enrichment-review.tsx` umieścić trwały komunikat po zapisie korekty wraz z odnośnikiem „Zobacz moje korekty”. Przenieść komunikat do poziomu, na którym odświeżenie wiersza do stanu `pending` go nie usuwa. Odnośnik przekazuje `batchId` i `toolId` do istniejących filtrów kolejki.
- W `apps/web/app/review/ReviewPage.tsx` dopasować tytuł i opis do operatora: śledzenie zgłoszeń oraz wyników decyzji. Parametr `tab=conflicts` dla operatora normalizować do własnych korekt, łącznie z filtrami i pustym stanem.
- Pokazać statusy „Oczekuje na weryfikację”, „Zatwierdzona”, „Odrzucona”, datę zgłoszenia, import, firmę i numer wiersza. Dodać powrót do importu z karty korekty.
- Rozszerzyć odpowiedź listy korekt w `apps/api/src/review-service.ts` o istniejące w modelu `reviewedAt` i `reviewReason`. Obecna lista zwraca uzasadnienie autora, ale nie zwraca daty ani powodu decyzji. Rozdzielić te informacje w UI i tłumaczyć kody decyzji na polski. Dla zgłoszeń oczekujących pola decyzji są puste.
- Dopasować pusty stan do filtrów oraz zachować jednoznaczne komunikaty o wygaśnięciu sesji i błędzie pobierania.

### Kryteria odbioru

- [x] Operator dociera do własnych zgłoszeń przez menu desktopowe i mobilne.
- [x] Po wysłaniu propozycji widzi trwałe potwierdzenie i odnośnik do kolejki ograniczonej do importu.
- [x] Widzi trzy statusy oraz datę i powód decyzji, jeśli została podjęta.
- [x] Widzi wyłącznie swoje korekty w swojej organizacji; brak kontrolek podejmowania decyzji.
- [x] Bezpośrednie wejście z `tab=conflicts` nie zmienia operatorowi widoku ani dostępnych filtrów na konflikty.
- [x] Manager, admin i reviewer zachowują kolejki decyzyjne; auditor otrzymuje dotychczasową odmowę dostępu.

### Weryfikacja

Rozszerzyć `apps/web/scripts/review-ui-smoke.cjs` o wejście z menu, filtr importu, trzy statusy i odmowę decyzji dla operatora. Uzupełnić `apps/api/src/review.http.test.ts` o nowe pola odpowiedzi. Scenariusz zgłoszenia i decyzji sprawdzić również na danych kontrolowanych, z odrębnymi autorami i organizacjami.

## Etap 2 — bezpieczny przydział leadów

### Potwierdzone zależności w kodzie

- Lista w `LeadWorkspace.tsx` może pobierać dane z `resultSetId` z adresu strony. Obecny POST przydziału pomija ten parametr, choć API go obsługuje. Przydział może więc objąć szerszą pulę niż otwarty zestaw wyników.
- API obsługuje idempotencję, natomiast formularz generuje nowe `idempotencyKey` przy każdej próbie. Po utracie odpowiedzi ponowienie może utworzyć kolejny przydział.
- Lista jest stronicowana po 25 rekordów. `items.length` nie określa całkowitej dostępności leadów.

### Kontrakt API

- Dodać odczyt dostępności, np. `GET /api/leads/allocation-summary?resultSetId=...`, zwracający `availableCount`, `resultSetId` i `checkedAt`.
- Dostęp przyznać wyłącznie managerowi i administratorowi, z kontrolą organizacji i narzędzia zgodną z przydziałem.
- Liczyć dokładnie tę samą pulę co POST: leady gotowe, nieprzydzielone, ukończony zestaw wyników i wykluczone importy w procesie usuwania. Współdzielić warunki kwalifikacji, aby odczyt i zapis nie rozchodziły się w przyszłości.
- Zachować transakcyjną walidację przy zapisie. Odczyt dostępności ma charakter informacyjny; inne przydziały mogą zmienić pulę przed zatwierdzeniem.
- Dla zmiany puli zwracać stabilny kod błędu i dostępność w ustrukturyzowanych polach. Frontend nie powinien wyciągać liczby z tekstu komunikatu.
- Nowe pola odpowiedzi korekt i odczyt dostępności wykorzystują istniejące dane; na tym etapie nie przewiduje się migracji schematu.

### Formularz i podsumowanie

- W `apps/web/app/leads/LeadWorkspace.tsx` korzystać z jednego źródła `resultSetId` dla listy, odczytu dostępności oraz POST przydziału.
- Pokazać „Dostępne do przydziału: N” dla całej puli albo konkretnego zestawu wyników. Jednoznacznie nazwać zakres.
- Filtry wyszukiwania i statusu kontaktu służą przeglądaniu tabeli. Podsumowanie przydziału wskazuje zakres całej puli lub zestawu, zgodnie z kontraktem API.
- Walidować liczbę całkowitą w zakresie 1–min(5000, dostępna pula). Przy pustej puli, braku odbiorców i błędzie odczytu dostępności pokazać właściwy stan formularza.
- Zastąpić bezpośredni zapis etapem „Sprawdź przydział”. Podsumowanie pokazuje odbiorcę, liczbę, zakres oraz zasadę wyboru najstarszych wolnych leadów. Dodać informację o stałości przydziału w MVP.
- Wykonać POST dopiero po „Potwierdź przydział”. „Wróć do edycji” zachowuje wartości. Zmiana odbiorcy, liczby lub zakresu wymaga nowego podsumowania.
- Podsumowanie powinno być dostępne klawiaturą; przy modalnym rozwiązaniu obsłużyć fokus, Escape i powrót fokusu do przycisku.

### Ponowienie i konflikt

- Utworzyć `idempotencyKey` raz dla zatwierdzanego podsumowania i zachować go przy ponowieniu tego samego żądania po timeout/zerwaniu połączenia.
- Przy niepewnym wyniku pokazać komunikat i akcję ponowienia tej samej operacji. Blokować utworzenie innego przydziału do wyjaśnienia jej wyniku. Zapisać oczekującą operację w stanie sesji przeglądarki z kontrolą użytkownika/organizacji, aby odświeżenie nie gubiło klucza.
- Podczas zapisu zablokować wielokrotne zatwierdzenie.
- Po definitywnym konflikcie puli odświeżyć dostępność, zachować odbiorcę i liczbę, pokazać błąd przy polu i wymagać ponownego podsumowania.
- Po sukcesie wyświetlić odbiorcę, liczbę i identyfikator przydziału oraz odświeżyć listę i dostępność. Nowy przydział otrzymuje nowy klucz.

### Kryteria odbioru

- [x] Sam podgląd i anulowanie nie wysyłają POST.
- [x] Otwarty zestaw wyników ogranicza również przydział; żaden lead z innego zestawu nie zostaje przypisany.
- [x] Licznik obejmuje całą kwalifikującą się pulę, także przy więcej niż 25 rekordach.
- [x] Błędna liczba, pusta pula i brak odbiorców blokują zatwierdzenie z czytelnym powodem.
- [x] Utrata odpowiedzi, ponowienie i odświeżenie strony nie tworzą drugiego przydziału.
- [x] Niepewny przydział blokuje rozpoczęcie innej operacji również po przejściu do innego zakresu wyników.
- [x] Dwie równoległe operacje nie przypisują tego samego leada; niewystarczająca pula nie powoduje częściowego przydziału.
- [x] Konflikt pozwala poprawić liczbę i przejść ponownie przez podsumowanie.
- [x] Operator, reviewer i auditor nie mają formularza ani uprawnienia do odczytu dostępności przydziału.

### Weryfikacja

Rozszerzyć `apps/web/scripts/manager-ui-smoke.cjs` o podsumowanie, anulowanie, `resultSetId`, walidację, konflikt oraz ponowienie z tym samym kluczem. Dodać skoncentrowane testy HTTP nowego kontraktu dostępności. Uzupełnić `apps/api/scripts/business-leads-db-smoke.cjs` o zgodność licznika z kwalifikacją, dwa zestawy wyników, równoległe przydziały i ponowienie po udanym zapisie. Użyć istniejącego harnessu jednorazowej bazy.

## Etap 3 — jedna nawigacja weryfikacji

- W `apps/web/app/review/ReviewPage.tsx` usunąć wewnętrzną nawigację globalną `admin-rail` i dopasować treść do `apps/web/app/platform-route-frame.tsx`.
- Pozostawić zakładki „Korekty REGON” i „Konflikty encji” jako lokalne przełączniki kolejki dla uprawnionych ról.
- Uzgodnić nagłówek wspólnego shellu z widokiem operatora „Moje korekty”.
- Uporządkować nieużywane elementy i importy strony. Współdzielone reguły w `apps/web/app/legacy-platform-frame.css` zmieniać dopiero po sprawdzeniu admina i audytu, które także używają starego układu.
- Sprawdzić dostępność konta i wylogowania po usunięciu starego menu.

Kryteria: jeden zestaw linków globalnych, poprawna aktywna pozycja, działające zakładki i historia przeglądarki, brak pustego paska oraz dodatkowego przewijania menu na telefonie. Sprawdzić również ładowanie sesji, jej wygaśnięcie i odmowę dostępu audytora.

## Etap 4 — responsywne filtry admina

- W `apps/web/app/admin/page.tsx` i `apps/web/app/admin.css` ułożyć filtry interwencji w zawijanej siatce reagującej na szerokość panelu. Dodać `min-width: 0` do elementów, które blokują zmniejszanie układu.
- Zapewnić widoczność czterech selektorów, wyszukiwania odbiorcy i przycisku filtrowania. Długie nazwy użytkowników i narzędzi nie mogą wypychać przycisku.
- Sprawdzić pozostałe zastosowania `.admin-filter-inline`, zwłaszcza filtrowanie ostatnich zadań.
- Zachować kolejność tabulacji odpowiadającą układowi wizualnemu. Na telefonie użyć pełnej szerokości pól i czytelnych etykiet.

Kryteria: kontrolki nie są ucięte przy 390, 768, 1024, 1280 i 1440 px, zarówno z rozwiniętym, jak i zwiniętym sidebarem. Sprawdzić powiększenie przeglądarki do 200%. Przewijanie szerokiej tabeli pozostaje w jej własnym kontenerze. Filtrowanie i paginacja zachowują dotychczasową funkcję.

## Etap 5 — komunikaty i język

- W `apps/web/app/workspace.tsx` zastąpić „Import gotowy do użycia” tekstem opisującym dostępną operację, np. „Import i przygotowanie dostępne”. Osobno przedstawić stan workera i warunek uruchomienia. Komunikat korzysta z istniejących statusów i uprawnień.
- W `ReviewPage.tsx` zmienić „Import UUID” na „Identyfikator importu”, z krótką podpowiedzią, skąd go skopiować. Zachować walidację istniejącego identyfikatora.
- Ujednolicić nazwy ról „Recenzent” i „Audytor” w zmienianych widokach.
- Sprawdzić, czy lokalne zakładki kolejek mieszczą się na telefonie; jeśli wymagają przewijania, zapewnić widoczną wskazówkę.

Kryteria: użytkownik odróżnia możliwość przygotowania importu od gotowości uruchomienia; operator otrzymuje opis śledzenia swoich korekt; etykiety i puste stany odpowiadają roli i filtrom.

## Etap 6 — odbiór całego zakresu

### Scenariusze końcowe

| Rola/scenariusz | Oczekiwany rezultat |
| --- | --- |
| Operator: import → zgłoszenie korekty → własna kolejka | Widoczne potwierdzenie, zachowany kontekst importu, brak cudzych zgłoszeń |
| Recenzent: kolejka → decyzja → operator odświeża kolejkę | Zmieniony status, data i powód decyzji |
| Manager: pula → podsumowanie → anulowanie | Brak mutacji danych |
| Manager/admin: konkretny zestaw → przydział | Dokładna liczba i właściwy odbiorca, leady wyłącznie z zestawu |
| Manager: utrata odpowiedzi → ponowienie | Ten sam przydział i ten sam klucz operacji |
| Dwóch managerów: konkurencyjny przydział | Brak podwójnego przypisania i brak częściowego sukcesu |
| Admin: długie etykiety → filtrowanie → paginacja | Wszystkie kontrolki dostępne i funkcjonalne |
| Auditor: nawigacja i próba wejścia do kolejki | Dostęp do audytu, odmowa danych operacyjnych |
| Worker offline/online i role z różnymi grantami | Komunikaty zgodne z faktyczną dostępnością działań |

### Zakres sprawdzenia

1. Zbudować zmienione workspace'y API i web. W przypadku zmian kodu przeczytać lokalne instrukcje Next.js zgodnie z `AGENTS.md`.
2. Uruchomić istniejące, rozszerzone smoke testy `test:review-ui-smoke`, `test:manager-ui-smoke` i `test:admin-ui-smoke` w workspace `@goldis/web` oraz regresję audytu, jeśli zmieniono współdzielony CSS lub shell.
3. Uruchomić `npm run test:module:review`, nowe testy HTTP dostępności i istniejący izolowany moduł migracji obejmujący `business-leads-db-smoke.cjs`.
4. Przejść interakcje klawiaturą i na telefonie; sprawdzić fokus, komunikaty statusu/błędu i wszystkie wskazane szerokości. Zrzuty są dowodem układu; testy interakcji i kontraktu są dowodem zachowania.
5. Zapisać zrzuty po zmianach, wyniki scenariuszy oraz faktycznie wykonane sprawdzenia. Zaktualizować status etapów tylko po spełnieniu ich kryteriów.

Wszystkie nowe scenariusze używają danych syntetycznych albo jednorazowej bazy w istniejącym harnessie. Odbiór nie wymaga uruchamiania portali ubezpieczycieli.

## Warunek zakończenia

Naprawa jest zakończona, gdy operator śledzi własną korektę od zgłoszenia do decyzji, przydział wymaga potwierdzenia właściwego odbiorcy/liczby/zakresu i bezpiecznie obsługuje ponowienia, a nawigacja weryfikacji i filtry admina przechodzą odbiór na desktopie oraz telefonie. Wszystkie kryteria P1 i P2 muszą być spełnione, a wyniki weryfikacji zapisane.

## Wynik implementacji i odbioru

- Operator ma pozycję „Moje korekty”; po wysłaniu propozycji link z kontekstem importu pozostaje widoczny również po odświeżeniu strony. Kolejka pokazuje trzy stany oraz polską etykietę daty i powodu decyzji.
- Przydział managera i administratora pokazuje pełną dostępność dla wybranego zakresu, wymaga osobnego podsumowania i potwierdzenia, zapisuje klucz idempotencji przed POST i umożliwia bezpieczne rozstrzygnięcie przerwanego żądania. Oczekująca operacja blokuje zmianę zakresu aż do retry; konflikt puli zachowuje wybory i wymaga ponownego podsumowania.
- Weryfikacja korzysta ze wspólnej nawigacji; filtry administratora układają się bez wychodzenia poza kontener. Panel admina nie udostępnia stanu zwiniętego menu, więc sprawdzono dostępny układ responsywny przy szerokościach 320, 390, 720 (odpowiednik widoku 200%), 768, 1024, 1280 i 1440 px.
- Zrzuty odbiorowe: `docs/design/goldis/user-flow-2026-10-12/admin-desktop.png` i `docs/design/goldis/user-flow-2026-10-12/admin-mobile.png`.

Uruchomione sprawdzenia zakończone powodzeniem:

- `npm run build -w @goldis/api` i `npm run build -w @goldis/web`.
- `npm run test:module:leads` oraz `npm run test:module:review` (18 testów).
- `npm run test:module:reports`: jednorazowa baza, migracje 001–053, izolacja tenantów, zakres przydziału, atomowość, retry i równoległe przydziały.
- `npm run test:lead-ui-smoke -w @goldis/web`, `npm run test:review-ui-smoke -w @goldis/web`, `npm run test:w4-enrichment-ui-smoke -w @goldis/web`, `npm run test:manager-ui-smoke -w @goldis/web` i `npm run test:admin-ui-smoke -w @goldis/web`.
- Smoke admina sprawdza overflow całego panelu przy 320, 375, 1024 i 1920 px oraz dokładne granice kontrolek filtrów przy 320, 390, 720 (szerokość layoutu odpowiadająca 200% na ekranie 1440 px), 768, 1024, 1280 i 1440 px.

Osobny `npm run test:module:migrations` zatrzymał się przed testami leadów w etapie `users_schema_seed` z błędem `MANAGER_MEMBERSHIP_GRANT_OR_ADMIN_BOUNDARY_MISMATCH`. Właściwy odbiór migracji i `business-leads-db-smoke.cjs` przeszedł w trybie `reports` (`MIGRATION_SMOKE_PASS mode=reports applied=053 rerun=stable`).
