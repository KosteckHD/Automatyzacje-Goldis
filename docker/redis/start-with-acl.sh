#!/bin/sh
set -eu

: "${REDIS_API_PASSWORD_FILE:?REDIS_API_PASSWORD_FILE is required}"
: "${REDIS_WORKER_PASSWORD_FILE:?REDIS_WORKER_PASSWORD_FILE is required}"
for password_file in "$REDIS_API_PASSWORD_FILE" "$REDIS_WORKER_PASSWORD_FILE"; do
  [ -f "$password_file" ] && [ -r "$password_file" ] || { echo "REDIS_PASSWORD_UNAVAILABLE" >&2; exit 1; }
done
REDIS_API_PASSWORD="$(cat "$REDIS_API_PASSWORD_FILE")"
REDIS_WORKER_PASSWORD="$(cat "$REDIS_WORKER_PASSWORD_FILE")"
for password in "$REDIS_API_PASSWORD" "$REDIS_WORKER_PASSWORD"; do
  case "$password" in *[!A-Fa-f0-9]*|"") echo "REDIS_PASSWORD_INVALID" >&2; exit 1 ;; esac
  if [ "${#password}" -lt 64 ]; then echo "REDIS_PASSWORD_INVALID" >&2; exit 1; fi
done

acl_file=/run/goldis-redis/users.acl
mkdir -p /run/goldis-redis
umask 077
api_password_hash="$(printf '%s' "$REDIS_API_PASSWORD" | sha256sum | awk '{print $1}')"
worker_password_hash="$(printf '%s' "$REDIS_WORKER_PASSWORD" | sha256sum | awk '{print $1}')"
printf '%s\n' \
  'user default off' \
  "user goldis_api on #$api_password_hash ~goldis:* ~bull:oc-verification:* &bull:oc-verification:* +@all -@admin -@dangerous +info" \
  "user goldis_worker on #$worker_password_hash ~bull:oc-verification:* &bull:oc-verification:* +@all -@admin -@dangerous +info" > "$acl_file"
chown redis:redis "$acl_file" /run/goldis-redis
chmod 0600 "$acl_file"
exec su-exec redis redis-server --appendonly yes --aclfile "$acl_file"
