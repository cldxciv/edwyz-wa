import glob
import io
import os
import re
import secrets
import sys
import tarfile
import time
from urllib.parse import unquote, urlparse

import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SCRATCH = r"C:\Users\ADMIN\AppData\Local\Temp\claude\c--Users-ADMIN-projects-edwyz\6267814c-bbba-4fc1-83d9-00a32447b8d3\scratchpad"
src = open(os.path.join(SCRATCH, "deploy_wa_finish.py"), encoding="utf-8").read()
HOST, USER, PASSWORD = eval(re.search(r"HOST, USER, PASSWORD\s*=\s*(.*)", src).group(1))
LOCAL = r"C:\Users\ADMIN\AppData\Local\Temp\claude\c--Users-ADMIN-projects-edwyz\6267814c-bbba-4fc1-83d9-00a32447b8d3\scratchpad\release-snapshot"
APP_DIR = "/var/www/edwyz-wa"
PORT = 3500
stamp = time.strftime("%Y%m%d-%H%M%S")
BK = "/root/backups"

archive = os.path.join(os.environ["TEMP"], "edwyz-wa-release.tar.gz")
standalone = os.path.join(LOCAL, ".next", "standalone")

# The worker daemon is one bundled file; its few external packages are not all in the standalone trace, so add them (and their deps).
import json
import subprocess

# Prebuilt from the tested source when the snapshot was made (make_release_snapshot.py); nothing is built here.
worker_out = os.path.join(LOCAL, "prebuilt", "worker", "index.mjs")
backfill_out = os.path.join(LOCAL, "prebuilt", "spend-backfill-commitments.mjs")


def pkg_dir(root, name):
    return os.path.join(root, "node_modules", *name.split("/"))


def collect(names, seen):
    for name in names:
        if name in seen:
            continue
        d = pkg_dir(LOCAL, name)
        if not os.path.isdir(d):
            continue
        seen.add(name)
        meta = json.load(open(os.path.join(d, "package.json"), encoding="utf-8"))
        collect(list((meta.get("dependencies") or {}).keys()), seen)


wanted = set()
collect(["@prisma/adapter-pg", "nodemailer"], wanted)
# The standalone build keeps only the files the web app traced, so a package directory can exist there yet be incomplete
# (postgres-array had a package.json and no index.js). Ship every worker dependency whole; it overlays the partial copy.
extra_pkgs = sorted(wanted)
print("extra packages for the worker:", ", ".join(extra_pkgs) or "none")

def write_archive(fileobj):
    # Stream mode ("w|gz"): the local disk can be nearly full, so the archive goes straight to the server, never to TEMP.
    with tarfile.open(fileobj=fileobj, mode="w|gz") as tar:
        for name in os.listdir(standalone):
            # data/ is the workstation's own media store (e2e uploads); production keeps its own.
            if name in ("tests", "e2e", "test-results", "docs", "README.md", "vitest.config.ts", "playwright.config.ts", "tsconfig.tsbuildinfo", "deploy", "data") or name.startswith(".env") or name.startswith("scripts-tmp") or name.startswith("test-results"):
                continue
            tar.add(os.path.join(standalone, name), arcname=name)
        tar.add(os.path.join(LOCAL, ".next", "static"), arcname=".next/static")
        pub = os.path.join(LOCAL, "public")
        if os.path.isdir(pub):
            tar.add(pub, arcname="public")
        tar.add(worker_out, arcname="worker/index.mjs")
        tar.add(backfill_out, arcname="scripts/spend-backfill-commitments.mjs")
        tar.add(os.path.join(LOCAL, "deploy"), arcname="deploy")
        tar.add(os.path.join(LOCAL, "scripts", "check-env.mjs"), arcname="scripts/check-env.mjs")
        tar.add(os.path.join(LOCAL, "src", "lib", "env-rules.mjs"), arcname="src/lib/env-rules.mjs")
        for n in extra_pkgs:
            tar.add(pkg_dir(LOCAL, n), arcname="node_modules/" + n)


STAGE = f"/root/releases/{stamp}"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30)
sftp = ssh.open_sftp()


def run(cmd, timeout=300, check=True, show=True):
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if show:
        print(f"$ {cmd[:130]}\n{out[-700:]}" + (f"STDERR: {err[-300:]}\n" if err.strip() and "warn" not in err.lower() else ""), flush=True)
    if check and code != 0:
        raise SystemExit(f"FAILED (exit {code}): {cmd[:100]}")
    return out


