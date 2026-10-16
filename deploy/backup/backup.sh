#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
set +x

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
env_file="${GOLDIS_ENV_FILE:-$repo_root/.env.production}"
secrets_dir="${GOLDIS_SECRETS_DIR:-}"
target_dir="${GOLDIS_BACKUP_TARGET_DIR:-}"
passphrase_file="${GOLDIS_BACKUP_PASSPHRASE_FILE:-}"
project="${GOLDIS_COMPOSE_PROJECT:-goldis}"
manifest_tool="$repo_root/deploy/backup/manifest.cjs"
crypto_tool="$repo_root/scripts/goldis-backup-crypto.cjs"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_id="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
work_dir=""
compose_args=()
declare -A container_ids=()
declare -A initially_running=()
restart_failed=0
partial_files=()

die() { printf '%s\n' "$1" >&2; exit 1; }
paths_overlap() {
  local first="$1" second="$2"
  [[ "$first" == "$second" || "$first" == "$second"/* || "$second" == "$first"/* ]]
}
require_private_file() {
  local file="$1" mode
  [[ -f "$file" && ! -L "$file" && -r "$file" ]] || die "BACKUP_PRIVATE_FILE_INVALID"
  mode="$(stat -c '%a' "$file")"
  (( (8#$mode & 077) == 0 )) || die "BACKUP_PRIVATE_FILE_PERMISSIONS_INVALID"
}
check_owned_container() {
  local id="$1" service="$2" meta
  [[ -n "$id" ]] || die "BACKUP_SERVICE_CONTAINER_MISSING"
  meta="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Running}}' "$id" 2>/dev/null)" || die "BACKUP_SERVICE_OWNERSHIP_INVALID"
  [[ "$meta" == "$project|$service|true" || "$meta" == "$project|$service|false" ]] || die "BACKUP_SERVICE_OWNERSHIP_INVALID"
}
resume_original_services() {
  local service api_state attempt
  for service in import-parser; do
    if [[ "${initially_running[$service]:-false}" == true ]]; then
      docker compose "${compose_args[@]}" start "$service" >/dev/null 2>&1 || restart_failed=1
    fi
  done
  if [[ "${initially_running[api]:-false}" == true ]]; then
    docker compose "${compose_args[@]}" start api >/dev/null 2>&1 || restart_failed=1
    for attempt in $(seq 1 60); do
      api_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_ids[api]}" 2>/dev/null || true)"
      [[ "$api_state" == healthy ]] && break
      sleep 2
    done
    if [[ "$api_state" != healthy ]]; then
      printf '%s\n' "BACKUP_API_DID_NOT_RETURN_HEALTHY; downstream worker/web services remain stopped" >&2
      restart_failed=1
      return
    fi
  elif [[ "${initially_running[web]:-false}" == true || "${initially_running[worker]:-false}" == true || "${initially_running[enrichment-worker]:-false}" == true ]]; then
    restart_failed=1
    return
  fi
  for service in web enrichment-worker worker; do
    if [[ "${initially_running[$service]:-false}" == true ]]; then
      docker compose "${compose_args[@]}" start "$service" >/dev/null 2>&1 || {
        printf 'BACKUP_SERVICE_RESTART_FAILED service=%s\n' "$service" >&2
        restart_failed=1
      }
    fi
  done
}
cleanup() {
  local status=$?
  trap - EXIT
  resume_original_services
  if [[ "${initially_running[web]:-false}" == true && "${initially_running[api]:-false}" == true && $restart_failed -eq 0 ]]; then
    local port="${GOLDIS_WEB_HOST_PORT:-3000}" attempt
    for attempt in $(seq 1 30); do
      if curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$port/api/health/ready" >/dev/null 2>&1; then break; fi
      sleep 2
    done
    if ! curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$port/api/health/ready" >/dev/null 2>&1; then
      printf '%s\n' "BACKUP_POST_RESTART_READINESS_FAILED" >&2
      restart_failed=1
    fi
  fi
  (( restart_failed == 0 )) || status=1
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    local resolved_target resolved_work
    resolved_target="$(realpath -m "$target_dir")"
    resolved_work="$(realpath -m "$work_dir")"
    case "$resolved_work" in "$resolved_target"/.goldis-backup-work-*) ;; *) die "BACKUP_TEMP_PATH_OWNERSHIP_INVALID" ;; esac
    rm -rf -- "$resolved_work"
  fi
  for partial in "${partial_files[@]}"; do
    [[ "$(dirname "$partial")" == "$(realpath -m "$target_dir")" && "$(basename "$partial")" == .*\.partial ]] && rm -f -- "$partial"
  done
  if (( status != 0 )); then
    printf '%s\n' "BACKUP_FAILED services_were_restarted_if_previously_running=true" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

[[ -n "$secrets_dir" && -d "$secrets_dir" && ! -L "$secrets_dir" ]] || die "BACKUP_SECRETS_DIRECTORY_REQUIRED"
[[ -n "$target_dir" ]] || die "BACKUP_TARGET_DIRECTORY_REQUIRED"
[[ -n "$passphrase_file" ]] || die "BACKUP_PASSPHRASE_FILE_REQUIRED"
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{1,62}$ ]] || die "BACKUP_COMPOSE_PROJECT_INVALID"
require_private_file "$passphrase_file"
[[ "$(stat -c '%s' "$passphrase_file")" -ge 16 ]] || die "BACKUP_PASSPHRASE_TOO_SHORT"
for command in docker node tar flock curl realpath stat find seq cmp od tr head cp mkdir chmod mv wc sleep rm dirname basename date; do
  command -v "$command" >/dev/null 2>&1 || die "BACKUP_REQUIRED_COMMAND_MISSING"
done
[[ -f "$env_file" && ! -L "$env_file" ]] || die "BACKUP_ENV_FILE_REQUIRED"
mkdir -p -- "$target_dir"
chmod 0700 -- "$target_dir"
[[ ! -L "$target_dir" ]] || die "BACKUP_TARGET_SYMLINK_UNSUPPORTED"
target_dir="$(realpath -e "$target_dir")"
secrets_dir="$(realpath -e "$secrets_dir")"
passphrase_file="$(realpath -e "$passphrase_file")"
repo_real="$(realpath -e "$repo_root")"
paths_overlap "$target_dir" "$secrets_dir" && die "BACKUP_TARGET_OVERLAPS_SECRETS"
paths_overlap "$target_dir" "$passphrase_file" && die "BACKUP_TARGET_OVERLAPS_PASSPHRASE_FILE"
paths_overlap "$target_dir" "$repo_real" && die "BACKUP_TARGET_OVERLAPS_REPOSITORY"
exec 9>"$target_dir/.backup.lock"
flock -n 9 || die "BACKUP_ALREADY_RUNNING"

compose_args=(--project-name "$project" --env-file "$env_file" -f "$repo_root/compose.yaml" -f "$repo_root/compose.production.yaml")
GOLDIS_SECRETS_DIR="$secrets_dir" docker compose "${compose_args[@]}" config --quiet >/dev/null 2>&1 || die "BACKUP_PRODUCTION_COMPOSE_INVALID"

for service in postgres api worker enrichment-worker web import-parser; do
  id="$(docker compose "${compose_args[@]}" ps -aq "$service" 2>/dev/null | head -n 1)"
  check_owned_container "$id" "$service"
  container_ids[$service]="$id"
  running="$(docker inspect --format '{{.State.Running}}' "$id")"
  initially_running[$service]="$running"
done
[[ "${initially_running[postgres]}" == true ]] || die "BACKUP_POSTGRES_NOT_RUNNING"
[[ "${initially_running[api]}" == true && "${initially_running[worker]}" == true ]] || die "BACKUP_WRITERS_NOT_RUNNING"

docker compose "${compose_args[@]}" stop --timeout 45 web worker enrichment-worker import-parser api >/dev/null 2>&1 || die "BACKUP_MAINTENANCE_STOP_FAILED"

work_dir="$(mktemp -d "$target_dir/.goldis-backup-work-$run_id.XXXXXX")"
chmod 0700 "$work_dir"
payload="$work_dir/payload"
mkdir -m 0700 "$payload"
mkdir -m 0700 "$payload/config" "$payload/secrets" "$payload/exports" "$payload/staging" "$payload/deletion-journal"
cp -- "$env_file" "$payload/config/env.production"
cp -a -- "$secrets_dir/." "$payload/secrets/"
for name in database_password migrator_db_password api_db_password worker_db_password enrichment_db_password \
  redis_api_password redis_worker_password database_url_migrator database_url_api database_url_worker database_url_enrichment \
  redis_url_api redis_url_worker session_secret login_rate_limit_secret privileged_action_binding_key admin_user admin_password \
  pesel_keyring artifact_keyring worker_auth_secret import_parser_secret registry_cache_key pzu_login pzu_password \
  compensa_login compensa_password worker_staging_key resend_api_key auth_mail_keyring; do
  [[ -f "$payload/secrets/$name" && ! -L "$payload/secrets/$name" ]] || die "BACKUP_REQUIRED_SECRET_MISSING"
done

docker compose "${compose_args[@]}" exec -T postgres pg_dump -U goldis -d goldis --format=custom --no-owner > "$payload/database.dump" 2>/dev/null || die "BACKUP_DATABASE_DUMP_FAILED"
[[ "$(stat -c '%s' "$payload/database.dump")" -ge 64 ]] || die "BACKUP_DATABASE_DUMP_EMPTY"
docker cp "${container_ids[api]}:/var/lib/goldis/exports/." "$payload/exports/" >/dev/null 2>&1 || die "BACKUP_EXPORT_COPY_FAILED"
docker cp "${container_ids[worker]}:/home/pwuser/goldis-staging/." "$payload/staging/" >/dev/null 2>&1 || die "BACKUP_STAGING_COPY_FAILED"
docker cp "${container_ids[api]}:/var/lib/goldis/deletion-journal/." "$payload/deletion-journal/" >/dev/null 2>&1 || die "BACKUP_JOURNAL_COPY_FAILED"

for source in "$payload" "$payload/exports" "$payload/staging" "$payload/deletion-journal" "$payload/secrets"; do
  [[ -z "$(find "$source" -type l -print -quit)" ]] || die "BACKUP_SOURCE_SYMLINK_UNSUPPORTED"
done
migration_head="$(docker compose "${compose_args[@]}" exec -T postgres psql -U goldis -d goldis -Atqc 'SELECT name FROM "SequelizeMeta" ORDER BY name DESC LIMIT 1' 2>/dev/null || die "BACKUP_MIGRATION_HEAD_READ_FAILED")"
node "$manifest_tool" create "$payload" "$payload/config/env.production" "$migration_head" >/dev/null || die "BACKUP_MANIFEST_CREATE_FAILED"
tar -czf "$work_dir/platform.tar.gz" -C "$work_dir" payload || die "BACKUP_ARCHIVE_CREATE_FAILED"

journal_work="$work_dir/current-journal"
mkdir -m 0700 "$journal_work" "$journal_work/deletion-journal"
cp -a -- "$payload/deletion-journal/." "$journal_work/deletion-journal/"
tar -czf "$work_dir/current-journal.tar.gz" -C "$work_dir" current-journal || die "BACKUP_JOURNAL_ARCHIVE_FAILED"

archive_name="goldis-platform-$timestamp-$run_id.goldis-backup"
journal_name="goldis-deletion-journal-current.goldis-backup"
archive_partial="$target_dir/.$archive_name.partial"
journal_partial="$target_dir/.$journal_name.partial"
partial_files+=("$journal_partial" "$archive_partial")
GOLDIS_BACKUP_PASSPHRASE="$(<"$passphrase_file")" node "$crypto_tool" encrypt "$work_dir/current-journal.tar.gz" "$journal_partial" >/dev/null 2>&1 || die "BACKUP_JOURNAL_ENCRYPT_FAILED"
GOLDIS_BACKUP_PASSPHRASE="$(<"$passphrase_file")" node "$crypto_tool" decrypt "$journal_partial" "$work_dir/current-journal-verified.tar.gz" >/dev/null 2>&1 || die "BACKUP_JOURNAL_VERIFY_FAILED"
cmp -s "$work_dir/current-journal.tar.gz" "$work_dir/current-journal-verified.tar.gz" || die "BACKUP_JOURNAL_VERIFY_FAILED"
mv -f -- "$journal_partial" "$target_dir/$journal_name" || die "BACKUP_JOURNAL_PUBLISH_FAILED"
GOLDIS_BACKUP_PASSPHRASE="$(<"$passphrase_file")" node "$crypto_tool" encrypt "$work_dir/platform.tar.gz" "$archive_partial" >/dev/null 2>&1 || die "BACKUP_ENCRYPT_FAILED"
GOLDIS_BACKUP_PASSPHRASE="$(<"$passphrase_file")" node "$crypto_tool" decrypt "$archive_partial" "$work_dir/platform-verified.tar.gz" >/dev/null 2>&1 || die "BACKUP_ENCRYPTED_ARCHIVE_VERIFY_FAILED"
cmp -s "$work_dir/platform.tar.gz" "$work_dir/platform-verified.tar.gz" || die "BACKUP_ENCRYPTED_ARCHIVE_VERIFY_FAILED"
mv -- "$archive_partial" "$target_dir/$archive_name" || die "BACKUP_PUBLISH_FAILED"
printf 'BACKUP_CREATED archive=%s latest_journal=%s\n' "$archive_name" "$journal_name"
printf '%s\n' "Skrypt nie usuwa kopii ani nie ustawia harmonogramu. Przenieś oba zaszyfrowane pliki do uzgodnionego, odseparowanego celu."
