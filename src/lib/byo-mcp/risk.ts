const RISKY = [
  "delete", "remove", "drop", "destroy", "purge", "wipe", "erase", "truncate", "reset", "revoke", "refund", "cancel", "transfer", "pay", "payment", "charge",
  "send", "publish", "post", "execute", "exec", "run", "shell", "command", "overwrite", "update", "modify", "write", "create", "insert", "upsert", "edit", "kill", "terminate", "deploy",
];

/** Extra verbs checked in the tool name only: descriptions of read-only tools often use them in other senses (opening hours, call centre). */
const RISKY_IN_NAME = [
  "add", "set", "apply", "approve", "reject", "issue", "grant", "assign", "enable", "disable", "change", "mark", "close", "open", "notify", "email", "sms", "schedule", "book", "reserve",
  "register", "ship", "purchase", "buy", "redeem", "submit", "confirm", "merge", "move", "rename", "import", "upload", "invite", "ban", "block", "unblock", "restore", "rollback",
  "trigger", "invoke", "call", "start", "stop", "restart", "reboot", "push", "commit", "sign", "reply", "forward", "share", "attach",
];

const READ_VERBS = new Set([
  "get", "list", "search", "find", "lookup", "fetch", "read", "view", "show", "check", "query", "describe", "count", "track", "retrieve", "browse",
  "calculate", "estimate", "compare", "preview", "summarize", "summarise", "explain", "whoami", "ping", "status", "info", "details", "inspect", "verify", "validate", "suggest", "recommend",
]);
const READ_SUFFIXES = new Set(["lookup", "status", "info", "details", "list", "search", "summary", "count"]);

export type ToolHints = { readOnlyHint?: boolean; destructiveHint?: boolean };

const wordsOf = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

/** Heuristic only: flags tools whose name or description suggests changing data or acting outside the system. */
export function isRiskyTool(name: string, description: string): boolean {
  const matches = (words: string[], list: string[]) => words.some((w) => list.some((r) => w === r || (w.startsWith(r) && ["s", "es", "ed", "ing", "d"].includes(w.slice(r.length)))));
  const nameWords = wordsOf(name);
  return matches([...nameWords, ...wordsOf(description)], RISKY) || matches(nameWords, RISKY_IN_NAME);
}

/**
 * True only for tools that positively look read-only: the server says so (annotations.readOnlyHint) or the name starts or ends with a lookup verb,
 * and nothing in the name or description suggests a change. Anything unrecognised needs the admin's explicit customer flag, so the default stays read-only.
 */
export function isCustomerSafeTool(name: string, description: string, hints: ToolHints = {}): boolean {
  if (hints.destructiveHint === true || hints.readOnlyHint === false) return false;
  if (isRiskyTool(name, description)) return false;
  if (hints.readOnlyHint === true) return true;
  const words = wordsOf(name);
  return words.length > 0 && (READ_VERBS.has(words[0]) || READ_SUFFIXES.has(words[words.length - 1]));
}
