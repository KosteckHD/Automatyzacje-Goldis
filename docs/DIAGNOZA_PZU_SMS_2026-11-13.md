# Diagnoza zatrzymania po SMS PZU — 13 listopada 2026

## Ustalenia z rzeczywistego workera

Dotyczy wyłącznie runu `5ce9f17d-8f31-4670-bf62-3af898be5226`, wiersz 18001. Godziny poniżej podano w Europe/Warsaw.

| Czas | Obserwacja |
| --- | --- |
| 15:23:10 | Wejście do Everest przekierowało przez SSO do `zaloguj.pzu.pl/my.policy`; odpowiedź HTTP 200. |
| 15:23:14 | Ramka Secfense otworzyła rzeczywisty formularz `/internalauth/authenticate/sms`. |
| 15:28:15 | Upłynęło pierwsze okno na kod w platformie, bez próby wpisania. |
| 15:28:52 | Żądanie nadrzędnej strony do `/vdesk/timeoutagent-i.php` otrzymało 404; wcześniejsze z 15:23:42 miało status 200. Samo 404 nie dowodzi konkretnego ustawienia timeoutu PZU. |
| 15:35:33 | Ponowienie otworzyło ponownie formularz SMS w ramce. Nie było nowego wejścia do Everest ani nowego pobrania dokumentu nadrzędnego `/my.policy`. |
| 15:38:53 | Formularz SMS wysłał POST do właściwego `/internalauth/authenticate/sms`, z polami `_csrf`, `code`, `fprint_state`. Odpowiedź: HTTP 200; wystawiono nowe cookies `proxyauth_public_zalogujpzu` i `proxyauth_zalogujpzu`. Wartości pól i cookies nie zostały zapisane w raporcie. |
| 15:38:54 | Kolejny POST do nadrzędnego `/my.policy` otrzymał rzeczywiste HTTP 403 i dokument z nagłówkiem „403 Forbidden”. |
| 15:39:20 | Worker nie potwierdził zalogowania i bez ponawiania kodu zatrzymał run jako `SMS_DELIVERY_UNCERTAIN`. |
| 15:51:48 | Jedno zwykłe wejście na skonfigurowany adres startowy Everest, w tym samym profilu i bez wysyłania loginu/hasła/kodu, zakończyło się HTTP 200 i prawidłowym formularzem loginu. Ramka SMS nie była widoczna. |

Kontener był zdrowy, bez OOM i bez restartu w trakcie przekazania kodu. W zachowanych żądaniach nie było błędów połączenia. Zbiór zablokowanych przez worker nawigacji był pusty. Nie wystąpiła odmowa dostępu z powodu lokalnej listy dozwolonych domen. Nie znaleziono dowodu na stałą blokadę adresu IP ani wymóg wyłączenia sandboxa Chromium.

## Przyczyna i granice pewności

**Potwierdzony błąd naszego przepływu:** ponowienie po wygaśnięciu SMS odświeżało tylko ramkę MFA, pozostawiając starą stronę nadrzędną SSO. W chwili powrotu po kodzie dokument nadrzędny pochodził sprzed około 16 minut.

**Najbardziej prawdopodobny mechanizm 403:** zakończona lub nieaktualna sesja nadrzędna F5/SSO przy nadal działającej ramce MFA. Wydanie nowych cookies MFA oraz poprawne świeże wejście bez ponownego kodu silnie wspierają ten wniosek. Nie jest to jednak odczyt logów serwera PZU: nie da się na tej podstawie ustalić dokładnej reguły, która zwróciła 403, ani konfiguracji czasu sesji PZU.

Selektor pola/przycisku SMS nie jest główną przyczyną tej próby: zachowana historia potwierdziła wysłanie formularza kodu do właściwej ścieżki z wymaganymi nazwami pól. Nie uznano samego HTTP 200 formularza SMS za końcowe zalogowanie do Everest.

**Drugi błąd:** skonfigurowany marker odmowy dostępu rozpoznawał „Access denied”, ale pomijał widoczny nagłówek „403 Forbidden”. Przez to panel otrzymywał ogólną informację o niepewnym przekazaniu kodu, zamiast jednoznacznego rozpoznania ekranu odmowy.

Wcześniejsze stwierdzenie, że do kontynuacji konieczna jest interwencja administratora PZU, było zbyt kategoryczne. Świeże, zwykłe wejście usunęło 403 bez takiej interwencji.

## Wprowadzone zmiany

