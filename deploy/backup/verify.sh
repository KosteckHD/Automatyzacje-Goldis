#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
set +x

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
crypto_tool="$repo_root/scripts/goldis-backup-crypto.cjs"
manifest_tool="$repo_root/deploy/backup/manifest.cjs"
passphrase_file="${GOLDIS_BACKUP_PASSPHRASE_FILE:-}"
verify_journal_only=0
archive="${1:-}"
[[ "$archive" != "--journal" ]] || { verify_journal_only=1; archive="${2:-}"; }

die() { printf '%s\n' "$1" >&2; exit 1; }
[[ -n "$archive" && -f "$archive" && ! -L "$archive" ]] || die "BACKUP_VERIFY_ARCHIVE_REQUIRED"
[[ -n "$passphrase_file" && -f "$passphrase_file" && ! -L "$passphrase_file" && -r "$passphrase_file" ]] || die "BACKUP_PASSPHRASE_FILE_REQUIRED"
mode="$(stat -c '%a' "$passphrase_file")"
(( (8#$mode & 077) == 0 )) || die "BACKUP_PRIVATE_FILE_PERMISSIONS_INVALID"
for command in node tar docker stat realpath; do command -v "$command" >/dev/null 2>&1 || die "BACKUP_VERIFY_REQUIRED_COMMAND_MISSING"; done
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/goldis-backup-verify.XXXXXX")"
chmod 0700 "$work_dir"
resolved_tmp="$(realpath -m "${TMPDIR:-/tmp}")"
resolved_work="$(realpath -m "$work_dir")"
case "$resolved_work" in "$resolved_tmp"/goldis-backup-verify.*) ;; *) die "BACKUP_VERIFY_TEMP_PATH_INVALID" ;; esac
cleanup() {
  local status=$?
  trap - EXIT
  case "$(realpath -m "$work_dir")" in "$(realpath -m "${TMPDIR:-/tmp}")"/goldis-backup-verify.*) rm -rf -- "$work_dir" ;; *) die "BACKUP_VERIFY_TEMP_PATH_INVALID" ;; esac
  exit "$status"
}
trap cleanup EXIT

plain="$work_dir/archive.tar.gz"
GOLDIS_BACKUP_PASSPHRASE="$(<"$passphrase_file")" node "$crypto_tool" decrypt "$archive" "$plain" >/dev/null 2>&1 || die "BACKUP_DECRYPT_OR_AUTHENTICATION_FAILED"
tar -tzf "$plain" >/dev/null 2>&1 || die "BACKUP_ARCHIVE_INVALID"
tar -tvzf "$plain" | awk 'substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { invalid = 1 } END { exit invalid ? 1 : 0 }' || die "BACKUP_ARCHIVE_LINK_OR_SPECIAL_FILE_FORBIDDEN"
while IFS= read -r entry; do
  [[ -n "$entry" && "$entry" != /* && "$entry" != *'\'* && "$entry" != *$'\n'* && "$entry" != *$'\r'* ]] || die "BACKUP_ARCHIVE_PATH_INVALID"
  clean="${entry%/}"
  IFS='/' read -r -a parts <<< "$clean"
  for part in "${parts[@]}"; do [[ -n "$part" && "$part" != . && "$part" != .. ]] || die "BACKUP_ARCHIVE_PATH_INVALID"; done
done < <(tar -tzf "$plain")

if (( verify_journal_only )); then
  mkdir -m 0700 "$work_dir/unpacked"
  tar --no-same-owner --no-same-permissions -xzf "$plain" -C "$work_dir/unpacked" || die "BACKUP_JOURNAL_ARCHIVE_INVALID"
  [[ -d "$work_dir/unpacked/current-journal/deletion-journal" ]] || die "BACKUP_DELETION_JOURNAL_REQUIRED"
  node "$manifest_tool" verify-journal "$work_dir/unpacked/current-journal/deletion-journal" || die "BACKUP_DELETION_JOURNAL_TAMPERED"
  printf '%s\n' "BACKUP_JOURNAL_ARCHIVE_VERIFIED"
  exit 0
fi

mkdir -m 0700 "$work_dir/unpacked"
tar --no-same-owner --no-same-permissions -xzf "$plain" -C "$work_dir/unpacked" || die "BACKUP_ARCHIVE_EXTRACT_FAILED"
payload="$work_dir/unpacked/payload"
[[ -d "$payload" && -f "$payload/database.dump" && -f "$payload/config/env.production" ]] || die "BACKUP_REQUIRED_FILES_MISSING"
node "$manifest_tool" verify "$payload" >/dev/null || die "BACKUP_MANIFEST_OR_CHECKSUM_INVALID"
postgres_image="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.release.images.GOLDIS_POSTGRES_IMAGE)' "$payload/manifest.json")"
[[ "$postgres_image" =~ ^.+@sha256:[a-f0-9]{64}$ ]] || die "BACKUP_POSTGRES_IMAGE_REFERENCE_INVALID"
docker run --rm -i --network none --entrypoint pg_restore "$postgres_image" --list - < "$payload/database.dump" >/dev/null 2>&1 || die "BACKUP_POSTGRES_ARCHIVE_INVALID_OR_DOCKER_UNAVAILABLE"
node -e 'const m=require(process.argv[1]);process.stdout.write(`BACKUP_VERIFIED files=${m.files.length} journalSequence=${m.deletionJournalHead.sequence} pgArchive=true\n`)' "$payload/manifest.json"
