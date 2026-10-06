# Instrukcja administratora platformy Goldis

## Cel i granice

Panel administracyjny obsługuje konta, uprawnienia do narzędzi i ich wyników, sesje, kolejkę zadań, interwencje, ustawienia nowych uruchomień, audyt i raporty. Dostęp jest przyznawany do narzędzia oraz oddzielnie do uruchamiania, odczytu wyników i pobierania plików. Widoczność kafla nie daje automatycznie prawa do danych.

Panel nie zarządza fizycznymi urządzeniami. Etykieta sesji to przybliżony typ przeglądarki i systemu wyliczony z User-Agent; nie jest identyfikatorem sprzętu. Panel nie udostępnia haseł do portali, sekretów, selektorów przeglądarki ani zdalnego sterowania workerem.

Adres panelu lokalnego to `http://localhost:3000`; API lokalne działa pod `http://127.0.0.1:3001/api`. Do produkcji wymagany jest HTTPS i poprawny `PUBLIC_APP_ORIGIN`.

## Interfejs i nawigacja

Interfejs wykorzystuje oryginalne logo Goldis, ciemne powierzchnie z ciepłym złotem dla głównych akcji oraz lokalne fonty Newsreader, Hanken Grotesk i IBM Plex Mono. Na wąskim ekranie nawigacja workspace otwiera dostępny z klawiatury drawer. Szerokie tabele mają własny obszar przewijania i krótką wskazówkę na małym ekranie.

Widoczność narzędzia, uruchamianie, odczyt wyników i pobranie pliku są w UI rozdzielone zgodnie z grantem otrzymanym przez sesję. Te stany mają ułatwiać obsługę; API ponownie autoryzuje każde żądanie i jest jedynym zabezpieczeniem danych. Przepływy z syntetycznym API można sprawdzić poleceniami `npm run test:tool-grants-ui-smoke -w @goldis/web` i `npm run test:admin-ui-smoke -w @goldis/web`.

## Role i zakres danych

| Rola | Dane i działania |
| --- | --- |
| Administrator | Pełny dostęp do narzędzi, wyników i plików w organizacji Goldis; zarządzanie kontami, grantami, sesjami, interwencjami, ustawieniami, operacjami, audytem i raportami. Nie przekracza granicy tenanta. |
| Operator | Własne importy i zadania w narzędziach, do których otrzymał grant. Zależnie od grantu może zobaczyć narzędzie, uruchamiać zadania, czytać wyniki i pobierać pliki. Nie zatwierdza korekt ani konfliktów. |
| Recenzent | Odczyt wyników w organizacji i zatwierdzanie korekt lub konfliktów w narzędziach z odpowiednim grantem. Nie uruchamia automatyzacji i nie pobiera plików. |
| Audytor | Odczyt dziennika audytu organizacji. Bez dostępu do operacyjnych wyników, narzędzi i plików. |

Grant do narzędzia ma cztery niezależne flagi:

- **Widoczność** — narzędzie pojawia się w katalogu.
- **Uruchamianie** — można tworzyć zadania i wykonywać dozwolone czynności operacyjne, w tym wysłać ręcznie wprowadzony kod SMS w aktywnym zgłoszeniu.
- **Odczyt wyników** — można otwierać importy i wyniki, w granicach roli oraz właściciela zasobu.
- **Pobieranie plików** — osobne prawo do pobrania gotowego artefaktu; wymaga też dostępu do wyniku.

Reguły implikacji są egzekwowane przez bazę i API: uruchamianie wymaga widoczności, a pobieranie wymaga odczytu wyników. Administrator ma dostęp do każdego narzędzia w tenancie; ustawienie narzędzia w konserwacji blokuje nowe uruchomienia również administratorowi. Operator bez grantu nie uzyskuje dostępu przez wpisanie znanego adresu URL.

## Konta i sesje

Utwórz konto w sekcji **Konta i bezpieczeństwo**. Login jest unikatowy bez względu na wielkość liter. Hasło tymczasowe musi mieć co najmniej 14 znaków. Po pierwszym logowaniu użytkownik musi zmienić hasło; platforma go nie wysyła, więc przekaż je bezpiecznym kanałem.

