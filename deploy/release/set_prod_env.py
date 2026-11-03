"""Merge settings into /var/www/edwyz-wa/.env on the VPS without ever printing a value.

Secrets come from wa/.env.prod-secrets (filled by the owner). They travel over the SSH channel's stdin, never on a command line
or in a temp file. The server .env is backed up first, stays mode 600, and only key names are reported. The app is not restarted
here: the release script's pm2 startOrReload --update-env picks the values up.
"""
import base64
import io
import json
import os
import sys
import time

import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
HERE = os.path.dirname(os.path.abspath(__file__))
SECRETS = r"C:\Users\ADMIN\projects\edwyz\wa\.env.prod-secrets"
APP_ENV = "/var/www/edwyz-wa/.env"

# Not secrets: local mail relay (Postfix on the same VPS, no login) and the Eddy platform switch.
STATIC = {
    "SMTP_HOST": "127.0.0.1",
    "SMTP_PORT": "25",
    "SMTP_USER": "noreply@edwyz.com",
    "SMTP_PASS": "",
    "SMTP_TLS_SERVERNAME": "mail.edwyz.com",
    "EMAIL_FROM": '"Edwyz WA <noreply@edwyz.com>"',
    "EDDY_ENABLED": "true",
}

values = dict(STATIC)
for line in open(SECRETS, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if value.strip():
        values[key.strip()] = value.strip()

lines = open(os.path.join(HERE, "deploy_wa_release.py"), encoding="utf-8").read().splitlines()
start = next(i for i, l in enumerate(lines) if l.startswith("SCRATCH"))
end = next(i for i, l in enumerate(lines) if l.startswith("HOST, USER"))
ns = {}
exec("import os, re\n" + "\n".join(lines[start:end + 1]), ns)

MERGE = r'''
import json, os, re, shutil, sys, time
values = json.load(sys.stdin)
path = sys.argv[1]
stamp = time.strftime("%Y%m%d-%H%M%S")
shutil.copy2(path, f"/root/backups/edwyz-wa.env.{stamp}.pre-settings")
text = open(path, encoding="utf-8").read().splitlines()
report = []
for key, value in values.items():
    new = f"{key}={value}"
    hits = [i for i, l in enumerate(text) if re.match(rf"^{re.escape(key)}=", l)]
    if hits:
        status = "unchanged" if text[hits[0]] == new else "updated"
        text[hits[0]] = new
        for i in reversed(hits[1:]):
            del text[i]
    else:
        text.append(new)
        status = "added"
    report.append(f"{key}: {status}")
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write("\n".join(text) + "\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
print("backup: /root/backups/edwyz-wa.env." + stamp + ".pre-settings")
print("\n".join(report))
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(ns["HOST"], username=ns["USER"], password=ns["PASSWORD"], timeout=30)
# Base64 keeps the merge code intact through the remote shell's quoting (it holds quotes, backslashes and newlines).
code = base64.b64encode(MERGE.encode("utf-8")).decode("ascii")
stdin, stdout, stderr = client.exec_command(f"python3 -c \"import base64; exec(base64.b64decode('{code}'))\" {APP_ENV}", timeout=60)
stdin.write(json.dumps(values))
stdin.channel.shutdown_write()
print(stdout.read().decode("utf-8", "replace").strip())
err = stderr.read().decode("utf-8", "replace").strip()
if err:
    print("error:", err[-500:])
client.close()
