#!/usr/bin/env bash
# Health, queue, backup, TLS and disk alerts for wa.edwyz.com. Run every 5 minutes as root (deploy/cron-wa-alert).
#   /usr/local/sbin/alert-wa.sh            normal run: log problems, mail the owner only when ALERT_EMAIL is set
#   /usr/local/sbin/alert-wa.sh --test     log one test line and, when configured, send one test mail
# Never prints or logs a secret: WORKER_SECRET is read from the app env file and handed to curl on stdin, not on the command line.
# Every problem is written to the log. Mail goes through the local `mail` command and only when ALERT_EMAIL is set and `mail` exists.
# A problem is mailed once, again after ALERT_REPEAT_MIN minutes while it lasts, and a "recovered" line is logged when it clears.
# Settings come from the environment or /etc/edwyz-wa-alert.conf (KEY=value lines). Nothing is deleted or changed on the server.
set -uo pipefail

CONF="${ALERT_CONF:-/etc/edwyz-wa-alert.conf}"
if [ -r "$CONF" ]; then
  while IFS='=' read -r k v; do
    v=${v%$'\r'}; v=${v#\"}; v=${v%\"}
    case "$k" in
      ALERT_*|WA_*|APP_ENV_FILE|BACKUP_DIR|CERT_FILE|MAIL_CMD|DISK_PATHS) [ -z "${!k:-}" ] && export "$k=$v" ;;
    esac
  done < <(grep -E '^[A-Z_0-9]+=' "$CONF")
fi

BASE_URL="${WA_BASE_URL:-http://127.0.0.1:3500}"
ENV_FILE="${APP_ENV_FILE:-/var/www/edwyz-wa/.env}"
BACKUP_DIR="${BACKUP_DIR:-/root/backups/wa}"
CERT_FILE="${CERT_FILE:-/etc/letsencrypt/live/wa.edwyz.com/fullchain.pem}"
LOG_FILE="${ALERT_LOG:-/var/log/edwyz-wa-alert.log}"
STATE_DIR="${ALERT_STATE_DIR:-/var/lib/edwyz-wa-alert}"
EMAIL="${ALERT_EMAIL:-}"
MAIL_CMD="${MAIL_CMD:-mail}"
REPEAT_MIN="${ALERT_REPEAT_MIN:-360}"
DISK_PATHS="${DISK_PATHS:-/ ${BACKUP_DIR}}"
DISK_MAX_PCT="${ALERT_DISK_MAX_PCT:-85}"
TLS_MIN_DAYS="${ALERT_TLS_MIN_DAYS:-14}"
BACKUP_MAX_HOURS="${ALERT_BACKUP_MAX_HOURS:-26}"
WORKER_MAX_AGE="${ALERT_WORKER_MAX_AGE:-300}"
QUEUE_MAX_AGE="${ALERT_QUEUE_MAX_AGE:-120}"
QUEUE_MAX_AGE_ANY="${ALERT_QUEUE_MAX_AGE_ANY:-900}"
QUEUE_MAX_DEPTH="${ALERT_QUEUE_MAX_DEPTH:-1000}"
# The worker daemon (pm2 app edwyz-wa-worker) writes its own heartbeat, separate from the cron tick. Set ALERT_EXPECT_DAEMON=0 on a host that
# still runs only the cron tick.
EXPECT_DAEMON="${ALERT_EXPECT_DAEMON:-1}"
DAEMON_MAX_AGE="${ALERT_DAEMON_MAX_AGE:-120}"
PM2_APPS="${ALERT_PM2_APPS-edwyz-wa edwyz-wa-worker}"

umask 077
mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="${TMPDIR:-/tmp}/edwyz-wa-alert"
mkdir -p "$STATE_DIR"
NOW=$(date +%s)
problems=()   # entries look like "key|message"

