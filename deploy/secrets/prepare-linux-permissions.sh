#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
die() { printf '%s\n' "$1" >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || die SECRETS_ROOT_REQUIRED
directory="${1:-}"
[[ -n "$directory" && -d "$directory" && ! -L "$directory" ]] || die SECRETS_DIRECTORY_REQUIRED
directory="$(realpath -e "$directory")"
[[ "$directory" != / ]] || die SECRETS_DIRECTORY_INVALID
# Compose binds files directly; the private host directory stays root-only.
for name in database_url_migrator database_url_api database_url_worker database_url_enrichment database_url_commission \
  redis_url_api redis_url_worker redis_url_commission session_secret login_rate_limit_secret privileged_action_binding_key \
  admin_user admin_password pesel_keyring artifact_keyring worker_auth_secret import_parser_secret registry_cache_key \
  pzu_login pzu_password compensa_login compensa_password worker_staging_key resend_api_key auth_mail_keyring commission_engine_secret; do
  file="$directory/$name"
  [[ -f "$file" && ! -L "$file" ]] || die SECRETS_REQUIRED_FILE_MISSING
done
chown root:root "$directory"
chmod 0700 "$directory"
for name in database_url_migrator database_url_api database_url_worker database_url_enrichment database_url_commission \
  redis_url_api redis_url_worker redis_url_commission session_secret login_rate_limit_secret privileged_action_binding_key \
  admin_user admin_password pesel_keyring artifact_keyring worker_auth_secret import_parser_secret registry_cache_key \
  pzu_login pzu_password compensa_login compensa_password worker_staging_key resend_api_key auth_mail_keyring commission_engine_secret; do
  chown root:1000 "$directory/$name"
  chmod 0640 "$directory/$name"
done
printf '%s\n' SECRETS_RUNTIME_PERMISSIONS_PREPARED
