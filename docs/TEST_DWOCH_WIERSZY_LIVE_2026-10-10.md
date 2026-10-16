# Rzeczywisty test wierszy 18001 i 18002 — 2026-10-10

Import `c55ae6dd-4144-42c8-8d63-8820bed568e6` zawiera wyłącznie wskazane dwa wiersze z oryginalnego arkusza „Realizacja”. Zachowano numery i wartości komórek. Przygotowanie platformy: ready=2, review=0, duplicates=0. Oba zadania uruchomiono przez API w jednej kolejce z concurrency=1 i w jednym profilu Chromium workera z zapamiętanym urządzeniem. Portale nie były otwierane w przeglądarce Codexa.

| Wiersz | Zadanie | Wynik |
| --- | --- | --- |
| 18001 | 41042b4b-b4b1-4ac9-8d67-0c12f38457ec | completed; 49/49 polis odczytanych; XLSX z 3 polisami |
| 18002 | b9cb91bc-c409-42ba-b826-46ab1417cdc9 | identity_review / IDENTITY_NOT_FOUND; Everest pokazał „Brak wyników wyszukiwania” |

Wiersz 18001 przeszedł PZU/Everest, dopasowanie osoby, Compensę, formularz, Zapisz, Weryfikację UFG, Szczegóły OC, przekazanie do API i eksport. Plik pobrano endpointem platformy i porównano wszystkie 15 kolumn danych z zapisem w PostgreSQL. Data odniesienia 2026-10-10; zachowana reguła końca ochrony >= data odniesienia. Potwierdzono dokładnie jeden draft, jeden zapis i jedną weryfikację UFG w tym zadaniu. Brak zgłoszeń SMS w zadaniu 18001.

Zdarzenie rozpoczęcia wyszukiwania Everest dla 18002 nastąpiło po zakończeniu 18001. Wiersze mają różne identyfikatory źródłowe REGON. Repozytorium i baza potwierdzają, że dla 18002 nie zapisano tożsamości, numeru sprawy Compensa ani zdarzeń rozpoczęcia oferty/zapisu/UFG. Automat nie użył tożsamości poprzedniego klienta do dalszego procesu.

Wynik odbioru: poprawny przebieg jednego wiersza oraz kontrolowane zatrzymanie drugiego przy braku klienta. Nie potwierdzono pełnego przebiegu Compensa/XLSX dla 18002, ponieważ nie uzyskano PESEL-u z Everest. Nie ustawiano ręcznie sukcesu ani zastępczych danych. Stan identity_review jest widoczny w platformie. Po teście wstrzymano konsumpcję kolejki, pozostawiając przeglądarkę workera otwartą.

Walidacja: kontrole składni zmienionych skryptów; rzeczywisty import i przygotowanie dwóch wierszy; rzeczywiste zadania produkcyjnej kolejki; porównanie artefaktu 18001; odczyt chronologii i checkpointów obu zadań przez `scripts/verify-live-acceptance-artifact.cjs`. Bez danych osobowych w raporcie.