stamp() { date -u +%FT%TZ; }
log() { printf '%s alert-wa: %s\n' "$(stamp)" "$*" >> "$LOG_FILE" 2>/dev/null || printf '%s alert-wa: %s\n' "$(stamp)" "$*" >&2; }
problem() { problems+=("$1|$2"); }
num() { case "${1:-}" in ''|*[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }

send_mail() {
  local subject=$1 body=$2
  [ -n "$EMAIL" ] || return 0
  command -v "$MAIL_CMD" >/dev/null 2>&1 || { log "mail command '$MAIL_CMD' not found, not mailing"; return 0; }
  printf '%s\n' "$body" | "$MAIL_CMD" -s "$subject" "$EMAIL" || log "mail command failed"
}

secret() {
  [ -r "$ENV_FILE" ] || return 1
  local v
  v=$(grep -E '^WORKER_SECRET=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)
  v=${v%$'\r'}; v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
  [ -n "$v" ] && printf '%s' "$v"
}

# 1. /health: two failed checks in a row, database round trip, worker heartbeat.
check_health() {
  local out failfile="$STATE_DIR/health.fails" fails
  out=$(curl -fsS --max-time 5 "$BASE_URL/health" 2>/dev/null) || out=""
  if ! printf '%s' "$out" | grep -q '"status":"ok"'; then
    fails=$(( $(num "$(cat "$failfile" 2>/dev/null)") + 1 ))
    echo "$fails" > "$failfile"
    [ "$fails" -ge 2 ] && problem health "The site health check (/health) has failed $fails times in a row. Run: pm2 status; pm2 logs edwyz-wa --lines 100. Is Postgres up?"
    return 0
  fi
  echo 0 > "$failfile"
  local rtt age
  rtt=$(printf '%s' "$out" | sed -n 's/.*"rttMs":\([0-9]*\).*/\1/p')
  age=$(printf '%s' "$out" | sed -n 's/.*"lastTickAgeSeconds":\([0-9]*\).*/\1/p')
  [ "$(num "$rtt")" -gt 500 ] && problem db_slow "The database round trip is ${rtt} ms (limit 500). Check Postgres load and disk."
  if [ -n "$age" ] && [ "$age" -gt "$WORKER_MAX_AGE" ]; then
    problem worker "The worker last reported ${age} seconds ago (limit ${WORKER_MAX_AGE}). Run: pm2 status edwyz-wa-worker; pm2 logs edwyz-wa-worker --lines 100; check the tick cron and WORKER_SECRET."
  fi
  return 0
}

# 2. Job queues from /api/internal/metrics.
check_queues() {
  local s lines daemon_age
  s=$(secret) || { log "WORKER_SECRET not readable, skipping the queue checks"; return 0; }
  command -v node >/dev/null 2>&1 || { log "node not found, skipping the queue checks"; return 0; }
  lines=$(printf 'header = "x-worker-secret: %s"\n' "$s" | curl -fsS --max-time 8 -K - "$BASE_URL/api/internal/metrics" 2>/dev/null | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      try {
        const m = JSON.parse(d);
        // failedRecent: failed in the past 24 hours. Old failed rows stay in the table for inspection and must not alert forever.
        for (const [q, s] of Object.entries(m.queues || {})) console.log(["q", q, s.queued, s.failedRecent ?? s.failed, s.oldestDueSeconds, s.stuckRunning].join(" "));
        const t = m.totals || {};
        console.log(["t", t.queued || 0, t.failed || 0, t.oldestDueSeconds || 0, t.stuckRunning || 0].join(" "));
        const age = m.worker && m.worker.daemonAgeSeconds;
        console.log(["d", age === null || age === undefined ? "none" : age].join(" "));
      } catch {
        console.log("bad");
      }
    });') || lines="bad"
  unset s
  if [ -z "$lines" ] || [ "$lines" = "bad" ]; then
    problem metrics "The metrics endpoint did not answer, or answered with something unreadable. Check the app and WORKER_SECRET."
    return 0
  fi
  local kind a b c d e failed_total=0 limit
  while read -r kind a b c d e; do
    if [ "$kind" = q ]; then
      limit=$QUEUE_MAX_AGE_ANY
      case "$a" in send|webhook) limit=$QUEUE_MAX_AGE ;; esac
      [ "$(num "$d")" -gt "$limit" ] && problem "queue_age_$a" "Queue '$a': the oldest due job has waited $d seconds (limit $limit). Customers may be waiting on messages."
      case "$a" in
        send|webhook|billing) [ "$(num "$c")" -gt 0 ] && problem "queue_failed_$a" "Queue '$a' has $c job(s) that failed in the last 24 hours. Read Job.lastError (scrubbed) in the database." ;;
      esac
    elif [ "$kind" = d ]; then
      daemon_age=$a
    elif [ "$kind" = t ]; then
      failed_total=$(num "$b")
      [ "$(num "$d")" -gt 0 ] && problem stuck "$d job(s) are stuck in running (the worker was killed mid-job). The queue reclaims them on the next pass; watch it."
      [ "$(num "$a")" -gt "$QUEUE_MAX_DEPTH" ] && problem queue_depth "$a jobs are queued (limit $QUEUE_MAX_DEPTH)."
    fi
  done <<< "$lines"
  if [ "$EXPECT_DAEMON" = 1 ]; then
    if [ "${daemon_age:-none}" = none ]; then
      problem daemon "The worker daemon has never reported a heartbeat. Run: pm2 status edwyz-wa-worker; pm2 logs edwyz-wa-worker --lines 100 (set ALERT_EXPECT_DAEMON=0 if this host only uses the cron tick)."
    elif [ "$(num "$daemon_age")" -gt "$DAEMON_MAX_AGE" ]; then
      problem daemon "The worker daemon last reported $daemon_age seconds ago (limit $DAEMON_MAX_AGE); only the one-minute cron fallback is moving work. Run: pm2 status edwyz-wa-worker; pm2 logs edwyz-wa-worker --lines 100"
    fi
  fi
  local prev
  prev=$(num "$(cat "$STATE_DIR/failed.total" 2>/dev/null)")
  echo "$failed_total" > "$STATE_DIR/failed.total"
  [ "$failed_total" -gt "$prev" ] && problem failed_jobs "Failed jobs increased from $prev to $failed_total. Read Job.lastError (scrubbed) in the database."
  return 0
}

