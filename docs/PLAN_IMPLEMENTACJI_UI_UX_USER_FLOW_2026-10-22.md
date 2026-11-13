# Plan implementacji poprawek UI, UX i user flow Goldis

Data: 22 października 2026. Status: **implementacja lokalna pakietów UX-00–UX-15 zakończona; odbiór integracyjny i pracowniczy w toku**.

Wyniki buildów, testów i otwarte punkty zapisano w [protokole odbioru](./ODBIOR_UI_UX_USER_FLOW_2026-10-22.md). [x] oznacza wdrożony krok implementacyjny, [~] oznacza wykonanie częściowe lub odbiór wymagający testu integracyjnego/manualnego, a [ ] oznacza pracę nierozpoczętą.

Podstawa: [audyt 17 ustaleń](./AUDYT_UI_UX_USER_FLOW_2026-10-22.md), bieżące źródła `apps/web` i `apps/api` oraz testy wymienione w protokole. Numery F01–F17 odpowiadają audytowi. Ścieżki są względem katalogu głównego repozytorium. Nazwy „nowy plik” opisywały punkt wyjścia planu; zostały utworzone tam, gdzie wymagała tego implementacja.

## 1. Cel i decyzje projektowe

Po wdrożeniu pracownik ma umieć bez znajomości architektury aplikacji: znaleźć swoje firmy, rozpoznać wynik OC, skontaktować się z firmą, zapisać decyzję i przejść dalej bez utraty kolejki. Osoba uruchamiająca OC ma wiedzieć, jaki plik i zakres sprawdza, co jest gotowe, co zostanie pominięte oraz czy operacja już ruszyła.

Przyjęte rozwiązania:

1. Zachować oficjalne logo, czarno-złotą identyfikację i obecne adresy stron. Zmiany nazw w UI nie wymagają migracji URL.
2. Nazwy robocze: **Moje firmy**, **Pula firm**, **Sprawdzanie OC**, **Przebiegi**, **Historia importów**. „Raporty zespołu” pozostają innym obszarem niż wynik OC konkretnej firmy.
3. Domyślna ścieżka pracownika: **Moje firmy → firma → kontakt / wynik OC → status → następna firma**.
4. Zachować osiem technicznych etapów OC, ale pogrupować je wizualnie w cztery fazy: **Plik → Przygotowanie → Zakres i start → Przebieg i wyniki**. Parametry `step` pozostają kompatybilne.
5. Lista, eksport, liczniki i przechodzenie między firmami korzystają z tego samego znormalizowanego zakresu danych.
6. Filtry i pozycja strony należą do URL; scroll i szkic wyboru do pamięci bieżącej karty. Dane utrwalone na serwerze pozostają źródłem prawdy.
7. Główny przycisk wykonuje opisaną czynność i dopiero przechodzi dalej. Swobodne oglądanie etapów jest osobną nawigacją.
8. Import i potwierdzenie startu pozostają oddzielne. Odtworzenie szkicu, otwarcie kroku ani odświeżenie nigdy nie uruchamia operacji.
9. Zachować trzy uzgodnione statusy kontaktu, istniejące uprawnienia, wersjonowanie, idempotencję i zasady zachowania wyników po usunięciu importu.
10. W tym planie nie dodawać notatek, CRM, nowych statusów rozmowy, nowych portali ani przebudowy workera. Nie zmieniać zasad identyfikacji i deduplikacji firm.

## 2. Kolejność, zależności i pakiety

Pakiety UX-00–UX-15 wdrożono lokalnie. Zaznaczenia poniżej odnoszą się do implementacji kroków; brak testów DB, ręcznego zoomu, badań pracowników i rolloutów jest wyszczególniony jako otwarty odbiór w protokole.

| Pakiet | Zakres | Ustalenia | Warunek rozpoczęcia |
|---|---|---|---|
| UX-00 | Punkt odniesienia i przypadki regresji | wszystkie | brak |
| UX-01 | Wspólny zakres zapytań i kontrakt listy | F01, F03, F12 | UX-00 |
| UX-02 | Eksport zgodny z zakresem | F01 | UX-01 |
| UX-03 | Prawdziwe stany odczytu i liczniki | F02, F12 | UX-01 |
| UX-04 | URL filtrów, stronicowanie i powrót | F03 | UX-01, UX-03 |
| UX-05 | Poprzednia / następna firma | F03, F10 | UX-04 |
| UX-06 | Powrót po logowaniu | F11 | UX-04 |
| UX-07 | Niezależne otwarcie powiadomienia | F05 | UX-00; UX-06 przed odbiorem 401 |
| UX-08 | Jawny wybór operacji i wyniki | F04 | UX-00; UX-03 jako wzorzec stanu |
| UX-09 | Warunki gotowości i przyciski procesu OC | F06 | UX-08 |
| UX-10 | Wybór firm i czytelne podsumowanie | F08 | UX-09 |
| UX-11 | Odtwarzanie szkicu i nazwy pliku | F07 | UX-09, UX-10 |
| UX-12 | Nawigacja, słownik i dashboard roli | F09 | UX-04, UX-09 |
| UX-13 | Lista i detal do codziennych kontaktów | F10 | UX-05, UX-12 |
| UX-14 | Kontrast i wspólne tokeny kontrolek | F13, F14 | UX-00; wykonać przed finałem UX-13 |
| UX-15 | Dashboard, sidebar, cele dotykowe | F15, F16, F17 | UX-12, UX-13, UX-14 |
| UX-16 | Odbiór przekrojowy i dokumentacja | wszystkie | UX-02–UX-15 |
| UX-17 | Wdrożenie i kontrolowany rollback | wszystkie | UX-16 |

Priorytet pierwszej dostawy: UX-01–UX-04, UX-07, UX-08 i UX-14. To zamyka największe źródła pomyłek oraz problemy dostępności. UX-05 i UX-06 domykają kolejkę pracy. Pozostałe pakiety upraszczają i uspójniają doświadczenie. Nie odkładać F13/F14 na kosmetyczny koniec projektu.

## 3. UX-00 — punkt odniesienia

**Pliki:** audyt, `output/ui-ux-audit-2026-10-22/`, `apps/web/scripts/{lead-ui-smoke,manager-ui-smoke,oc-workspace-ui-smoke,history-ui-smoke}.cjs`, `apps/api/scripts/business-leads-db-smoke.cjs`.

Kroki:

1. [x] Sprawdzić bieżący stan plików i nie nadpisać niezacommitowanej pracy innych zmian. Przy zapisie planu istniało wiele takich zmian.
2. [x] Sprawdzić właściwe `AGENTS.md`. Przed zmianami routera/Link/API Next przeczytać dokumentację dołączoną do faktycznie zainstalowanego Next w `node_modules/next/dist/docs/`.
3. [x] Wykonać świeży build web i właściwy zakres testów jako baseline. Błędy istniejące wcześniej zapisać oddzielnie od regresji wprowadzonych pakietem.
4. [x] Utrwalić syntetyczny zestaw: co najmniej 61 firm, dwa zestawy wyników, dwa konta pracowników, menedżer, firmy nieprzydzielone, trzy statusy, jednakowe `createdAt` dla części rekordów, zachowane wyniki po usunięciu importu i odrębny tenant.
5. [x] Dodać do istniejących smoke testów zachowania z audytu, a nie testy kopiujące klasy CSS. Część testów będzie początkowo odtwarzać defekty i powinna zostać naprawiona w odpowiadającym pakiecie.
6. [~] Przyjąć widoki odbiorowe: 1440×900, **1366×768**, 1024×768, 390×844 i kontrola reflow/zoom. Zrzuty audytu są dowodem poprzedniego stanu, nie nowym wzorcem wymagającym kopiowania wad.

**Koniec:** znane wyniki baseline, przypadki danych i lista testów przypisana do pakietów; żadnego uruchomienia portali live.

## 4. UX-01 — jeden zakres danych dla listy, eksportu i nawigacji

**Istniejące pliki:** `apps/api/src/features/leads/business-leads.controller.ts`, `business-leads.service.ts`, `business-leads.http.spec.ts`, `apps/api/scripts/business-leads-db-smoke.cjs`.

