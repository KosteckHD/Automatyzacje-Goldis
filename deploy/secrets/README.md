# Sekrety Compose

Compose montuje pliki z katalogu `GOLDIS_SECRETS_DIR` jako pliki Docker secrets. Kontenery nie dostają haseł baz danych, hasła Redis, hasła pierwszego administratora ani kluczy szyfrujących jako wartości środowiskowych. Entry point Node odczytuje wyłącznie stałe ścieżki pod `/run/secrets/`; loguje tylko kod błędu.

Wymagane pliki (UTF-8, bez końcowego tekstu opisowego):

`database_password`, `migrator_db_password`, `api_db_password`, `worker_db_password`, `enrichment_db_password`, `redis_api_password`, `redis_worker_password`, `database_url_migrator`, `database_url_api`, `database_url_worker`, `database_url_enrichment`, `redis_url_api`, `redis_url_worker`, `session_secret`, `login_rate_limit_secret`, `privileged_action_binding_key`, `admin_user`, `admin_password`, `pesel_keyring`, `artifact_keyring`, `worker_auth_secret`, `import_parser_secret`, `registry_cache_key`, `pzu_login`, `pzu_password`, `compensa_login`, `compensa_password`, `worker_staging_key`, `resend_api_key`, `auth_mail_keyring`.

Odzyskiwanie hasła przez Resend jest domyślnie wyłączone (`GOLDIS_PASSWORD_RECOVERY_ENABLED=0`). `resend_api_key` jest kluczem Resend z prawem wysyłki ograniczonym do zweryfikowanej domeny. `auth_mail_keyring` zawiera base64-encoded JSON mapujący wersję klucza na osobny 32-bajtowy klucz AES-256-GCM; to inny sekret niż API key. `AUTH_MAIL_ENCRYPTION_ACTIVE_KEY_VERSION` w pliku środowiska wskazuje aktywną wersję. Windowsowy `Write-GoldisComposeSecrets.ps1` tworzy keyring, jeśli jeszcze go nie ma, i zachowuje istniejący podczas kolejnych zapisów sekretów.

Adresy DB w plikach URL muszą używać hosta `postgres` i portu `5432`; `redis_url_api` to `redis://goldis_api:<hasło API>@redis:6379/0`, a `redis_url_worker` używa `goldis_worker` i osobnego hasła. Hasła DB i Redis mają być losowe. Klucze PESEL/artefaktów to base64 JSON z 32-bajtowymi kluczami, a klucz stagingu jest base64url 32 bajtów. Pliki `pzu_*` i `compensa_*` mogą być puste, dopóki `WORKER_LIVE_PORTALS=0`.

Na Linuxie katalog ustaw jako `/etc/goldis/secrets`, właściciel `root`, tryb `0700`; pliki tryb `0600`. Nie zapisuj ich w repozytorium, obrazie, kopii danych tej samej klasy co backup ani w logach. Windowsowy `Initialize-GoldisLocal.ps1` i `Start-GoldisLocal.ps1` synchronizują lokalne pliki do ACL-chronionego katalogu użytkownika.

W Compose user `default` Redis jest wyłączony. `goldis_api` ma dostęp do kluczy `goldis:*` limitera i kolejki `oc-verification`; `goldis_worker` widzi tylko tę kolejkę. Hasła i ACL są rozdzielone, a konta nie dostają kategorii administracyjnych ani niebezpiecznych. Kontrola Redis po starcie musi potwierdzić odrzucenie `ACL`, `CONFIG`, `SHUTDOWN`, `FLUSHALL` i `FLUSHDB`, a także poprawne działanie skryptów rate-limit/BullMQ.
