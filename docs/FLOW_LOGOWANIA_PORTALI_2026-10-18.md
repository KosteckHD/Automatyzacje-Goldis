# Logowanie Everest i Compensa — flow zaakceptowany przez operatora

Data: 18 października 2026. Operator zaakceptował flow. Pierwszy run 18031 używał zbyt ogólnego detektora. Po poprawce i odrębnej próbie 18001 bezpośredni odczyt otwartej strony potwierdził rzeczywisty formularz SMS PZU; szczegóły zawiera sekcja 13 planu. Nie podano kodu i nie potwierdzono jeszcze dalszych etapów w głównej instalacji.

Operator potwierdził numer rejestracyjny używany przy rozpoczęciu Komunikacji, wskazał wiersz `18031` importu `45784330-03e0-4b03-af99-bcbc393b6c77` i zaakceptował flow. Obecnie nie ma dostępu do kodu SMS Everest; zachowano ograniczenie bez podawania i ponawiania kodu.

## Aktualny stan aktywacji

- Worker `goldis-local` ma konfigurację live. Health: `servicesReady=true`, `worker=online`, `portalMode=live`, `portalConfig=valid`, `automationReady=true`.
- Kolejka `oc-verification` jest **wznowiona**. Nowe uruchomienia narzędzia są włączone bez limitu godzinowego (`maxNewRunsPerHour=null`, wersja ustawień `4`); tymczasowy limit usunięto na polecenie operatora. Worker wykonuje zadania sekwencyjnie.
- Wiersz `18031` uruchomiono jednokrotnie z formularza panelu. Run `42eda996-cf3c-4031-8c0d-056f611924e5` był `waiting_for_sms`, a następnie przeszedł w `waiting_for_manual_data` z `SMS_DELIVERY_UNCERTAIN`. Challenge unieważniono bez prób przesłania kodu (`attempt_count=0`). Nie zażądano ponownego wysłania.
- Aktualnie zamontowana konfiguracja poprawiająca detekcję SMS ma SHA-256 `90c4e051a71b7ce6548331a6d1088bb67e3acdadb1849c18388455c89528efcd`; zachowuje numer potwierdzony przez operatora. Poprawiony worker został odtworzony i jest zdrowy, a kolejka wznowiona. Szczegóły wdrożenia opisuje sekcja 11 planu. Konfiguracja kontenerowa jest montowana tylko do odczytu jako `/run/config/portal-selectors.json`.
- Gotowość health oznacza przygotowanie infrastruktury i konfiguracji. Nie potwierdza sesji na portalu ani dopasowania selektorów do dzisiejszej strony.
- Worker korzysta z Chromium `153.0.8010.12` w Dockerze, w trybie bez widocznego okna, z trwałym profilem `/home/pwuser/goldis-profile` w wolumenie `goldis-local_worker_profile`. To osobny profil od przeglądarki użytkownika na Windows.
- Odczyt istniejącej strony potwierdził widoczny formularz pod `/internalauth/authenticate/sms`, pole kodu, przycisk oraz niezaznaczony checkbox zapamiętania urządzenia. Diagnostyka nie ponawiała logowania ani SMS. Zaufanie tego profilu po poprawnym MFA i ponownym uruchomieniu nie zostało jeszcze sprawdzone.

## 1. Wspólny mechanizm logowania

