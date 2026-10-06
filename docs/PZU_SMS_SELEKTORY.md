# PZU — selektory SMS odczytane 2 października 2026

Źródło: nadzorowany odczyt DOM rzeczywistego PZU w osobnym profilu `worker-profiles/pzu-supervised-sms-20261002`. Nie odczytano wartości pól, nie zapisano kodu, ciasteczek ani pełnego HTML strony. Agent nie zatwierdzał SMS i nie klikał ponownego wysłania.

Fragment do połączenia z pełną konfiguracją znajduje się w `config/pzu-sms.observed.json`, pod kluczem `session`. Nie jest to samodzielna pełna konfiguracja runtime. Oba przykłady konfiguracji zawierają te same selektory; pozostałe placeholdery nadal blokują uruchomienie live.

| Klucz adaptera | Selektor | Zakres |
| --- | --- | --- |
| `smsChallenge`, `smsFrame` | `iframe#secfense_iframe` | Główna strona `https://zaloguj.pzu.pl/my.policy` |
| `smsCodeInput` | `input#code[name="code"][type="text"]` | Wewnątrz ramki |
| `smsCodeSubmit` | `form:has(input#code) .buttons > button.btn.btn-primary` | Wewnątrz ramki |
| `smsRememberDevice` | `input#fprint_state[name="fprint_state"][type="checkbox"]` | Wewnątrz ramki |
| `smsResendCode` | `form:has(input#code) .buttons > a#resend` | Wewnątrz ramki |
| `smsCodeExpired` | `.errors_wrapper > span.errors:text-matches("expired", "i")` | Wewnątrz ramki; komunikat po zatwierdzeniu starego kodu przez użytkownika |

Ramka miała ścieżkę `/internalauth/authenticate/sms`. Potwierdzono pojedynczą ramkę, formularz, pole i przycisk zatwierdzenia; checkbox miał wskazane ID/name/type, a resend był linkiem `a`, nie przyciskiem `button`. Adapter używa `page.frameLocator(smsFrame).locator(selector)` dla elementów wewnętrznych; `smsChallenge` pozostaje selektorem głównej strony. Nie stosować ogólnego `button` ani zgadywanej etykiety checkboxa/resend.

Test `observed PZU selectors submit through the SMS frame and remember the device` w `pzu-session.test.ts` wczytuje zapisany fragment, porównuje go z przykładami, uruchamia produkcyjny adapter na izolowanym Chromium i potwierdza: wykrycie challenge, jeden submit, przekazanie syntetycznego kodu, zaznaczenie checkboxa, wyzerowanie bufora oraz brak resend. Jest to test syntetyczny odtworzonej struktury, nie odbiór rzeczywistego przekazania kodu przez platformę.

Użytkownik zatwierdził stary kod jeden raz. Następnie potwierdzono jeden widoczny `.errors_wrapper > span.errors` zawierający `expired`, bez tokenów błędnego kodu, oraz jeden widoczny link RESEND. Nie zapisano całej treści komunikatu ani kodu. Rzeczywistego czasu pojawienia linku i jego skutecznego kliknięcia nie zmierzono; 15–20 sekund jest informacją użytkownika, nie pomiarem tego testu.

Adapter przy jawnej próbie ponowienia czeka maksymalnie 25 sekund na pojedynczy widoczny, enabled element bez `aria-disabled=true`. Sprawdza bieżący DOM i uprawnienie wykonania, nie odpytuje portalu HTTP ani nie wysyła SMS podczas czekania. Po kliknięciu wraca bez kolejnego kliknięcia. Brak linku po terminie, wiele dopasowań, utrata challenge lub uprawnienia daje `error`, co w produkcyjnym flow zatrzymuje zadanie zamiast otwierać nowy cykl logowania. Dotychczasowy limit jednej jawnej dodatkowej próby na run pozostaje w API.

Test Chromium odtwarza pojawienie linku po rzeczywistych 20 sekundach: jeden resend. Sprawdza także brak elementu, duplikaty i cofnięcie uprawnienia: zero resend. Osobny test zapisanych selektorów potwierdza, że widoczny marker `expired` blokuje wpisanie/wysłanie kolejnego kodu i czyści bufor.

Pozostają nieobserwowane rzeczywisty marker błędnego kodu, enabled/skutek resend oraz usunięcie starego komunikatu po nowym SMS. Nie wymuszać kolejnych błędnych kodów na koncie. Limit 5 minut pochodzi z ustalenia użytkownika; tego czasu nie zmierzono podczas odczytu DOM. Obecność checkboxa nie dowodzi, że PZU zapamięta urządzenie ani jak długo będzie mu ufać.

Następny odbiór: dopełnić pełną konfigurację, połączyć ją z właściwym profilem workera i przetestować pojedynczy aktualny SMS z modalu platformy do PZU, a następnie potwierdzić Everest. Sam zapis selektorów nie włącza portali.
