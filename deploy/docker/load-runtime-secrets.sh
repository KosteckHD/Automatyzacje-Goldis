#!/bin/sh
set -eu

load_secret() {
  name="$1"
  file_name="${name}_FILE"
  eval "secret_path=\${$file_name:-}"
  [ -n "$secret_path" ] || return 0
  case "$secret_path" in
    /run/secrets/[A-Za-z0-9_-]*) ;;
    *) echo "RUNTIME_SECRET_PATH_INVALID" >&2; exit 1 ;;
  esac
  [ -f "$secret_path" ] && [ -r "$secret_path" ] || { echo "RUNTIME_SECRET_UNAVAILABLE" >&2; exit 1; }
  secret_value="$(cat "$secret_path")"
  export "$name=$secret_value"
  unset "$file_name" secret_path secret_value
}

for name in \
  DATABASE_URL REDIS_URL SESSION_SECRET LOGIN_RATE_LIMIT_SECRET PRIVILEGED_ACTION_BINDING_KEY GOLDIS_ADMIN_USER GOLDIS_ADMIN_PASSWORD \
  PESEL_ENCRYPTION_KEYS_BASE64 ARTIFACT_ENCRYPTION_KEYS_BASE64 WORKER_AUTH_SECRET IMPORT_PARSER_SHARED_SECRET \
  REGISTRY_CACHE_HMAC_KEY PZU_LOGIN PZU_PASSWORD COMPENSA_LOGIN COMPENSA_PASSWORD WORKER_STAGING_KEY_V1 \
  RESEND_API_KEY AUTH_MAIL_ENCRYPTION_KEYS_BASE64
do
  load_secret "$name"
done

exec "$@"
