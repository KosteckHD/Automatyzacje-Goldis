# Goldis — plan frontendu w kolorach czerni i złota

Data: 2 października 2026. Kierunek: **Gabinet Goldis**. Status: motyw, fonty, logo, komponenty React Bits, kontrola uprawnień frontendu i główne przepływy są wdrożone. Build oraz cztery syntetyczne testy UI przechodzą. Ten dokument rozdziela działającą implementację od pozostałych odbiorów z API i dostępności. Mockupy pozostają odizolowane w `docs/design/goldis`; screenshoty aplikacji z danymi syntetycznymi zapisuje `docs/design/goldis/implemented`.

## 1. Cel i decyzje projektowe

Platforma służy zespołowi do korzystania z narzędzi, uruchamiania weryfikacji i pracy z wynikami zapisanymi w systemie. Projekt musi pokryć cały ten przepływ: logowanie, import, korekty, uruchomienie, interwencje, wynik, pobieranie pliku, administrację i konto. Wszystkie widoki mają korzystać z jednego systemu kolorów, typografii i elementów interfejsu.

Przyjąć atramentową czerń z logo, grafitowe powierzchnie, ciepłe złoto do akcji i wybranego stanu oraz jasny tekst do codziennej pracy. Wrażenie marki ma wynikać z prawdziwego logo, eleganckich nagłówków i starannego układu. Używać delikatnych obrysów i niewielkich promieni narożników. Dane i formularze mają być czytelne przez wiele godzin pracy.

Element wyróżniający: duży nagłówek Newsreader zestawiony z użytkowym, kompaktowym panelem danych. Karta głównego narzędzia otrzymuje dyskretne złote światło po najechaniu. Logo zachowuje swoją kaligrafię i oryginalne barwy. Złoto interfejsu jest spokojniejsze od jasnego złota logo.

Numerować tylko rzeczywiste etapy: import, weryfikacja, wynik. Na ekranach administracji wystarczy nazwa sekcji i kontekst. Menu oraz etykiety nie mają używać ozdobnych numerów.

## 2. Stan repozytorium i mapowanie ekranów

| Obszar | Istniejący plik | Zakres przebudowy |
| --- | --- | --- |
| Metadane i globalne style | `apps/web/app/layout.tsx` | Fonty lokalne, wspólne importy CSS, brand assets |
| Punkt wejścia | `apps/web/app/page.tsx` | Zachowanie wejścia do przestrzeni pracy |
| Logowanie i przestrzeń pracy | `apps/web/app/workspace.tsx` | Login, shell, import, statusy, runy, SMS, wynik, pobranie |
| Korekty danych | `apps/web/app/enrichment-review.tsx` | Tabela, konflikty, formularze, potwierdzanie, paginacja |
| Administracja | `apps/web/app/admin/page.tsx` | Granty, konta i sesje, operacje, interwencje, automatyzacja, audyt, raporty |
| Konto | `apps/web/app/account/page.tsx` | Hasło tymczasowe, zmiana hasła, aktywne i cofnięte sesje |
| Style przestrzeni pracy | `apps/web/app/globals.css` | Usunięcie niebieskich i białych powierzchni, wspólne tokeny |
| Style admina i konta | `apps/web/app/admin.css` | Ta sama paleta i elementy co w przestrzeni pracy |

Aktualny projekt używa Next.js, React, TypeScript i zwykłego CSS. Wybrać warianty **React Bits TS-CSS**, aby dopasować je do repozytorium. Nie dodawać Tailwind wyłącznie na potrzeby tej zmiany.

Główne adresy `/`, `/admin`, `/account` pozostają punktami wejścia. Podczas pierwszego etapu administracja może nadal nawigować do sekcji przez kotwice. Docelowe przełączanie pojedynczych sekcji można zapisać w `?section=operations`, z zachowaniem linków ze starych kotwic. Nawigacja musi wskazywać rzeczywiście istniejące widoki.

### Różnice między makietą a bieżącym API

1. Makieta „Narzędzia” przedstawia docelowy katalog. Backend ma katalog narzędzi; przed wdrożeniem potwierdzić kształt jego odpowiedzi i capability dla bieżącego użytkownika. Obecny `workspace.tsx` wylicza część akcji z samej roli. W nowym UI widoczność, wykonanie, odczyt i pobieranie muszą wynikać z odpowiednich uprawnień, przy zachowaniu backendu jako ostatecznej kontroli.
2. Obecnie `GET /api/imports/:id` odczytuje znany import, a `GET /api/runs?batchId=...` listuje zadania tego importu. Nie ma publicznego `GET /api/imports` do listowania wszystkich importów użytkownika. Karta ostatniego wyniku może używać istniejącego, ponownie autoryzowanego importu. Pełna historia na stronie startowej wymaga osobnego kontraktu API z paginacją i kontrolą dostępu. Nie wyprowadzać listy organizacji z lokalnego storage.
3. Makieta wyniku pokazuje docelową zbiorczą tabelę polis. Bieżące dane runu udostępniają status, `policyCounts`, historię i dostępność artefaktu; widok importu udostępnia wiersze. Pierwszy etap ma użyć tych prawdziwych danych. Pełna lista polis wymaga istniejącego, zweryfikowanego kontraktu albo osobnego rozszerzenia backendu. Nie odczytywać samodzielnie arkusza z wynikiem w przeglądarce.
4. Podsumowania w makietach są przykładami kompozycji. Każdy licznik w aplikacji musi mieć konkretne źródło. Nie sumować pełnego importu z pierwszych 50 wierszy.
5. Tryb portali i dostępność workera w mockupie są demonstracyjne. W aplikacji wyświetlać prawdziwy health i jawnie odróżniać tryb wyłączony od gotowości do uruchomienia.

