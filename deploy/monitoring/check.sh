#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
env_file="${GOLDIS_MONITOR_ENV_FILE:-$root/.env.production}"
backup_dir="${GOLDIS_MONITOR_BACKUP_DIR:-}"
max_backup_age="${GOLDIS_MONITOR_MAX_BACKUP_AGE_SECONDS:-86400}"
min_free_mb="${GOLDIS_MONITOR_MIN_FREE_MB:-4096}"
fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ -f "$env_file" && ! -L "$env_file" ]] || fail MONITOR_ENV_FILE_REQUIRED
[[ -n "$backup_dir" && -d "$backup_dir" && ! -L "$backup_dir" ]] || fail MONITOR_BACKUP_DIRECTORY_REQUIRED
[[ "$max_backup_age" =~ ^[0-9]{1,6}$ && "$min_free_mb" =~ ^[0-9]{1,8}$ ]] || fail MONITOR_LIMIT_INVALID
(( max_backup_age > 0 && min_free_mb > 0 )) || fail MONITOR_LIMIT_INVALID
cd "$root"
compose=(docker compose --env-file "$env_file" -f compose.yaml -f compose.production.yaml)
states="$("${compose[@]}" ps --all --format json)" || fail MONITOR_COMPOSE_UNAVAILABLE
printf '%s' "$states" | node -e '
let text="";process.stdin.on("data",chunk=>text+=chunk).on("end",()=>{
 try {
  const trimmed=text.trim();
  const rows=trimmed.startsWith("[")?JSON.parse(trimmed):trimmed.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const required=["postgres","redis","api","import-parser","commission-engine","commission-worker","enrichment-worker","worker","web"];
  for(const service of required){const row=rows.find(row=>row.Service===service);
   if(!row||row.State!=="running"||(row.Health&&row.Health!=="healthy"))throw Error("state");}
 }catch{process.stderr.write("MONITOR_SERVICE_STATE_FAILED\n");process.exitCode=1;}
});' || fail MONITOR_SERVICE_CHECK_FAILED
node scripts/runtime-check.cjs || fail MONITOR_RUNTIME_CHECK_FAILED
latest=0
while IFS= read -r -d '' file; do
  modified="$(stat -c %Y "$file")"
  (( modified > latest )) && latest="$modified"
done < <(find "$backup_dir" -maxdepth 1 -type f -name 'goldis-platform-*.goldis-backup' -print0)
now="$(date +%s)"
(( latest > 0 && latest <= now && now - latest <= max_backup_age )) || fail MONITOR_BACKUP_OVERDUE
journal="$backup_dir/goldis-deletion-journal-current.goldis-backup"
[[ -f "$journal" && ! -L "$journal" ]] || fail MONITOR_CURRENT_JOURNAL_MISSING
modified="$(stat -c %Y "$journal")"
(( modified <= now && now - modified <= max_backup_age )) || fail MONITOR_JOURNAL_OVERDUE
free_kb="$(df -Pk "$backup_dir" | awk 'NR==2 {print $4}')"
[[ "$free_kb" =~ ^[0-9]+$ ]] && (( free_kb >= min_free_mb * 1024 )) || fail MONITOR_DISK_LOW
printf '%s\n' MONITOR_LOCAL_CHECK_PASS
