# Końcowe domknięcie platformy i automatyzacji — projekt do ustalenia zakresu

> Dokument roboczy zastąpiony po odpowiedziach właściciela przez [szczegółowy plan ostatecznego domknięcia](PLAN_OSTATECZNEGO_DOMKNIECIA_PLATFORMY_2026_10_08.md). Poniższe pytania i propozycje pozostają zapisem wcześniejszego etapu, a nie aktualnym zestawem decyzji.

Data: 8 października 2026. Podstawa: [audyt platformy](AUDYT_CALOSCI_PLATFORMY_2026_10_08.md), aktualny kod i oficjalna dokumentacja dostawców. Dokument opisuje proponowane prace i testy; nie jest ich wykonaniem ani zezwoleniem na uruchomienie live. Odpowiedzi użytkownika mają pierwszeństwo przed proponowanymi ustawieniami.

## Ustalenia już przekazane przez użytkownika

- **Zakres:** pełne przedstawione flow wraz z edge cases, wpisywanie SMS przez użytkownika w platformie i zarządzanie automatyzacją przez platformę. Ręczny SMS jest częścią docelowego produktu i nie jest brakiem uniemożliwiającym uznanie automatyzacji za kompletną w tym modelu.
- **Wdrożenie:** domyślnie VPS, również dla przeglądarki workera. Parametry/system i dostępność VPS pozostają do ustalenia.
- **Użytkownicy:** maksymalnie 5 jednocześnie. Użytkownik odpowiedział „1 firma” na pytanie o wolumen; wysłano doprecyzowanie, czy chodzi o organizację używającą platformy, czy jeden sprawdzany podmiot dziennie. Do odpowiedzi nie przypisano tej liczbie limitu przetwarzania. Zasady ponownego sprawdzania pozostają nieustalone.
- **Propozycja startowa:** jeden portal worker na dedykowany profil/konto i trwała kolejka; pięć sesji platformy nie oznacza pięciu równoległych sesji portali. Zwiększenie liczby workerów zależy od wolumenu i izolacji kont/profili.
- **Obsługa przez panel:** start/preview, rzeczywisty postęp, interwencja/SMS, kontrolowane wznowienie, anulowanie i zarządzanie przyjmowaniem nowych zadań. Szczegóły pauzy aktywnego zadania wymagają punktów bezpiecznego zatrzymania; pauza nie cofa wykonanej akcji portalu.

Te odpowiedzi rozstrzygają D01/D02 oraz część D03. Nie zlecono jeszcze implementacji ani prób live.

## Decyzje potrzebne do implementacji

| ID | Pytanie | Dlaczego odpowiedź ma znaczenie |
| --- | --- | --- |
| D01 | Czy pierwsze wydanie ma automatyzować poprawne przypadki i oddawać SMS/wyjątki operatorowi, czy pracować bez operatora? | Wyznacza zakres uwierzytelnienia, interwencji i definicję ukończenia. Propozycja pierwszego wydania: operator obsługuje SMS i wyjątki. |
| D02 | Gdzie pracują panel/API/DB/Redis, a gdzie przeglądarka: dedykowany Windows, serwer czy model mieszany? Czy system jest wewnętrzny/VPN czy dostępny przez Internet? | Określa sieć, TLS, prywatne endpointy workera, backup, sesje i dostęp. Nie należy wystawiać odbiornika kodu workera publicznie. |
| D03 | Ilu użytkowników jednocześnie, ile firm dziennie, jaka największa partia i w jakim czasie powinna się skończyć? | Wyznacza benchmarki, limity, kolejkę oraz potrzebę większej przepustowości. |
| D04 | Czy ta sama firma może być sprawdzana ponownie tego samego dnia; jak długo wynik może być używany ponownie? | Oddziela retry tego samego zadania, duplikat importu, świadome nowe sprawdzenie i cache. Potrzebna jest też definicja daty odniesienia polis. |
| D05 | Czy obsługujemy tylko JDG z potwierdzonym PESEL, czy także spółki i inne podmioty? Co robić przy wielu osobach/dopasowaniach? | Obecny resolver tożsamości nie jest uniwersalnym resolverem wszystkich form działalności. Spółki mogą wymagać odmiennego procesu. |
| D06 | Czy brak adresu, powiatu, REGON lub niezgodność osoby ma zatrzymać ten rekord, całą partię, czy skierować rekord do korekty? | Określa kontynuację partii i ręczne wznowienie. Propozycja: odizolować rekord, kontynuować poprawne; awaria całego dostawcy zatrzymuje jego kolejkę. |
| D07 | Czy jest klucz GUS BIR? Czy BIR ma być podstawowy, a MF pomocniczy, czy na początek jeden dostawca? | Określa konfigurację, pokrycie i potrzebę fallbacku. Nie przesyłać klucza w odpowiedzi na pytanie; wystarczy potwierdzić jego dostępność. |
| D08 | Ile kont PZU/Compensy będzie używanych, kto odbiera SMS i czy te konta są równocześnie używane ręcznie? Czy dostępne są warunki/limity od dostawców i środowisko testowe? | Określa własność profilu, konflikty sesji, granice tempa i możliwość przeprowadzenia prób bez skutków biznesowych. |
| D09 | Jak długo przechowywać importy, wyniki, dane tożsamości i audyt? Ile pracy można utracić i jak szybko trzeba wznowić usługę? | Wyznacza retencję, harmonogram backupu, RPO/RTO i test restore. Okresy ustala właściciel danych, nie agent. |
| D10 | Kto jest administratorem/operatorami/reviewerem, kto zatwierdza wynik i gdzie mają trafiać alarmy? Czy administratorzy mogą używać aplikacji TOTP? | Wyznacza MFA/recovery, macierz ról, przydział interwencji i kanał alertów. |