**Nowe pliki:** `apps/api/src/features/leads/lead-query.ts`, `lead-query.spec.ts`; `apps/web/app/leads/lead-query.ts`. Backendowy helper zostaje we własnym feature; nie wprowadzać importu backendowego serwisu do web.

Kontrakt zakresu:

```ts
type LeadScope = {
  scope: 'mine' | 'pool';
  search: string;               // trim; maksymalnie 120 znaków
  contactStatus: '' | 'not_contacted' | 'offer_accepted' | 'not_interested';
  resultSetId: string | null;   // poprawny UUID
};
type LeadPageQuery = LeadScope & {
  limit: number;               // 25 w UI; API zachowuje przedział 1–50
  cursor: string | null;
  direction: 'next' | 'previous';
};
```

Kroki:

1. [x] Przenieść walidację `scope`, statusu, UUID, frazy i kursora z `list()` do małych funkcji w `lead-query.ts`. Odrzucać niepoprawny znany parametr zamiast po cichu zamieniać go na szerszy zakres. Powtórzone parametry/skalar jako tablica również walidować.
2. [x] Zachować dotychczasowy `search` w HTTP i wewnętrzne mapowanie `query`; nie wprowadzać konkurencyjnego parametru `q` dla firm.
3. [x] Wyodrębnić wspólny predykat widoczności i filtrów do listy, eksportu, agregatów i sąsiadów. Parametry SQL przekazywać przez replacements/bind, nigdy przez interpolację wartości użytkownika.
4. [x] Zachować **wszystkie** obecne ograniczenia: tenant, narzędzie, uprawnienia, gotowość wyniku, stan zestawu, mine/pool, bariery usuwania i wyjątki dla przypisanych zachowanych snapshotów. Obecny `list()` ma bogatszą regułę niż `exportWorkbook()`; wspólną podstawą ma być poprawna reguła listy, nie prostszy eksport.
5. [x] Oddzielić predykat filtrowania od paginacji. Eksport i liczniki nie mogą otrzymywać `LIMIT 25` ani warunku bieżącego kursora.
6. [x] Pozostawić istniejące `items` i `nextCursor`. Dodać `previousCursor` i opcjonalne `summary`, bez usuwania dotychczasowych pól.
7. [x] Dla `direction=previous` odwrócić porównanie pary `(created_at, lead_id)`, pobrać w ASC z zapasem, następnie odwrócić wynik do standardowego DESC. Kursor poprzedniej strony opierać na pierwszym rekordzie; następnej — na ostatnim. Nie używać numeru strony jako źródła prawdy.
8. [x] Zachować obsługę istniejącego formatu kursora; jeśli potrzebna jest nowa wersja, jawnie parsować stary i nowy format. Nie osłabiać ACL dla kursora wskazującego inny tenant.

**Testy:** nieprawidłowe scope/status/UUID, apostrof, `%`, `_`, powtórzone parametry, kolejność rekordów o identycznej dacie, page1→page2→previous, pusta ostatnia strona, tenant i zachowane wyniki. Testy parsera rejestrować w istniejącym runnerze `scripts/test-module.cjs`, jeśli mają należeć do `test:module:leads`.

**Koniec:** te same filtry dają tę samą definicję zbioru dla wszystkich czterech operacji. Bez migracji schematu bazy w tym pakiecie.

## 5. UX-02 — eksport dokładnie tego zakresu, który wybrał pracownik

**Pliki:** controller/service/helper z UX-01; `apps/web/app/leads/LeadWorkspace.tsx`; testy HTTP, DB i `lead-ui-smoke.cjs`.

Docelowo:

```text
GET /api/leads/export?scope=mine&contactStatus=not_contacted&search=Transport
GET /api/leads/export?scope=pool&resultSetId=<uuid>&search=Alfa
```

Kroki:

1. [x] Controller eksportu przyjmuje te same filtry co lista, bez `cursor`, `direction` i `limit`. Zachować osobną kontrolę prawa `download_results`; możliwość czytania nie oznacza prawa eksportu.
2. [x] `exportWorkbook(actor, scope)` korzysta ze wspólnego predykatu. Domyślne `scope=pool` zachować dla starych wywołań, natomiast nowy UI zawsze przekazuje zakres jawnie.
3. [x] Eksport obejmuje **wszystkie dopasowania**, nie tylko 25 widocznych rekordów. Opis przy przycisku: „Excel obejmie wszystkie firmy pasujące do filtrów”.
4. [x] W mine nazwa akcji „Eksportuj moje firmy”; w pool „Eksportuj firmy z tego widoku”. Przy aktywnych filtrach pokazać ich krótkie podsumowanie. Nie dodawać w pierwszej iteracji automatycznego obejścia eksportującego szerszy zbiór.
5. [x] Zastąpić sam odnośnik kontrolowanym pobraniem: status błędu wyświetlić w aplikacji, odpowiedź XLSX pobrać jako Blob, nazwę odczytać z `Content-Disposition`, zwolnić object URL. Nie logować zawartości pliku.
6. [x] Zablokować wielokrotne uruchomienie podczas pobierania; komunikaty „Przygotowuję Excel…” i „Pobrano plik”/konkretny błąd. Brak prawa — wyjaśnienie, bez aktywnego przycisku.
7. [x] Zachować obecny limit 50 000. Przekroczenie: bez częściowego pliku i bez cichego obcięcia; błąd `LEAD_EXPORT_LIMIT_EXCEEDED` z limitem i instrukcją użycia wspieranych filtrów. Najpierw backend, potem frontend obsługujący kod.
8. [x] Zachować sanitację tekstu i ochronę przed formułami Excela. Do pliku dodać arkusz/sekcję „Zakres”: zakres, zastosowane filtry, czas generowania. Nie dodawać danych poza dozwolonym zbiorem.

**Testy:** wczytać rzeczywisty wygenerowany XLSX w teście DB i porównać identyfikatory z pełnym zbiorem odpowiedniej listy; mine/pool, status, fraza, zestaw, drugi tenant, zachowane snapshoty, brak grantu, 50 000/50 001, wartości zaczynające się od `=`. Browser: żądanie zawiera filtry, zero cursor/limit, błąd pozostawia użytkownika na liście.

**Koniec:** żadne filtrowane wywołanie nie staje się eksportem pełnej puli; ograniczenie limitu ma działające rozwiązanie w UI.

## 6. UX-03 — stany danych i prawdziwe podsumowania

**Pliki:** `LeadWorkspace.tsx`, `tools/tool-catalog.tsx`, `result-set-workspace.tsx` jako późniejszy konsument; `business-leads.service.ts`; nowy `apps/web/app/lib/remote-data.ts` i prosty komponent `apps/web/components/ui/LoadState.tsx`, jeżeli zostanie użyty w co najmniej dwóch obszarach.

Proponowane dodatkowe pole odpowiedzi listy, żądane przez `includeSummary=1`:

```ts
summary: {
  scopeTotal: number;            // ACL + mine/pool + resultSetId, przed frazą/statusami
  matchingTotal: number;         // cały aktywnie filtrowany zbiór, bez kursora
  byContactStatus: {
    not_contacted: number;
    offer_accepted: number;
    not_interested: number;
  };                            // liczone w aktywnym zbiorze, także z filtrem statusu
  checkedAt: string;
}
```

Kroki:

