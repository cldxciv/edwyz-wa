import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const posix = (p: string) => p.split(path.sep).join("/");
/** A PATH entry for bash on Windows (Git Bash) must be /c/Users/... because a colon in C:/ would split it. */
const msys = (p: string) => posix(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);

const bash = (() => {
  const probe = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() === "ok";
})();

describe("pm2 definition", () => {
  const config = createRequire(import.meta.url)(path.join(root, "deploy/ecosystem.config.cjs")) as { apps: Record<string, unknown>[] };

  it("defines exactly the web and worker apps, each a single fork-mode instance", () => {
    expect(config.apps.map((a) => a.name)).toEqual(["edwyz-wa", "edwyz-wa-worker"]);
    for (const app of config.apps) {
      expect(app.instances).toBe(1);
      expect(app.exec_mode).toBe("fork");
    }
  });

  it("starts the worker from the bundle with the env file and a polling interval of two seconds", () => {
    const worker = config.apps[1] as { script: string; node_args: string; env: Record<string, string>; kill_timeout: number };
    expect(worker.script).toBe("worker/index.mjs");
    expect(worker.node_args).toContain("--env-file=.env");
    expect(worker.env.WORKER_INTERVAL_MS).toBe("2000");
    expect(worker.kill_timeout).toBeGreaterThanOrEqual(30_000);
  });

  it("holds no secrets", () => {
    expect(read("deploy/ecosystem.config.cjs")).not.toMatch(/SECRET\s*[:=]\s*["'][^"']+["']|password|EAA[A-Za-z0-9]{10,}/i);
  });

  it("the bundler script builds the daemon entry point", () => {
    const build = read("deploy/build-worker.mjs");
    expect(build).toContain("src/worker/index.ts");
    expect(existsSync(path.join(root, "src/worker/index.ts"))).toBe(true);
    expect(build).toContain("--check");
  });

  it("esbuild, which the bundler imports, is a declared devDependency (not only vitest's transitive one)", () => {
    const pkg = JSON.parse(read("package.json")) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    expect(pkg.devDependencies?.esbuild ?? pkg.dependencies?.esbuild).toMatch(/^[\^~]?[0-9]/);
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { devDependencies?: Record<string, string> }> };
    expect(lock.packages[""].devDependencies?.esbuild).toBe(pkg.devDependencies?.esbuild);
  });
});