Nie wszystkie decyzje blokują rozpoczęcie. Poprawę kontrastu, testy izolacji, limiter transportu i przygotowanie bramek wydania można prowadzić niezależnie. Docelowe wdrożenie, retencja, zakres nowych podmiotów i live zależą od odpowiedzi.

## Pakiety kończące budowę

| Pakiet | Prace | Testy i dowód zakończenia |
| --- | --- | --- |
| K1 — aktualny odbiór techniczny | Uruchomić odizolowany PostgreSQL/Redis; sprawdzić migracje 031–033 od kopii schematu 030, aktualne sesje/granty i limitery. | Migrations/security-db/security-redis PASS; równoległe login/reset/change-password, cofanie grantów, cztery role i dwa tenanty; brak nieautoryzowanych skutków. Nie migrować istniejącej instalacji dla samego testu. |
| K2 — wykończenie produktu | Naprawić kontrast enrichment, pokryć nowe karty admina tokenami, ujednolicić czytelne błędy i cele dotykowe. | UI i screenshoty przy 320/768/1920 px; klawiatura, focus, stany 401/403/409/429/503, pusta lista, powrót po utracie sieci; kontrast. |
| K3 — bezpieczeństwo wdrożenia | MFA/recovery/step-up, HTTPS, właściwe origin/proxy, osobne konto migratora, małe prawa runtime, Redis ACL i non-root. | Izolowany staging: cookies, CSRF/CSP, spoofing proxy, wygasanie/cofanie sesji, utrata urządzenia MFA, brak step-up i ponowienie uprzywilejowanej akcji. |
| K4 — tempo i niezawodność automatyzacji | Wspólny limiter dostawcy, cooldown, ograniczone retry, checkpointy, zatrzymanie kolejki przy problemie systemowym i dalsza praca dobrych rekordów. | Fixture z kontrolowanym czasem, współbieżne workery, restarty i 429; rzeczywiste liczby wywołań i brak drugiej oferty/UFG po niepewnym wyniku. |
| K5 — utrzymanie i wydanie | Pełny backup/restore DB+exports+keys, retencja dry-run, uzgadnianie orphanów, metryki/alerty, release manifest, rollback i CI modułów. | Restore do drugiej instalacji, wrong-key, disk-full, awaria DB/API, dostarczony alarm; pomiary p95/RSS/SQL i uzgodnione RPO/RTO; wydanie ma rzeczywisty commit/schema/digests. |
| K6 — odbiór portali i biznesu | Zweryfikowane selektory całej ścieżki, jednoznaczny kontrakt danych wejściowych i oczekiwanego wyniku. | Najpierw osobne moduły. Następnie użytkownik świadomie zleca odbiór live na zatwierdzonym zakresie; porównanie danych, liczników akcji, snapshotu, XLSX i audytu. |

K2 oraz przygotowanie K4 mogą postępować podczas K1. Wydanie użytkownikom zależy od K1/K3/K5. K6 nie jest automatycznie uruchamiane przez agentowy runner ani dodawane do CI jako ukryty pełny przepływ.

### Docelowy układ na VPS