## 3. Logo i identyfikacja

Źródło od użytkownika: `C:/Users/micha/Downloads/Goldis.jpg`. Niezmieniona kopia użyta w podglądzie: `docs/design/goldis/assets/logo-goldis.jpg`.

1. Skopiować oryginał do `apps/web/public/brand/goldis-logo.jpg`.
2. Utworzyć `GoldisLogo.tsx` z wariantami `login`, `sidebar`, `header` i czytelnym `alt="AC Goldis Ubezpieczenia"`.
3. Zachować proporcje, parasol, litery AC, napis Goldis oraz Ubezpieczenia. Nie zastępować logo tekstem z fontu ani literą G.
4. Nie nakładać filtrów, zmiany koloru, tilt, połysku ani animacji deformującej logo.
5. Tło otoczenia logo dopasować do `--color-brand-bg`. Makiety używają oryginalnego JPG i kadru CSS usuwającego tylko puste marginesy. Wszystkie elementy znaku muszą pozostać widoczne.
6. Do dużego logo użyć pola o szerokości około 390 px; sidebar około 200 px; na mobile widoczny znak ma mieć bezpieczne pole w nagłówku. Nie dopuszczać do kolizji z menu, podpisem i linią nagłówka.
7. Podstawą wdrożenia jest dostępny JPG. Gdy pojawi się oficjalny SVG, wymienić zasób w jednym komponencie, zachowując wymiary i testy. Favicon i kompaktowy symbol oprzeć wtedy na dostarczonej wersji znaku.
8. Określić rozmiar obrazka w HTML/CSS, aby uniknąć przesunięcia układu przy ładowaniu. Oznaczyć logo logowania jako zasób priorytetowy; pozostałe nie powinny blokować treści.

## 4. Paleta i tokeny

Utworzyć `apps/web/app/styles/tokens.css` i używać semantycznych nazw. Kolory nie mogą być wpisywane osobno w każdej stronie.

| Token | Wartość | Zastosowanie |
| --- | --- | --- |
| `--color-bg` | `#08080C` | Tło całej aplikacji |
| `--color-brand-bg` | `#03010D` | Pole z logo, sidebar, lewa część logowania |
| `--color-surface` | `#111116` | Karty, tabele i formularze |
| `--color-surface-raised` | `#19191F` | Nagłówki tabel, menu, powierzchnie pomocnicze |
| `--color-text` | `#F2EEE5` | Podstawowy tekst |
| `--color-text-muted` | `#A6A39A` | Opisy, dodatkowe daty, etykiety pomocnicze |
| `--color-gold` | `#D9B65F` | Główne akcje, zaznaczenia, aktywna nawigacja |
| `--color-gold-hover` | `#F2D889` | Hover i focus |
| `--color-border` | `#323238` | Podziały strukturalne |
| `--color-field-border` | `#77717B` | Rozpoznawalny obrys pól i kontrolek |
| `--color-success` | `#ACCDB4` | Mały akcent stanu powodzenia |
| `--color-danger` | `#E7A8A2` | Mały akcent błędu i działań niebezpiecznych |
| `--color-attention` | `#F2D889` | Uwaga, wysoki priorytet, potrzebny SMS |

Zielony i czerwony są funkcjonalnymi wyjątkami: tekst statusu, ikona albo mały znacznik. Duże powierzchnie nadal pozostają czarne i złote. Status zawsze zawiera nazwę, żeby działał także bez rozróżniania kolorów.

Pozostałe tokeny:

```css
--font-display: "Newsreader", Georgia, serif;
--font-body: "Hanken Grotesk", Arial, sans-serif;
--font-data: "IBM Plex Mono", Consolas, monospace;
--radius-control: 5px;
--radius-card: 9px;
--radius-modal: 12px;
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 24px;
--space-6: 32px;
--space-7: 48px;
--motion-fast: 160ms;
--motion-enter: 350ms;
```

Złoty przycisk ma ciemny tekst, nie biały. Unikać złotych akapitów: podstawowy tekst pozostaje jasny, pomocniczy stonowany. Gradient ograniczyć do dyskretnego tła głównej karty i materiału dekoracyjnego. Wykresy korzystają z ustalonej palety, z legendą i oznaczeniami tekstowymi.

## 5. Typografia

Rekomendowana para to **Newsreader + Hanken Grotesk**, uzupełniona **IBM Plex Mono** do identyfikatorów i odczytu czasu.