describe("cron files", () => {
  it("the tick cron stays as a fallback and reads the secret from the env file", () => {
    const tick = read("deploy/cron-wa-tick");
    expect(tick).toMatch(/api\/internal\/tick/);
    expect(tick).toMatch(/grep -E '\^WORKER_SECRET='/);
    expect(tick).toMatch(/FALLBACK/i);
  });

  it("the alert cron runs every five minutes as root and appends to a log", () => {
    const cron = read("deploy/cron-wa-alert");
    expect(cron).toMatch(/^\*\/5 \* \* \* \* root \/usr\/local\/sbin\/alert-wa\.sh >> \/var\/log\//m);
  });

  it("the alert config example sets nothing by default", () => {
    const example = read("deploy/edwyz-wa-alert.conf.example");
    const live = example.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(live).toEqual([]);
  });
});

describe("alert-wa.sh", () => {
  const script = read("deploy/alert-wa.sh");

  it("covers health, queue age, failed jobs, backup age, TLS expiry and disk", () => {
    for (const fn of ["check_health", "check_queues", "check_backup", "check_tls", "check_disk"]) expect(script).toContain(`${fn}()`);
    expect(script).toMatch(/oldestDueSeconds/);
    expect(script).toMatch(/failed_jobs/);
    expect(script).toMatch(/\*\.sql\.gz/);
    expect(script).toMatch(/openssl x509 -checkend/);
    expect(script).toMatch(/df -P/);
  });

  it("writes to a log and mails only when ALERT_EMAIL is set and the mail command exists", () => {
    expect(script).toMatch(/\[ -n "\$EMAIL" \] \|\| return 0/);
    expect(script).toMatch(/command -v "\$MAIL_CMD"/);
    expect(script).toContain("/var/log/edwyz-wa-alert.log");
  });

  it("never puts the worker secret on a command line or in the log", () => {
    expect(script).not.toMatch(/-H "x-worker-secret: \$/);
    expect(script).toMatch(/curl[^\n]* -K -/);
    expect(script).not.toMatch(/log "[^"]*\$s\b/);
  });

  it("only looks at the two edwyz-wa pm2 apps and deletes nothing", () => {
    expect(script).toContain('PM2_APPS="${ALERT_PM2_APPS-edwyz-wa edwyz-wa-worker}"');
    expect(script).not.toMatch(/pm2 (restart|stop|delete|kill)/);
    expect(script).not.toMatch(/\brm -rf\b/);
    expect(script.match(/\brm\b[^\n]*/g) ?? []).toEqual(['rm -f "$f"; send_mail "wa.edwyz.com recovered: $key" "The alert \'$key\' has cleared." ;;'].slice(0, 1));
  });

  it.skipIf(!bash)("is valid bash", () => {
    execFileSync("bash", ["-n", posix(path.join(root, "deploy/alert-wa.sh"))]);
  });

  it.skipIf(!bash)("--test logs a line, stays quiet about mail when none is configured, and exits 0", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "alert-wa-"));
    const log = posix(path.join(dir, "alert.log"));
    const out = spawnSync("bash", [posix(path.join(root, "deploy/alert-wa.sh")), "--test"], {
      encoding: "utf8",
      env: { ...process.env, ALERT_CONF: posix(path.join(dir, "none.conf")), ALERT_LOG: log, ALERT_STATE_DIR: posix(path.join(dir, "state")), ALERT_EMAIL: "" },
    });
    expect(out.status).toBe(0);
    expect(readFileSync(path.join(dir, "alert.log"), "utf8")).toMatch(/test run: alert-wa is installed \(mail not configured\)/);
    expect(readdirSync(dir)).toContain("alert.log");
  });
});