Przeglądarka użytkownika → HTTPS/reverse proxy → web/API → prywatne PostgreSQL/Redis → osobny portal worker Playwright z trwałym prywatnym profilem i osobny worker rejestru. Magazyn eksportów i zaszyfrowanego stagingu jest trwały; backup jest przechowywany także poza VPS. Panel przekazuje SMS przez prywatną komunikację API–worker, bez potrzeby zdalnego pulpitu dla zwykłej obsługi.

Na VPS trzeba dodatkowo sprawdzić start po reboot, brak dwóch właścicieli profilu, wygaśnięcie sesji portalu, odzyskanie kolejki, limit pamięci przeglądarki i warunki połączenia/SSO portali z serwera. Headless musi zostać zweryfikowany na docelowych ekranach. Ewentualny dostęp serwisowy do przeglądarki jest prywatny i nie zastępuje panelu operatora.

SMS ma odpowiadać aktualnemu challenge, portalowi i zadaniu. Wygaśnięty kod nie jest wysyłany. Równoczesne wysłanie kodu przez dwie osoby ma zakończyć się jednym przyjęciem i czytelnym stanem dla drugiej. Oczekiwanie na MFA wspólnej sesji portalu może blokować inne zadania używające tej sesji; nie obiecywać ich kontynuacji bez rozdzielenia profili.

Test pięciu zalogowanych użytkowników obejmuje kolejkę kilku partii, izolację danych, równoczesne akcje SMS/sterowania, cofnięcie praw w trakcie oczekiwania i restart workera/VPS. Docelowy limit czasu przetworzenia partii można ustalić dopiero po podaniu jej wielkości i pomiarze pojedynczego rekordu.

## Odstępy między requestami — dodatkowe ustalenie po audycie

Obecny kod ma budżet dzienny (`registry-request-budget.ts`), batch/cache, pojedynczy portal worker (`concurrency: 1`) i retry techniczne portali po 5/15 s. Runner enrichment ogranicza współbieżność, ale po zakończeniu zadania może od razu przejść do następnego. W przeglądanych adapterach nie znaleziono wspólnego egzekwowania okien sekundowych/minutowych/godzinowych na rzeczywistym transporcie dostawcy.

**Dodatkowy brak do implementacji: tempo wywołań oraz cooldown na poziomie dostawcy, wspólne dla procesów i obejmujące wszystkie próby sieciowe.** Jedno zadanie lub lookup może wywołać więcej niż jeden request: BIR login, search, odnowienie sesji i ponowiony search. Rozliczanie wyłącznie wejścia do lookup nie mierzy tych wszystkich wywołań.

### Limity potwierdzone w źródłach

