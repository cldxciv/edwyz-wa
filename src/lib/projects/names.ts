/**
 * The project name rule, shared by the New project form (in the browser) and POST /api/projects, so both say the same thing.
 * It is the signup form's workspace name rule (required, at most 100 characters after trimming) plus two small additions:
 * runs of spaces, tabs and line breaks become one space, and the name needs at least one letter or number (otherwise its web
 * address part would be empty) and no invisible control characters. Pure: no imports beyond the constants.
 */
import { PROJECT_NAME_MAX } from "./types";

export const NAME_REQUIRED = "Enter a name for the project.";
export const NAME_TOO_LONG = `Use ${PROJECT_NAME_MAX} characters or fewer.`;
export const NAME_NEEDS_LETTER = "Use at least one letter or number in the name.";
export const NAME_BAD_CHARACTER = "The name has a character we can't use. Type it again without it.";

// Invisible characters a name must not carry, as code point ranges: C0 and C1 controls (whitespace was already turned into
// spaces by normalizeProjectName), zero-width and direction marks, line and paragraph separators, direction embeddings and
// isolates, and the byte order mark. Numbers, not a regex literal, so no editor or tool can turn them into the raw characters.
const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function hasInvisible(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (INVISIBLE.some(([from, to]) => code >= from && code <= to)) return true;
  }
  return false;
}

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/** The name as it will be saved: trimmed, with every run of whitespace turned into one space. */
export function normalizeProjectName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The message to show under the name field, or null when the name can be used. */
export function projectNameProblem(value: unknown): string | null {
  if (typeof value !== "string") return value === undefined || value === null ? NAME_REQUIRED : NAME_BAD_CHARACTER;
  const name = normalizeProjectName(value);
  if (!name) return NAME_REQUIRED;
  if (name.length > PROJECT_NAME_MAX) return NAME_TOO_LONG;
  if (hasInvisible(name)) return NAME_BAD_CHARACTER;
  if (!LETTER_OR_NUMBER.test(name)) return NAME_NEEDS_LETTER;
  return null;
}

/** Case- and space-insensitive comparison, for "you already have a project called ...". */
export function sameProjectName(a: string, b: string): boolean {
  return normalizeProjectName(a).toLocaleLowerCase("en") === normalizeProjectName(b).toLocaleLowerCase("en");
}