1. Worker używa własnego trwałego profilu Chromium w Dockerze. Najpierw rozpoznaje aktualną stronę i istniejącą sesję; dla nowej pustej karty otwiera adres portalu.
2. Sprawdza dozwoloną domenę, komunikat odmowy dostępu, skonfigurowany komunikat informacyjny i ewentualne przekierowanie SSO. Następnie rozpoznaje ekran MFA, formularz logowania lub znacznik zalogowania.
3. Jeśli sesja jest już aktywna, przechodzi dalej bez wpisywania hasła. Jeśli widzi formularz logowania, bierze poświadczenia z odpowiednich sekretów PZU lub Compensy.
4. Każde pole loginu i hasła oraz przycisk zatwierdzenia musi mieć dokładnie jedno widoczne i aktywne dopasowanie. Wpisuje login i hasło, a następnie jeden raz klika przycisk logowania w danym cyklu uwierzytelniania.
5. Oczekuje na zmianę stanu, domyślnie do 10 sekund. Niejednoznaczne selektory, nierozpoznany ekran, błąd nawigacji lub odmowa dostępu przekazują sprawę do obsługi zamiast zgadywania elementu.
6. Jeśli rozpozna MFA, tworzy interwencję powiązaną z runem, portalem i sesją przeglądarki. Nie pobiera kodu automatycznie. W zwykłym trybie kod jest dostarczany przez operatora przez platformę. Portal może wysłać SMS już w reakcji na kliknięcie przycisku logowania.
7. Po poprawnym uwierzytelnieniu zwykły przebieg kontynuuje kolejne kroki automatyzacji. Profil zachowuje sesję w granicach zasad portalu; kolejny przebieg może ponownie wymagać MFA.

## 2. PZU / Everest

Adres wejścia: `https://everest.pzu.pl/pc/PolicyCenter.do`.

Dozwolone domeny dla głównej strony: `https://everest.pzu.pl`, `https://zaloguj.pzu.pl`, `https://strefa.agentpzu.pl`.

| Rozpoznanie lub czynność | Dokładny selektor |
| --- | --- |
| Formularz logowania | `#credentials_table:has(input[name="username"]):has(input[name="password"])` |
| Login | `input[name="username"]` |
| Hasło | `input[name="password"]` |
| Wysłanie formularza | `#credentials_table input[type="submit"]` |
| Strona pośrednia po SSO | `a.shortcut:has-text("Everest")` |
| Znacznik aktywnej sesji | `input[placeholder^="PESEL/REGON"], input[name$="-smartsearch"]` |
| Wykrycie MFA i ramka kodu | `iframe#secfense_iframe` |
| Odmowa dostępu | `text="Access denied"` |

Po wykryciu strony pośredniej SSO worker ponownie otwiera adres wejścia Everest. **Nie klika skrótu Everest** — skrót służy do rozpoznania strony pośredniej.

Pierwotny kod traktował samą obecność jednej widocznej ramki jako oczekiwanie na SMS. Poprawiony detektor dodatkowo wymaga widocznego i jednoznacznego pola kodu oraz przycisku zatwierdzenia wewnątrz ramki. Dla głównej konfiguracji PZU dodano `smsFramePath=/internalauth/authenticate/sms`, sprawdzane względem faktycznej ścieżki dokumentu ramki. Pusta, niejednoznaczna, ładująca się ramka lub inna metoda uwierzytelniania nie daje potwierdzenia SMS i pozostaje nierozpoznanym ekranem.

### Obsługa SMS Everest — dopiero po dostarczeniu kodu

Poniższe selektory są wyszukiwane **wewnątrz** `iframe#secfense_iframe`:

| Czynność | Dokładny selektor |
| --- | --- |
| Pole kodu | `input#code[name="code"][type="text"]` |
| Zatwierdzenie kodu | `form:has(input#code) .buttons > button.btn.btn-primary` |
| Zapamiętanie urządzenia | `input#fprint_state[name="fprint_state"][type="checkbox"]` |
| Ponowne wysłanie kodu | `form:has(input#code) .buttons > a#resend` |
| Rozpoznanie wygaśnięcia kodu | `.errors_wrapper > span.errors:text-matches("expired", "i")` |

- Checkbox zapamiętania urządzenia, jeśli jest widoczny, jest zaznaczany dopiero przy przesyłaniu kodu dostarczonego przez operatora.
- Przycisk ponownego wysłania kodu służy jawnemu wznowieniu przez operatora; samo oczekiwanie na SMS nie klika go automatycznie.
- Challenge Everest ma w kodzie czas ważności pięć minut. Bez uwierzytelnienia po tym czasie przebieg przechodzi w obsługę przerwania wymagającą operatora.
- W tej konfiguracji nie ma osobnego selektora komunikatu błędnego kodu PZU (`smsCodeRejected`); utrzymanie formularza po zatwierdzeniu samo w sobie nie jest dowodem odrzucenia. Rozpoznawanie wygaśnięcia obejmuje komunikat zawierający angielskie `expired`.
- W uzgodnionej próbie nie będzie wpisywania kodu ani żądania jego ponownego wysłania.