# ---------- preflight ----------
run(f"mkdir -p {BK}/wa && df -h / | tail -1 && free -m | sed -n 2p")
avail_kb = int(run("df --output=avail -k / | tail -1", show=False).strip())
if avail_kb < 1_500_000:
    raise SystemExit("less than 1.5 GB free on /, stopping before touching anything")

# ---------- upload the release (staged only; nothing live changes here) ----------
run("mkdir -p /root/releases", show=False)
with sftp.open(f"{STAGE}.tgz", "wb") as remote_tgz:
    remote_tgz.set_pipelined(True)
    write_archive(remote_tgz)
print("archive MB:", round(sftp.stat(f"{STAGE}.tgz").st_size / 1e6, 1))

# ---------- backups (additive only) ----------
run(f"cp -a {APP_DIR}/.env {BK}/edwyz-wa.env.{stamp} && cp -a /etc/nginx/sites-available/wa.edwyz.com {BK}/nginx-wa.edwyz.com.{stamp} && echo config-backed-up")
size_mb = int(run(f"du -sm {APP_DIR} | cut -f1", show=False).strip())
print("app dir MB:", size_mb)
if size_mb < 600:
    run(f"tar czf {BK}/edwyz-wa-app-{stamp}.tgz -C {APP_DIR} . && ls -la {BK}/edwyz-wa-app-{stamp}.tgz", timeout=600)
else:
    print("app dir larger than 600 MB: skipping app tarball backup")

env = sftp.open(f"{APP_DIR}/.env").read().decode("utf-8")
pairs = {}
for line in env.splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        pairs[k] = v
url = pairs["DATABASE_URL"]
u = urlparse(url)
pg = f"PGPASSWORD='{unquote(u.password)}' psql -h {u.hostname} -U {u.username} -d {u.path.lstrip('/')} -v ON_ERROR_STOP=1 -q"
pgdump = f"PGPASSWORD='{unquote(u.password)}' pg_dump -h {u.hostname} -U {u.username} -d {u.path.lstrip('/')}"
run(f"{pgdump} | gzip > {BK}/wa/pre-release-{stamp}.sql.gz && chmod 600 {BK}/wa/pre-release-{stamp}.sql.gz", show=False)

# ---------- migrations (only the ones whose marker table is missing) ----------
server_version = int(run(f"{pg} -Atc \"show server_version_num\"", show=False).strip() or "0")
if server_version < 110000:
    raise SystemExit(f"PostgreSQL {server_version} is older than 11; 0009 needs 11 or later. Nothing was changed.")
MARKERS = {"0005_growth": "MetaConnection", "0006_gap_closure": "Team", "0009_spend_controls": "SpendLedger"}
# Safe to run any number of times (DROP NOT NULL; a backfill that only touches empty rows; IF NOT EXISTS indexes and enum values).
IDEMPOTENT = {"0007_bsuid", "0008_agent_reply_backfill", "0010_spend_message_indexes", "0011_template_flagged"}
# One transaction (psql -1): the file must apply completely or not at all. 0010 must NOT run in one (CREATE INDEX CONCURRENTLY).
SINGLE_TX = {"0009_spend_controls", "0011_template_flagged"}


def apply_migration(name, mig_dir):
    sftp.put(os.path.join(mig_dir, "migration.sql"), f"/tmp/{name}.sql")
    flag = "-1 " if name in SINGLE_TX else ""
    t0 = time.time()
    # && so a failing file stops the release (a trailing echo used to hide psql's exit code).
    out = run(f"{pg} {flag}-f /tmp/{name}.sql && echo migrated-{name}; rc=$?; rm -f /tmp/{name}.sql; exit $rc", show=False, check=False)
    if f"migrated-{name}" not in out:
        raise SystemExit(f"migration {name} failed; the database backup is {BK}/wa/pre-release-{stamp}.sql.gz. Output:\n{out[-1500:]}")
    print(f"{name}: applied in {time.time() - t0:.1f}s")