- MF VAT `search`: 100 zapytań dziennie, do 30 podmiotów w zapytaniu. MF dodatkowo ostrzega przed zbyt szybkim odpytywaniem i nie publikuje wszystkich technicznych progów. Nie ma podstaw do zagwarantowania bezpieczeństwa jednej arbitralnej przerwy. [Oficjalny opis MF](https://www.gov.pl/web/kas/api-wykazu-podatnikow-vat).
- GUS BIR w godzinach 08:00–16:59: 3 wywołania/s, 120/min, 6000/h. Poza tym pasmem dostępne są wyższe limity według oficjalnej tabeli. **6000/dobę w obecnym kodzie to dodatkowy konserwatywny budżet aplikacji, nie oficjalna jednostka limitu GUS.** [Oficjalne limity GUS](https://api.stat.gov.pl/Home/RegonApi?lang=pl).
- Dla PZU/Compensy/UFG nie potwierdzono w tym przeglądzie opublikowanej liczbowej kwoty właściwej dla używanych kont. Nie należy prezentować proponowanych odstępów jako limitów dostawcy.

### Proponowany mechanizm

| Warstwa | Reguła |
| --- | --- |
| GUS | Na początek globalnie maksymalnie 1 rzeczywiste wywołanie SOAP/s, bez burstu, plus egzekwowanie okien minutowych/godzinowych i budżetu wewnętrznego. Ten poziom startowy jest propozycją; także logowanie/retry zużywają rezerwację. |
| MF | Batch/cache i budżet dobowy; konfigurowalna przerwa między batchami, respektowanie Retry-After i wspólny cooldown po 429. Wartość przerwy ustalić na podstawie warunków i obserwacji dozwolonych prób. |
| Portale | Jedno aktywne zadanie na profil/konto; oczekiwanie na konkretny stan ekranu i zakończenie odpowiedniej operacji. Dodatkowa przerwa między akcjami biznesowymi konfigurowalna; np. 2–5 s wyłącznie jako punkt startowy do pomiaru, nie gwarancja ani oficjalny limit. |
| Ponowienia | Retry-After ma pierwszeństwo. Przy przejściowym błędzie rosnące odstępy, niewielkie rozproszenie czasowe i ograniczona liczba prób. Nie ponawiać niepewnego Zapisz/UFG przed uzgodnieniem wyniku. |
| Awaria dostawcy | Po progu kolejnych błędów zatrzymać nowe wywołania, zachować nextAttemptAt/cooldownUntil i przekazać stan do panelu/alertu. Kontrolowana próba powrotu; brak pętli agresywnych retry. |
| Panel → własne API | Polling zależny od aktywnego widoku, bez nakładających się requestów, z backoff po błędzie. Obecne 10–20 s dla wielu statusów stanowi punkt wyjścia; SMS może mieć osobny interwał. Przy większej liczbie użytkowników scalić powtarzające się odczyty lub rozważyć SSE. |

Limiter ma działać blisko rzeczywistego transportu i atomowo współdzielić stan według zakresu limitu dostawcy (konto/klucz/wyjście sieciowe). Dla klienta korzystającego też ręcznie z konta/IP trzeba zostawić zapas. Długi cooldown powinien zwolnić worker i trafić do trwałej kolejki; nie zajmować slotu wielominutowym sleep.

Przy portalu jedna akcja UI może wywołać kilka requestów AJAX. Nie opóźniać mechanicznie każdego zasobu strony. Kontrolować tempo akcji biznesowych, stan ekranu i mierzyć rzeczywistą liczbę wywołań. Po oczekiwaniu na pacing ponownie sprawdzić lease/anulowanie przed kliknięciem.

## Macierz testów tempa i awarii

1. **Granice okien:** fake clock; zapytanie na granicy sekundy/minuty/godziny/doby; brak burstu i reset bez dodatkowych wywołań. Uwzględnić Europe/Warsaw i zmianę czasu przy regułach opartych na lokalnej dacie.
2. **Wspólny limit:** dwa procesy/workery, ta sama konfiguracja dostawcy, suma faktycznych requestów nie przekracza ustawionych kwot. Restart zachowuje cooldown i rezerwacje.
3. **Transport BIR:** login/search/expired-session/relogin/retry osobno policzone. Cache hit nie wywołuje HTTP; batch dzieli się według adaptera i nie myli liczby NIP z liczbą requestów.
4. **429/Retry-After:** liczba sekund i data HTTP, brak/błędny nagłówek, trwający cooldown, nowe zadania oraz różni użytkownicy. Retry nie następuje przed dozwolonym terminem; anulowanie nadal działa.
5. **Błędy przejściowe:** timeout/503/zerwane połączenie; ograniczona liczba retry, rosnące opóźnienia, rozproszenie i zatrzymanie dostawcy po progu. Błąd danych i 401 nie powodują bezcelowego retry.
6. **Akcje niepewne:** timeout po wysłaniu Zapisz/UFG, restart po checkpointcie i utrata lease. Liczniki akcji nie rosną bez autorytatywnego potwierdzenia potrzeby ponowienia.
7. **Przeglądarka:** wolny AJAX, stary wynik poprzedniego REGON, dodatkowy overlay, wygaśnięcie sesji, niepełna tabela, wirtualizacja i brak powiatu. Oczekiwanie kończy się poprawnym stanem albo jawną interwencją.
8. **Panel i skala:** wielu użytkowników/kart, ukryty widok, utrata sieci i powrót; nie mnożyć pollingów ani traktować ich jako interakcji przedłużających sesję. Sprawdzić sumę requestów wobec własnego limitera API i rzeczywistej topologii proxy.

Testy przeciążenia i fault injection wykonuje się na syntetycznych fixture/staging. Nie próbować znaleźć limitu produkcyjnego portalu przez doprowadzenie konta do blokady.

## Odbiór wyniku

Warunki obowiązkowe: zero błędnych powiązań osoby/firmy w zestawie odbiorowym, zero nieautoryzowanych odczytów, brak drugiej oferty lub weryfikacji po retry, kompletne oczekiwane pola i liczność OC, prawidłowy filtr daty, właściwy XLSX albo jawny wynik zerowy, trwały audyt oraz odtwarzalny stan po restarcie.

Uzgodnione limity czasowe/rozmiary/obciążenie i dopuszczalny udział interwencji trzeba ustalić z odpowiedzi D01–D10. Zaliczone testy modułów nie są formalną akceptacją całego procesu live.