Nowe konto nie ma grantów do narzędzi. Nadaj rolę i granty osobno, zgodnie z obowiązkami użytkownika. Po zmianie roli platforma cofa wszystkie jego sesje; przy zmianie roli na inną niż administrator zdejmuje też otwarte przydziały. Odebranie odczytu lub wykonania z grantu zdejmuje tylko te przydziały, których uprawnienia zostały odebrane. Wyłączenie konta również cofa sesje i usuwa przydziały z otwartych interwencji. Ponowne włączenie konta nie przywraca cofniętych sesji ani zdjętych przydziałów.

Hasło można zresetować z ekranu zarządzania kontem. Wprowadzone hasło nie jest później wyświetlane; następne logowanie wymaga jego zmiany. Użytkownik może obejrzeć własne sesje pod `/account` i cofnąć pojedynczą sesję. Administrator widzi sesje użytkowników i może cofnąć jedną lub wszystkie. Cofnięcie bieżącej sesji wyloguje administratora po następnym żądaniu.

Sesja wygasa po 8 godzinach bezwzględnie. API sprawdza aktywność sesji serwerowej przy każdym żądaniu. Hasło, zmiana roli, wyłączenie konta lub cofnięcie sesji unieważniają poprzednie cookies. Po przejściu na sesje v2 dotychczasowi użytkownicy muszą zalogować się ponownie.

Organizacja musi zachować co najmniej jednego aktywnego administratora. API blokuje wyłączenie lub degradację ostatniego aktywnego admina, także przy konkurencyjnych żądaniach. Zalecane są dwa niezależne konta administracyjne. Jeśli utracono dostęp do wszystkich adminów, sam panel nie ma trybu samodzielnego odzyskania; należy użyć zatwierdzonej procedury operatora bazy i potwierdzić zmianę w audycie.

## Centrum operacyjne i interwencje

**Centrum operacyjne** pokazuje dostępność API, bazy i Redis, stan workera oraz portali, oczekujące dyspozycje, statusy zadań i otwarte interwencje. Lista zadań zwraca do 50 wierszy na stronę, ma nawigację poprzednia/następna i osobne filtry narzędzia oraz statusu. Filtry zadań nie zmieniają ustawień automatyzacji ani raportów. Widok nie pokazuje payloadu kolejki ani sekretów. Worker jest uznany za aktywny na podstawie istniejącego heartbeat i reguły świeżości; brak świeżego heartbeat trzeba traktować jako stan offline.

Kolejka interwencji filtruje po statusie, narzędziu, osobie i priorytecie; na stronę pokazuje do 50 rekordów. Odbiorcę można wyszukać po loginie i doczytać kolejne wyniki, więc lista nie kończy się na pierwszej setce kont. Administrator może przypisać otwarte zgłoszenie aktywnemu użytkownikowi mającemu dostęp do danego narzędzia, ustawić termin i zmienić priorytet `normal/high`. Termin w formularzu jest czasem `Europe/Warsaw`; pozostawienie go bez edycji zachowuje dokładny zapis UTC. Przy wiosennej zmianie czasu nieistniejąca godzina jest odrzucana, a przy jesiennej trzeba wybrać jeden z dwóch offsetów. Zapis zawiera oczekiwaną rewizję; odpowiedź `409` oznacza, że zgłoszenie zmieniło się w innej sesji — edycja pozostaje na ekranie, odśwież listę i świadomie ponów zmianę. Sam odczyt ani przydział nie rozwiązuje zgłoszenia.

Historia interwencji zawiera rodzaj zmiany, autora i czas. W zgłoszeniu nie zapisuje się swobodnych notatek, kodu SMS ani danych biznesowych. Ponowny timeout SMS pozostaje częścią dotychczasowego przepływu challenge i jego limitu prób.

## Ustawienia automatyzacji

Ustawienia są przypisane do narzędzia i mają wersję. Zmiana z nieaktualną wersją zwraca `409`; odśwież dane i sprawdź bieżącą wartość przed ponowieniem.

- **Przyjmuj nowe zadania** blokuje tworzenie nowych runów, ale nie anuluje ani nie zatrzymuje zadań już przyjętych.
- **Limit startów na godzinę** ogranicza liczbę zadań utworzonych w poprzednich 60 minutach dla organizacji i narzędzia. Przekroczenie zwraca `429`.
- **Okno pracy** wymaga podania obu godzin albo wyczyszczenia obu. Godziny są interpretowane w wybranej strefie czasowej; okno może przechodzić przez północ.

