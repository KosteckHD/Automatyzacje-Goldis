# Realizacja odzyskiwania hasła i Resend

Punkt odniesienia: 14 października 2026. Wykonanie według [planu implementacji](PLAN_IMPLEMENTACJI_ODZYSKIWANIA_HASLA_RESEND_2026-10-14.md), w istniejącym, niezacommitowanym drzewie roboczym. Wcześniejsze zmiany użytkownika zostały zachowane.

## Dziennik kroków

| Krok | Status | Wynik |
| --- | --- | --- |
| A01 Punkt odniesienia i zależności | Wykonany | Punkt startowy: migracja 059. Przejrzane istniejące zmiany, `apps/web/AGENTS.md` i lokalne przewodniki Next.js 16.4. Wykonane testy auth/security jako baza; prawdziwa domena/nadawca/Reply-To pozostają nieznane. |
| A02 Wspólna zmiana hasła i naprawy DB | Wykonany | Wspólny helper zmiany hasła; poprawione audytowanie resetów, smoke migracji `bootstrapAdminOnce`, grant TEMPORARY dla migratora i test runtime permissions. Świeża baza przechodzi `users-empty` i powtórne migracje 001–060. |
| A03 Konfiguracja i adapter Resend | Wykonany | Fail-closed parser konfiguracji, provider z ustalonym endpointem HTTPS, timeoutem i bezpiecznymi kodami, szyfrowanie AES-256-GCM z wersjonowanym keyringiem oraz szablony tekst/HTML. Testy pokrywają sukces, throttling, timeout, błędne odpowiedzi i rotację keyringu. |
| A04 Schemat danych i granty | Wykonany | Migracja `060-account-recovery-and-auth-mail`; adresy są nullable, tokeny/outbox mają constraints i indeksy, a runtime API dostaje wyłącznie wymagane prawa. Świeża baza i stabilny rerun migracji przeszły. |
| A05 Tokeny i blokady | Wykonany | Token CSPRNG jest przechowywany jako SHA-256; token wiąże purpose, konto, rewizję hasła/adresu, fingerprint i termin. Zmiana hasła zużywa jednorazowy token, zwiększa rewizję i unieważnia sesje/linki. DB smoke potwierdza, że dwa równoległe POST-y pozwalają tylko na jedną zmianę. |
| A06 Adres odzyskiwania | Wykonany po stronie kodu | Ustawienie adresu wymaga obecnej sesji, CSRF, reautentykacji hasłem i potwierdzenia linkiem. Stary adres pozostaje aktywny do potwierdzenia nowego; są powiadomienia i ścieżki admin/team. Syntetyczny DB smoke potwierdził weryfikację. |
| A07 Limity | Wykonany | Limity HMAC-hashują e-mail, obejmują IP/token/wysyłkę i fail closed przy awarii Redis. Test security przeszedł. |
| A08 Publiczne żądanie resetu | Wykonany | `POST /api/auth/forgot-password` zwraca ten sam ogólny kształt dla nieznanego, niezweryfikowanego i znanego adresu; zapis tokenu i outbox jest atomowy. DB smoke sprawdził suppress dla adresu niezweryfikowanego i brak enumeracji. |
| A09 Ustawienie nowego hasła | Wykonany | Endpoint nie loguje automatycznie, stosuje politykę haseł, zapisuje bezpieczny audyt i powiadomienie oraz unieważnia sesje. Jednorazowość/replay przeszły test DB. |
| A10 Kolejka i wysyłka | Wykonany | Dispatcher używa lease i `FOR UPDATE SKIP LOCKED`, stałego klucza idempotencji oraz fake providera w DB smoke. Potwierdzenie wysyłki czyści ciphertext. Adapter Resend nie udostępnia odpowiedzi dostawcy użytkownikowi. |
| A11 Reset admin/team | Wykonany po stronie kodu | Dodane endpointy wymagają świeżego potwierdzenia, idempotency key i ponownej kontroli aktora/celu w transakcji. Manager jest ograniczony do operatora tego samego tenanta; adres pochodzi z potwierdzonego profilu konta. Testy potwierdzają macierz ról. |
| A12 Interfejs | Wykonany | Dodane `/odzyskaj-haslo`, `/reset-hasla`, `/potwierdz-email`, ustawianie adresu w koncie oraz przyciski admin/team. Build Next.js przechodzi. Playwright potwierdza `no-store`, `no-referrer`, usunięcie fragmentu tokenu z historii i brak auto-potwierdzenia przy samym otwarciu linku. |
| A13 Audyt i metryki | Wykonany | Dodano dozwolone akcje audytu, ograniczone metadane i licznik/stan outbox w podsumowaniu operacyjnym. Podczas DB smoke wykryto i naprawiono nazwę metadanych odrzucaną przez filtr wrażliwych kluczy. |
| A14 Sekrety, Compose i backup | Wykonany po stronie kodu | Recovery domyślnie wyłączone; Resend/keyring są sekretami montowanymi tylko do API. Dodano konfigurację, generowanie sekretu z zachowaniem istniejącego keyringu i unieważnianie linków/outbox przed startem po restore. Składnia skryptów Bash, test Compose, testy crypto i manifestu przeszły; pełnego cold restore na Linux VPS tu nie wykonywano. |
| A15 Testy bezpieczeństwa i awarii | Częściowo wykonany | `auth` 38/38, `security` 69/69, `password-recovery` DB smoke na świeżym PostgreSQL, browser smoke, build API/web, fixture Compose, crypto/manifest i test runnera przeszły. Pełna macierz awarii Resend/Redis oraz prawdziwe dostarczenie są niezrealizowane. Dodatkowo `test:module:security-db` nie zakończył testu `users` (`MIGRATION_SMOKE_FAILED_users`; diagnostyka tego testu pozostaje osobnym problemem repozytorium). |
| A16 Istniejące konta | Częściowo wykonany | Migracja pozostawia e-mail nullable, więc dotychczasowe konta nadal logują się bez zmian. Admin może rozpocząć weryfikację adresu pracownika. Dodano kontrolowaną komendę offline administratora i runbook. Przypisanie konkretnych firmowych skrzynek wymaga danych właściciela. |
| A17 Włączenie produkcyjne | Oczekuje na właściciela | Funkcja pozostaje `GOLDIS_PASSWORD_RECOVERY_ENABLED=0`; brak domeny, rekordów wygenerowanych przez Resend, klucza API, HTTPS oraz odbiorczych skrzynek. Instrukcja operatora home.pl jest w [planie użytkownika](PLAN_UZYTKOWNIKA_RESEND_HOME_PL_2026-10-14.md). Nie wykonywano prawdziwych wysyłek. |

## Odbiór techniczny

- `npm run build -w @goldis/api` — PASS.
- `npm run build -w @goldis/web` — PASS.
- `npm run test:module:auth` — PASS, 38/38.
- `npm run test:module:security` — PASS, 69/69.
- `npm run test:module:password-recovery` — PASS; nowy test wykonuje pełny syntetyczny przepływ na jednorazowym PostgreSQL.
- `node apps/web/scripts/security-browser-smoke.cjs` — PASS dla zabezpieczeń CSP i fragmentu recovery.
- Testy backup crypto/manifest, produkcyjnego Compose, składni skryptów i manifestu test runnera — PASS.
- `npm run test:module:security-db` — FAIL/nieukończony w istniejącym trybie `users`; nie jest oznaczony jako zaliczony.

Nie podano rzeczywistej domeny ani rekordów DNS z Resend. Sam operator panelu DNS to `home.pl`; trzeba jeszcze potwierdzić, czy home.pl obsługuje aktywną strefę domeny. Do czasu zakończenia tych kroków kod nie wysyła wiadomości produkcyjnych.
