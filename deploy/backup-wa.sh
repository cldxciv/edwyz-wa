#!/usr/bin/env bash
# Nightly logical backup of the edwyz_wa database. Run as root (cron.d/edwyz-wa-backup does).
#   /usr/local/sbin/backup-wa.sh
# Reads DATABASE_URL from the app .env without printing it, hands it to pg_dump through PG* variables (never on the command
# line, so it is not visible in the process list), writes a timestamped gzip under /root/backups/wa/ with mode 600 and prints
# its size. It never deletes anything: pruning old dumps is a manual decision (see docs/ops.md).
set -euo pipefail
umask 077

ENV_FILE="${APP_ENV_FILE:-/var/www/edwyz-wa/.env}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups/wa}"

fail() { echo "backup-wa: $*" >&2; exit 1; }

[ -r "$ENV_FILE" ] || fail "cannot read the app env file"
command -v pg_dump >/dev/null || fail "pg_dump is not installed"

raw=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-) || true
raw=${raw%$'\r'}
raw=${raw#\"}; raw=${raw%\"}
raw=${raw#\'}; raw=${raw%\'}
[ -n "$raw" ] || fail "DATABASE_URL is not set in the env file"

urldecode() { local s=$1; printf '%b' "${s//%/\\x}"; }

re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)(\?.*)?$'
[[ $raw =~ $re ]] || fail "DATABASE_URL is not in postgresql://user:password@host:port/database form"
export PGUSER; PGUSER=$(urldecode "${BASH_REMATCH[2]}")
export PGPASSWORD; PGPASSWORD=$(urldecode "${BASH_REMATCH[4]}")
export PGHOST="${BASH_REMATCH[5]}"
export PGPORT="${BASH_REMATCH[7]:-5432}"
export PGDATABASE; PGDATABASE=$(urldecode "${BASH_REMATCH[8]}")
unset raw

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$BACKUP_DIR/${PGDATABASE}-${stamp}.sql.gz"
partial="$final.partial"
[ ! -e "$final" ] && [ ! -e "$partial" ] || fail "target already exists, not overwriting"

if ! pg_dump --no-owner --no-privileges --format=plain "$PGDATABASE" | gzip -9 > "$partial"; then
  mv "$partial" "$final.FAILED"
  fail "pg_dump failed; partial output kept as ${final##*/}.FAILED"
fi
if ! gzip -t "$partial"; then
  mv "$partial" "$final.FAILED"
  fail "gzip integrity check failed; kept as ${final##*/}.FAILED"
fi

chmod 600 "$partial"
mv "$partial" "$final"
bytes=$(stat -c %s "$final")
echo "backup-wa: $(date -u +%FT%TZ) wrote ${final} (${bytes} bytes, $(du -h "$final" | cut -f1))"
echo "backup-wa: free space on backup volume: $(df -h --output=avail "$BACKUP_DIR" | tail -n 1 | tr -d ' ')"