# 3. Backups: newest dump age and size against the one before it.
check_backup() {
  [ -d "$BACKUP_DIR" ] || { problem backup "The backup folder $BACKUP_DIR does not exist."; return 0; }
  local files newest prev age_h size psize
  files=$(ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | head -n 2)
  newest=$(printf '%s\n' "$files" | sed -n 1p)
  prev=$(printf '%s\n' "$files" | sed -n 2p)
  [ -n "$newest" ] || { problem backup "There is no backup file in $BACKUP_DIR."; return 0; }
  age_h=$(( (NOW - $(stat -c %Y "$newest")) / 3600 ))
  [ "$age_h" -gt "$BACKUP_MAX_HOURS" ] && problem backup "The newest backup is ${age_h} hours old (limit ${BACKUP_MAX_HOURS}). Run /usr/local/sbin/backup-wa.sh and read /var/log/edwyz-wa-backup.log."
  size=$(stat -c %s "$newest")
  psize=$(stat -c %s "${prev:-$newest}")
  [ -n "$prev" ] && [ "$size" -lt $(( psize / 2 )) ] && problem backup_size "The newest backup (${size} bytes) is less than half the one before it (${psize} bytes)."
  ls "$BACKUP_DIR"/*.FAILED >/dev/null 2>&1 && problem backup_failed "A failed backup file (*.FAILED) is present in $BACKUP_DIR."
  return 0
}

# 4. TLS certificate expiry.
check_tls() {
  command -v openssl >/dev/null 2>&1 || return 0
  [ -r "$CERT_FILE" ] || { log "certificate file not found, skipping the TLS check"; return 0; }
  if ! openssl x509 -checkend $(( TLS_MIN_DAYS * 86400 )) -noout -in "$CERT_FILE" >/dev/null 2>&1; then
    problem tls "The TLS certificate expires within ${TLS_MIN_DAYS} days, or has expired. Run: certbot renew --dry-run"
  fi
  return 0
}

# 5. Disk space.
check_disk() {
  local p pct
  for p in $DISK_PATHS; do
    [ -e "$p" ] || continue
    pct=$(df -P "$p" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
    [ "$(num "$pct")" -ge "$DISK_MAX_PCT" ] && problem "disk_$(printf '%s' "$p" | tr -c 'A-Za-z0-9' _)" "Disk holding $p is ${pct}% full (limit ${DISK_MAX_PCT}%). Free space before the backups or Postgres fail."
  done
  return 0
}

# 6. The two edwyz-wa pm2 apps are online. No other pm2 app is looked at.
check_pm2() {
  [ -n "$PM2_APPS" ] || return 0
  command -v pm2 >/dev/null 2>&1 || return 0
  local list app
  list=$(pm2 jlist 2>/dev/null | tr -d '\n')
  [ -n "$list" ] || return 0
  for app in $PM2_APPS; do
    if ! printf '%s' "$list" | grep -q "\"name\":\"$app\""; then
      problem "pm2_$app" "pm2 app $app is not defined. Run: pm2 startOrReload deploy/ecosystem.config.cjs"
    elif ! printf '%s' "$list" | tr '{' '\n' | grep "\"name\":\"$app\"" | grep -q '"status":"online"'; then
      problem "pm2_$app" "pm2 app $app is not online. Run: pm2 status; pm2 logs $app --lines 100"
    fi
  done
  return 0
}

# Report: one mail per new problem, again after ALERT_REPEAT_MIN minutes, and a recovery line when it clears.
report() {
  local entry key msg f last new=() keys=" "
  for entry in ${problems[@]+"${problems[@]}"}; do
    key=${entry%%|*}
    msg=${entry#*|}
    keys+="$key "
    f="$STATE_DIR/active.$key"
    log "PROBLEM $key: $msg"
    last=$(num "$(cat "$f" 2>/dev/null)")
    if [ "$last" -eq 0 ] || [ $(( NOW - last )) -ge $(( REPEAT_MIN * 60 )) ]; then
      echo "$NOW" > "$f"
      new+=("- $msg")
    fi
  done
  for f in "$STATE_DIR"/active.*; do
    [ -e "$f" ] || continue
    key=${f##*/active.}
    case "$keys" in
      *" $key "*) ;;
      *) log "RECOVERED $key"; rm -f "$f"; send_mail "wa.edwyz.com recovered: $key" "The alert '$key' has cleared." ;;
    esac
  done
  if [ "${#new[@]}" -gt 0 ]; then
    send_mail "wa.edwyz.com alert (${#new[@]})" "$(printf '%s\n' "${new[@]}"; printf '\nHost: %s\nTime: %s\n' "$(hostname)" "$(stamp)")"
  fi
  [ "${#problems[@]}" -eq 0 ] && log "ok"
  return 0
}

if [ "${1:-}" = "--test" ]; then
  if [ -n "$EMAIL" ]; then log "test run: alert-wa is installed (mail configured)"; else log "test run: alert-wa is installed (mail not configured)"; fi
  send_mail "wa.edwyz.com alert test" "This is a test message from alert-wa.sh on $(hostname)."
  exit 0
fi

check_health
check_queues
check_backup
check_tls
check_disk
check_pm2
report
