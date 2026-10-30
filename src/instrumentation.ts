export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { logStartupReport } = await import("@/lib/env");
  const report = logStartupReport();
  if (report.errors.length > 0 && process.env.ENV_STRICT === "1") {
    throw new Error(`Refusing to start: ${report.errors.length} required environment variable problem(s); run node scripts/check-env.mjs`);
  }
}