1. [x] Rozdzielić stan pierwszego pobrania, gotowych danych, odświeżania gotowych danych i błędu. Gotowe dane muszą zawierać klucz zapytania i czas ostatniego udanego odczytu.
2. [x] Dla zmiany filtrów anulować poprzedni request i ignorować odpowiedź o starym kluczu. Stare dane można zachować po błędzie **odświeżenia tego samego zapytania**; nie prezentować ich jako wyników innego filtra.
3. [x] Dodać agregaty ze wspólnym predykatem, bez kosztownych lateral joinów używanych do szczegółów firm. Gdy summary i strona wracają razem, pobierać je w jednej krótkiej transakcji odczytowej ze spójnym snapshotem. Nie utrzymywać transakcji podczas generowania pliku lub interakcji użytkownika.
4. [x] Pokazać „Firmy w tym widoku”, „Do kontaktu w tym widoku”, „Zainteresowane w tym widoku”. Obok tabeli osobno „Pokazano 25 z 61”. Zmiana strony nie zmienia znaczenia KPI.
5. [x] Usunąć stałe „Dane aktualne”. Pokazywać „Odczytano: 13:40”, „Odświeżam…” albo „Nie udało się odświeżyć; dane z 13:40”. Nie sugerować ciągłej synchronizacji, jeśli jej nie ma.
6. [x] Wprowadzić jedno miejsce na błąd. „Spróbuj ponownie” ponawia dokładnie obecny zakres i kursor. Zachować filtry i dostępne ostatnie dane tego zakresu.
7. [x] Rozdzielić puste stany według poniższej tabeli; analogicznie katalog narzędzi nie może po błędzie ogłaszać braku grantów.

| Warunek | Komunikat | Działanie |
|---|---|---|
| Pierwszy request nieudany | „Nie udało się pobrać firm” | „Spróbuj ponownie” |
| mine, scopeTotal=0 | „Nie masz jeszcze przydzielonych firm” | wyjaśnienie kontaktu z menedżerem; ewentualnie pula, jeśli dostępna |
| pool, scopeTotal=0 | „W puli nie ma jeszcze gotowych firm” | sprawdzanie OC tylko przy canExecute |
| scopeTotal>0, matchingTotal=0 | „Brak firm pasujących do filtrów” | „Wyczyść filtry” |
| matchingTotal>0, bieżąca strona pusta | „Lista zmieniła się od ostatniego odczytu” | „Przejdź do początku tego widoku”, zachowując filtry |
| 401 | „Sesja wygasła” | logowanie z powrotem, UX-06 |
| 403 | „Nie masz dostępu do tego widoku” | dozwolony powrót; nie ponawiać bez końca |

8. [x] Błąd oznaczać `role=alert`, potwierdzenie/odświeżanie `role=status` lub jednym `aria-live=polite`. `aria-busy` tylko na aktualizowanym obszarze. Nie ogłaszać całej tabeli po każdej zmianie.

**Testy:** opóźniona odpowiedź A po odpowiedzi B, 503 na pierwszym odczycie i przy refresh, 401/403, rozróżnienie czterech pustych stanów, KPI niezależne od strony. Testy DB muszą sprawdzić, że sumy nie obejmują innego użytkownika/tenanta.

**Koniec:** zero fałszywych zer i deklaracji aktualności przy błędzie; każdy pusty stan wskazuje właściwą następną czynność.

## 7. UX-04 — lista odtwarzana z URL i poprawny powrót

**Pliki:** `LeadWorkspace.tsx`, strony `my-results/page.tsx`, `results/oc-policy-verification/page.tsx`, `my-results/[id]/page.tsx`, `leads/[id]/page.tsx`; nowe `app/leads/lead-navigation.ts`, `app/leads/lead-view-memory.ts`.

Przykład:

```text
/my-results?search=Transport&contactStatus=not_contacted&cursor=<opaque>&direction=next
/my-results/<id>?returnTo=<zakodowana pełna ścieżka listy>
```

Kroki:

1. [x] Zainicjalizować aktywne filtry i stronę z URL przed pierwszym pobraniem. Pole wpisywania frazy może mieć oddzielny draft, ale aktywny zakres pochodzi wyłącznie z zatwierdzonych parametrów.
2. [x] Zatwierdzenie wyszukiwania/zmiana statusu usuwa cursor/direction i przechodzi na początek. Zmiana strony używa kursorów API. Usunąć lokalny `cursorStack` jako warunek działania „Poprzednia”.
3. [x] Jedno działanie nawigacyjne tworzy jeden wpis historii. Nie uruchamiać jednocześnie `loadList()` w handlerze i drugi raz w efekcie; efekt reaguje na znormalizowany URL. Back/Forward musi odczytać cały stan.
4. [x] Link firmy przenosi bezpieczny `returnTo`. Wewnątrz aplikacji użyć `next/link` zgodnie z lokalną dokumentacją Next, zachowując Ctrl/Cmd i otwieranie nowej karty. Sam Link nie jest mechanizmem przechowywania filtrów.
5. [x] W `sessionStorage` zapamiętać wyłącznie scroll i ID ostatnio otwartej firmy, pod kluczem tenant+user+znormalizowany URL. Przywrócić po odczytaniu listy; jeśli firma wypadła z filtra, przywrócić najbliższą dostępną pozycję bez zmiany filtrów.
6. [x] Link „Wróć do moich firm/puli” prowadzi do dokładnego `returnTo`. Bez niego wybrać bezpieczny adres domyślny zgodny z miejscem wejścia, nie dowolną historię przeglądarki.
7. [x] Parser `returnTo` dopuszcza wyłącznie lokalne listy `/my-results` i `/results/oc-policy-verification` z dozwolonymi parametrami. Odrzuca origin zewnętrzny, `//`, backslash, nieprawidłowe kodowanie i zagnieżdżony `returnTo`. Kursor pozostaje nieprzezroczysty; nie wyciągać z niego uprawnień.
8. [x] `resultSetId` puli przechodzi przez wejście w detal i powrót; nie resetować go przez efekt uruchamiany tylko raz.

**Testy:** druga/trzecia strona → firma → link powrotny; Back/Forward; reload listy; otwarcie detalu w nowej karcie; odtworzenie ograniczonego zestawu; brak rekordu po zmianie statusu; złośliwy returnTo; niedostępny storage.

**Koniec:** po powrocie użytkownik rozpoznaje ten sam widok i miejsce pracy. Parametr URL nie może rozszerzyć dostępu do danych.

## 8. UX-05 — przejście do następnej firmy bez powrotu do tabeli

**Pliki:** controller/service/helper leads; `LeadWorkspace.tsx`; nowy `apps/web/app/leads/LeadQueueNavigation.tsx`.

Kontrakt nowego, tylko odczytowego endpointu:

```text
GET /api/leads/:id/navigation?scope=mine&contactStatus=not_contacted&search=Transport
→ { previousLeadId: string|null, nextLeadId: string|null, checkedAt: string }
```

Kroki:

1. [x] Zweryfikować sesję, prawo odczytu i dostęp do firmy wskazanej ID. Zakres sąsiadów normalizować tym samym helperem co lista; bez cursor/limit.
2. [x] Wyznaczyć pozycję bieżącej firmy według `(created_at, lead_id)`. Sąsiadów wyszukiwać w przefiltrowanym, autoryzowanym zbiorze przed i za tą pozycją. Nie pobierać całej kolejki do przeglądarki.
3. [x] Bieżąca firma może po zapisaniu statusu nie należeć już do filtra „Nie kontaktowano”. Nadal użyć jej pozycji jako kotwicy i wyszukać następną pasującą. Odczyt kotwicy wymaga uprawnienia, ale nie wymaga zgodności jej nowego statusu z filtrem kolejki.
4. [x] Po zapisaniu decyzji pozostać na detalu, wyświetlić „Zapisano status” i umożliwić „Następna firma”. Nie wykonywać automatycznego skoku podczas wyboru opcji w select.
5. [x] Sąsiadów odświeżyć po zmianie statusu/przydziału. Link kolejnej firmy zachowuje `returnTo` i definicję kolejki. Nie obiecywać niezmiennego numeru „12 z 61” przy współbieżnych zmianach.
6. [x] Po 404/403 następnego rekordu pokazać „Lista zmieniła się”, odświeżyć sąsiadów i dać powrót. Koniec kolejki: „To ostatnia firma w tym widoku”.

**Testy:** przejście przez granicę strony, firma wypada z filtra po zapisie, jednakowe daty, cofnięcie przydziału, usunięcie źródła, ostatnia firma, brak ACL do kotwicy i obcy tenant. Brak grantu nie może ujawniać ID sąsiadów.

**Koniec:** można obsłużyć kilka firm w przefiltrowanej kolejce bez odtwarzania listy.

## 9. UX-06 — spójny powrót po logowaniu

