# Plan implementacji poprawek UI/UX strony wejściowej

Data: 2026-10-12  
Zakres: ekran logowania (`/`) i pulpit po zalogowaniu (`/dashboard`). Repozytorium nie zawiera osobnego publicznego landing page.  
Podstawa: audyt zapisany w `.impeccable/critique/2026-10-12T09-23-14Z__apps-web-app-workspace-tsx.md`.

## Cel i kolejność

Najpierw usunąć błędne lub mylące stany pulpitu (P1), następnie skrócić i uporządkować drogę użytkownika na pulpicie oraz poprawić logowanie na telefonie (P2). Zakres nie wymaga nowego endpointu ani publicznego procesu resetu hasła.

| Etap | Priorytet | Wynik |
| --- | --- | --- |
| 1. Dane i uprawnienia | P1 | CTA, metryki i listy mają jawne stany ładowania, sukcesu i błędu. |
| 2. Nazwa akcji i gotowość | P1 | Użytkownik wie, że otwiera import, i widzi, czy automatyzacja jest gotowa do uruchomienia. |
| 3. Architektura pulpitu | P2 | Jedna główna akcja, krótsze skróty, logiczna kolejność na mobile. |
| 4. Logowanie | P2 | Mniej pustej przestrzeni na telefonie oraz realna wskazówka po błędzie logowania. |
| 5. Odbiór | P1/P2 | Sprawdzone warianty uprawnień, błędów sieci i szerokości ekranu. |

## 1. Uporządkować stany pobierania pulpitu

**Plik:** `apps/web/app/dashboard/DashboardWorkspace.tsx`.

1. Zastąpić zależne od siebie `data`, `loading` i `error` jednym jawnym stanem widoku: `loading`, `ready(data)`, `error`. Zachować dotychczasową obsługę braku sesji i przekierowanie do logowania.
2. Wyliczać główną akcję dopiero dla `ready(data)` na podstawie `tools` zwróconych przez `/api/dashboard`:
   - `canExecute`: `/tools/oc-policy-verification`, etykieta **„Przygotuj import OC”**;
   - tylko `canViewResults`: `/results/oc-policy-verification`, etykieta **„Zobacz wyniki OC”**;
   - brak obu uprawnień: bez linku do OC; wyświetlić informację o braku dostępu i pozostałe dostępne akcje.
3. W czasie ładowania pokazać nieklikalny placeholder głównej akcji i metryk. Nie zgadywać adresu linku z `undefined`.
4. Po błędzie `/api/dashboard` pokazać komunikat i przycisk **„Spróbuj ponownie”**. Nie pokazywać zerowych metryk ani komunikatów o pustych listach, bo brak danych nie oznacza braku aktywności.
5. Oznaczyć ładowanie przez `role="status"`, a błąd przez `role="alert"`. Przy ponowieniu pobierania zabezpieczyć stan przed odpowiedzią ze starego żądania, np. przez `AbortController`.

**Warunek odbioru:** przy opóźnionej odpowiedzi nie da się kliknąć błędnego CTA; przy błędzie widać ponowienie, lecz nie widać fikcyjnych zer; trzy warianty uprawnień prowadzą tylko do dozwolonych miejsc.

## 2. Nazwać rzeczywistą czynność i pokazać gotowość automatyzacji

**Pliki:** `apps/web/app/dashboard/DashboardWorkspace.tsx`; ewentualnie współdzielony hook/typ wydzielony z `apps/web/app/workspace.tsx`.

1. Zmienić etykietę głównej akcji wykonawcy z **„Uruchom automatyzację”** na **„Przygotuj import OC”**. Link otwiera narzędzie i etap przygotowania pliku, a nie rozpoczyna wykonania.
2. Przy głównej akcji pokazać zwięzły status z istniejącego `/api/health/automation`: „Automatyzacja gotowa”, „Automatyzacja niedostępna” z krótkim powodem albo „Nie można sprawdzić statusu”. Dla użytkownika bez prawa wykonania status worker nie musi zajmować głównego miejsca.
3. Wykorzystać istniejące odpytywanie statusu w `workspace.tsx` lub wydzielić je do jednego hooka. Zachować odświeżanie tylko wtedy, gdy karta jest widoczna i przeglądarka jest online.
4. Czytać treść odpowiedzi także przy HTTP 503: endpoint zwraca wtedy prawidłowy opis stanu `waiting`. Błąd sieci traktować jako stan nieznany, a nie jako potwierdzone `offline`.
5. Pozostawić możliwość wejścia do importu przy niedostępnym workerze dla uprawnionego użytkownika. Przycisk, który faktycznie rozpoczyna wykonanie w narzędziu, nadal musi respektować istniejące ograniczenie gotowości.

**Warunek odbioru:** użytkownik rozumie, że CTA otwiera przygotowanie importu; stany `ready`, `waiting` (w tym 503) i błąd sieci mają różne, prawdziwe komunikaty; żadna etykieta na pulpicie nie obiecuje natychmiastowego startu.

