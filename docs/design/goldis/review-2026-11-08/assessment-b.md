# Assessment B — dowody techniczne i przeglądarkowe

Target: `apps/web/app`. Niezależna analiza B; nie czytano ocen A. Source review + jednorazowy CLI + osobna instancja Chromium/context Playwright. Dane wyłącznie syntetyczne. UI nie zmieniano.

## Wnioski potwierdzone

1. **P1 — Powiadomienia pozostają na „Sprawdzam sesję…” po prawidłowym logowaniu.** Źródło: `apps/web/app/notifications/NotificationWorkspace.tsx:26` inicjuje `authenticated=null`; ścieżka sukcesu w wierszach 52–58 ustawia rolę, CSRF i ładuje informacje, lecz nie wywołuje `setAuthenticated(true)`. Guard w wierszu 89 cały czas zwraca ekran sesji. Browser na synthetic operator potwierdził brak nagłówka/treści, wyłącznie status. Dowód: `b02-notifications-desktop.png`, `.txt`, `browser-b.json` → b02. To błąd działania, a nie ocena estetyczna. Naprawa: domknąć stan powodzenia i pokazać odzyskiwalny błąd przy niepowodzeniu. Sugerowane: impeccable harden.

2. **P1 — Wybór konkretnych firm OC nie daje czytnikowi nazw checkboxów.** `apps/web/app/tools/oc-policy-verification/CompanySelection.tsx:129` generuje sam input wewnątrz `div`, bez `label`, `aria-label` ani `aria-labelledby`; nazwa firmy w sąsiednim `span` nie jest etykietą. Świeży AX `b07-oc-selection-desktop.txt` zawiera trzy pozycje „checkbox” bez nazwy, podczas gdy zbiorczy checkbox ma nazwę. DOM metrics potwierdzają `labels=[]`, `ariaLabel=null`, rozmiar 18×18 px. Użytkownik klawiatury może zaznaczać pola, ale użytkownik czytnika nie ma pewnego powiązania z firmą. Naprawa: przypiąć unikalną nazwę firmy oraz numer wiersza do input, a cały wiersz uczynić obszarem label. Dowody: `b07-oc-selection-desktop.png`, `.txt`, `browser-b.json`. Sugerowane: impeccable harden/audit.

3. **P2 — Skip link nie omija nawigacji.** `apps/web/app/layout.tsx:50–51`: link wskazuje wrapper obejmujący całe `PlatformRouteFrame`, razem z boczną nawigacją. W osobnym browserze wykonano Tab → Enter → Tab na `/my-results`; focus wrócił do linku logo GOLDIS w sidebarze, a nie do treści. Widoczny focus jest dobry, lecz trzeba przejść nawigację ponownie. Naprawa: przenieść cel do właściwego main lub nagłówka strony. Dowody: `b04-skip-focus.png`; `browser-b.json.skipLinkAfterEnterAndTab.focus`. Sugerowane: impeccable harden.

4. **P2 — Mobilny wybór plików w porównywarce wymaga precyzji i poziomego skanowania tabeli.** Przy 390 px checkboxy plików mają rzeczywisty wymiar 13×13 px; input ma aria-label, lecz nie obejmujący go label ani większy klikalny obszar. Tabela ma min-width 760 px, a nazwy plików leżą w części poza początkowym viewportem tabeli. Użytkownik musi osobno przesuwać tabelę i trafiać małe pola przy rozróżnianiu podobnych plików. Źródła: `apps/web/app/tools/commission-comparison/workspace.tsx:197`; `workspace.module.css:26`, `:31`. Naprawa: mobilne wiersze/karty z nazwą i dużym obszarem zaznaczenia, minimum produktowe 44 px. Nie klasyfikuję samego 13 px jako automatycznego naruszenia WCAG 2.5.8: odstępy mogą spełniać wyjątek. Dowody: `b10-commission-mobile.png`, `browser-b.json` → b10 controls. Sugerowane: impeccable adapt.

## Mniejsze obserwacje

- Sekcje porównywarki są buttonami w nav, aktywna sekcja jest zaznaczana wyłącznie klasą CSS. Brak `aria-pressed`, `aria-current` i semantyki tab/tabpanel. Źródło `workspace.tsx:191`; browser-b dictionary controls potwierdzają null role/current/selected. Uzupełnić stan w dostępnej semantyce; nie trzeba koniecznie przebudowywać na pełny widget tabs.
- CSS przycisku mobilnego `.runControls>.lead-primary` w CSS Module wskazuje lokalizowaną klasę, podczas gdy JSX używa globalnej `lead-primary`. Screenshot b10 pokazuje przycisk startu w połowie szerokości zamiast planowanego grid-column 1/-1. To P3 — nie blokuje kliknięcia.
- Drobne teksty tabel są rzędu 10–12 px; to ryzyko wygody odczytu, a nie wykazane naruszenie kontrastu.

## Co działa w sprawdzonej próbce