**Pliki:** `workspace.tsx`, `platform-route-frame.tsx`, `DashboardWorkspace.tsx`, `LeadWorkspace.tsx`, `NotificationWorkspace.tsx`, `history/HistoryList.tsx`; nowe `app/lib/return-to.ts`, `components/ui/SessionRequired.tsx`.

Kroki:

1. [x] Wyodrębnić istniejącą bezpieczną obsługę `returnTo` z `workspace.tsx` do funkcji wspólnej. Zachować osobną, węższą walidację powrotu do list firm z UX-04.
2. [x] Ekrany z potwierdzonym 401 prowadzą do `/?returnTo=<bieżący pathname+search>`. Dopuszczone detale firm i operacji zachowują swoje dozwolone parametry, w tym kontekst listy.
3. [x] Odczyt sieci zakończony timeoutem/503 nie jest wygaśnięciem sesji. Zamiast wyrzucenia do logowania pokazać ponowienie. 403 nie jest 401.
4. [x] Po loginie wrócić do walidowanego adresu; bez niego użyć istniejącego domyślnego celu roli. Nie zastępować sesji aplikacji zapisanymi danymi klienta.
5. [x] Przymusowa zmiana hasła przekazuje cel przez stronę konta i wraca do niego po udanej zmianie, bez pomijania tego wymogu. Uzupełnić `account/page.tsx` w tym zakresie.
6. [x] Błędy mutacji 401 w zmianie statusu, eksporcie, oznaczaniu alertu i starcie operacji pokazują ten sam wzorzec. Nie ponawiać automatycznie niepewnych mutacji po logowaniu.

**Testy:** wygaśnięcie w firmie na drugiej stronie kolejki, w powiadomieniu i w OC; 503 auth/me; wymagane nowe hasło; adresy zewnętrzne i nieprawidłowo kodowane. Wygasła lub cofnięta sesja nie przywraca dostępu przez sam URL.

**Koniec:** pracownik wraca do tej samej dozwolonej sprawy po uwierzytelnieniu.

## 10. UX-07 — otwarcie powiadomienia niezależne od „przeczytane”

**Pliki:** `notifications/NotificationWorkspace.tsx`, `leads/LeadSidebar.tsx`; istniejące API notifications pozostaje źródłem licznika.

Kroki:

1. [x] Zostawić prawdziwy link do sprawy. Usunąć warunek, w którym `window.location.assign` wykonuje się dopiero po sukcesie `markRead()`.
2. [x] Dla zwykłej aktywacji rozpocząć pomocniczy zapis z CSRF i `keepalive:true`, nie blokując nawigacji. Przerwanie albo błąd tego zapisu może pozostawić powiadomienie nieprzeczytane; nie udawać sukcesu.
3. [x] Ctrl/Cmd, środkowy przycisk i klawiatura zachowują natywne zachowanie linku. Nie przechwytywać modyfikowanego kliknięcia po to, by wymuszać bieżącą kartę.
4. [x] Aktualizować licznik dopiero po potwierdzonej odpowiedzi; zabezpieczyć przed dwukrotnym odjęciem przy równoległych kliknięciach. Przy ponownym wejściu pobrać licznik z API.
5. [x] Osobny przycisk „Oznacz jako przeczytane” nadal ma lokalne busy/error/retry. Awaria pomocniczego zapisu nie zmienia miejsca docelowego.

**Testy:** POST=503/timeout, klik zwykły, Enter, Ctrl/Cmd, już przeczytane, dwa szybkie kliknięcia, 401. Cel operacji otwiera się przy błędzie przeczytania; licznik nie spada bez potwierdzenia.

## 11. UX-08 — wynik wymaga jawnego kontekstu operacji

**Pliki:** `result-set-workspace.tsx`, `workspace.tsx`, `tools/oc-policy-verification/automation-workspace.tsx`, `history/HistoryList.tsx`.

Kroki:

1. [x] Rozdzielić stany: brak identyfikatora, odczytywanie operacji, odczytywanie wyników, gotowe, błąd, brak dostępu, niezgodny import. Stan „loading” wolno pokazać tylko przy rzeczywistym żądaniu.
2. [x] Bez `resultSetId/submission/execution`: komunikat „Nie wybrano sprawdzania OC” i link „Otwórz przebieg”. Przy znanym imporcie można wskazać jego operacje; bez niego prowadzić do `/runs`. Nie wybierać automatycznie przypadkowego najnowszego zestawu.
3. [x] `resultSetId=null` dla istniejącego zgłoszenia: wyjaśnić, że wynik nie został jeszcze utworzony; jeśli operacja jest aktywna, kontrolowanie odświeżać odczyt operacji. Zakończona operacja bez wyniku wymaga komunikatu błędu i drogi do przebiegu, nie nieskończonego spinnera.
4. [x] Filtry i eksport pokazywać dopiero po rozpoznaniu zestawu; wyszukiwanie w trakcie odczytu danych może mieć jawne busy.
5. [x] Zachować istniejące sprawdzenia powiązania import↔operacja↔zestaw i dotychczasowe testy niezgodnych ID. Nigdy nie „naprawiać” UX przez usunięcie tych kontroli.
6. [x] Pozostawić wyniki częściowe i „Brak aktualnych polis” jako poprawne, oddzielne stany. Błąd fetch ma ponowienie, które nie uruchamia nowej operacji.

**Testy:** `?step=results` bez ID, z samym importem, z prawidłowym zestawem, 404/403/503, zgłoszenie jeszcze bez wyniku, częściowy wynik, niezgodne ID. Po braku kontekstu nie ma aktywnego fałszywego wyszukiwania ani komunikatu „otwieram…”.

## 12. UX-09 — jeden model gotowości i jasne akcje OC

**Pliki:** `workspace.tsx`, `automation-workspace.tsx`, `run-submission-launcher.tsx`, `import-preparation-panel.tsx`, `lib/use-automation-health.ts`; nowe `app/tools/oc-policy-verification/automation-flow.ts` i testy jego decyzji.

Kroki:

1. [x] Zdefiniować stan procesu: import, wybrana i aktualna przygotowana rewizja, wybór, aktualność podglądu, próba startu, ID operacji, wynik oraz stan uprawnień i health.
2. [x] Rozszerzyć callback panelu przygotowania: zamiast samego `ready:boolean` przekazać ID rewizji, numer, fingerprint i gotowość. Callback launchera przekazuje wybrany zakres oraz stan aktualności preview; nie kopiować całych modeli DB do komponentów.
3. [x] Wyliczać statusy kroków czystą funkcją. Nie opierać ukończenia na tym, że użytkownik przeszedł do późniejszego kroku. Brak danych: „Wymaga pliku/wyboru”; aktualne preview: „Podsumowanie gotowe”; aktywna operacja: rzeczywisty status; wynik: częściowy/gotowy.
4. [x] Usunąć stałe `launch: 'Gotowe do sprawdzenia'` oraz fallback oznaczający poprzednie kroki jako wykonane na podstawie indeksu.
5. [x] Ustalić działania zgodnie z poniższą tabelą. W jednym etapie jeden główny CTA. Nie dodawać drugiego formularza ani zdalnego `.click()` na ukrytym przycisku tylko po to, żeby sterować stopką.
6. [x] Operację przygotowania preview wywołuje formularz wyboru. Launcher odpowiada za nią, a rodzic przekazuje do stopki jawny descriptor akcji albo pozostawia główny CTA w launcherze; wówczas stopka nie ma konkurencyjnego „Dalej”.
7. [x] Swobodne linki etapów można zachować, ale pusty krok ma wyjaśnienie i bezpośredni link do brakującej czynności. „Otwórz etap” nie sugeruje wykonania procesu.
8. [x] Zmiana importu, rewizji, zakresu lub daty odniesienia unieważnia preview i checkbox. 409 przy starcie kieruje do odświeżenia podsumowania, nigdy do startu na starych danych.
9. [x] Brak gotowości automatyzacji nie blokuje importu/przygotowania. Przy ostatnim starcie pokazać przyczynę i odświeżenie statusu; brak potwierdzonej gotowości nie może wyglądać jak sukces. Backendowe reguły przyjmowania i kolejki pozostają ostateczne. Nie mylić „usługa gotowa” z gwarancją braku prośby o SMS.
10. [x] Po zmianie etapu fokus na nagłówku; po błędzie formularza fokus na podsumowaniu błędu z linkami do pól. Nie przesuwać fokusu przy każdym pollingu.