- Przy jawnym ponowieniu logowania worker otwiera ponownie skonfigurowany adres aplikacji i czeka na rozpoznawalny ekran. Nie odświeża samej starej ramki PZU.
- Nowy formularz MFA po tym wejściu jest prawidłowym stanem oczekiwania, a nie automatycznym błędem.
- Widoczny standardowy nagłówek „403 Forbidden” jest rozpoznawany jako odmowa dostępu, bez prób wpisywania danych w taką stronę.
- Administrator lub manager będący osobą uruchamiającą może zlecić ponowne sprawdzenie tego samego zadania po niepewnym MFA, wyłącznie przed rozpoczęciem sprawy zewnętrznej. Operacja nie może zastąpić aktywnego wyzwania kodu lub wykonania workera; stary kod i stary cykl MFA nie są ponownie używane.
- Analogiczna kontrolowana ścieżka dotyczy błędu technicznego bez checkpointu i bez sprawy zewnętrznej; zaczyna od PZU, nie zgaduje checkpointu Compensy.

Nie zmieniano list dozwolonych domen, sprawdzania TLS, sandboxa, kontroli lease ani limitów ponawiania SMS. Nie wprowadzono ukrywania automatyzacji ani omijania MFA.

## Walidacja

- 53/53 testów workera i przeglądarkowych fixture PZU po poprawce ponowienia: PASS, bez pominięć.
- Dodatkowe testy wznowienia administratora sprawdzają nowy cykl logowania, blokadę aktywnego kodu, działającego wykonania, obcego uruchamiającego oraz sprawy zewnętrznej.
- Pierwsza próba wznowienia po wdrożeniu potwierdziła nowe HTTP 200. Ujawniła dodatkowo niespójność w nowej ścieżce: operacja czyszczenia kodów błędów SMS nie obsługiwała `REVIEW_RETRY_QUEUED`. Zatrzymanie nastąpiło przed wysłaniem poświadczeń. Poprawka pozostawia kod wznowienia kontroli sesji do wyczyszczenia przez zwykłe przejście stanu, bez rozszerzania SQL przeznaczonego do ponowień SMS.
- Końcowe testy logiki workera: 34/34 PASS; testy kontraktu i serwisu wznowienia API: 14/14 PASS. Test regresyjny odrzuca użycie operacji SQL dla ponowienia SMS w ścieżce kontroli sesji oraz wymaga pojedynczego świeżego wejścia na jedno wznowienie.
- Build API, workera i panelu: PASS. Kontrola granic modułów: PASS.
- Poprawiono też etykietę panelu: interwencja bez przypisanego portalu jest opisywana jako „platforma”, zamiast domyślnie jako „Compensa”. Sam taki komunikat nie oznaczał przejścia do Compensy.

## Wynik ponownego testu na rzeczywistej platformie

O 16:10:10 wznowiono przez przycisk panelu **to samo zadanie**, bez tworzenia nowego runu. Worker wykonał świeże wejście do aplikacji i zwykłe logowanie, po czym o 16:10:15 utworzył nowe wyzwanie SMS PZU. Nie wystąpił ponownie błąd 403 ani poprzedni błąd wznowienia.

W tym nowym oknie nie przekazano następnego kodu. O 16:15:15 wyzwanie wygasło; run przeszedł do `waiting_for_manual_data` z `SMS_RETRY_REQUIRED`. Licznik prób pozostał równy 1, pochodzący z historycznego przekazania z 15:38 — w nowej sesji nie było kolejnego zdarzenia `sms_code_submitted`.

**Potwierdzone:** poprawki działają w rzeczywistej platformie aż do nowego MFA w świeżej sesji. **Niepotwierdzone:** przyjęcie nowego kodu i przejście Everest → Compensa → UFG → eksport. Do tej części potrzebny jest aktualny kod wpisany przez operatora podczas nowego, aktywnego okna. Nie wykonano automatycznego kolejnego żądania SMS.

[Stan panelu po poprawkach](worker-test-2026-11-13-session-fix.jpg). Poprawione obrazy API, workera i panelu są uruchomione w lokalnym projekcie `goldis-local`.

## Dokumentacja pomocnicza

Dokumentacja producentów potwierdza rozdzielenie ustawień czasu uwierzytelnienia i sesji oraz zależność przebiegu F5 od aktualnego stanu sesji. Nie potwierdza konfiguracji konkretnej instalacji PZU:

- [Secfense: konfiguracja aplikacji i Session Lifetime](https://docs.secfense.com/guides/configuring-local-applications/).
- [F5: restart sesji przy nieaktualnym stanie sesji i cookies](https://my.f5.com/manage/s/article/K02309338).