for mig_dir in sorted(glob.glob(os.path.join(LOCAL, "prisma", "migrations", "0*"))):
    name = os.path.basename(mig_dir)
    if name <= "0004_phase2":
        continue
    if name in IDEMPOTENT:
        apply_migration(name, mig_dir)
        continue
    marker = MARKERS.get(name)
    if not marker:
        raise SystemExit(f"migration {name} has no marker table configured in the deploy script; stopping")
    has = run(f"{pg} -Atc \"select to_regclass('public.\\\"{marker}\\\"') is not null\"", show=False).strip()
    if has == "t":
        print(f"{name}: already applied")
        continue
    apply_migration(name, mig_dir)
invalid = run(f"{pg} -Atc \"select string_agg(c.relname, ',') from pg_index i join pg_class c on c.oid = i.indexrelid where not i.indisvalid\"", show=False).strip()
if invalid:
    raise SystemExit(f"invalid (half-built) indexes after migrating: {invalid}. Drop them CONCURRENTLY and run 0010 again; the app was not changed.")
tables = run(f"{pg} -Atc \"select count(*) from information_schema.tables where table_schema='public'\"", show=False).strip()
print("tables:", tables)

# ---------- environment: keep everything, add new secrets only when absent ----------
add = {}
for k in ("CREATIVE_MEDIA_SECRET", "CONTENT_MEDIA_SECRET"):
    if not pairs.get(k):
        add[k] = secrets.token_hex(32)
if add:
    with sftp.open(f"{APP_DIR}/.env", "a") as fh:
        fh.write("\n# Added by release " + stamp + "\n" + "\n".join(f"{k}={v}" for k, v in add.items()) + "\n")
    print("added env keys:", ", ".join(add))

# Owner-supplied values: fill a key only when it is missing or blank; never overwrite a value that is already set.
fill = {
    "META_APP_SECRET": open(os.path.join(SCRATCH, "meta_app_secret.txt"), encoding="utf-8").read().strip(),
    "META_ES_CONFIG_ID": "1456804329669326",
    "PLATFORM_ADMIN_EMAILS": "attri.anshuman@gmail.com",
}
lines = sftp.open(f"{APP_DIR}/.env").read().decode("utf-8").splitlines()
filled = []
for k, v in fill.items():
    idx = [i for i, ln in enumerate(lines) if ln.startswith(k + "=")]
    if idx and any(lines[i].split("=", 1)[1].strip().strip("'\"") for i in idx):
        continue
    if idx:
        lines[idx[0]] = f"{k}={v}"
        for i in reversed(idx[1:]):
            del lines[i]
    else:
        lines.append(f"{k}={v}")
    filled.append(k)
if filled:
    with sftp.open(f"{APP_DIR}/.env", "w") as fh:
        fh.write("\n".join(lines) + "\n")
    print("filled blank env keys:", ", ".join(filled))
run(f"chmod 600 {APP_DIR}/.env")
run("mkdir -p /var/lib/edwyz-wa && chmod 700 /var/lib/edwyz-wa")

# ---------- app files ----------
run(f"mkdir -p {STAGE}")
run(f"tar -xzf {STAGE}.tgz -C {STAGE} && echo staged")
# The environment must pass the new validator before any live file is replaced (names only are printed, never values).
envcheck = run(f"node {STAGE}/scripts/check-env.mjs {APP_DIR}/.env 2>&1 | sed -E 's/=.*//' | tail -30", check=False, show=False)
print("check-env:\n" + envcheck[-1800:])
if re.search(r"(^|\n)\s*ERROR", envcheck):
    raise SystemExit("environment has ERROR lines; nothing live was changed (staged in " + STAGE + ")")
run(f"cp -a {STAGE}/. {APP_DIR}/ && echo unpacked")

# ---------- nginx: zones first, then the site; roll back on any test failure ----------
zones = open(os.path.join(LOCAL, "deploy", "nginx-wa-zones.conf"), encoding="utf-8").read()
site = open(os.path.join(LOCAL, "deploy", "nginx-wa.edwyz.com.conf"), encoding="utf-8").read()
current_site = sftp.open("/etc/nginx/sites-available/wa.edwyz.com").read().decode("utf-8")
zones_existed = run("test -f /etc/nginx/conf.d/wa-zones.conf && echo y || echo n", show=False).strip() == "y"
with sftp.open("/etc/nginx/conf.d/wa-zones.conf", "w") as fh:
    fh.write(zones)