## 3. Usunąć powtórzenia i skrócić pulpit

**Pliki:** `apps/web/app/dashboard/DashboardWorkspace.tsx`, `apps/web/app/leads/platform-pages.css`.

1. Usunąć pierwszy skrót prowadzący pod ten sam adres co główne CTA. Deduplikować listę skrótów po docelowym adresie także dla użytkownika, który może tylko oglądać wyniki.
2. Zostawić wyłącznie skróty, które dana rola może otworzyć. Dla braku uprawnień do OC nie pokazywać linku do importu ani wyników OC.
3. Uporządkować kolejność w DOM i na ekranie telefonu: główna akcja i status → metryki → „Do zrobienia” → ostatnie uruchomienia → pozostałe skróty. CSS nie powinien zmieniać kolejności czytania względem kolejności wizualnej.
4. Na desktopie wyrównać kolumny i ograniczyć puste powierzchnie; na mobile zamienić wysokie karty skrótów na zwarte wiersze z wyraźnym obszarem kliknięcia. Nie zmniejszać obszaru interakcji poniżej 44 × 44 px.

**Warunek odbioru:** na każdej roli główna akcja jest pojedyncza, skróty nie powtarzają jej adresu, a na ekranie 375 px użytkownik widzi priorytetowe informacje bez przewijania przez serię dużych kart.

## 4. Poprawić ekran logowania na telefonie i drogę odzyskania dostępu

**Pliki:** `apps/web/app/workspace.tsx`, `apps/web/app/styles/theme.css`.

1. Przed zmianą CSS obejrzeć aktualny ekran na szerokościach 320, 375/390 i 680 px. Zrzut z audytu wskazuje dużą pustą przestrzeń, lecz pomiar aktualnego widoku rozstrzygnie proporcje logo i odstępy.
2. Zmniejszyć rezerwowaną na mobile wysokość logo (`.goldis-logo--login` ma teraz 204 px) i odstępy `.login-intro` oraz `.login-card`. Zachować czytelny znak, nagłówek i wygodne pola; po zmianie sprawdzić również desktop.
3. Pod błędem logowania dodać stałą wskazówkę: **„Nie pamiętasz hasła? Skontaktuj się z menedżerem lub administratorem organizacji.”** Nie dodawać martwego linku „Resetuj hasło”: aktualnie reset wykonuje menedżer w panelu zespołu.
4. Zachować ogólny komunikat błędnych danych, obecne przekierowania zależne od roli oraz wymuszoną zmianę hasła po resecie. Początkowe ładowanie ekranu oznaczyć przez `role="status"`.

**Warunek odbioru:** na telefonie znak nie wypycha formularza niepotrzebnie w dół; przy błędzie wiadomo, jak odzyskać dostęp; poprawne logowanie, role i wymuszona zmiana hasła działają jak dotąd.

## 5. Odbiór zmian

Przed rozpoczęciem edycji kodu przeczytać odpowiedni przewodnik w `apps/web/node_modules/next/dist/docs`, zgodnie z `apps/web/AGENTS.md`.

| Scenariusz | Oczekiwany wynik |
| --- | --- |
| Wolna odpowiedź `/api/dashboard` | Brak klikalnego, zgadywanego CTA i brak zerowych metryk. |
| Błąd `/api/dashboard` i ponowienie | Widoczny błąd, działający retry, brak fałszywych pustych stanów. |
| Prawo wykonania / tylko wyniki / brak dostępu | Odpowiednio import / wyniki / brak akcji OC; bez duplikatów. |
| Status automatyzacji: 200 ready / 503 waiting / błąd sieci | Trzy zgodne ze stanem komunikaty; brak fałszywej informacji „gotowa”. |
| Błędne hasło / reset przez menedżera / poprawne logowanie | Wskazówka odzyskania dostępu, zachowane przekierowania i wymuszona zmiana hasła. |
| 320, 375/390, 768, 1440 px; klawiatura mobilna; powiększenie 200% | Brak poziomego przewijania i zasłoniętych pól; czytelny fokus; wygodne cele dotykowe. |

Wystarczą ukierunkowane sprawdzenia stanów i ról oraz oględziny układu w przeglądarce. Przed zmianą CSS porównać aktualny widok z zapisanym zrzutem; po zmianach sprawdzić zrzuty desktop i mobile.

## Granice zakresu

- Nie tworzyć publicznego odzyskiwania hasła bez osobnego procesu produktowego i backendu; wskazówka odsyła do istniejącej osoby uprawnionej do resetu.
- Nie zmieniać kontraktu `/api/dashboard` ani `/api/health/automation`, o ile podczas implementacji nie wyjdzie rzeczywista luka w danych.
- Nie zmieniać reguł uprawnień ani działania narzędzia OC; ten plan poprawia prezentację i drogę do istniejących funkcji.