| Rola | Font | Rozmiar / ciężar | Reguła |
| --- | --- | --- | --- |
| Główne nagłówki | Newsreader | 34–54 px, 450–500 | Maksymalnie 2 linie na desktopie, naturalne łamanie na mobile |
| Główny nagłówek logowania | Newsreader | 38–48 px, 420–460 | Wyraźna hierarchia względem logo |
| Nagłówek ważnej karty | Newsreader | 28–39 px, 450–480 | Tylko wybrane karty, nie wszystkie komórki |
| Nagłówki tabel i sekcji | Hanken Grotesk | 16–20 px, 500–600 | Krótkie, opisowe etykiety |
| Tekst i pola | Hanken Grotesk | 14–15 px, 400–500 | Interlinia 1,5–1,65 |
| Dane tabelaryczne | Hanken Grotesk | 13–14 px, 400–500 | Czytelność ważniejsza od liczby wierszy na ekranie |
| Etykiety pomocnicze | Hanken Grotesk | 11–12 px, 500 | Nie stosować drobnego tekstu do wymaganych instrukcji |
| Identyfikatory i timer | IBM Plex Mono | 12–13 px, timer 32–37 px | Cyfry o równej szerokości, daty bez skakania kolumn |
| Liczniki raportów | Newsreader | 30–36 px, 450 | Wartość zawsze obok jednoznacznej definicji |