with sftp.open("/etc/nginx/sites-available/wa.edwyz.com", "w") as fh:
    fh.write(site)
ok = run("nginx -t 2>&1 | tail -2", check=False, show=False)
if "successful" not in ok:
    print("nginx test failed, restoring:", ok[-300:])
    with sftp.open("/etc/nginx/sites-available/wa.edwyz.com", "w") as fh:
        fh.write(current_site)
    if not zones_existed:
        run("rm -f /etc/nginx/conf.d/wa-zones.conf", check=False)
    run("nginx -t 2>&1 | tail -1", check=False)
    NGINX = "rolled-back"
else:
    run("nginx -s reload && echo nginx-reloaded", check=False)
    NGINX = "updated"

# ---------- backups cron (new files only) ----------
sftp.put(os.path.join(LOCAL, "deploy", "backup-wa.sh"), "/usr/local/sbin/backup-wa.sh")
sftp.put(os.path.join(LOCAL, "deploy", "cron-wa-backup"), "/etc/cron.d/edwyz-wa-backup")
run("chmod 700 /usr/local/sbin/backup-wa.sh && chmod 644 /etc/cron.d/edwyz-wa-backup && sed -i 's/\\r$//' /usr/local/sbin/backup-wa.sh /etc/cron.d/edwyz-wa-backup && echo backup-installed")

# ---------- restart and verify ----------
# Only the two edwyz-wa apps named in the ecosystem file are touched; other tenants' pm2 apps are never listed.
backfill = run(f"cd {APP_DIR} && node --env-file=.env scripts/spend-backfill-commitments.mjs 2>&1 | tail -3", timeout=300, check=False)
print("spend backfill:", backfill.strip()[-300:])
if not re.search(r"Added \d+ live commitments", backfill):
    raise SystemExit("the spend commitments backfill did not finish; the new build was not started. Files are in place; rerun it, then restart.")
run(f"cd {APP_DIR} && pm2 startOrReload deploy/ecosystem.config.cjs --update-env >/dev/null && pm2 save >/dev/null && echo restarted", timeout=180)
healthy = False
for i in range(20):
    time.sleep(3)
    out = run(f"curl -s -m 5 http://127.0.0.1:{PORT}/health", show=False)
    if '"status":"ok"' in out:
        healthy = True
        break
print("healthy:", healthy)
if not healthy:
    print(run("pm2 logs edwyz-wa --lines 40 --nostream --no-color 2>&1 | tail -45", show=False)[-2500:])
    raise SystemExit("app did not become healthy; the previous release is in " + BK + f"/edwyz-wa-app-{stamp}.tgz and the env backup is " + f"{BK}/edwyz-wa.env.{stamp}")
print(run(f"curl -s -m 8 http://127.0.0.1:{PORT}/health/ready", show=False))

# ---------- ops files (new files only; the existing tick cron stays as the documented fallback) ----------
run(
    f"install -m 755 {APP_DIR}/deploy/alert-wa.sh /usr/local/sbin/alert-wa.sh && install -m 644 {APP_DIR}/deploy/cron-wa-alert /etc/cron.d/edwyz-wa-alert "
    f"&& install -m 755 {APP_DIR}/deploy/restore-check-wa.sh /usr/local/sbin/restore-check-wa.sh && ([ -e /etc/edwyz-wa-alert.conf ] || install -m 600 {APP_DIR}/deploy/edwyz-wa-alert.conf.example /etc/edwyz-wa-alert.conf) "
    "&& sed -i 's/\\r$//' /usr/local/sbin/alert-wa.sh /usr/local/sbin/restore-check-wa.sh /etc/cron.d/edwyz-wa-alert && echo ops-files-installed",
    check=False,
)
time.sleep(15)
print("pm2:", run("pm2 list 2>/dev/null | grep -E 'edwyz-wa' | sed -E 's/[│|]+/ /g' | tr -s ' '", check=False, show=False))
print("worker log:", run("pm2 logs edwyz-wa-worker --lines 15 --nostream --no-color 2>&1 | grep -E 'worker\\] |started|failed' | tail -6", check=False, show=False))
print("health:", run(f"curl -s -m 8 http://127.0.0.1:{PORT}/health", show=False))
print("nginx:", NGINX)
sftp.close()
ssh.close()
print("RELEASE OK", stamp)
