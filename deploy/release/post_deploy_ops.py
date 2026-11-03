"""After a release: owner-approved ops defaults (2026-10-31). Additive only; backs up anything it changes; prints no secret values.

- Default 9, rotate wa logs only: installs deploy/logrotate-edwyz-wa as /etc/logrotate.d/edwyz-wa (wa's cron logs and its own pm2
  logs, copytruncate) and dry-runs it. pm2-logrotate is not installed (it would rotate other tenants' logs).
- Default 10, alert emails to anshuman@edwyz.com: sets ALERT_EMAIL in /etc/edwyz-wa-alert.conf and sends one test alert.
- The demo account (an address that cannot receive mail) is marked verified, so the email gate does not lock the demo workspace.
"""
import io
import os
import sys

import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = "/var/www/edwyz-wa"
ALERT_EMAIL = "anshuman@edwyz.com"
DEMO_EMAIL = "demo@edwyz-demo.example"
VERIFY_SCRIPT = r"C:\Users\ADMIN\projects\edwyz\wa\scripts\verify-user.mjs"

lines = open(os.path.join(HERE, "deploy_wa_release.py"), encoding="utf-8").read().splitlines()
start = next(i for i, l in enumerate(lines) if l.startswith("SCRATCH"))
end = next(i for i, l in enumerate(lines) if l.startswith("HOST, USER"))
ns = {}
exec("import os, re\n" + "\n".join(lines[start:end + 1]), ns)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(ns["HOST"], username=ns["USER"], password=ns["PASSWORD"], timeout=30)


def run(cmd, timeout=120):
    _, out, err = client.exec_command(cmd, timeout=timeout)
    return (out.read().decode("utf-8", "replace") + err.read().decode("utf-8", "replace")).strip()


stamp = run("date +%Y%m%d-%H%M%S")

print("--- log rotation")
print(run(
    f"[ -e /etc/logrotate.d/edwyz-wa ] && cp -a /etc/logrotate.d/edwyz-wa /root/backups/logrotate-edwyz-wa.{stamp}; "
    f"install -m 644 {APP_DIR}/deploy/logrotate-edwyz-wa /etc/logrotate.d/edwyz-wa && sed -i 's/\\r$//' /etc/logrotate.d/edwyz-wa "
    "&& logrotate -d /etc/logrotate.d/edwyz-wa 2>&1 | grep -E 'error|rotating pattern|considering log' | head -12"
))

print("--- alert email")
print(run(
    f"cp -a /etc/edwyz-wa-alert.conf /root/backups/edwyz-wa-alert.conf.{stamp} && "
    f"(grep -qE '^ALERT_EMAIL=' /etc/edwyz-wa-alert.conf && sed -i 's/^ALERT_EMAIL=.*/ALERT_EMAIL={ALERT_EMAIL}/' /etc/edwyz-wa-alert.conf "
    f"|| printf '\\n# Owner default 10 (2026-10-31)\\nALERT_EMAIL={ALERT_EMAIL}\\n' >> /etc/edwyz-wa-alert.conf) && chmod 600 /etc/edwyz-wa-alert.conf "
    "&& grep -c '^ALERT_EMAIL=' /etc/edwyz-wa-alert.conf && /usr/local/sbin/alert-wa.sh --test; tail -n 2 /var/log/edwyz-wa-alert.log"
))
print(run("sleep 5; tail -n 40 /var/log/mail.log 2>/dev/null | grep -E 'status=|reject' | tail -3 | sed -E 's/<[^>]*@[^>]*>/<addr>/g'"))

print("--- demo account email marked verified")
sftp = client.open_sftp()
sftp.put(VERIFY_SCRIPT, f"{APP_DIR}/scripts/verify-user.mjs")
sftp.close()
print(run(f"cd {APP_DIR} && node scripts/verify-user.mjs {DEMO_EMAIL} 2>&1 | tail -1"))
client.close()