- LeadSidebar: nazwy ikon, aria-current, klikalne obszary menu 44 px; mobilny drawer przenosi focus, Escape zamyka i przywraca focus na przycisk 44×44 z widocznym złotym obrysem. Dowody `b09-mobile-drawer-focus.png`, browser-b mobileDrawerAfterEscape.
- `/my-results` zamienia szeroką tabelę w mobilne karty. W badanej próbce 390 px document scrollWidth = 390 px, bez poziomego przepełnienia całej strony. Tak samo `/tools/commission-comparison` ma document scrollWidth 390 px; wewnętrzna tabela nadal przewija się poziomo.
- Formularze listy firm mają etykiety; status odczytu i błędy są semantyczne (`role=status`, `role=alert`, `aria-live`). Zmiany kroków OC kierują focus na nagłówek.
- Próbka kolorów nie uzasadnia zarzutu słabego kontrastu: `#aaa69c` na `#111116` ≈7.75:1, `#85818a` na `#111116` ≈4.93:1, złoto `#d9b65f` na `#111116` ≈9.69:1; granica `#6d6a72` na `#0d0d12` ≈3.65:1. To obliczenia wybranych par ze źródła i odpowiadających im computed styles, nie pełna certyfikacja wszystkich stanów.

## Detektor

Jedyny przebieg: `impeccable.cmd detect --json apps/web/app`, exit 2. 53 pliki markup w wejściowym drzewie, więc nie trzeba było zawężać. Wynik w `detector.json`: **16 dopasowań, 2 nazwy reguł zgłoszeń**, wszystkie warning/slop. Liczba wszystkich reguł silnika nie jest publikowana w tym JSON; nie należy podawać „sprawdzono tylko 2 reguły”.

- `side-tab` / Side-tab accent border — **15**: `admin.css:10`; `auth-recovery.css:25`; `globals.css:1,6,8,9`; `history.css:53`; `import-preparations.css:24,27`; `leads/leads.css:37`; `styles/theme.css:93,140,156,276,336`.
- `border-accent-on-rounded` / Border accent on rounded element — **1**: `globals.css:7`.

Odrzucam interpretację tych dopasowań jako automatycznie potwierdzonych problemów UX. Obwódka aktywnej nawigacji (`leads.css:37`) wzmacnia orientację, a obwódki błędów, statusów i komunikatów mają funkcję informacyjną. `globals.css` i `theme.css` obejmują nakładające się warstwy legacy/theme: liczba deklaracji CSS nie jest liczbą unikalnych widocznych elementów. Detektor prawidłowo odnajduje składnię, ale nie dowodzi jej szkodliwości; żadnego z głównych problemów dostępności powyżej nie zgłosił. Nie zalecam usuwać złotych/ostrzegawczych krawędzi wyłącznie dla wyzerowania skanu.

## Metoda, ograniczenia i cleanup

- Target viewable. Native CUA w B zwrócił `browsers=[]`; `getBrowser` dla iab/2 i createBrowserTab iab zwróciły „Browser is not available”. Rodzic i A mieli IAB, lecz Windows loopback kończył się timeoutem/error page. Native UI nie posłużył jako dowód strony.
- Po instrukcji rodzica i odczycie `webapp-testing/SKILL.md` użyto lokalnego Playwright (brak MCP Playwright). Osobny browser i context B; żadnego odczytu wniosków A. Faktyczny Next render build z 6 listopada; A sprawdził brak nowszych źródeł app. Fresh screenshots z 8 listopada, nie stare materiały z października.
- Jedyny współdzielony serwer fixture+Next należał do A; B nie startował drugiego Next/build. B uzupełnił wyłącznie kontrakt syntetycznego `/api/leads` o wymagane obecnie summary oraz sesję o syntetyczny tenantId. Bez tego październikowy fixture dałby fałszywy błąd aplikacji. Brak prawdziwych kont, portali lub danych klienta.
- `capture-b.cjs` zapisał 7 głównych próbek i 3 dodatkowe screenshoty interakcji: b01–b10. Po nich opcjonalny dashboard-error nie osiągnął networkidle w 8 s; nie powtarzano próbki, nie przedstawiam jej jako badanego error state. `browser-b.json` ma 0 pageerror z wcześniej ukończonych próbek.
- Browser zamknięty w finally, co zamknęło też context. Nie ma pozostałego browsera B. Wspólny Next/proxy cleanup wykonuje A.
- Nakładka nie jest widoczna dla użytkownika. Native evaluate jest tylko do odczytu, więc nie wykonywano nieudokumentowanej mutacji. Playwright fallback doszedł do screenshotów, lecz nie do zaplanowanego mutable preflight (ostatni opcjonalny case timeoutował). Dodatkowo realne próby `live-server --background` w sandboxie i elevated nie uruchomiły serwera: brak JSON/health w pierwszej i „Timed out waiting for live server to start” w drugiej. `live-server stop --keep-inject` zwrócił „No running live server found”. Nie wstrzykiwano detect.js; brak console findings z nakładki, brak twierdzenia o widocznym [Human]. Nie zmieniano CSP.
- Pliki `capture-b.cjs`, JSON i PNG/TXT są celowymi dowodami archiwalnymi. Brak osobnych tymczasowych plików B do usunięcia.
