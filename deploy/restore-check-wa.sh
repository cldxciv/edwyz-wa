#!/usr/bin/env bash
# Proves the newest backup can be restored: restores it into a TEMPORARY database, runs sanity queries, then drops only that
# temporary database. The live database is never written to or dropped. Run as root:
#   /usr/local/sbin/restore-check-wa.sh                 newest dump in /root/backups/wa
#   /usr/local/sbin/restore-check-wa.sh <dump.sql.gz>   a specific dump
# Exit 0 = every check passed, 1 = a check failed, 2 = the check could not run. The last line printed is the result.
#
# Safety rules built in:
#  - the temporary name is edwyz_wa_restorecheck_<UTC stamp>_<pid>; it is dropped only if this run created it, only if the name still
#    matches that pattern, and never if it equals the production database name;
#  - the dump is read-only input; nothing is deleted from the backup folder;
#  - the production DATABASE_URL is read from the app env file without printing it and used only for read-only count queries.
# The temporary database holds customer data while it exists. The trap drops it on success, failure and Ctrl-C.
set -uo pipefail
umask 077

ENV_FILE="${APP_ENV_FILE:-/var/www/edwyz-wa/.env}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups/wa}"
APP_ROLE="${RESTORE_OWNER_ROLE:-edwyz_wa_app}"
# Prefix for the administrative psql/createdb/dropdb calls. On the VPS this is `sudo -u postgres`; set it empty when the current
# user can create databases directly.
ADMIN_PREFIX="${PG_ADMIN_CMD-sudo -u postgres}"
MAX_AGE_HOURS="${RESTORE_MAX_DATA_AGE_HOURS:-24}"
LOG_FILE="${RESTORE_CHECK_LOG:-}"

say() {
  printf 'restore-check: %s\n' "$*"
  [ -z "$LOG_FILE" ] || printf '%s restore-check: %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG_FILE" 2>/dev/null || true
}
die() { say "$*"; exit 2; }

admin() { if [ -n "$ADMIN_PREFIX" ]; then $ADMIN_PREFIX "$@"; else "$@"; fi; }

for c in psql createdb dropdb gunzip; do command -v "$c" >/dev/null 2>&1 || die "$c is not installed"; done

dump="${1:-}"
if [ -z "$dump" ]; then
  dump=$(ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -n 1)
fi
[ -n "$dump" ] && [ -r "$dump" ] || die "no readable backup file found in $BACKUP_DIR"
gunzip -t "$dump" 2>/dev/null || { say "FAIL the dump is not a valid gzip file: ${dump##*/}"; exit 1; }

# Production database name and a read-only connection for comparison (optional).
prod_db=""
if [ -r "$ENV_FILE" ]; then
  raw=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)
  raw=${raw%$'\r'}; raw=${raw#\"}; raw=${raw%\"}; raw=${raw#\'}; raw=${raw%\'}
  re='^postgres(ql)?://([^:@/]+)(:([^@]*))?@([^:/?]+)(:([0-9]+))?/([^?]+)(\?.*)?$'
  if [[ $raw =~ $re ]]; then prod_db="${BASH_REMATCH[8]}"; fi
  unset raw
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
TMPDB="edwyz_wa_restorecheck_${stamp}_$$"
CREATED=0

cleanup() {
  local code=$?
  if [ "$CREATED" -eq 1 ] && [[ $TMPDB =~ ^edwyz_wa_restorecheck_[0-9]{8}T[0-9]{6}Z_[0-9]+$ ]] && [ "$TMPDB" != "$prod_db" ]; then
    if admin dropdb --if-exists "$TMPDB" >/dev/null 2>&1; then say "dropped the temporary database $TMPDB"; else say "WARNING could not drop $TMPDB; drop it by hand: dropdb $TMPDB"; fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

[ "$TMPDB" != "$prod_db" ] || die "refusing to use the production database name"

admin createdb -O "$APP_ROLE" "$TMPDB" >/dev/null 2>&1 || die "could not create the temporary database $TMPDB (does role $APP_ROLE exist?)"
CREATED=1
say "restoring ${dump##*/} into $TMPDB"

if ! gunzip -c "$dump" | admin env PGOPTIONS="-c role=$APP_ROLE" psql -v ON_ERROR_STOP=1 -q -X -d "$TMPDB" >/dev/null 2>"${TMPDIR:-/tmp}/restore-check.$$.err"; then
  say "FAIL the dump did not restore cleanly (first error below, no data shown)"
  head -n 3 "${TMPDIR:-/tmp}/restore-check.$$.err" | cut -c1-200 >&2
  rm -f "${TMPDIR:-/tmp}/restore-check.$$.err"
  exit 1
fi
rm -f "${TMPDIR:-/tmp}/restore-check.$$.err"

q() { admin psql -X -A -t -d "$1" -c "$2" 2>/dev/null | tr -d '[:space:]'; }
failures=0
fail() { say "FAIL $*"; failures=$((failures + 1)); }

tables=$(q "$TMPDB" "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
case "$tables" in ''|*[!0-9]*) fail "could not count tables" ; tables=0 ;; esac
[ "$tables" -ge 20 ] || fail "only $tables tables were restored (a real dump has dozens)"

for t in Tenant User Membership Contact Conversation Message Template Job PlatformSetting; do
  n=$(q "$TMPDB" "select count(*) from \"$t\"")
  case "$n" in ''|*[!0-9]*) fail "table $t is missing or unreadable" ;; *) say "rows in $t: $n" ;; esac
done

orphans=$(q "$TMPDB" "select count(*) from \"Message\" m left join \"Conversation\" c on c.id = m.\"conversationId\" where c.id is null")
case "$orphans" in ''|*[!0-9]*) fail "could not check messages against conversations" ;; 0) ;; *) fail "$orphans messages point at a missing conversation" ;; esac

# The newest message should be close to the time the dump was taken (file name carries the UTC stamp).
base=${dump##*/}
ts=$(printf '%s' "$base" | sed -n 's/.*-\([0-9]\{8\}T[0-9]\{6\}Z\)\.sql\.gz$/\1/p')
if [ -n "$ts" ]; then
  gap=$(q "$TMPDB" "select coalesce(round(extract(epoch from (to_timestamp('$ts','YYYYMMDD\"T\"HH24MISS\"Z\"') at time zone 'utc') - max(\"createdAt\"))/3600), 0) from \"Message\"")
  case "$gap" in ''|*[!0-9-]*) ;; *) [ "$gap" -le "$MAX_AGE_HOURS" ] || say "NOTE newest message is $gap hours older than the dump (a quiet workspace is fine; a gap on a busy one is not)" ;; esac
fi

# Table count should match production (read-only, optional).
if [ -n "$prod_db" ]; then
  prod_tables=$(q "$prod_db" "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")
  case "$prod_tables" in
    ''|*[!0-9]*) say "NOTE could not read the production table count, comparison skipped" ;;
    *) [ "$prod_tables" = "$tables" ] || fail "restored $tables tables but production has $prod_tables (the dump is older than the latest migration, or incomplete)" ;;
  esac
fi

if [ "$failures" -eq 0 ]; then say "PASS ${base} restored with $tables tables"; exit 0; fi
say "FAILED ${base}: $failures check(s) failed"
exit 1
