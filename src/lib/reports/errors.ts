// Plain-language hints for Meta error codes. Only add a code here after verifying its meaning in Meta's
// documentation; docs/meta-checklist.md lists none, so unknown codes are shown raw with no hint.
export const ERROR_HINTS: Record<string, string> = {};

export const hintFor = (code: string): string | null => ERROR_HINTS[code] ?? null;
