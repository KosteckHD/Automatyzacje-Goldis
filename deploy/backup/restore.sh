#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
set +x

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
crypto_tool="$repo_root/scripts/goldis-backup-crypto.cjs"
manifest_tool="$repo_root/deploy/backup/manifest.cjs"
backup_archive="${1:-}"
journal_archive="${GOLDIS_RESTORE_LATEST_JOURNAL:-}"
passphrase_file="${GOLDIS_BACKUP_PASSPHRASE_FILE:-}"
restore_project="${GOLDIS_RESTORE_PROJECT:-}"
restore_base="${GOLDIS_RESTORE_BASE:-/var/lib/goldis/restores}"
web_port="${GOLDIS_RESTORE_WEB_PORT:-}"
restore_root=""
work_dir=""
compose_args=()
started=0

die() { printf '%s\n' "$1" >&2; exit 1; }
validate_tar_paths() {
  local archive="$1" entry clean part
  tar -tzf "$archive" >/dev/null 2>&1 || die "RESTORE_ARCHIVE_INVALID"
  tar -tvzf "$archive" | awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { invalid = 1 } END { exit invalid ? 1 : 0 }' || die "RESTORE_ARCHIVE_LINK_OR_SPECIAL_FILE_FORBIDDEN"
  while IFS= read -r entry; do
    [[ -n "$entry" && "$entry" != /* && "$entry" != *'\'* && "$entry" != *$'\n'* && "$entry" != *$'\r'* ]] || die "RESTORE_ARCHIVE_PATH_INVALID"
    clean="${entry%/}"
    IFS='/' read -r -a parts <<< "$clean"
    for part in "${parts[@]}"; do [[ -n "$part" && "$part" != . && "$part" != .. ]] || die "RESTORE_ARCHIVE_PATH_INVALID"; done
  done < <(tar -tzf "$archive")
}
compose() {
  GOLDIS_SECRETS_DIR="$restore_root/secrets" GOLDIS_WEB_HOST_PORT="$web_port" WORKER_LIVE_PORTALS=0 \
    docker compose --project-name "$restore_project" --env-file "$restore_root/env.production" \
    -f "$repo_root/compose.yaml" -f "$repo_root/compose.production.yaml" "$@"
}
cleanup() {
  local status=$?
  trap - EXIT
  if (( started )); then
    compose stop --timeout 30 web api redis postgres >/dev/null 2>&1 || true
  fi
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    local base_real work_real
    base_real="$(realpath -m "${TMPDIR:-/tmp}")"
    work_real="$(realpath -m "$work_dir")"
    case "$work_real" in "$base_real"/goldis-restore-work.*) rm -rf -- "$work_real" ;; *) printf '%s\n' "RESTORE_TEMP_PATH_OWNERSHIP_INVALID" >&2; status=1 ;; esac
  fi
  if (( status != 0 )) && [[ -n "$restore_project" ]]; then
    printf 'RESTORE_FAILED project=%s volumes_preserved=true services_stopped=true\n' "$restore_project" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

[[ "${GOLDIS_RESTORE_CONFIRM:-}" == "RESTORE_TO_NEW_ISOLATED_PROJECT" ]] || die "RESTORE_EXPLICIT_ISOLATED_PROJECT_CONFIRMATION_REQUIRED"
[[ "$restore_project" =~ ^goldis-restore-[a-z0-9-]{6,28}$ ]] || die "RESTORE_PROJECT_NAME_INVALID"
[[ -n "$backup_archive" && -f "$backup_archive" && ! -L "$backup_archive" ]] || die "RESTORE_BACKUP_ARCHIVE_REQUIRED"
[[ -n "$journal_archive" && -f "$journal_archive" && ! -L "$journal_archive" ]] || die "RESTORE_CURRENT_JOURNAL_ARCHIVE_REQUIRED"
[[ -n "$passphrase_file" && -f "$passphrase_file" && ! -L "$passphrase_file" && -r "$passphrase_file" ]] || die "BACKUP_PASSPHRASE_FILE_REQUIRED"
[[ "$(stat -c '%s' "$passphrase_file")" -ge 16 ]] || die "BACKUP_PASSPHRASE_TOO_SHORT"
mode="$(stat -c '%a' "$passphrase_file")"
(( (8#$mode & 077) == 0 )) || die "BACKUP_PRIVATE_FILE_PERMISSIONS_INVALID"
[[ "$web_port" =~ ^[0-9]{4,5}$ ]] && (( web_port >= 18000 && web_port <= 65535 )) || die "RESTORE_LOOPBACK_PORT_REQUIRED"
for command in docker node tar stat realpath install cp chmod chown ss curl sleep; do command -v "$command" >/dev/null 2>&1 || die "RESTORE_REQUIRED_COMMAND_MISSING"; done
[[ -z "$(ss -H -ltn "sport = :$web_port")" ]] || die "RESTORE_LOOPBACK_PORT_IN_USE"
[[ "$(id -u)" == 0 ]] || die "RESTORE_MUST_RUN_AS_ROOT_FOR_PRIVATE_SECRETS"

[[ ! -L "$restore_base" ]] || die "RESTORE_BASE_SYMLINK_UNSUPPORTED"
install -d -m 0700 "$restore_base"
restore_base="$(realpath -e "$restore_base")"
[[ ! -L "$restore_base" ]] || die "RESTORE_BASE_SYMLINK_UNSUPPORTED"
[[ ! -e "$restore_base/$restore_project" && ! -L "$restore_base/$restore_project" ]] || die "RESTORE_PROJECT_DIRECTORY_ALREADY_EXISTS"
restore_root="$restore_base/$restore_project"
install -d -m 0700 "$restore_root" "$restore_root/secrets"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/goldis-restore-work.XXXXXX")"
chmod 0700 "$work_dir"
GOLDIS_BACKUP_PASSPHRASE="$(<"$passphrase_file")" node "$crypto_tool" decrypt "$backup_archive" "$work_dir/platform.tar.gz" >/dev/null 2>&1 || die "RESTORE_BACKUP_DECRYPT_OR_AUTHENTICATION_FAILED"
GOLDIS_BACKUP_PASSPHRASE="$(<"$passphrase_file")" node "$crypto_tool" decrypt "$journal_archive" "$work_dir/latest-journal.tar.gz" >/dev/null 2>&1 || die "RESTORE_LATEST_JOURNAL_DECRYPT_OR_AUTHENTICATION_FAILED"
validate_tar_paths "$work_dir/platform.tar.gz"
validate_tar_paths "$work_dir/latest-journal.tar.gz"
mkdir -m 0700 "$work_dir/platform" "$work_dir/latest-journal"
tar --no-same-owner --no-same-permissions -xzf "$work_dir/platform.tar.gz" -C "$work_dir/platform" || die "RESTORE_BACKUP_EXTRACT_FAILED"
tar --no-same-owner --no-same-permissions -xzf "$work_dir/latest-journal.tar.gz" -C "$work_dir/latest-journal" || die "RESTORE_LATEST_JOURNAL_EXTRACT_FAILED"
payload="$work_dir/platform/payload"
latest_journal="$work_dir/latest-journal/current-journal/deletion-journal"
[[ -d "$payload" && -d "$latest_journal" && -f "$payload/database.dump" && -f "$payload/config/env.production" ]] || die "RESTORE_REQUIRED_FILES_MISSING"
node "$manifest_tool" verify "$payload" >/dev/null || die "RESTORE_BACKUP_MANIFEST_INVALID"
backup_sequence="$(node -e 'process.stdout.write(String(require(process.argv[1]).deletionJournalHead.sequence))' "$payload/manifest.json")"
backup_hash="$(node -e 'process.stdout.write(require(process.argv[1]).deletionJournalHead.hash)' "$payload/manifest.json")"
node "$manifest_tool" verify-journal "$latest_journal" "$backup_sequence" "$backup_hash" >/dev/null || die "RESTORE_CURRENT_JOURNAL_NOT_A_VALID_EXTENSION"
cp -a -- "$latest_journal/." "$payload/deletion-journal/"
node "$manifest_tool" verify-journal "$payload/deletion-journal" >/dev/null || die "RESTORE_CURRENT_JOURNAL_INVALID"
cp -- "$payload/manifest.json" "$restore_root/source-manifest.json"
cp -- "$payload/config/env.production" "$restore_root/env.production"
cp -a -- "$payload/secrets/." "$restore_root/secrets/"
for name in resend_api_key auth_mail_keyring; do
  if [[ ! -f "$restore_root/secrets/$name" || -L "$restore_root/secrets/$name" ]]; then
    install -m 0600 /dev/null "$restore_root/secrets/$name"
  fi
done
chmod 0700 "$restore_root" "$restore_root/secrets"
find "$restore_root/secrets" -type d -exec chmod 0700 {} +
find "$restore_root/secrets" -type f -exec chmod 0600 {} +
chmod 0600 "$restore_root/env.production" "$restore_root/source-manifest.json"

compose_args=(--project-name "$restore_project" --env-file "$restore_root/env.production" -f "$repo_root/compose.yaml" -f "$repo_root/compose.production.yaml")
GOLDIS_SECRETS_DIR="$restore_root/secrets" GOLDIS_WEB_HOST_PORT="$web_port" WORKER_LIVE_PORTALS=0 \
  docker compose "${compose_args[@]}" config --quiet >/dev/null 2>&1 || die "RESTORE_PRODUCTION_COMPOSE_INVALID"
recovery_enabled="$(GOLDIS_SECRETS_DIR="$restore_root/secrets" GOLDIS_WEB_HOST_PORT="$web_port" docker compose "${compose_args[@]}" config --format json \
  | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(JSON.parse(s).services.api.environment.GOLDIS_PASSWORD_RECOVERY_ENABLED||"0"))')" || die "RESTORE_RECOVERY_CONFIGURATION_READ_FAILED"
if [[ "$recovery_enabled" == "1" ]]; then
  [[ -s "$restore_root/secrets/resend_api_key" && -s "$restore_root/secrets/auth_mail_keyring" ]] || die "RESTORE_RECOVERY_SECRETS_MISSING"
fi
existing="$(GOLDIS_SECRETS_DIR="$restore_root/secrets" GOLDIS_WEB_HOST_PORT="$web_port" docker compose "${compose_args[@]}" ps -aq 2>/dev/null)"
[[ -z "$existing" ]] || die "RESTORE_PROJECT_CONTAINERS_ALREADY_EXIST"
for volume in postgres_data redis_data worker_profile worker_staging export_data deletion_journal web_cache; do
  docker volume inspect "${restore_project}_${volume}" >/dev/null 2>&1 && die "RESTORE_PROJECT_VOLUME_ALREADY_EXISTS"
done
for network in goldis_frontend goldis_data goldis_parser; do
  docker network inspect "${restore_project}_${network}" >/dev/null 2>&1 && die "RESTORE_PROJECT_NETWORK_ALREADY_EXISTS"
done

compose up -d postgres >/dev/null || die "RESTORE_POSTGRES_START_FAILED"
started=1
compose run --rm --no-deps db-roles >/dev/null || die "RESTORE_DATABASE_ROLES_FAILED"
cat "$payload/database.dump" | compose exec -T postgres pg_restore -U goldis -d goldis --no-owner --exit-on-error >/dev/null 2>&1 || die "RESTORE_DATABASE_IMPORT_FAILED"
compose run --rm --no-deps migrate >/dev/null || die "RESTORE_MIGRATION_OR_RUNTIME_GRANTS_FAILED"

config_json="$(GOLDIS_SECRETS_DIR="$restore_root/secrets" GOLDIS_WEB_HOST_PORT="$web_port" docker compose "${compose_args[@]}" config --format json)" || die "RESTORE_IMAGE_CONFIG_FAILED"
api_image="$(node -e 'const c=JSON.parse(process.argv[1]);process.stdout.write(c.services.api.image)' "$config_json")"
worker_image="$(node -e 'const c=JSON.parse(process.argv[1]);process.stdout.write(c.services.worker.image)' "$config_json")"
[[ "$api_image" =~ ^.+@sha256:[a-f0-9]{64}$ && "$worker_image" =~ ^.+@sha256:[a-f0-9]{64}$ ]] || die "RESTORE_IMAGE_DIGEST_INVALID"
copy_into_volume() {
  local image="$1" volume="$2" source="$3"
  docker volume create "$volume" >/dev/null || die "RESTORE_VOLUME_CREATE_FAILED"
  docker run --rm --network none --entrypoint /bin/sh \
    --mount "type=volume,source=$volume,target=/target" \
    --mount "type=bind,source=$source,target=/source,readonly" \
    "$image" -c 'cp -a /source/. /target/ && chown -R 1000:1000 /target' >/dev/null 2>&1 || die "RESTORE_FILE_VOLUME_IMPORT_FAILED"
}
copy_into_volume "$api_image" "${restore_project}_export_data" "$payload/exports"
copy_into_volume "$worker_image" "${restore_project}_worker_staging" "$payload/staging"
copy_into_volume "$api_image" "${restore_project}_deletion_journal" "$payload/deletion-journal"
compose run --rm --no-deps -e GOLDIS_RESTORE_MAINTENANCE=1 api node apps/api/scripts/apply-deletion-journal.cjs >/dev/null || die "RESTORE_DELETION_JOURNAL_REPLAY_FAILED"
compose run --rm --no-deps -e GOLDIS_RESTORE_MAINTENANCE=1 api node apps/api/scripts/purge-account-recovery.cjs >/dev/null || die "RESTORE_RECOVERY_INVALIDATION_FAILED"

compose up -d web >/dev/null || die "RESTORE_QUARANTINE_WEB_START_FAILED"
for attempt in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$web_port/api/health/ready" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$web_port/api/health/ready" >/dev/null 2>&1 || die "RESTORE_READINESS_SMOKE_FAILED"
http_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 5 "http://127.0.0.1:$web_port/" 2>/dev/null)" || die "RESTORE_WEB_SMOKE_FAILED"
[[ "$http_status" =~ ^[23][0-9][0-9]$ ]] || die "RESTORE_WEB_SMOKE_FAILED"
printf 'RESTORE_QUARANTINE_READY project=%s loopback_port=%s workers_started=false live_portals=off journal_replayed=true\n' "$restore_project" "$web_port"
printf 'Dane odtworzone w nowych wolumenach. Web/API działają wyłącznie lokalnie; worker portalowy nie został uruchomiony. Root odtworzenia: %s\n' "$restore_root"
started=0