describe("alert-wa.sh against a fake site", () => {
  // A fake curl answers /health and the metrics endpoint, so the real script logic runs without a server.
  function run(metrics: object, extraEnv: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "alert-wa-run-"));
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(dir, "metrics.json"), JSON.stringify(metrics));
    writeFileSync(path.join(dir, "env"), "WORKER_SECRET=test-secret\n");
    const fake = [
      "#!/usr/bin/env bash",
      `case "$*" in *metrics*) cat "${posix(path.join(dir, "metrics.json"))}" ;; *) echo '{"status":"ok","rttMs":3,"lastTickAgeSeconds":4}' ;; esac`,
      "",
    ].join("\n");
    writeFileSync(path.join(bin, "curl"), fake, { mode: 0o755 });
    mkdirSync(path.join(dir, "backups"));
    const log = path.join(dir, "alert.log");
    spawnSync("bash", [posix(path.join(root, "deploy/alert-wa.sh"))], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${msys(bin)}:${process.env.PATH}`,
        ALERT_CONF: posix(path.join(dir, "none.conf")),
        ALERT_LOG: posix(log),
        ALERT_STATE_DIR: posix(path.join(dir, "state")),
        ALERT_EMAIL: "",
        APP_ENV_FILE: posix(path.join(dir, "env")),
        BACKUP_DIR: posix(path.join(dir, "backups")),
        CERT_FILE: posix(path.join(dir, "no-cert.pem")),
        DISK_PATHS: "/nonexistent-disk-path",
        ALERT_PM2_APPS: "",
        ...extraEnv,
      },
    });
    return readFileSync(log, "utf8");
  }
  const stats = (failed: number, failedRecent: number) => ({ queued: 0, running: 0, failed, failedRecent, oldestDueSeconds: 0, stuckRunning: 0 });
  const metrics = (failed: number, failedRecent: number, daemonAgeSeconds: number | null) => ({
    queues: { send: stats(failed, failedRecent) },
    totals: stats(failed, failedRecent),
    worker: { heartbeatAgeSeconds: 3, daemonAgeSeconds },
  });

  it.skipIf(!bash)("an old failed job that nobody has cleared no longer alerts, a recent one does", () => {
    expect(run(metrics(1, 0, 5))).not.toMatch(/queue_failed_send/);
    expect(run(metrics(1, 2, 5))).toMatch(/PROBLEM queue_failed_send: Queue .send. has 2 job\(s\) that failed in the last 24 hours/);
  }, 60_000);

  it.skipIf(!bash)("reports a dead or missing worker daemon even while the cron tick keeps the shared heartbeat fresh", () => {
    expect(run(metrics(0, 0, 500))).toMatch(/PROBLEM daemon: The worker daemon last reported 500 seconds ago/);
    expect(run(metrics(0, 0, null))).toMatch(/PROBLEM daemon: The worker daemon has never reported/);
    expect(run(metrics(0, 0, 10))).not.toMatch(/PROBLEM daemon/);
    expect(run(metrics(0, 0, null), { ALERT_EXPECT_DAEMON: "0" })).not.toMatch(/PROBLEM daemon/);
  }, 60_000);
});

describe("restore-check-wa.sh", () => {
  const script = read("deploy/restore-check-wa.sh");

  it("restores into a uniquely named temporary database and checks the data", () => {
    expect(script).toContain('TMPDB="edwyz_wa_restorecheck_${stamp}_$$"');
    expect(script).toMatch(/createdb -O "\$APP_ROLE" "\$TMPDB"/);
    for (const needle of ["information_schema.tables", "for t in Tenant User", "gunzip -t"]) expect(script).toContain(needle);
    expect(script).toMatch(/left join .{1,3}Conversation.{1,3} c on c\.id = m\./);
  });

  it("drops only the database it created, only by the temporary name, and never the production one", () => {
    const drops = script.split("\n").filter((l) => /dropdb|DROP DATABASE/i.test(l) && !l.trim().startsWith("#"));
    expect(drops.filter((l) => /dropdb --if-exists "\$TMPDB"/.test(l))).toHaveLength(1);
    expect(drops.filter((l) => /DROP DATABASE/i.test(l))).toEqual([]);
    expect(script).toMatch(/\[ "\$CREATED" -eq 1 \] && \[\[ \$TMPDB =~ \^edwyz_wa_restorecheck_/);
    expect(script).toMatch(/\[ "\$TMPDB" != "\$prod_db" \]/);
    expect(script).toContain("trap cleanup EXIT");
  });

  it("does not modify or delete the backups and does not print the database URL", () => {
    expect(script).not.toMatch(/\brm\b[^\n]*(\$dump|BACKUP_DIR)/);
    expect(script).not.toMatch(/echo[^\n]*DATABASE_URL|say[^\n]*\$raw/);
    expect(script).toContain("unset raw");
  });

  it("exits 0 only when every check passed", () => {
    expect(script).toMatch(/if \[ "\$failures" -eq 0 \]; then say "PASS[^\n]*exit 0/);
    expect(script).toMatch(/exit 1\s*$/);
  });

  it.skipIf(!bash)("is valid bash", () => {
    execFileSync("bash", ["-n", posix(path.join(root, "deploy/restore-check-wa.sh"))]);
  });

  it.skipIf(!bash)("exits 2 without touching anything when there is no dump", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "restore-check-"));
    const out = spawnSync("bash", [posix(path.join(root, "deploy/restore-check-wa.sh"))], {
      encoding: "utf8",
      env: { ...process.env, BACKUP_DIR: posix(dir), APP_ENV_FILE: posix(path.join(dir, "none.env")), PG_ADMIN_CMD: "" },
    });
    expect(out.status).toBe(2);
    expect(out.stdout + out.stderr).toMatch(/not installed|no readable backup file/);
  });
});