### Co następuje po zalogowaniu

W zwykłym przebiegu worker wpisuje REGON wybranej sprawy w pole wyszukiwania i naciska Enter. Odczytuje świeże wyniki i weryfikuje tożsamość; następnie może przejść do Compensy.

| Element wyszukiwania | Selektor |
| --- | --- |
| Wyszukiwarka | `input[placeholder^="PESEL/REGON"], input[name$="-smartsearch"]` |
| Wiersze wyników | `table.gw-ListViewWidget--table tr:has(td.gw-CellWidget)` |
| Brak wyników | `text=/^Brak wyników wyszukiwania(?:\s*:|$)/` |
| Typ konta | `td[id$="-AccountType_Cell"]` |
| Nazwa / imię i nazwisko | `td[id$="-Name_Cell"]` |
| Identyfikator | `td[id$="-peselOrRegon_Cell"]` |

Aktualny kod i uruchomiony obraz zawierają również tryb `WORKER_PZU_LOGIN_TEST_RUN_ID`, przypisany do konkretnego runu. Ten tryb po potwierdzeniu zalogowania zapisuje pauzę **przed wyszukaniem REGON i przed Compensą**. Nie jest obecnie włączony ani przekazywany przez bieżący plik Compose. Wcześniejsze stwierdzenie, że w kodzie nie istnieje taki mechanizm, było nieprawidłowe. Samo wykrycie jego obecności nie oznacza wykonania testu.

## 3. Compensa

Adres wejścia: `https://cportal.compensa.pl/Portal`.

Dozwolona domena: `https://cportal.compensa.pl`.

| Rozpoznanie lub czynność | Dokładny selektor |
| --- | --- |
| Formularz logowania / login | `input#login` |
| Hasło | `input#password` |
| Wysłanie formularza | `button#submitLogin` |
| Znacznik aktywnej sesji | `a.tg-btnLogout:visible` |
| Wykrycie MFA / pole kodu | `input[autocomplete="one-time-code"]` |
| Zatwierdzenie kodu | `button:has-text("Potwierdź"):visible` |
| Odmowa dostępu | `text="Brak dostępu"` |

Link wylogowania jest wyłącznie znacznikiem rozpoznawania sesji — worker go nie klika.

Jeśli widoczny jest skonfigurowany komunikat o przerwie technicznej, worker może zamknąć dokładnie ten komunikat:

```text
Kontener:
ux-dialog.tm-modal-news:has(ux-dialog-header p:text-is("Przerwa techniczna")):has(ux-dialog-body:has-text("będzie niedostępna"))

Przycisk wewnątrz tego kontenera:
button:has-text("Zamknij")
```

Inny tytuł lub treść komunikatu nie pasuje do tej reguły. Brak dopasowania nie daje zgody na zamykanie innych okien.

Selektory SMS Compensy są skonfigurowanymi kandydatami; w głównej instalacji nie potwierdzono ich na rzeczywistym challenge. W odróżnieniu od Everest nie wskazano ramki — pole kodu jest szukane w głównej stronie. Challenge Compensy ma w kodzie czas ważności dwie minuty.

Po zalogowaniu zwykły przebieg otwiera Komunikację i korzysta z dopasowanej tożsamości oraz potwierdzonego numeru rejestracyjnego. Może utworzyć formularz, zapisać go i wykonać sprawdzenie UFG. Samo logowanie nie stanowi odbioru tych dalszych etapów.

## 4. Co ocenia operator

