# Poprawny przebieg Compensa bez logowania — 10 października 2026

Zapisano HTML przekazany przez użytkownika jako selektory akcji w config/compensa-actions.observed.json. Generator konfiguracji workera używa ich zarówno do sprawdzenia formularza, zapisu, wykonania UFG, jak i otwarcia szczegółów. Zapis jest ograniczony do insured-section, a przyciski UFG rozróżnia się po ikonie, etykietach i prefiksie identyfikatora. Nie używa się całego losowego identyfikatora ani współdzielonego id_cpabyh. Etykiety z br są obsługiwane przez oddzielne warunki has-text. Dodatkowe wymaganie enabled służy jako znacznik zakończenia UFG.

Polecenie odtwarzające test:

    npm run test:compensa-happy-flow

Test uruchamia Chromium na lokalnym syntetycznym HTML, począwszy od otwartej, uwierzytelnionej sprawy i gotowego formularza. Używa rzeczywistych CompensaPortalSession, CompensaOfferSaver, CompensaUfgReader, parsera OC, pętli LiveRunProcessor i exportOcWorkbook. Stan bazy, checkpointy, staging i transport wyniku zastępuje pamięcią; nie testuje rzeczywistego PostgreSQL, kolejki, API ani zgłoszeń platformy. Wszystkie żądania przeglądarki przechwytuje lokalny fixture. Nie odczytuje danych dostępowych i nie loguje się do prawdziwych portali. PZU i wcześniejsze wyszukiwanie osoby są poza zakresem, zgodnie z poleceniem pominięcia logowania i sprawdzenia poprawnego przypadku od Compensy.

Wynik: 2/2, bez pominięć. Build workera i API przeszły. Zweryfikowano:

- Zapis dokładnie raz, po czym checkpoint saved poprzedza weryfikację UFG.
- Weryfikację UFG dokładnie raz, otwarcie szczegółów weryfikacji i szczegółów polis OC w tej kolejności.
- Przejścia compensa_form → ufg_verification → reading_oc → export_ready → completed w testowym repozytorium pamięciowym.
- Pełny snapshot trzech syntetycznych polis, następnie dwie polisy spełniające koniec ochrony >= data odniesienia, w tym dzień graniczny.
- Ponowne odczytanie XLSX z bajtów eksportu i zgodność wszystkich 15 kolumn obu wierszy.
- Dwa różne sufiksy identyfikatora VerificationStatus oraz powtórzone id_cpabyh na różnych przyciskach.
- Ponowne uruchomienie oraz ponowne wywołanie adapterów bez kolejnego zapisu lub weryfikacji UFG; bez tworzenia nowej oferty i bez kolejnych żądań nawigacji/logowania.

Poprzednia sesja workera nie była już dostępna. Nie wykonywano nowych operacji na rzeczywistej ofercie i nie zmieniano stanu wcześniejszego zadania platformy na sukces. To potwierdzenie poprawnego przypadku w teście integracyjnym, nie odbiór żywego zadania z kolejki do produkcyjnego XLSX. Odbiór kroku 7 na portalu nadal wymaga dostępnej sesji i bezpiecznego uzgodnienia konkretnej istniejącej sprawy.