| Etap | Główna akcja | Warunek / efekt |
|---|---|---|
| upload | „Sprawdź i zaimportuj plik” | poprawny plik; po sukcesie kontrola danych |
| validation | „Przejdź do przygotowania danych” | import istnieje; wyjaśnienie liczby problemów |
| regon | „Dalej: usuń duplikaty” | operacja opcjonalna; osobno liczba nierozwiązanych braków |
| deduplication | „Przygotuj zestaw” albo „Wybierz firmy” | wybór dopiero dla aktualnej zamkniętej rewizji |
| selection | „Sprawdź wybrane firmy i przejdź dalej” | poprawny zakres; wykonuje preview |
| launch | „Potwierdź i uruchom…” | aktualne preview, ready>0, zgoda, uprawnienia, rozpoznany stan usług |
| progress | „Otwórz wyniki” | istnieje zestaw; inaczej status i obsługa interwencji |
| results | „Pobierz raport Excel” | zestaw istnieje i prawo pobrania; nowy import jako akcja pomocnicza |

**Testy:** wszystkie kroki bez pliku; przejście selection→launch jedną akcją; brak/nieaktualna rewizja; zmiana wyboru po preview; 409; podwójny start; portale wyłączone; prośba o SMS; preview nie generuje startu. Testować znaczenie statusów, nie tylko ich kolor.

## 13. UX-10 — wybór i podsumowanie po nazwach firm

**Pliki:** `run-submission-launcher.tsx`; backend `run-submissions.service.ts`, `run-submission-preview.repository.ts`; panel przygotowania i jego istniejący endpoint rows; nowy `app/tools/oc-policy-verification/CompanySelection.tsx`.

Kroki:

1. [x] Zostawić szybką opcję „Wszystkie gotowe firmy”. Korzysta z istniejącego preview całego przygotowanego importu, bez limitowania go do 500 przez formularz częściowego wyboru. Istniejące porcjowanie backendu pozostaje.
2. [x] Dodać wybór „Wybrane firmy” z wyszukiwaniem i checkboxami na **wierszach przygotowanej rewizji**, nie na zmiennej kopii surowego Excela. Pokazać nazwę, NIP/REGON, numer wiersza i status gotowości.
3. [x] Użyć istniejącego endpointu wierszy przygotowania; gdy nie wspiera wyszukiwania, dodać walidowany `q` i filtrowanie po stronie API z istniejącą paginacją. Najpierw policzyć pełną liczbę dopasowań, potem stronę; nie filtrować wyłącznie bieżących 50 rekordów w przeglądarce.
4. [x] Zaznaczenia zachowywać między stronami pod ID/numerem wiersza tej rewizji. Limit częściowego wyboru: 500, jak obecne API. „Zaznacz stronę” oznacza tylko widoczną stronę, nigdy wszystkie dopasowania.
5. [x] Duplikat/brak danych ma tekst przyczyny i nie jest domyślnie zaznaczany. Nie wprowadzać własnej frontendowej decyzji o gotowości; ostatecznie rozlicza ją preview backendu.
6. [x] „Zakres wierszy” i „Lista numerów” umieścić pod jawnym trybem zaawansowanym; zachować istniejący kontrakt `rowNumbers` albo `fromRow/toRow`.
7. [x] Rozszerzyć `SnapshotEntry` i odpowiedź preview o bezpieczne pola prezentacyjne: `companyName`, `nip`, `effectiveRegon`, `sourceRowId` oraz identyfikator aktualnej rewizji. Wziąć je z tych samych danych/snapshotu co obliczone stany, nie robić 500 osobnych requestów.
8. [x] Nowe pola są tylko prezentacyjne; nie dodawać ich bez potrzeby do wejściowego payloadu startu. Nie zmieniać niejawnie algorytmu `selectionFingerprint`; jeśli trzeba go wersjonować, opisać kompatybilność i 409. Samo wzbogacenie odpowiedzi nie zmienia zasad deduplikacji.
9. [x] Podsumowanie: „Firma · NIP/REGON · wiersz · zostanie sprawdzona/pominięta · powód”. Przy liczbie zadań wyjaśnić, że kilka wierszy może tworzyć jedną firmę/zadanie. Dla całego importu liczby + paginowany podgląd, bez renderowania tysięcy checkboxów.

**Testy:** zaznaczenia na dwóch stronach i po wyszukiwaniu, limit 500/501, reset po zmianie rewizji, nazwy odpowiadają wybranym wierszom, duplikaty i konflikty, brak pozwoleń do obcego importu, brak N+1 zapytań. Start nadal weryfikuje fingerprint i wersje.

## 14. UX-11 — szkic bez utraty pracy i bez automatycznego startu

**Pliki:** `workspace.tsx`, `run-submission-launcher.tsx`, `import-preparation-panel.tsx`; nowy `app/tools/oc-policy-verification/automation-draft.ts`; `apps/api/src/features/imports/import.service.ts` tylko dla zgodności metadanych odpowiedzi upload.

Kroki:

1. [x] Rozszerzyć frontendowy `ImportResult` o `fileName` i użyć pola z istniejącego `GET /api/imports/:id`. Endpoint już zwraca nazwę. Do odpowiedzi upload dodać tak samo sanitowaną nazwę dla jednolitego kontraktu. `file?.name` oznacza wybrany nowy plik, nie może nadpisywać etykiety starego aktywnego importu przed sukcesem uploadu.
2. [x] Zapisywać w `sessionStorage` szkic wersji 1: tenantId, userId, batchId, preparationId/revision/fingerprint, tryb, wybrane numery/zakres, updatedAt. Klucz np. `goldis:oc-draft:v1:<tenant>:<user>:<batch>`. To szkic dla bieżącej karty, bez obietnicy synchronizacji między urządzeniami.
3. [x] Nie zapisywać pliku, haseł, SMS, CSRF, nazw firm ani zaznaczonej zgody. Odczyt dopiero po potwierdzeniu tożsamości; błędy JSON/limit storage nie blokują działania.
4. [x] Przy odtworzeniu porównać bieżący import i rewizję. Odtworzyć wybór, następnie pobrać **nowy preview**. Checkbox zawsze false. Komunikat „Przywrócono wybór; sprawdź aktualne podsumowanie”.
5. [x] Zmieniona rewizja: zachować kandydatów wyboru tylko po ponownej walidacji; pokazać różnice i wymagać ponownego podglądu. Usunięty import albo odebrany dostęp: nie odtwarzać danych, wyjaśnić powód.
6. [x] Dodać jawne „Wyczyść zapisany wybór”. Wyczyścić po świadomym wylogowaniu, zmianie użytkownika/kontekstu i poprawnym starcie. Po 401 wstrzymać odtwarzanie do ponownego uwierzytelnienia tego użytkownika.
7. [x] Po sukcesie startu URL z ID operacji ma pierwszeństwo nad szkicem. Reload wyświetla istniejący przebieg, a nie formularz nowego startu.
8. [x] **Niepewna odpowiedź startu:** przed wysłaniem zachować w szkicu dokładną próbę (`kind`, payload bez sekretów, fingerprint i użyty idempotencyKey). Timeout nie może generować nowego klucza. Jawne „Ponów tę samą próbę” wysyła ten sam payload i klucz; istniejący backend potrafi odtworzyć wcześniejszy zapis. Żadnego automatycznego ponowienia po reloadzie.
9. [x] Dopóki nie rozstrzygnięto niepewnej próby, nie łączyć jej z nowym zakresem i tym samym kluczem. Dla nowej decyzji nowy aktualny preview i nowa zgoda; zachować informację o nierozstrzygniętej poprzedniej próbie.

