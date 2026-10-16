# Operacje i awarie

## Kontrola stanu

Z zaufanego hosta uruchamiaj okresowo:

```sh
GOLDIS_RUNTIME_BASE_URL=https://<domena> \
GOLDIS_EXPECT_ENRICHMENT_PROVIDER=mf-vat \
GOLDIS_EXPECT_PORTAL_LIVE=0 \
node scripts/runtime-check.cjs
```

Runner odpytuje tylko publiczne, bezpieczne podsumowania health. Wynik JSON nie zawiera body błędu ani danych zadań. Kod wyjścia `0` oznacza, że API działa, readiness jest spełnione, zależności odpowiadają i MF VAT ma oczekiwany stan. Kod `1` oznacza brak gotowości lub niezgodny provider. Kod `2` oznacza błędne ustawienia runnera. Gdy automaty portalowe mają być odebrane jako aktywne, ustaw `GOLDIS_EXPECT_PORTAL_LIVE=1`.

| Endpoint | Znaczenie |
| --- | --- |
| `/api/health/live` | Proces API odpowiada. |
| `/api/health/ready` | PostgreSQL, Redis i przyjęcie dziennika kasowań działają. |
| `/api/health/automation` | Usługi i heartbeat portalu; `off` jest prawidłowym trybem przed odbiorem live. |
| `/api/health/enrichment` | Świeżość workera rejestru i provider MF VAT. |

`docker compose ps` pokazuje stan kontenerów i restartów. Panel administracyjny pokazuje runy, kolejkę, SMS i interwencje. Porównuj je z healthcheckiem; sam otwarty port lub działający kontener nie potwierdza sprawnego workera. Ustal po wdrożeniu progi alertów i czas podtrzymania na podstawie pomiarów. Kanał powiadomień i dyżur operatora pozostają do wyboru.

## Zatrzymanie przyjęć

Gdy wystąpi awaria, najpierw ogranicz nowe żądania przez domenę/proxy. Jeśli potrzebujesz zatrzymać wejście aplikacji:

```sh
docker compose --project-name goldis --env-file /etc/goldis/env.production \
  -f compose.yaml -f compose.production.yaml stop web
```

Gdy trzeba również wstrzymać automaty, zatrzymaj portal-workera po graceful stop i potwierdź heartbeat oraz checkpointy:

```sh
docker compose --project-name goldis --env-file /etc/goldis/env.production \
  -f compose.yaml -f compose.production.yaml stop worker enrichment-worker
```

Nie zatrzymuj PostgreSQL ani Redis jako pierwszej reakcji, jeśli ich logi wskazują na żywy zapis. Zachowaj logi, identyfikator runu/dispatchu i status operatora bez eksportowania sekretów.

## Runbook

| Objaw | Bezpieczna kolejność |
| --- | --- |
| `live` nie odpowiada | Sprawdź Nginx, certyfikat i stan web/API. Potwierdź, że reguły sieci nadal ograniczają porty do loopback/prywatnych sieci. Nie włączaj workerów, by „naprawić” web. |
| `ready` nie odpowiada | Rozróżnij bazę, Redis i walidację dziennika kasowań. Przy braku DB/Redis przywróć usługę i sprawdź readiness ponownie. Przy błędzie journalu zatrzymaj przyjęcia; nie kasuj klucza ani pliku i nie uruchamiaj API z pominięciem kontroli. |
| Automation worker offline | Zatrzymaj nowe partie, sprawdź worker heartbeat, logi z kodami, lease i checkpointy. Zrestartuj worker tylko po sprawdzeniu, że poprzednia instancja zakończyła się. Nie zmieniaj ręcznie statusu runu. |
| Run czeka na SMS/interwencję | Zweryfikuj właściciela runu i termin challenge w panelu. Kod przekazuje właściwa osoba. Nie powtarzaj niepewnego kliknięcia w portalu i nie kopiuj OTP do zgłoszenia. |
| MF VAT degraded/offline | Pozostaw runy portalowe bez zmian. Sprawdź health enrichment, dzienny limit i czasowe błędy dostawcy. Nie przełączaj automatycznie na GUS. |
| Dysk zapełniony | Zatrzymaj nowe przyjęcia i sprawdź logi, katalog tymczasowy Nginx oraz rozmiar znanych wolumenów. Nie usuwaj eksportów, stagingu, wolumenu bazy ani dziennika kasowań ręcznie. |
| Wynik nie dostarczony do API | Zachowaj zaszyfrowany staging i checkpoint. Wznawiaj tylko bezpieczny etap dostawy wyniku; nie powtarzaj zapisu oferty/UFG. |
| Odtworzenie backupu | Zatrzymaj przyjęcia, zweryfikuj szyfrowany plik i aktualny journal, odtwarzaj wyłącznie w nowym projekcie/wolumenach; replay kasowań musi poprzedzić readiness. Skrypt `restore.sh` nie usuwa istniejących wolumenów. |

