import { log } from "@/lib/log";
import { checkEnv, type EnvReport } from "./env-rules.mjs";

export { checkEnv };
export type { EnvReport };

/**
 * Logs the environment report once at boot: counts and variable names only, never values. Returns the report so a
 * caller can decide to stop (set ENV_STRICT=1 to make `instrumentation.ts` refuse to start on errors).
 */
export function logStartupReport(env: Record<string, string | undefined> = process.env): EnvReport {
  const report = checkEnv(env);
  for (const message of report.errors) log.error("env.invalid", { problem: message });
  for (const message of report.warnings) log.warn("env.warning", { problem: message });
  log.info("startup", {
    envErrors: report.errors.length,
    envWarnings: report.warnings.length,
    disabledFeatures: report.disabled,
    cspMode: env.CSP_MODE === "enforce" ? "enforce" : "report-only",
  });
  return report;
}
