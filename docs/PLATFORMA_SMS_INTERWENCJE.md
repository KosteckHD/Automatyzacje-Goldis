# Interwencje SMS w platformie — 2 października 2026

## Zachowanie użytkownika

Powiadomienia w centrum zgłoszeń wskazują portal, wiersz, powód i nieprzeczytaną zmianę. Kliknięcie otwiera modal kodu lub szczegóły zatrzymania. Platforma nie wywołuje automatycznego RESEND.

| Stan | Działanie |
| --- | --- |
| Portal wymaga SMS, również po utracie sesji/zaufania do urządzenia | Aktywne zgłoszenie `SMS_REQUIRED`; pole kodu, termin serwera i pozostały limit prób. Przyczyna zaufania urządzenia nie jest zgadywana. |
| Portal jawnie odrzucił kod | `SMS_CODE_REJECTED`; nowy jednorazowy handoff do tej samej sesji, z zachowaniem pierwotnego terminu i liczby prób. Można wpisać aktualny kod; uprawniony właściciel/operator lub admin może jawnie wybrać dodatkowy SMS. |
| Kod wygasł w platformie lub portal pokazał potwierdzony marker expiry | `SMS_TIMEOUT`; brak inputa starego kodu, wstrzymane zadanie. Po jawnej akcji `resume-auth` worker czeka na RESEND, następnie tworzy nowy challenge. |
| RESEND pojawia się z opóźnieniem | Do 25 s lokalnego oczekiwania adaptera. Jeden klik dopiero przy pojedynczym widocznym/enabled elemencie. Brak lub duplikat zatrzymuje zadanie. |
| Nie wiadomo, czy kod został dostarczony lub sesja zniknęła podczas submit | `SMS_DELIVERY_UNCERTAIN`; input jest blokowany, potrzebna kontrola administratora. Nie powtarzać niepewnej operacji. |
| Limit wpisania lub dodatkowego SMS wykorzystany | `SMS_ATTEMPT_LIMIT` lub timeout bez dostępnej próby; brak kolejnego RESEND. |

PZU ma pięciominutowy cykl zgodnie z ustaleniem użytkownika. Odrzucenie kodu nie wydłuża cyklu. Jawne dodatkowe wysłanie resetuje metadane cyklu dopiero po rezerwacji akcji. Maksymalnie jedna dodatkowa próba PZU na zadanie; limit wpisania kodów pozostaje oddzielny. Zaznaczenie checkboxa odbywa się w adapterze, lecz portal może ponownie zażądać SMS.

## Uprawnienia i atomowość

- Powiadomienia są filtrowane po tenant, właścicielu/przydziale i grantach narzędzia. Operator przypisany wyłącznie do SMS może otworzyć modal bez dostępu do pełnych wyników.
- Wpisanie kodu wymaga istniejącego `sms:submit`. RESEND wymaga `run:resume`: admin w swoim tenant albo operator własnego zadania z prawem wykonania. Sam przydział cudzego SMS nie nadaje prawa RESEND.
- POST wymaga CSRF. Backend ponownie sprawdza aktualny stan; interfejs nie stanowi granicy uprawnień.
- Rezerwacja dodatkowej próby, unieważnienie niewykorzystanego challenge, rozwiązanie zgłoszenia, audyt i outbox są jedną transakcją. Challenge claimed/submitted nie może zostać zastąpiony przez RESEND. Po zatwierdzeniu transakcji stary inbox jest unieważniany.
- Równoczesne RESEND: jeden sukces i jeden konflikt. Stare ID challenge odrzuca kod. Nowy SMS nie zeruje liczby wcześniejszych prób wpisania kodu.
- Kod jest czyszczony po wysłaniu, po wygaśnięciu i zmianie challenge; nie trafia do zdarzeń ani joba. Utrata odpowiedzi blokuje ponowne wysłanie z tego samego modalu.

## Odświeżanie i testy

Centrum zgłoszeń korzysta z istniejącego polling 20 s i backoff, zatrzymanego przy ukrytej karcie/offline. Aktywny challenge odświeżany co 5 s, także dla operatora przypisanego do SMS, bez nakładania fetch. Odliczanie jest lokalne co sekundę. Wygaśnięcie inicjuje pojedyncze sprawdzenie stanu; nie wysyła SMS. Modal zachowuje pułapkę fokusu i czyszczenie danych.

Odbiór tej iteracji: API 93 testy; worker 66 pass/37 skip w zwykłej komendzie; PZU Chromium 16/16 bez skip. UI smoke obejmuje modal timeoutu z RESEND, odrzucony kod, limit, CSRF, czyszczenie i fokus. Pełny syntetyczny HTTP/DB/BullMQ/produkcja-adapter/XLSX obejmuje 7 scenariuszy: aktywna sesja, SMS, odrzucony kod → poprawny wpis, odrzucony kod → równoczesny RESEND → wpis, timeout → RESEND, wyczerpany RESEND oraz brak osoby.

UI smoke i integracja procesora są osobnymi testami; nie oznaczają jednego odbioru modalu z tym samym rzeczywistym backendem. Rzeczywisty selector expiry i RESEND odczytano w PZU. Marker błędnego kodu pozostaje nieobserwowany live: nie podstawiać zgadywanego markera jako potwierdzonego. Bez niego nierozpoznana odpowiedź jest traktowana jako niepewna. Pełna konfiguracja portali nadal ma placeholdery i tryb live pozostaje wyłączony. Nie wykonano rzeczywistego RESEND ani nowego logowania w tej iteracji.