1. Czy ekran logowania PZU zawiera wskazane pola i przycisk w `#credentials_table`, a po zalogowaniu pośrednim wraca się do Everest z polem PESEL/REGON.
2. Czy wymagany przez PZU kod rzeczywiście pojawia się w ramce Secfense, w podanym polu `input#code`; czy opcja zapamiętania urządzenia jest właściwa.
3. Czy Compensa loguje przez `#login`, `#password` i `#submitLogin`, a widoczny link `a.tg-btnLogout` oznacza zalogowaną sesję.
4. Czy Compensa rzeczywiście używa skonfigurowanego pola i przycisku MFA, jeśli ten etap występuje na używanym koncie. Bez takiego doświadczenia pozostaje to niepotwierdzony punkt konfiguracji.

Operator zaakceptował opis i zezwolił na działanie platformy. Pierwsza próba 18031 pozostaje historycznie niepewna. Po późniejszej próbie 18001 wykonano bezpośredni odczyt istniejącej karty, potwierdzając rzeczywisty formularz SMS. Nie podano kodu, nie ustanowiono w odebranym przebiegu zaufania do tego profilu i nie potwierdzono dalszych kroków Compensy. Dokumentacja Secfense przewiduje konfigurowalny okres zaufania do przeglądarki; rzeczywistej polityki czasowej PZU nie ustalono. Szczegóły aktywacji zawiera sekcja 10 planu, poprawkę detektora sekcja 11, a aktualny odczyt i profil przeglądarki — sekcja 13.

Źródła w repozytorium: `apps/worker/src/portals/shared/portal-session.ts`, `apps/worker/src/portals/pzu/pzu-session.ts`, `apps/worker/src/portals/pzu/everest-identity-provider.ts`, `apps/worker/src/portals/compensa/compensa-session.ts`, `apps/worker/src/features/execution/live-run.ts`, `apps/worker/src/infrastructure/database/pg-run-repository.ts`.

## 5. Wpisanie kodu przez platformę — sprawdzenie 18 października 2026

Przy aktywnym żądaniu SMS użytkownik, który uruchomił zadanie i ma dostęp do wykonania narzędzia, otwiera **Sprawy wymagające uwagi → Wpisz kod**, wypełnia **Kod weryfikacyjny** i naciska **Przekaż kod**. Okno pokazuje pozostały czas. Kod trafia przez API do pamięci workera obsługującego challenge, następnie do ramki PZU; po podaniu kodu pole jest czyszczone. Potwierdzenie przyjęcia przez API oznacza przekazanie do workera; dopiero odpowiedź portalu potwierdza uwierzytelnienie.

Sprawdzenie objęło:

- Test przeglądarkowy na działającym webie `127.0.0.1:3000`, z wszystkimi żądaniami API przechwyconymi i obsłużonymi syntetycznie: otwarcie okna, filtrowanie cyfr, właściwy run i token CSRF, jednorazowe wysłanie, usunięcie pola po wysłaniu, wygaśnięcie, odrzucony kod i jawne ponowienie. Wynik `W3_SMS_UI_SMOKE_PASS`.
- 32 testy API, obsługi challenge i wewnętrznego odbiornika workera: wszystkie przeszły.
- 22 testy sesji PZU i detektora SMS w Chromium na stronach testowych: wszystkie przeszły, bez pominiętych testów. Potwierdzono selektory ramki, wpisanie i wysłanie kodu, zaznaczenie zapamiętania urządzenia oraz rozpoznanie uwierzytelnionej strony.
- Odczyt z działającego kontenera API do wewnętrznego odbiornika workera: połączenie i uwierzytelnienie sekretu usługi poprawne. Użyto GET do nieistniejącej ścieżki diagnostycznej; nie przesłano kodu ani nie zmieniono challenge.

O `2026-10-18T14:11:14.878Z` baza zawierała **zero aktywnych, niewygasłych żądań SMS**. Stare, unieważnione zgłoszenie nie umożliwia wpisania kodu; pole pojawi się przy kolejnym aktywnym żądaniu. W ramach sprawdzenia nie rozpoczęto rzeczywistego logowania, nie wysłano SMS i nie uruchomiono zadania. Nie była potrzebna zmiana kodu aplikacji. Pierwsze skuteczne MFA na rzeczywistym PZU i cały dalszy przebieg pozostają niepotwierdzone.
