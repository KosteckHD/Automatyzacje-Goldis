# Kopia i odtwarzanie na Linuxie

Skrypty tworzą zaszyfrowany lokalny pakiet testowy. Nie konfiguruje się tu dostawcy zewnętrznego, harmonogramu ani retencji. Hasło backupu musi być przechowywane osobno od obu plików kopii. Archiwum i aktualny dziennik kasowań trzeba później wysłać do odseparowanego celu jako dwie wymagane części.

## Wymagania

- Linux z Bash 5, Docker Engine/Compose, Node.js, GNU tar/coreutils, `flock`, `curl` i `ss`;
- aktywny projekt produkcyjny Compose `goldis`, poprawne digesty pięciu obrazów i wszystkie sekrety;
- `.env.production` poza repo, katalog sekretów poza repo i plik hasła tryb `0600`, minimum 16 bajtów;
- lokalny, prywatny katalog docelowy na tyle duży, by przechować zaszyfrowany pakiet i pliki tymczasowe. Nie umieszczaj go w katalogu repo, sekretów, eksportów ani w tym samym wolumenie aplikacyjnym.

Skrypty zatrzymują web/API/parser/workery, pozostawiają PostgreSQL/Redis, wykonują dump i kopiują artefakty/checkpointy/journal, a potem odtwarzają wyłącznie usługi, które wcześniej działały. API musi wrócić do health `healthy`; inaczej downstream pozostają zatrzymane i komenda kończy się błędem. Przerwanie backupu nie usuwa wolumenów. Workdir jest prywatny (`0700`) i sprzątany, choć zwykłe usunięcie pliku nie gwarantuje fizycznego nadpisania nośnika SSD.

## Backup

Przygotuj folder lokalny i plik hasła poza repo. Nie ustawiaj hasła w argumentach procesu ani terminalu. Następnie:

```sh
GOLDIS_ENV_FILE=/etc/goldis/env.production \
GOLDIS_SECRETS_DIR=/etc/goldis/secrets \
GOLDIS_COMPOSE_PROJECT=goldis \
GOLDIS_BACKUP_TARGET_DIR=/var/backups/goldis-test \
GOLDIS_BACKUP_PASSPHRASE_FILE=/etc/goldis/backup-passphrase \
bash deploy/backup/backup.sh
```

Wynik to `goldis-platform-<UTC>-<id>.goldis-backup` oraz atomowo odświeżany `goldis-deletion-journal-current.goldis-backup`. Oba zaszyfrowane pliki są wymagane. Pierwszy zawiera dump PostgreSQL, eksporty, staging, runtime secrets, plik środowiska, manifest release i journal z HMAC key. Drugi zawiera aktualny journal/key, który może być nowszy od historycznego dumpu. Manifest nie ujawnia wartości sekretów; zawiera rozmiary, checksums, digesty obrazów, migration head i head journala.

Skrypt nie wykonuje purge. Wysyłaj oba pliki i osobną kopię hasła/klucza odtworzenia do ustalonego celu. Synchronizacja zewnętrzna nie jest zaimplementowana ani aktywna.

## Weryfikacja

```sh
GOLDIS_BACKUP_PASSPHRASE_FILE=/etc/goldis/backup-passphrase \
  bash deploy/backup/verify.sh /var/backups/goldis-test/goldis-platform-<UTC>-<id>.goldis-backup

GOLDIS_BACKUP_PASSPHRASE_FILE=/etc/goldis/backup-passphrase \
  bash deploy/backup/verify.sh --journal /var/backups/goldis-test/goldis-deletion-journal-current.goldis-backup
```

Weryfikacja sprawdza uwierzytelnienie szyfrowania, bezpieczne ścieżki archiwum, manifest/checksumy, HMAC i ciągłość journala oraz spis dumpu przez `pg_restore --list` w kontenerze z przypiętego obrazu. To nie jest jeszcze test pełnego cold restore.

## Odtworzenie w kwarantannie

Restore nigdy nie używa istniejącego projektu `goldis`, nie nadpisuje jego wolumenów i nie usuwa danych. Wymaga nowej nazwy zaczynającej się od `goldis-restore-`, jawnego potwierdzenia, aktualnego journala i wolnego portu loopback. Skrypt:

1. Odszyfrowuje i weryfikuje oba archiwa w prywatnym katalogu tymczasowym.
2. Potwierdza, że aktualny journal kryptograficznie przedłuża head zapisany w kopii.
3. Zachowuje sekrety/konfigurację odtworzenia w `/var/lib/goldis/restores/<projekt>` z restrykcyjnymi prawami.
4. Tworzy wyłącznie nowe wolumeny projektu, startuje bazę/role, przywraca dump, uruchamia aktualne migracje i granty, kopiuje eksporty/staging/journal i odtwarza brakujące kasowania.
5. Przed uruchomieniem web/API unieważnia wszystkie niezużyte linki resetu/weryfikacji oraz anuluje oczekujące/przetwarzane wiadomości odzyskiwania. Odtworzone dane nie mogą ponownie aktywować starych linków ani wysłać ich z kolejki.
6. Uruchamia web/API/Redis tylko po replay i unieważnieniu, testuje readiness i stronę przez port loopback. Portal-workera nie uruchamia i wymusza `WORKER_LIVE_PORTALS=0`.

Przykładowe użycie po przygotowaniu plików i wolnego portu:

```sh
GOLDIS_RESTORE_CONFIRM=RESTORE_TO_NEW_ISOLATED_PROJECT \
GOLDIS_RESTORE_PROJECT=goldis-restore-20261013a \
GOLDIS_RESTORE_WEB_PORT=18080 \
GOLDIS_RESTORE_LATEST_JOURNAL=/var/backups/goldis-test/goldis-deletion-journal-current.goldis-backup \
GOLDIS_BACKUP_PASSPHRASE_FILE=/etc/goldis/backup-passphrase \
bash deploy/backup/restore.sh /var/backups/goldis-test/goldis-platform-<UTC>-<id>.goldis-backup
```

Po sukcesie projekt pozostaje uruchomiony w kwarantannie na loopback, a workery są wyłączone. Porównaj rekordy i wyniki przy użyciu zatwierdzonego syntetycznego scenariusza przed jakimkolwiek ruchem na domenie. Po błędzie usługi są zatrzymywane, a częściowe wolumeny zachowane do przeglądu; skrypt niczego nie usuwa automatycznie. Usunięcie projektu i wolumenów jest oddzielną operacją administratora po potwierdzeniu retencji.

## Co wymaga odbioru

`npm run test:backup-crypto` i `npm run test:backup-manifest` sprawdzają szyfrowanie, checksums i journal na syntetycznych plikach. Komendy Linuxa wymagają `bash -n`; pełna walidacja PostgreSQL/Compose i odtworzenie muszą być wykonane na izolowanym Linux/Docker Engine. Do wyboru pozostały: zewnętrzny storage, synchronizacja obu archiwów, klucz/escrow, harmonogram, retencja, cold restore na drugim hoście i zmierzone RPO/RTO.