Ustawienia nie włączają portali live. `WORKER_LIVE_PORTALS=0` pozostaje domyślną bezpieczną konfiguracją; odbiór PZU/Compensy ma osobne bramki.

## Audyt i raporty

Audyt jest dostępny administratorowi, audytorowi i ograniczonemu reviewerowi na stronie `/audit` oraz przez `GET /api/audit/events`. Zakres jednego zapytania nie przekracza 90 dni; strona ma maksymalnie 100 rekordów i używa kursora. Filtry obejmują czas, aktora, akcję, typ i identyfikator zasobu, wynik oraz narzędzie. Reviewer widzi wyłącznie operacyjne zdarzenia powiązane z narzędziami, do których ma aktualny grant odczytu wyników lub pobierania; filtr kont, sesji i ustawień jest odrzucany. Auditor czyta dziennik tenanta, ale nie dane operacyjne i nie potrzebuje `/admin`. Historia nie udostępnia swobodnego payloadu ani tajnych danych.

Raporty są dostępne administratorowi. Zakres może obejmować do 366 dni, a odpowiedź zwraca definicje wskaźników. „Brak polis” jest osobną kategorią od błędu; procent ukończeń nie liczy zadań trwających. Liczba pobrań pochodzi ze zdarzeń audytu, a wygenerowane pliki z rekordów gotowych artefaktów. Bieżące otwarte interwencje i mediana czasu rozwiązania są liczone według opisanych w raporcie zakresów czasu.

## Interfejs API administratora

Panel korzysta z poniższych ścieżek. Wszystkie operacje zmieniające dane wymagają poprawnego Origin i CSRF; sprawdzanie uprawnień odbywa się w API, a nie tylko w interfejsie.

| Obszar | Ścieżki |
| --- | --- |
| Użytkownicy i granty | `GET /api/admin/users?limit&cursor&q` (kursor jest związany z filtrem `q`), `POST /api/admin/users`, `GET /api/admin/users/:id/grants`, `PUT /api/admin/users/:id/grants/:toolId`, `POST /api/admin/users/:id/grants/:toolId/revoke` |
| Konta i sesje | `PATCH /api/admin/users/:id/role`, `POST /api/admin/users/:id/disable`, `POST /api/admin/users/:id/enable`, `POST /api/admin/users/:id/password`, `GET /api/admin/users/:id/sessions`, `POST /api/admin/users/:id/revoke-sessions`, `POST /api/admin/users/:id/sessions/:sessionId/revoke` |
| Własne konto | `POST /api/auth/change-password`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:sessionId` |
| Narzędzia i operacje | `GET /api/tools`, `GET /api/admin/tools`, `GET /api/admin/operations/summary`, `GET /api/admin/operations/runs?page&toolId&status` (50 rekordów i `hasMore`) |
| Interwencje | `GET /api/admin/interventions?page&status&assigneeUserId&toolId&priority` (50 rekordów i `hasMore`), `PATCH /api/admin/interventions/:id/assignment`, `PATCH /api/admin/interventions/:id/priority`, `GET /api/admin/interventions/:id/activity` |
| Ustawienia | `GET/PATCH /api/admin/tools/:toolId/settings` |
| Audyt i raporty | `GET /api/audit/events`, `GET /api/admin/reports/overview`, `/failures`, `/interventions`, `/throughput` |

## Stan odbioru

Kod, buildy, testy automatyczne API/UI i smoke panelu są gotowe w repozytorium. Smoke migracyjny PostgreSQL nie został odebrany: `npm run test:db-integration` wymaga `GOLDIS_TEST_DATABASE_ADMIN_URL`, którego bieżące środowisko nie udostępnia. Nie odczytuj produkcyjnego `.env`, aby uzupełnić ten test. Smoke Redis wymaga osobnego izolowanego Redis URL. Nie oznaczaj odbioru migracji 001–023 ani E0–E6 jako zakończonego, dopóki testy PostgreSQL i Redis, aktualizacja kopii bazy oraz scenariusze API nie przejdą na dedykowanym środowisku testowym.