Zbieraj identyfikatory, czas i bezpieczne kody błędów. Nie włączaj request body, haseł, connection strings, PESEL-u, danych kontaktowych, OTP, cookies ani zrzutów ekranów portali do zwykłych logów.

## Ograniczenia odbioru

Runner, progi health i runbook są przygotowane lokalnie. Nie podłączono zewnętrznego monitoringu/alarmów, nie ustalono dyżuru ani celu kopii. Testy awarii DB/Redis/parsera, restartu VPS i limitów dysku wymagają izolowanego Docker Engine i nie są zaliczone przez samą dokumentację.

## Odzyskiwanie kont i Resend

Funkcja pozostaje wyłączona do czasu dodania domeny do Resend, publikacji dokładnych rekordów z panelu dostawcy w aktywnej strefie DNS, uzyskania HTTPS dla `PUBLIC_APP_ORIGIN` i przygotowania dwóch sekretów API. Sam status `submitted` znaczy, że Resend przyjął wiadomość; nie potwierdza dostarczenia do skrzynki. Panel administratora pokazuje liczniki oczekujących i błędnych zadań, ale wiadomość resetu nadal powinna zostać sprawdzona w logach Resend i w skrzynce syntetycznego odbiorcy.

Przy błędach wysyłki sprawdź kolejkę i bezpieczny `last_error_code`, stan klucza oraz weryfikację domeny w Resend. Zleć użytkownikowi nowe zgłoszenie dopiero po naprawie; nie kopiuj linku z bazy ani logów. Jeżeli klucz Resend wyciekł, wyłącz funkcję (`GOLDIS_PASSWORD_RECOVERY_ENABLED=0`, provider `disabled`), odwołaj klucz w Resend, zapisz nowy ograniczony klucz do `/etc/goldis/secrets/resend_api_key`, zachowaj prawa `root:root 0600` i odtwórz kontener API. Następnie wykonaj syntetyczną wysyłkę przed ponownym włączeniem.

Rotacja klucza szyfrującego wymaga zachowania starych wersji, dopóki outbox może zawierać wiadomość w stanie `pending` lub `processing` zaszyfrowaną daną wersją. Dodaj nowy losowy klucz 32-bajtowy do JSON keyringu, zwiększ `AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION` i wdroż nową konfigurację. Dopiero po sprawdzeniu, że żadna oczekująca/przetwarzana wiadomość nie używa starej wersji, usuń stary klucz. Nie nadpisuj keyringu pustą wartością i nie uruchamiaj skryptu generującego sekrety w sposób, który zastępuje istniejący plik.

Weryfikację wersji wykonaj na bazie produkcyjnej przez uprawnioną, lokalną sesję administracyjną PostgreSQL:

```sql
SELECT key_version, status, count(*)
FROM auth_mail_outbox
GROUP BY key_version, status
ORDER BY key_version, status;
```

Jeśli administrator utracił dostęp do skrzynki odzyskiwania, zweryfikuj jego tożsamość poza panelem, dostęp SSH do VPS i właściwy host/projekt. Nie zmieniaj hasła przez SQL ani bootstrap. Wstrzymaj frontend, API, parser i workery; pozostaw bazę działającą. Interaktywnie uruchom istniejącą, ograniczoną komendę:

```sh
docker compose --project-name goldis --env-file /etc/goldis/env.production \
  -f compose.yaml -f compose.production.yaml stop web api import-parser enrichment-worker worker

docker compose --project-name goldis --env-file /etc/goldis/env.production \
  -f compose.yaml -f compose.production.yaml run --rm --no-deps -it \
  -e GOLDIS_OFFLINE_ADMIN_RECOVERY=VERIFIED_VPS_OPERATOR \
  api node apps/api/scripts/offline-admin-password-reset.cjs <login-administratora>

docker compose --project-name goldis --env-file /etc/goldis/env.production \
  -f compose.yaml -f compose.production.yaml start api web import-parser enrichment-worker worker
```

Komenda działa tylko w `APP_ENV=production`, wymaga dokładnego hosta DB `postgres:5432/goldis`, jednego aktywnego konta admina Goldis i interaktywnego TTY. Nowe hasło wpisuje się dwa razy bez echa i bez argumentu procesu. Operacja przez wspólny helper zwiększa rewizję poświadczeń, unieważnia wszystkie sesje i linki odzyskiwania oraz zapisuje audyt `password.changed` z powodem `offline_admin_recovery`. Nie wydaje nowej sesji; administrator loguje się normalnie. Po zalogowaniu należy dodać indywidualny adres odzyskiwania i zweryfikować go wiadomością.

Nie uruchamiaj tej procedury jako testu na produkcji. Najpierw zweryfikuj dokładny login i prawo do konta drugim kanałem. Funkcja, która wprowadza nowe hasło, nie może służyć do przejmowania konta na podstawie samego dostępu do interfejsu WWW.