**Testy:** reload w kroku 5/6, storage niedostępny/niepoprawny, inny użytkownik, nowa rewizja, zmiana daty po północy w Warszawie, usunięty import, reload po start, start zapisany na backendzie z utraconą odpowiedzią i ponowienie tym samym kluczem. Nie wolno powtórnie uruchomić nowej operacji przez odtworzenie szkicu.

## 15. UX-12 — nawigacja zadaniowa i dashboard roli

**Pliki:** `LeadSidebar.tsx`, `DashboardWorkspace.tsx`, `tool-catalog.tsx`, `platform-route-frame.tsx`, `HistoryList.tsx`, nagłówki stron firm; nowe `app/lib/ui-labels.ts`, `app/lib/automation-status-copy.ts`.

Kroki:

1. [x] Spisać i zastosować jeden słownik nazw w menu, nagłówkach, breadcrumbach, pustych stanach, powiadomieniach i instrukcjach. Nie zmieniać `toolId` ani wartości statusów API tylko dlatego, że zmienia się etykieta.
2. [x] Mapa: Moje wyniki→**Moje firmy**; Wyniki/Pula wyników OC→**Pula firm**; Zadania→**Przebiegi**; Importy→**Historia importów**; Audyt/Dziennik audytu→**Dziennik aktywności**; Konto→**Moje konto**. Katalog `/tools` pozostaje „Automatyzacje”, karta OC „Sprawdzanie OC”.
3. [x] Sekcja PRACA ma kolejność: Przegląd, Moje firmy, Pula firm, Automatyzacje, Przebiegi, Historia importów, Powiadomienia; korekty tam, gdzie obecne uprawnienia je uzasadniają. Funkcje organizacyjne są oddzielne; nie dodawać obowiązkowego hamburgera na desktopie.
4. [x] Linki zależą także od grantów, nie tylko roli. Zachować dostęp do wspólnej puli zgodnie z obecną polityką; nie ograniczać jej pracownikom samą zmianą copy. Audytor/reviewer zachowują dozwolone ścieżki.
5. [x] Usunąć slug narzędzia z głównej treści karty. Pod opisem jedno zdanie: „Wgraj bazę firm, sprawdź dane i odbierz wyniki OC”. Techniczny identyfikator ewentualnie w szczegółach.
6. [x] Stan usług opisać zadaniowo: „Możesz rozpocząć sprawdzanie”, „Możesz przygotować plik; sprawdzanie jest chwilowo niedostępne”, „Nie udało się sprawdzić dostępności — odśwież”. Worker/provider/raw code pod rozwijanym „Szczegóły techniczne”. Powód wymagający decyzji pracownika pozostaje widoczny.
7. [x] Dashboard wybiera jedną główną akcję z danych i uprawnień: wymagająca działania własna operacja→„Dokończ sprawdzanie”; pracownik z firmami do kontaktu→„Otwórz moje firmy”; menedżer z nieprzydzieloną pulą→„Przydziel firmy”; w pozostałych przypadkach uprawniony→„Sprawdź nową bazę OC”. Reviewer/auditor dostają swoje dozwolone zadanie.
8. [x] Link do pilnej operacji prowadzi bezpośrednio do niej, korzystając z rzeczywistego ID/href z API, a nie do ogólnej listy. Pozostałe możliwości jako akcje drugorzędne, bez ukrycia ich za onboardingiem.
9. [x] Krótkie objaśnienie obiegu: „Sprawdzenie OC tworzy pulę wyników. Menedżer przydziela firmy. Przydzielone firmy znajdziesz w Moich firmach”. Bez obowiązkowego tutoriala.

**Testy:** role operator/manager/admin/reviewer/auditor z różnymi grantami; brak firm vs zaległości vs pilna operacja; etykiety nie mieszają zakresów; stare linki działają. Odbiór z pracownikiem sprawdza rozumienie nazw, nie preferencję estetyczną.

## 16. UX-13 — lista i detal skoncentrowane na kontakcie

**Pliki:** `LeadWorkspace.tsx`, `leads.css`; nowe lokalne `LeadContactLinks.tsx`, `LeadListRow.tsx`, `LeadMobileCard.tsx`, `LeadDetail.tsx` tylko jako podział obecnego rozbudowanego JSX.

Kroki:

1. [x] Desktop mine: firma + miejscowość, kontakt, status rozmowy, wynik OC, szczegóły. Nie powtarzać kolumny „przydzielono mnie” w każdym wierszu. W pool zachować przydział i potrzebne narzędzia menedżera.
2. [x] Telefon/e-mail są linkami `tel:`/`mailto:` także na liście; użyć obecnych sanitowanych wartości, dostępnych nazw i bezpiecznej normalizacji numeru. Nie dopisywać kraju do niejednoznacznego numeru.
3. [x] Pełna nazwa statusu ma się mieścić albo zawijać w reprezentacji czytelnej przed i po zmianie. Nie zastępować natywnego selecta rozbudowanym własnym dropdownem bez potrzeby.
4. [x] Detal: u góry nazwa firmy i wynik gotowości; następnie dane kontaktowe, osoba decyzyjna, decyzja i „Poprzednia / następna”. Identyfikatory oraz pochodzenie niżej, w logicznie opisanym rozwinięciu.
5. [x] Sekcja „Wynik OC” pokazuje istniejące prawdziwe liczby, datę odniesienia i jawne linki „Otwórz wynik OC z dnia…” / „Pobierz wynik Excel”. Nie nazywać ogólnej liczby `policyCount` liczbą aktualnych polis, jeśli źródło nie gwarantuje takiej semantyki. Nie wymyślać brakujących danych.
6. [x] Zachować wariant usuniętego importu: pobranie zachowanego snapshotu przez istniejący endpoint, bez linku do nieistniejącego źródła i bez przywracania skasowanych danych.
7. [x] Dla szerokości ≤820 px przejść do kart: nazwa, miejscowość, najważniejszy kontakt, status i szczegóły dostępne bez poziomego przewijania. Tabela i karty korzystają z tych samych danych oraz handlerów. Ukryty wariant nie może pozostawać w kolejności Tab ani dublować ID pól.
8. [x] Zmiana statusu ma stan zapisu przy danej firmie i potwierdzenie. 409 oznacza odświeżenie wersji i pokazanie aktualnej decyzji, bez ślepego ponowienia nadpisującego cudzą zmianę.
9. [x] „Zwolnij mój przydział” przenieść do akcji pomocniczych i wyjaśnić skutek przed zapisem. Użyć istniejącego mechanizmu potwierdzenia albo dostępnego dialogu; nie dodawać pozornego „Cofnij”, skoro backend nie gwarantuje odzyskania przydziału.

**Odbiór:** telefon, decyzja i przejście do następnej firmy w zasięgu bez otwierania technicznych sekcji; przy 390 px brak poziomego przewijania potrzebnego do statusu. Nie dodawać obowiązkowej notatki ani nowego statusu.

## 17. UX-14 — kontrast i tokeny rzeczywiście używane przez formularze

**Pliki:** `styles/tokens.css`, `styles/theme.css`, `leads/leads.css`, `team/team.css`, `access/access.css`, `tools/oc-policy-verification/automation.css`, właściwe override w `legacy-platform-frame.css`.

Kroki:

1. [x] Użyć istniejącego `--color-field-border: #77717b` jako kandydata wspólnej granicy pola. Najpierw policzyć kontrast wobec faktycznych sąsiadujących teł; token jest propozycją, wynik pomiaru warunkiem akceptacji.
2. [x] `--lead-*` i `--oc-*` przekierować na odpowiednie globalne semantyczne tokeny tam, gdzie znaczenie jest wspólne. Zastąpić obrysy `#47454b`/`#393a3d` w aktywnych polach. Nie podnosić wszystkich dekoracyjnych linii kart do 3:1.
3. [x] `.lead-nav-label` i `.oc-step-rail-note` używają sprawdzonego muted tokena, np. istniejącego `--color-text-muted`, zamiast zbyt ciemnych lokalnych szarości. Sprawdzić też statusy przy błędzie/disabled/focus, bez błędnego wymagania kontrastu dla nieaktywnych kontrolek.
4. [x] Ustalić skalę roboczą: tekst/pola 14–16 px, ważne etykiety 13–14 px, pomocnicze metadane 12–13 px. Nie zwiększać wyłącznie nagłówków; ograniczyć powtarzane overline, by zachować miejsce na pracę.
5. [x] Zachować fonty i wyraźne focus-visible. Fokus 2 px z odsunięciem, bez obcięcia przez `overflow:hidden`; dodatkowa korekta scroll padding dla sticky topbara.
6. [x] Nie robić pełnej przebudowy globalnego CSS. Sprawdzić kaskadę na renderowanym elemencie, żeby stary `theme.css` nie anulował poprawionego tokena. Usuwać jedynie potwierdzone zbędne override w zmienianym zakresie.