Newsreader wprowadza charakter gabinetu i dobrze współgra z logo bez powielania jego kaligrafii. Hanken Grotesk utrzymuje przejrzystość formularzy i tabel. Dokumentacja projektu Newsreader opisuje go jako font przeznaczony do czytania na ekranie, z szerokim zakresem Latin Plus: [projekt Newsreader](https://github.com/productiontype/NewsReader). Hanken jest przeznaczony także do interfejsów: [projekt Hanken Grotesk](https://github.com/marcologous/hanken-grotesk).

1. Użyć `next/font/local` w `layout.tsx` i powiązać fonty ze zmiennymi CSS.
2. Przechowywać fonty aplikacji w `apps/web/app/fonts`; nie wykonywać żądań do Google Fonts po zalogowaniu.
3. Fonty prototypu są w `docs/design/goldis/assets/fonts`, wraz z plikami OFL. Do aplikacji przygotować WOFF2 zachowujące polskie znaki i licencje.
4. Użyć `font-display: swap` oraz właściwego fallbacku. Jeśli usunięcie podzbiorów wymaga osobnej pracy, pierwsze wdrożenie może wykorzystać pełny font, z pomiarem rozmiaru.
5. Włączyć `font-optical-sizing: auto` dla Newsreader; używać tylko dostarczonych odmian. Nie polegać na sztucznym pogrubieniu lub kursywie.
6. Na liczbach tabel włączyć `font-variant-numeric: tabular-nums`. Identyfikatory muszą mieć możliwość skopiowania; nie rozstrzeliwać ich liter ozdobnym trackingiem.
7. Sprawdzić: „Zażółć gęślą jaźń”, „Ubezpieczenia”, „Łódź”, „Uprawnienia”, „Nieprzypisane”, daty i kwoty z polskim separatorem.

## 6. React Bits: komponenty i sposób użycia

Wybrać oficjalny projekt [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits), nie pakiety o podobnej nazwie. Projekt dostarcza warianty JS-CSS, JS-TW, TS-CSS i TS-TW oraz kod do selektywnego kopiowania. Źródło i instrukcje: [instalacja](https://reactbits.dev/get-started/installation).

Przed kopiowaniem kodu zapisać commit SHA, datę, wariant, URL źródła, wymagane zależności i licencję w `apps/web/components/react-bits/SOURCES.md`. Dopasować kod do lokalnego CSS i nazw tokenów. Nie pobierać całego katalogu komponentów.

| Komponent | Miejsce | Parametry i ograniczenia |
| --- | --- | --- |
| **SpotlightCard** | Główna karta narzędzia | `spotlightColor="rgba(217,182,95,0.12)"`; delikatny efekt tylko pointer/fine. Karta pozostaje czytelna na touch i przy reduced motion. Oryginał używa React i CSS bez silnika animacji. |
| **CountUp** | Wybrane liczniki raportów | Jedno krótkie wejście, około 0,6 s po pobraniu danych. Nie animować timerów SMS, aktualnych statusów ani każdej odpowiedzi pollingu. Potrzebuje `motion/react`. |
| **Stepper** | Etapy import → weryfikacja → wynik | Dopasować wizualnie do istniejącego procesu, usunąć fioletowe hardcode’y. Dla statusów serwera wymagana wersja kontrolowana i bez klikania do przyszłych etapów. Potrzebuje `motion/react`. |
| **AnimatedContent — opcjonalnie** | Krótkie wejście dekoracyjnej treści logowania albo nagłówka katalogu | `distance=12`, `duration=0.35`, `delay=0`, bez scale. Aktualna wersja TS-CSS korzysta z GSAP; dodatkową zależność dodać dopiero po pomiarze kosztu. Formularze i istotna treść muszą być widoczne bez zakończenia animacji. |

Źródła do sprawdzenia przy wdrożeniu: [SpotlightCard](https://reactbits.dev/components/spotlight-card), [CountUp](https://reactbits.dev/text-animations/count-up), [Stepper](https://reactbits.dev/components/stepper), [AnimatedContent](https://reactbits.dev/animations/animated-content).

Istotne różnice względem gotowych przykładów:

1. `Stepper` ma własny stan i domyślnie pozwala przejść między etapami. Dla przebiegu automatyzacji stan ma pochodzić z API. Dodać kontrolowane `currentStep`/stany, semantyczne `ol`, `aria-current="step"` i wyłączyć przechodzenie kliknięciem. Sama animacja nie uruchamia, nie wznawia i nie kończy zadania.
2. `CountUp` formatuje liczby przez `en-US` i początkowo zwraca pusty `span`. Adapter `StatValue` musi od razu renderować końcową wartość dla SSR, braku JS oraz czytnika ekranu. Animowaną kopię oznaczyć `aria-hidden`. Format docelowy `pl-PL`; czytnik nie ma słyszeć wszystkich wartości pośrednich. Przy reduced motion zwrócić zwykły tekst.
3. `AnimatedContent` początkowo ukrywa zawartość i rejestruje ScrollTrigger. Użyć go wyłącznie za bezpiecznym adapterem z widocznym fallbackiem; nie opakowywać logowania, błędów, pól, tabel ani pilnej interwencji. Jeśli koszt GSAP nie jest uzasadniony, trzy główne komponenty wystarczą.
4. CSS skopiowanych komponentów musi być ograniczony nazwą, np. `rb-goldis-*`; selektory takie jak `.outer-container` nie mogą oddziaływać na pozostałe ekrany.
5. Każdy komponent musi sprzątać observer/listener/timeline przy odmontowaniu i poprawnie działać w React Strict Mode.

Podgląd HTML pozostaje statyczną, demonstracyjną makietą. Produkcyjny frontend zawiera wybrane adaptacje React Bits TS-CSS: `SpotlightCard`, `CountUp` przez `StatValue` oraz kontrolowany serwerowym stanem `RunStepper`. SHA źródeł i zmiany adaptacyjne zapisano w `apps/web/components/react-bits/SOURCES.md`.

## 7. Docelowa struktura plików

```text
apps/web/
  public/brand/goldis-logo.jpg
  app/
    fonts/                         # pliki WOFF2 i licencje
    styles/tokens.css
    styles/base.css
    styles/ui.css
    layout.tsx
    globals.css                    # etapowo: style workspace, potem rozdzielenie
    admin.css                      # etapowo: specyfika admina i konta
    workspace.tsx
    enrichment-review.tsx
    admin/page.tsx
    account/page.tsx
  components/
    brand/GoldisLogo.tsx
    layout/AppShell.tsx
    layout/Sidebar.tsx
    layout/Topbar.tsx
    layout/PageHeader.tsx
    ui/Button.tsx
    ui/Field.tsx
    ui/StatusBadge.tsx
    ui/DataTable.tsx
    ui/StatValue.tsx
    ui/EmptyState.tsx
    ui/Toast.tsx
    ui/Modal.tsx
    ui/PermissionSwitch.tsx
    tools/ToolCard.tsx
    tools/RunStepper.tsx
    react-bits/                     # tylko wybrane komponenty i SOURCES.md
```

Nie wykonywać jednocześnie dużego przeniesienia całej logiki requestów. Najpierw wyodrębnić widoki i wspólne elementy, pozostawiając istniejące handlery, polling, kontrolę CSRF oraz kontrakty DTO. Każdy etap ma kończyć się działającą aplikacją.

## 8. Kolejność implementacji krok po kroku

### P0 — punkt bazowy i pokrycie

1. Przeczytać plan administracji oraz aktualny stan implementacji. Oddzielić bramki wizualne od nadal otwartej integracji DB.
2. Uruchomić bieżący build i trzy smoke testy frontendu, zapisując wynik i użyte środowisko.
3. Zrobić screenshoty istniejących ekranów: login, import pusty/załadowany, wynik, korekta, SMS, admin, konto.
4. Spisać wszystkie klasy ze `globals.css` i `admin.css`, w tym modal, powiadomienia, disabled, focus i media queries.
5. Sprawdzić capability katalogu i listę endpointów. Udokumentować brakujące kontrakty historii/polis opisane w sekcji 2.
6. Sporządzić macierz ról: admin, operator, reviewer, auditor; uwzględnić brak grantu, brak wykonania i brak pobierania.
7. Zapisać punkt bazowy w osobnym dzienniku projektu. Nie zmieniać statusu historycznych bramek DB po wykonaniu testów z mockowanym API.

Odbiór: jest lista powierzchni i stanów, a wynik smoke sprzed zmian można porównać z wynikiem po zmianach.

### P1 — logo i fonty

1. Dodać asset logo oraz licencjonowane fonty lokalne.
2. Utworzyć `GoldisLogo` i użyć go w osobnej galerii elementów: login, sidebar, mobile.
3. Dodać konfigurację fontów w `layout.tsx`; ustawić fallbacki, zakresy ciężaru i zmienne.
4. Zastosować fonty do dokumentu bez zmian handlerów.
5. Sprawdzić polskie znaki, skalowanie 200% i font fallback przy zablokowanym ładowaniu fontów.
6. Sprawdzić w Network, że aplikacja nie pobiera fontów ani logo z obcej domeny.

Odbiór: całe logo widoczne; zero przesunięć układu spowodowanych obrazkiem; tekst czytelny także z fallbackiem.

Realizacja: oryginalny JPG i fonty OFL są kopiowane do aplikacji, a logo jest używane w logowaniu, nawigacji, administracji i koncie. Produkcja korzysta z pełnych lokalnych TTF przez `next/font/local`; konwersja do WOFF2 i pomiar rozmiaru fontów pozostają optymalizacją.

### P2 — tokeny i reset stylów

1. Dodać `tokens.css`, `base.css` i kolejność importów w root layout.
2. Włączyć `color-scheme: dark` i ciemne tło dokumentu, aby nie pojawiała się biała klatka przed renderem.
3. Zastąpić kolory `--blue`, `--paper`, białe tła, stare navy oraz hardcode’y semantycznymi tokenami. Nie podmieniać automatycznie koloru w logo.
4. Zapewnić wspólne style `button`, `input`, `select`, `textarea`, linków i selection, ograniczając je do kontrolowanych selektorów.
5. Zdefiniować focus, hover, pressed, disabled, invalid, loading i success.
6. Zmierzyć kontrast: zwykły tekst co najmniej 4,5:1, duży 3:1; rozpoznawalne elementy kontrolek i focus co najmniej 3:1. Linie czysto strukturalne mogą być subtelniejsze. Progi opisują [WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) i [WCAG 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
7. Usunąć pozostałe niebieskie akcenty i białe powierzchnie, również z modala SMS i alertów.

Odbiór: nawet jeszcze niewyodrębnione ekrany korzystają ze spójnego ciemnego tła; czytelność statusów i pól jest zachowana.

### P3 — wspólny shell i nawigacja

1. Utworzyć `AppShell`, `Sidebar`, `Topbar`, `PageHeader` oraz listę pozycji menu z uprawnieniami.
2. Włączyć ten sam shell dla pracy z narzędziem, admina i konta. Logowanie ma własny wariant z tymi samymi tokenami.
3. Sidebar: 238–252 px na desktopie; główna treść z `min-width:0`; padding 32–48 px; aktywny link ma złoty akcent i `aria-current`.
4. Zastąpić obecne nawigacyjne `span` linkami albo właściwymi przyciskami. Każda pozycja musi mieć cel, historię przeglądarki lub rzeczywisty stan sekcji.
5. Na mobile zastosować nagłówek z całym logo i przyciskiem menu. Drawer ma focus trap, zamknięcie Escape, przywrócenie focus i właściwe `aria-expanded`/`aria-controls`.
6. Menu admina pokazywać tylko właściwej roli. Dostęp audytora dopasować do faktycznie dostępnego widoku dziennika, a nie do niedostępnego panelu administracyjnego.
7. Dodawać tytuł strony, breadcrumbs i status użytkownika bez surowych identyfikatorów sesji.

Odbiór: wszystkie główne widoki mają jedną nawigację i nie przechodzą z ciemnej wersji do starego niebieskiego układu.

Realizacja: każdy istniejący widok używa wspólnej warstwy tokenów i stylów. Przestrzeń pracy ma mobilny drawer z fokusem modalnym, Escape, powrotem fokusu i linkami do rzeczywistych sekcji. Admin ma aktywną pozycję synchronizowaną ze scrollowaniem oraz przewijane menu z podpowiedzią na małym ekranie. Osobny komponent `AppShell` współdzielony przez wszystkie strony nie został jeszcze wyodrębniony.

### P4 — wspólne elementy interfejsu

1. `Button`: primary gold, secondary outline, quiet, danger; stabilna szerokość podczas loading, pełna obsługa disabled.
2. `Field`: etykieta, opis, komunikat błędu, wymagane pole; połączyć przez `id`, `htmlFor` i `aria-describedby`.
3. `StatusBadge`: mapa istniejących statusów z nazwą i ikoną; `unknown` ma jawny fallback.
4. `DataTable`: semantyczny HTML, caption, właściwe `th`, sticky header według potrzeby, wrapper ze scroll i informacją o liczbie wierszy.
5. `PermissionSwitch`: użyć semantycznego checkboxa/switch; stan disabled różny od unchecked, nazwa każdego prawa dostępna z klawiatury.
6. `Modal` i `Toast`: zachować obecny focus trap SMS; komunikaty zwykłe `status`, pilne błędy `alert`, brak animacji wymuszającej odczyt kolejnych liczb.
7. `EmptyState`: brak wyników, brak uprawnień, brak sesji, brak audytu w zakresie; treść mówi, jaka akcja jest możliwa.
8. Galeria kontrolna ma pokazać wszystkie warianty na czarnym tle, z długą etykietą, błędem i przy reduced motion.

Odbiór: żadna strona nie definiuje własnego niezgodnego przycisku, pola lub statusu.

Realizacja: kontrolki ekranu logowania, workspace, korekt, konta i admina używają wspólnych tokenów, kolorów stanów, focus-visible i stylów responsywnych. Tabele z przewijaniem mają nazwany region klawiaturowy oraz podpowiedź mobilną. Nie wyodrębniono jeszcze osobnej biblioteki prymitywów `Button`/`Field`/`DataTable`.

### P5 — logowanie i konto

1. Odwzorować mockup logowania: logo i wprowadzenie po lewej, kompaktowy formularz po prawej; na mobile jeden stos.
2. Zachować `autocomplete="username"`, `current-password`, obsługę submit Enter i komunikat błędnego logowania.
3. Przełączanie loading nie usuwa focus i nie powoduje zmiany szerokości formularza.
4. Nie dodawać fikcyjnego self-service resetu; istniejący proces administracyjny opisać prawdziwym komunikatem.
5. Przebudować `/account` wspólnymi kartami i polami: zmiana hasła, wymagany reset, sesje bieżące/wygasłe/cofnięte.
6. Używać właściwego `autocomplete` nowego hasła i czytelnego minimum 14 znaków.
7. Bieżąca sesja ma opis; działanie wylogowania widocznie różni się od samego odczytu.

Odbiór: login działa, wymuszone hasło nadal przekierowuje poprawnie, cofnięcie sesji nie jest mylone z zarządzaniem urządzeniem.

### P6 — narzędzie, import, korekty i wynik

1. Wyodrębnić prezentację narzędzia z obecnego `Workspace`, zachowując stan i requesty.
2. Katalog pobiera rzeczywistą listę dostępnych narzędzi i wyświetla tylko dozwolone akcje. Jeśli historia importów nie ma endpointu, pierwszy ekran pokazuje aktualne/ostatnio otwarte uprawnione dane bez udawania pełnego archiwum.
3. Import: ciemne pole pliku, złoty przycisk, nazwa pliku bez nachodzenia na akcję; błędny format, pusty plik i błąd API mają osobne komunikaty.
4. Tabela importu zachowuje filtry, 50 wierszy na stronie i stany gotowy/do sprawdzenia.
5. `EnrichmentReviewPanel`: nowy wygląd korekt, konfliktów, źródeł, decyzji i wersji; zatwierdzanie nadal wysyła oczekiwaną wersję.
6. Run: stan rzeczywisty, historia etapów, health, anulowanie, oczekiwanie na adapter; nie zmieniać częstotliwości pollingu dla efektów wizualnych.
7. SMS: ciemny modal, duża wartość czasu, czytelne pole i akcja; timer bez CountUp, brak opóźnienia dostępności przycisku przez animację.
8. Dane manualne i resume-review otrzymują te same pola; zachować walidację, restrykcje i komunikaty po odrzuceniu.
9. Wynik: wyróżnić zakończenie, zapisany artefakt i źródła danych. Użyć istniejących `policyCounts`, statusu oraz dat; zbiorczą tabelę z makiety wdrożyć dopiero po potwierdzeniu kontraktu.
10. Pobieranie kontrolować odpowiednim prawem i stanem artefaktu. Nie utożsamiać prawa wykonania z prawem pobrania. Backend nadal sprawdza każde żądanie.

Odbiór: przechodzi pełny syntetyczny przepływ import → korekta → start → SMS/interwencja → wynik → dozwolone pobranie, również dla roli z ograniczeniami.

### P7 — administracja

1. Zastąpić duży ozdobny hero admina funkcjonalnym `PageHeader` zgodnym z mockupami.
2. Granty: lista osób, wybrana osoba, cztery prawa, wersja i wynik zapisu. Na mobile listę zastąpić dostępnym selectem albo panelem wyboru, z zachowaniem możliwości zmiany osoby. Błąd `409` nie kasuje roboczych zmian i kieruje do odświeżenia.
3. Konta i sesje: utworzenie, reset, rola, disable/enable, cofanie sesji; ostatni admin pozostaje chroniony. Złote primary nie mogą sugerować, że disable jest bezpiecznym domyślnym działaniem.
4. Operacje: pasek usług i liczników; offline/loading/error różnią się opisem od stanu gotowości.
5. Interwencje: filtry, priorytet, osoba, termin, rewizja, historia; panel boczny tylko dla rzeczywiście wybranego zgłoszenia. Na mobile szczegóły są osobną kartą lub panelem.
6. Ustawienia automatyzacji: włącznik nowych zadań, limit, okno czasu i strefa; aktywne zadania nie zmieniają wyglądu statusu po edycji tych ustawień.
7. Audyt: jeden wspólny blok filtrów, zakres dat, keyset pagination, tekstowe outcome i brak wrażliwych metadanych.
8. Raporty: wykresy w złocie, prawdziwe miary, definicje i stany bez danych. Dodać tabelaryczny odpowiednik wykresu do odczytu i dostępności.
9. Dopasować wszystkie długie loginy, UUID, kody powodów i daty bez poziomego scroll całej strony.

Odbiór: wszystkie siedem obszarów admina jest pokrytych motywem, a ich CAS, CSRF i filtrowanie zachowują dotychczasowe kontrakty.

### P8 — integracja React Bits i ruch

1. Dodać kod TS-CSS wybranych komponentów i `SOURCES.md` z wersją.
2. Dodać tylko wymagane zależności; zmienić `package.json` i lockfile w tym samym etapie.
3. Najpierw SpotlightCard z poprawnym layeringiem: efekt nie zasłania tekstu i nie przechwytuje kliknięć.
4. Następnie `StatValue` z CountUp, końcową wartością SSR i formatem `pl-PL`.
5. Zintegrować kontrolowany RunStepper z mapą statusów i historią serwerową.
6. Opcjonalne AnimatedContent ocenić osobno; nie dodawać drugiego silnika animacji bez korzyści i pomiaru.
7. Rozpoznawać `prefers-reduced-motion` oraz `hover:none`; wariant statyczny nie może pozostawić zawartości z `opacity:0` lub `visibility:hidden`.
8. Nie uruchamiać animacji przy każdym odświeżeniu, zmianie countdown, powrocie focus ani zmianie filtra tabeli.
9. Zmierzyć koszt na słabszym urządzeniu; nowe animacje nie mogą wykonywać ciągłego WebGL/canvas pod tabelami.

Odbiór: efekt jest widoczny tam, gdzie zaplanowano, a brak animacji nie usuwa danych i interakcji.

### P9 — responsive, dostępność i regresja

1. Sprawdzić 320, 390, 768, 1024, 1440 i 1920 px oraz zoom 200%.
2. Logo ma pełny znak w każdym wariancie. Mobile menu jest dostępne; nawigacja nie znika bez zastępstwa.
3. Gridy i kolumny mają `min-width:0`; tabele przewijają się we własnym wrapperze.
4. Pola i istotne akcje mobile mają wygodny obszar co najmniej 44 px wysokości, z odstępem między akcjami.
5. Sprawdzić klawiaturę: kolejność Tab, Escape, Enter, przywrócenie focus i brak focus na ukrytych elementach.
6. Sprawdzić reduced motion, wolne fonty, brak JS w warstwie dekoracyjnej, skeleton, 401, 403, 404, 409 i błędy sieci.
7. Sprawdzić role i cztery capability. Dane niedostępne nie mogą być chwilowo widoczne przed odczytem uprawnień.
8. Dłuższe filtry/admin drafts zachowują wartość podczas asynchronicznego odświeżania; status zapisu nie udaje ukończenia odczytu po zapisie.
9. Zweryfikować tekst, obrysy pól i focus narzędziem pomiaru kontrastu.

Odbiór: aplikacja nie wymaga poziomego scroll całego dokumentu, cała obsługa krytycznych akcji działa z klawiatury.

### P10 — końcowy odbiór i przekazanie

1. Uruchomić `npm run build`.
2. Uruchomić `npm run test:w3-sms-ui-smoke -w @goldis/web`.
3. Uruchomić `npm run test:w4-enrichment-ui-smoke -w @goldis/web`.
4. Uruchomić `npm run test:admin-ui-smoke -w @goldis/web` na świeżym produkcyjnym buildzie. Ten test używa `next start`; nie widzi niezbudowanych zmian.
5. Jeśli zmieniano backend/capability kontrakt, uruchomić odpowiednie testy API i zachować osobną bramkę integracji DB. Same mockupy nie dowodzą działania z rzeczywistą bazą.
6. Obejrzeć screenshoty wszystkich stanów z macierzy poniżej, nie tylko landing page.
7. Sprawdzić bundle i brak zewnętrznych requestów po zalogowaniu; używać dynamicznego importu dla opcjonalnych cięższych efektów.
8. Usunąć martwe selektory, powielone stare brand-symbol i nieużywane fonty po przejściu wszystkich stron.
9. Dodać opis nowego wyglądu, nawigacji i uprawnień do instrukcji admina; zaktualizować dziennik rzeczywistymi wynikami.
10. Przekazać listę zmienionych plików, screenshoty i jawny wykaz elementów, które nadal wymagają API albo odbioru z DB.

## 11. Bieżący stan wdrożenia

Wdrożone elementy:

- Tokeny i warstwa czarno-złota są użyte w logowaniu, przestrzeni pracy, korektach, adminie i koncie.
- Oryginalne logo pozostaje niezmienione; fonty są lokalne: Newsreader, Hanken Grotesk i IBM Plex Mono.
- `SpotlightCard`, `CountUp`/`StatValue` i kontrolowany `RunStepper` pochodzą z wybranych adaptacji React Bits, bez opcjonalnego GSAP.
- Interfejs workspace używa capability zwróconych przez `/api/auth/me` osobno dla widoczności, uruchamiania, odczytu wyników i pobierania. UI nie zastępuje autoryzacji API; nie zmieniano kontraktów serwera.
- Admin i konto zachowują dotychczasowe endpointy oraz przepływy CAS/CSRF. Małe ekrany mają zwijane nawigowanie w workspace i przewijane regiony dla szerokich tabel.
- Syntetyczne screenshoty logowania, workspace i admina zapisuje `docs/design/goldis/implemented`.

Zweryfikowano po zmianach:

- `npm run build` — zaliczone.
- `npm run test:w3-sms-ui-smoke -w @goldis/web` — zaliczone (symulowany portal).
- `npm run test:w4-enrichment-ui-smoke -w @goldis/web` — zaliczone (syntetyczne API).
- `npm run test:admin-ui-smoke -w @goldis/web` — zaliczone (syntetyczne API, przepływy CAS/CSRF i szerokości 320–1920 px).
- `npm run test:tool-grants-ui-smoke -w @goldis/web` — zaliczone (brak grantu, wykonanie-only, odczyt-only, fokus drawera, 320–1920 px, brak zewnętrznych żądań).
- Kontrast wybranych tokenów policzony względem używanych teł: tekst/tło 17,27:1, tekst pomocniczy/powierzchnia 7,46:1, złoto/brand-bg 10,66:1, obrys pola/tło pola 4,12:1, ciemny tekst/złoty przycisk 9,59:1. To kontrola par tokenów, nie pełny audyt każdej kombinacji w aplikacji.

Pozostałe bramki przed odbiorem produkcyjnym: testy w realnym API i przeglądarkach poza Chromium, powiększenie 200%, pełny pomiar kontrastu, pomiar bundle/rozmiaru fontów i konwersja WOFF2. Obecne UI smoke celowo używają stubów API i nie stanowią dowodu odbioru PostgreSQL, Redis ani działania automatyzacji portali.

## 9. Macierz odbioru wizualnego i funkcjonalnego

| Widok | Wymagane stany |
| --- | --- |
| Logowanie | Pusty formularz, błędne dane, loading, sukces, wymuszona zmiana hasła |
| Katalog / przestrzeń pracy | Dostępny tool, brak grantu, view-only, konserwacja, offline, brak ostatniego importu |
| Import | Pusty, wybrany plik, długi filename, zły format, walidacja, błąd |
| Korekty | Gotowy, brak REGON, konflikt, oczekujące zatwierdzenie, odrzucona poprawka, CAS 409 |
| Run | Kolejka, aktywny etap, SMS, dane manualne, brak adaptera, błąd, cancelled, completed, brak polis |
| SMS | Aktywny, submitting, accepted, invalid, expired, niepewne przekazanie, retry niedozwolony |
| Wynik | Zapisany, brak artefaktu, bez prawa pobrania, błędne pobranie, historyczny rezultat |
| Granty | Wszystkie kombinacje zgodne z regułami API, odebranie dostępu, CAS 409 |
| Konta / sesje | Aktywna, cofnięta, wygasła, bieżąca, ostatni admin, konto wyłączone |
| Operacje / interwencje | Usługi online/offline, pusty filtr, długie dane, przydział, konflikt rewizji |
| Automatyzacja | Włączona/wyłączona, limit, okno czasu, błąd walidacji, konflikt wersji |
| Audyt | Brak wyników, kolejne strony, długi kod, ograniczony zakres, błąd dostępu |
| Raporty | Pełne dane, zera, brak próby, brak mediany, zmiana dat, mobile wykres |

## 10. Materiały i wynik wdrożenia

Podgląd: `docs/design/goldis/index.html`. Uruchomienie lokalne:

```powershell
node docs/design/goldis/serve.cjs
# http://127.0.0.1:3445
```

Renderowanie PNG, z uruchomionym serwerem:

```powershell
node docs/design/goldis/render.cjs
```

Prototyp HTML renderuje demonstracyjne widoki. Produkcyjne screenshoty są przechwytywane osobno przez smoke UI, który uruchamia zbudowaną aplikację na loopback i podaje jej syntetyczne odpowiedzi API.

Zapisane mockupy:

- `mockups/tools-desktop.png` — katalog i ostatnie zadania.
- `mockups/results-desktop.png` — docelowy układ wyniku.
- `mockups/operations-desktop.png` — centrum operacyjne i interwencje.
- `mockups/access-desktop.png` — osoby i granty.
- `mockups/reports-desktop.png` — raporty jakości.
- `mockups/account-desktop.png` — konto i sesje.
- `mockups/login-desktop.png` — ekran logowania.
- `mockups/tools-mobile.png`, `login-mobile.png`, `access-mobile.png` — wersje 390 px.

Weryfikacja prototypu: 7 widoków desktop, 3 screenshoty mobile, załadowane fonty i brak błędów JavaScript. Wszystkie 7 widoków sprawdzono też przy 320 px bez poziomego overflow dokumentu. Wybrane pary tekstu, przycisku i obrysu pola mają policzony kontrast; wyniki zapisuje `verification.json`. Te wyniki dotyczą makiet; syntetyczne testy aplikacji i ich zakres opisano w sekcji 11.

Zrzuty aplikacji po wdrożeniu, oparte na syntetycznych danych z Playwright:

- `docs/design/goldis/implemented/login-desktop.png` i `login-mobile.png`.
- `docs/design/goldis/implemented/workspace-desktop.png`, `workspace-mobile.png` i `workspace-mobile-menu.png`.
- `docs/design/goldis/implemented/admin-desktop.png` i `admin-mobile.png`.

Źródła komponentów, wykorzystane przy przygotowaniu planu:

- [SpotlightCard — aktualne TS-CSS](https://raw.githubusercontent.com/DavidHDev/react-bits/main/src/ts-default/Components/SpotlightCard/SpotlightCard.tsx).
- [CountUp — aktualne TS-CSS](https://raw.githubusercontent.com/DavidHDev/react-bits/main/src/ts-default/TextAnimations/CountUp/CountUp.tsx).
- [Stepper — aktualne TS-CSS](https://raw.githubusercontent.com/DavidHDev/react-bits/main/src/ts-default/Components/Stepper/Stepper.tsx).
- [AnimatedContent — aktualne TS-CSS](https://raw.githubusercontent.com/DavidHDev/react-bits/main/src/ts-default/Animations/AnimatedContent/AnimatedContent.tsx).
- [Newsreader w Google Fonts](https://github.com/google/fonts/tree/main/ofl/newsreader), [Hanken Grotesk](https://github.com/google/fonts/tree/main/ofl/hankengrotesk), [IBM Plex Mono](https://github.com/google/fonts/tree/main/ofl/ibmplexmono).

Przy wdrażaniu zapisać źródła po konkretnym SHA, ponieważ odwołania `main` mogą się zmienić.
