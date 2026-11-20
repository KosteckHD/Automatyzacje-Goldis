# Nadzorowany test workera przez platformę — 13 listopada 2026

## Środowisko

- Projekt Docker Compose: `goldis-local`, konfiguracja `.env.local` oraz `compose.yaml` i `compose.local-browser.yaml`.
- Panel: `http://127.0.0.1:3000`.
- Uruchomione: PostgreSQL, Redis, API, panel, parser importu, worker portalowy, worker wzbogacania, silnik prowizji i worker prowizji.
- Migracje wykonane; przed testem potwierdzono pustą kolejkę portali i brak zadań przeznaczonych do automatycznego wznowienia.
- API potwierdziło `automationReady=true`, `worker=online`, `portalMode=live`, `portalConfig=valid`.

## Usunięte przeszkody

1. Uzupełniono lokalne dane połączeń konta prowizji za pomocą istniejącego skryptu aktualizacji konfiguracji. Sekrety pozostają w prywatnych, ignorowanych przez Git plikach.
2. Dostosowano generowanie losowego tokenu w `Write-GoldisComposeSecrets.ps1` do Windows PowerShell: konwersja przez `BitConverter`, bez `Convert.ToHexString`.
3. Poprawiono cudzysłów zamykający tekst przycisku w `run-submission-launcher.tsx`, który uniemożliwiał build panelu.
4. Po zatrzymaniu workera i sprawdzeniu, że żaden aktywny kontener nie montuje jego profilu, usunięto nieaktywną blokadę `.goldis-worker.lock` z 18 października. Profil i jego dane zachowano.
5. Usunięto zależność zapisu powiązań leadów i powiadomień od tymczasowej funkcji PostgreSQL tworzonej przez Sequelize `findOrCreate`. Zapis korzysta z `bulkCreate` z `ignoreDuplicates`; ograniczenia unikalności zachowują idempotencję. Konto API nadal nie ma prawa `TEMPORARY`.

## Walidacja poprawek

- Build panelu, API i workera: PASS.
- Kontrola granic modułów: `FEATURE_BOUNDARY_CHECK_PASS`.
- Testy modułu leadów i serwisu powiadomień: 4/4 PASS.
- Test na rzeczywistym koncie `goldis_api`, bez `TEMPORARY`: dwukrotne powiązanie tych samych grup i dwukrotne utworzenie tego samego zdarzenia powiadomienia zachowały po jednym rekordzie. Transakcja testowa została wycofana: `RUNTIME_API_NO_TEMP_REGRESSION_PASS`.

## Próba przez interfejs użytkownika

- Import: `45784330-03e0-4b03-af99-bcbc393b6c77`.
- Wybrano wyłącznie wcześniejszy rekord testowy, wiersz `18001`.
- Panel pokazał: 1 wybrany, 1 gotowy, 0 do kontroli, 1 osobne zadanie, 0 już aktywnych.
- Pierwszy zapis zakończył się wycofaniem transakcji przez brak prawa `TEMPORARY`; nie utworzył zadania. Po poprawce użyto przycisku „Ponów tę samą próbę”, z zachowaniem pierwotnego klucza idempotencji.
- Zgłoszenie: `b08302ef-7bda-4cb3-b78d-9ccb55220b01`.
- Run: `5ce9f17d-8f31-4670-bf62-3af898be5226`.
- Data odniesienia: `2026-11-13`.
- Przejścia widoczne w panelu (Europe/Warsaw): kolejka 15:23:03 → walidacja 15:23:08 → logowanie Everest 15:23:09 → oczekiwanie na SMS 15:23:14.
- Otworzono formularz „Kod SMS · PZU Everest” dla tego runu. Kod ma wpisać operator bezpośrednio w platformie.

## Stan odbioru

Test dotarł do rzeczywistego żądania MFA PZU. Okno na kod wygasło o 15:28:15 (Europe/Warsaw), bez żadnej próby wpisania kodu (`attempt_count=0`). Run przeszedł do `waiting_for_manual_data` z `SMS_RETRY_REQUIRED`; challenge ma stan `expired`. Panel wyświetla „Kod wygasł. Automatyzacja jest wstrzymana.” i udostępnia przycisk „Wyślij jeden dodatkowy kod SMS”. Nie żądano kolejnego SMS automatycznie.

Środowisko pozostaje uruchomione. Dalszy test wymaga działania operatora i aktualnego kodu PZU. Nie potwierdzono przyjęcia kodu, przejścia przez Everest → Compensa → UFG ani wygenerowania końcowego eksportu. Ten zapis nie stanowi pełnego odbioru workera.

Zrzut stanu panelu: [worker-test-2026-11-13.jpg](worker-test-2026-11-13.jpg).

## Dalsza próba po przekazaniu kodu

Operator ponowił SMS w platformie. Nowe wyzwanie powstało o 15:35:33. Kod został odebrany przez platformę i przekazany workerowi: `sms_code_claimed` o 15:38:50 oraz `sms_code_submitted` o 15:38:51. Zapisano jedną próbę wpisania; samego kodu nie odczytywano ani nie zapisywano w diagnostyce.

O 15:39:20 worker nie uzyskał potwierdzenia zalogowania. Run przeszedł do `waiting_for_manual_data` z `SMS_DELIVERY_UNCERTAIN`, a wyzwanie zostało unieważnione. Nie ponawiano przesyłania tego samego kodu.

Odczyt istniejącej instancji przeglądarki, bez klikania, nawigacji i ponownego logowania, potwierdził o 15:43:01:

- domena i ścieżka: `https://zaloguj.pzu.pl/my.policy`;
- widoczny nagłówek: **403 Forbidden**;
- brak ramki SMS i brak widocznej uwierzytelnionej wyszukiwarki Everest;
- brak akcji portalowych wykonanych w ramach diagnostyki;
- tymczasowy debugger dostępny wyłącznie na loopback wewnątrz kontenera został zamknięty, a skrypt z `/tmp` usunięty.

Nie ustalono przyczyny odmowy 403 ani tego, czy kod został zaakceptowany przez PZU. Nie jest to dowód nieprawidłowego kodu. Dalszy odbiór jest zablokowany przez odmowę dostępu portalu; nie uruchamiano nowego zadania i nie żądano kolejnego SMS. Środowisko pozostaje uruchomione. Compensa, UFG i eksport nie zostały jeszcze przetestowane w tym przebiegu.

Zrzut panelu po próbie: [worker-test-2026-11-13-after-code.jpg](worker-test-2026-11-13-after-code.jpg).

## Uzupełnienie po szczegółowej diagnozie

[Szczegółowa diagnoza i poprawki](DIAGNOZA_PZU_SMS_2026-11-13.md) opisują odtworzoną historię HTTP i błąd ponawiania wyłącznie ramki MFA przy starej stronie nadrzędnej. Zwykłe świeże wejście na Everest przywróciło HTTP 200; wcześniejszy wniosek o koniecznej interwencji PZU był zbyt kategoryczny.

Po poprawkach wznowiono ten sam run przez panel. O 16:10:15 dotarł on do nowego SMS w świeżej sesji, bez powtórzenia 403. Nowego kodu nie przekazano; okno wygasło o 16:15:15. Aktualny stan to `waiting_for_manual_data` / `SMS_RETRY_REQUIRED`. Środowisko pozostaje uruchomione, a pełny odbiór po nowym MFA nadal wymaga działania operatora.