**Odbiór:** zwykły informacyjny tekst ≥4,5:1, wymagane granice/stany komponentów ≥3:1; obliczenia z computed styles, nie z pikseli antyaliasowanego screena. 44 px jest celem ergonomii; nie utożsamiać go z minimum AA.

**Źródła:** [WCAG kontrast tekstu](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [kontrast nietekstowy](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), [rozmiar celów AA](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

## 18. UX-15 — układ na laptopie i wygodne cele interakcji

**Pliki:** `leads/platform-pages.css`, `leads/leads.css`, `LeadSidebar.tsx`, `team/team.css`, `automation.css`.

Kroki:

1. [x] Zmienić `.platform-operation-row`: stałe szerokości sześciu kolumn zastąpić układem elastycznym. Nazwa i status na pierwszej linii, liczby i data na drugiej, strzałka jako stała wąska kolumna. Używać `minmax(0,1fr)` dla tekstu.
2. [x] Obszar panelu operacji oznaczyć jako kontener szerokości. Przy małej szerokości karty przejść do układu kompaktowego, niezależnie od szerokości całego viewportu. Nie leczyć problemu samym ukryciem daty albo `overflow:hidden`.
3. [x] Przebudować sidebar na: marka stała, `nav` w `flex:1; min-height:0; overflow-y:auto`, dół stały. Usunąć minimalną wysokość wymuszającą wyjście poza niski ekran; stosować dostępne `100dvh` z właściwym fallbackiem.
4. [x] W `LeadSidebar.tsx` nadać przewijalnemu obszarowi wyraźną strukturę bez zmiany uprawnień. Zachować zwijanie, etykiety, aria-current, mobilny focus trap i Escape. Sprawdzić rozwinięty i zwinięty sidebar oraz ruch myszy nad nim.
5. [x] Ważne samodzielne linki/przyciski mają aktywny obszar około 44×44 px: Konto, menu, odświeżenie, strzałka detalu, zarządzanie, powrót i główne akcje etapów. Powiększać hit area/padding, nie tylko ikonę.
6. [~] Przy 200% zoomie zapewnić przejście do wariantu o właściwej szerokości; elementy sticky nie zasłaniają fokusu. Nawigacja nie może wymagać wyłącznie hovera.
7. [x] Nie animować zmiany rozmiaru tabel i paneli. Zachować krótkie sygnały zmiany stanu, respektować reduced-motion w zmienianych komponentach.

**Odbiór:** 1366×768 — pełna informacja operacji i całe menu; 390×844 — wygodne akcje i poprawna nawigacja; brak przyciętego fokusu. Test samego `document.scrollWidth` nie wystarcza: sprawdzić geometrię i clipping wewnątrz paneli.

## 19. UX-16 — testy przekrojowe i dowód zakończenia

### 19.1 Macierz najważniejszych scenariuszy

| ID | Scenariusz | Oczekiwany wynik | Pakiety |
|---|---|---|---|
| T01 | mine + fraza + status → eksport | tylko wszystkie dopasowane moje firmy, bez innych przydziałów | 01–03 |
| T02 | pool + resultSetId → eksport | dokładny zakres zestawu | 01–02 |
| T03 | brak download grantu | brak aktywnego eksportu, API odmawia | 02 |
| T04 | limit 50 001 | brak częściowego pliku, poprawna instrukcja zawężenia | 02 |
| T05 | pierwszy odczyt 503 → retry | błąd z ponowieniem, bez fałszywych zer/aktualności | 03 |
| T06 | refresh tych samych danych 503 | poprzednie dane z czasem i ostrzeżeniem | 03 |
| T07 | A request wolny, B szybki | odpowiedź A nie zastępuje B | 03–04 |
| T08 | brak dopasowań / brak przydziału | różne komunikaty i właściwe działania | 03 |
| T09 | 61 firm → druga strona | KPI całego zakresu, licznik widocznych osobno | 01–04 |
| T10 | druga strona + filtr → detal → powrót/reload | zachowane parametry, zakres i pozycja | 04 |
| T11 | Back/Forward i nowa karta | właściwy widok, bez ręcznego odtwarzania filtra | 04 |
| T12 | status zmieniony poza aktywny filtr → następna | aktualna następna pasująca firma, bez automatycznego skoku | 05 |
| T13 | sąsiad skasowany/niedostępny | komunikat, bezpieczne ponowienie/powrót | 05 |
| T14 | sesja wygasa w firmie/OC/alercie | logowanie i powrót do dozwolonego kontekstu | 06 |
| T15 | auth/me 503 | błąd połączenia, nie fałszywe wylogowanie | 06 |
| T16 | powiadomienie read=503/timeout | sprawa mimo to otwiera się, licznik bez fałszywego sukcesu | 07 |
| T17 | wynik bez ID lub z ID obcej operacji | wybór operacji albo odmowa, nie spinner i nie obce dane | 08 |
| T18 | wszystkie etapy OC bez pliku | prawdziwe stany braków i konkretna droga dalej | 08–09 |
| T19 | wybór → preview → start | jedna akcja tworzy podsumowanie, zgoda dopiero przed startem | 09–10 |
| T20 | rewizja zmieniona po preview | unieważnienie i ponowienie podsumowania, bez startu starego zakresu | 09–11 |
| T21 | zaznaczenia przez strony, 500/501 | zachowane 500, jawny limit, brak cichego ucięcia | 10 |
| T22 | reload wyboru/podsumowania | odtworzony zakres, świeży preview, zgoda=false | 11 |
| T23 | utracona odpowiedź po zapisanym starcie | ta sama próba/klucz, dokładnie jedna operacja | 11 |
| T24 | inny użytkownik, niedostępny storage | brak przejętego szkicu; aplikacja działa | 04, 11 |
| T25 | dane po usunięciu importu | zachowany dozwolony wynik; bez odtworzenia źródła | 01–05, 13 |
| T26 | role i granty | menu/CTA zgodne z API, bez rozszerzenia dostępu | 06, 12 |
| T27 | 1366×768 i 1440×900 | brak obcięcia operacji i dolnych akcji menu | 15 |
| T28 | 390px i 200% zoom | kontakt/status dostępne, brak niepotrzebnego scrolla poziomego | 13–15 |
| T29 | Tab/Shift+Tab/Enter/Escape | widoczny fokus, sensowna kolejność, powrót z dialogów | 07–15 |
| T30 | kontrast ze stylów renderowanych | tekst ≥4,5:1; wymagane wskazówki pól ≥3:1 | 14 |
| T31 | status 409 i podwójne kliknięcie | brak nadpisania cudzej wersji, brak powtórnej operacji | 05, 09, 13 |
| T32 | drugi tenant i sfałszowany cursor/returnTo | brak ujawnienia danych/ID i brak zewnętrznego przekierowania | 01–06 |

### 19.2 Gdzie dopisać weryfikację

- Parsery, zakresy, decyzje flow: małe testy jednostkowe obejmujące różne wejścia i reguły, bez kopiowania JSX/CSS do asercji.
- API: `business-leads.http.spec.ts`, nowe testy helpera i nawigacji; `run-submissions.http.spec.ts`/właściwe testy feature dla nowego preview. Uaktualnić jawne listy runnera modułowego.
- DB: `apps/api/scripts/business-leads-db-smoke.cjs` i istniejący runner integracji. Czytać wygenerowany XLSX, sprawdzić ACL, zachowane wyniki i współbieżność, zamiast wyłącznie mockować service.
- Browser: rozszerzyć `lead-ui-smoke.cjs`, `oc-workspace-ui-smoke.cjs`, `manager-ui-smoke.cjs`, `history-ui-smoke.cjs`; dla rozległego flow można dodać osobny `ux-flow-ui-smoke.cjs` z zarejestrowanym npm script. Istniejące smoke scripts startują serwer z `.next`, więc **wymagają świeżego buildu**.
- Responsywność: screenshoty desktop/mobile i pomiary elementów w tej samej rundzie; poprawki zbiorcze, najwyżej jedna runda potwierdzająca. Nie tworzyć otwartej pętli kosmetycznej.
- Czytnik ekranu: ręcznie sprawdzić NVDA przynajmniej na formularzu zakresu, błędzie odczytu, wyniku, zmianie statusu i mobilnym menu. Osobno dotyk na fizycznym urządzeniu; emulacja szerokości tego nie potwierdza.

### 19.3 Komendy i zakres

Z katalogu głównego, po właściwych zmianach:

```powershell
npm run build -w @goldis/api
npm run build -w @goldis/web
npm run test:module:leads
npm run test:module:submission
npm run test:module:auth
npm run test:module:notifications
npm run test:architecture
npm run test:lead-ui-smoke -w @goldis/web
npm run test:oc-workspace-ui-smoke -w @goldis/web
npm run test:run-submission-ui-smoke -w @goldis/web
npm run test:manager-ui-smoke -w @goldis/web
npm run test:history-ui-smoke -w @goldis/web
```

Nie uruchamiać całej listy po każdej zmianie tekstu. Pakiet uruchamia testy właściwe dla zachowania, a pełny powyższy przekrój — po integracji. Nowe parsery/kontrakty dopisać do runnera, aby przejście istniejących modułów ich nie pomijało. Testy DB wykonywać przez istniejący `npm run test:db-integration` w dedykowanym środowisku testowym, po zapoznaniu się z jego wymaganiami. Niedostępnej bazy nie oznaczać jako PASS.

**Nie jest częścią tego planu uruchamianie portali live, produkcyjnych operacji ani automatyzacji biznesowej.** Testy flow bazują na danych syntetycznych i testowej bazie, a nie na rzeczywistych firmach.

### 19.4 Dokumenty końcowe

1. [x] Zaktualizować opisy ekranów w instrukcji użytkownika/admina, gdzie zmieniono nazwy i ścieżki pracy.
2. [x] Utworzyć `docs/ODBIOR_UI_UX_USER_FLOW_2026-10-22.md`: wersja/commit, środowisko, T01–T32 z wynikiem i linkami do dowodów, otwarte ograniczenia, osoba odbierająca.
3. [~] Zrobić ponowny audyt tego samego zakresu; nie traktować samego wzrostu punktacji jako substytutu testów zachowania. Detektor Impeccable tylko jako pomoc, z weryfikacją false positives.
4. [~] Przeprowadzić krótkie zadania z nowymi/doświadczonymi pracownikami i menedżerem. Zanotować ukończenie, błędy, pytania i odtwarzanie kolejki. Bez wymyślania wyniku badań lub deklarowania mierzonej poprawy przed pomiarem.

## 20. UX-17 — sposób wdrożenia i cofania zmian

Kolejność dostawy:

1. [~] Backend z nowymi, kompatybilnymi polami i obsługą filtrów eksportu. Zweryfikować stary frontend na nowym API.
2. [~] Frontend naprawiający zakres eksportu, stany i kontrast; nie publikować nowego eksportu przed backendem, który naprawdę respektuje parametry.
3. [~] Backend paginacji/sąsiadów i preview prezentacyjnego, następnie UI kontekstu kolejki, wyboru i szkicu.
4. [~] Nawigacja, dashboard roli i robocze listy/karty po przejściu podstawowych scenariuszy.
5. [~] Odbiór na środowisku testowym, następnie mała grupa pracowników i menedżer. Publikacja produkcyjna jest osobnym działaniem wdrożeniowym po odbiorze konkretnej wersji.

Warunki zatrzymania wdrożenia: eksport innego zakresu, ujawnienie obcego wyniku, utrata/duplikacja startu, niemożliwy powrót do pracy, niewidoczna kluczowa akcja, nieprzechodzące testy ACL. Tych usterek nie maskować komunikatem marketingowym lub samym powrotem do starszego koloru.

Rollback:

- Zmiany API są addytywne; rollback frontendu nie wymaga migracji danych. Nowy frontend nie powinien być uruchamiany ze starym API ignorującym filtry.
- Przy rollbacku API razem cofnąć zależny frontend albo czasowo wyłączyć nowy eksport; nie dopuścić do cichego szerokiego eksportu.
- Klucze szkicu mają wersję; starszy frontend może je ignorować. Odtwarzanie nie jest warunkiem odczytu istniejącej operacji.
- Zachować istniejący awaryjny `OC_AUTOMATION_WORKSPACE_ENABLED=0`, ale najpierw sprawdzić, które poprawki rzeczywiście obejmują legacy. Flaga nie jest automatycznym sposobem zamknięcia usterek eksportu, ACL czy dostępności i nie zastępuje osobnego odbioru starszego widoku.
- Nie usuwać operacji już utworzonych przez nowy frontend. Pozostają obsługiwane przez niezmienione kontrakty wykonawcze.

## 21. Mapa kompletności — każde ustalenie ma rozwiązanie

| Audyt | Rozwiązanie główne | Dowód odbioru |
|---|---|---|
| F01 eksport | UX-01–02: wspólny zakres, backend + UI | T01–T04, rzeczywisty XLSX w teście |
| F02 sprzeczne stany | UX-03: model remote data i osobne puste stany | T05–T08 |
| F03 utrata kolejki | UX-04–05: URL, powrót, dwukierunkowe cursory, sąsiedzi | T09–T13 |
| F04 pozorne ładowanie | UX-08: brak kontekstu oddzielony od requestu | T17 |
| F05 blokujące przeczytanie | UX-07: link niezależny od zapisu | T16 |
| F06 kroki/CTA | UX-09: stan gotowości i jedna akcja | T18–T20 |
| F07 utrata szkicu/nazwy | UX-11: storage zakresu, świeże preview, metadane importu | T22–T24 |
| F08 numery zamiast firm | UX-10: wybór nazw i opisane preview | T19–T21 |
| F09 model nawigacji | UX-12: słownik, role, CTA i objaśnienie | T26 + sesja z pracownikiem |
| F10 kontakt/lista/mobile | UX-05, UX-13: kolejka, linki i karty | T12, T25, T28, T31 |
| F11 login gubi cel | UX-06: wspólny bezpieczny powrót | T14–T15, T32 |
| F12 liczniki strony | UX-01, UX-03: agregaty aktywnego zbioru | T09 |
| F13 obrys pól | UX-14: wspólny zweryfikowany token | T30 |
| F14 kontrast tekstu | UX-14: muted token i skala tekstu | T30 |
| F15 obcinany dashboard | UX-15: układ zależny od kontenera | T27 |
| F16 ukryte menu | UX-15: przewijalny nav i stały dół | T27, T29 |
| F17 małe cele | UX-15: hit area i odstępy | T28–T29 + fizyczny dotyk |

## 22. Definicja zakończenia

Plan jest wykonany dopiero, gdy wszystkie F01–F17 mają zapisany wynik odbioru, krytyczne ścieżki przechodzą na świeżym buildzie, eksport i liczniki respektują wspólny zakres oraz uprawnienia, kolejka jest odtwarzana po przerwie, start nie duplikuje operacji, a czytelność i dostępność są potwierdzone na renderowanym interfejsie. Pozostałe ograniczenia muszą być nazwane w raporcie odbioru, bez zastępowania niewykonanych testów deklaracją gotowości.

Plan został wypełniony po implementacji. Stan lokalnego kodu i wyniki konkretnych testów znajdują się w [protokole odbioru](./ODBIOR_UI_UX_USER_FLOW_2026-10-22.md). Sama implementacja lokalna nie oznacza wdrożenia produkcyjnego ani akceptacji przez pracowników.
