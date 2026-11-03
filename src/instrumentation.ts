import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { logStartupReport } = await import("@/lib/env");
  const report = logStartupReport();
  if (report.errors.length > 0 && process.env.ENV_STRICT === "1") {
    throw new Error(`Refusing to start: ${report.errors.length} required environment variable problem(s); run node scripts/check-env.mjs`);
  }
  // Error tracker: no vendor is chosen yet (owner decision). When one is, register it here, for example
  //   const { setErrorReporter } = await import("@/lib/log");
  //   setErrorReporter(({ err, context, requestId }) => tracker.capture(err, { context, requestId }));
  // It then receives every log.error that carries an err: api.unexpected, request.unhandled, webhook and worker failures. The data
  // is already scrubbed (class name, a scrubbed message, route, request id), never a message body, a token or an address.
}

/**
 * Errors that reach Next.js itself: a page, layout or server action that throws, or a route handler that throws past its own
 * try/catch. Handlers that catch and call errorResponse() log `api.unexpected` instead, so one failure is one line.
 * The line names the route pattern (never the concrete path, which can carry a token such as /approve/<token>), the method, the
 * request id nginx or the proxy set, and the digest Next shows on the error page, so a screenshot of that page can be matched.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getRequestId, log, REQUEST_ID_HEADER } = await import("@/lib/log");
  const inbound = request.headers[REQUEST_ID_HEADER];
  const raw = (error as { digest?: unknown } | null)?.digest;
  // Next's digest is a decimal hash; as a string the log scrubber would take it for a phone number, so a numeric one stays a number.
  const digest = typeof raw === "string" ? (/^\d{1,15}$/.test(raw) ? Number(raw) : raw.slice(0, 64)) : undefined;
  log.error("request.unhandled", {
    err: error,
    reqId: getRequestId(new Headers(typeof inbound === "string" ? { [REQUEST_ID_HEADER]: inbound } : {})),
    method: request.method,
    route: context.routePath,
    routeType: context.routeType,
    ...(context.renderSource ? { renderSource: context.renderSource } : {}),
    ...(digest !== undefined ? { digest } : {}),
  });
};
