/** Mirrors the limits in src/lib/auth/password.ts. The client bundle cannot import that file (node:crypto), so a test keeps them equal. */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Validator = (value: string) => string;

export const validateEmail: Validator = (value) => {
  const v = value.trim();
  if (!v) return "Enter your email address.";
  if (v.length > 254 || !EMAIL.test(v)) return "Enter a valid email address, like name@company.com.";
  return "";
};

export const validateName: Validator = (value) => {
  const v = value.trim();
  if (!v) return "Enter your name.";
  if (v.length > 100) return "Use 100 characters or fewer.";
  return "";
};

export const validateWorkspace: Validator = (value) => {
  const v = value.trim();
  if (!v) return "Enter a workspace name, usually your business name.";
  if (v.length > 100) return "Use 100 characters or fewer.";
  return "";
};

export const validateCurrentPassword: Validator = (value) => (value ? "" : "Enter your password.");

export const validateNewPassword: Validator = (value) => {
  if (!value) return "Choose a password.";
  if (value.length < MIN_PASSWORD_LENGTH) {
    const missing = MIN_PASSWORD_LENGTH - value.length;
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. Add ${missing} more.`;
  }
  if (value.length > MAX_PASSWORD_LENGTH) return `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`;
  return "";
};

export const VALIDATORS = {
  email: validateEmail,
  name: validateName,
  workspace: validateWorkspace,
  currentPassword: validateCurrentPassword,
  newPassword: validateNewPassword,
} as const;

export type ValidatorKey = keyof typeof VALIDATORS;

export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: string; hint: string };

const COMMON = ["password", "passw0rd", "qwerty", "letmein", "welcome", "admin", "iloveyou", "123456", "111111", "abc123", "edwyz"];

function classCount(pw: string): number {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
}

function isWeakPattern(pw: string, personal: string[]): boolean {
  const lower = pw.toLowerCase();
  if (/^(.)\1+$/.test(pw)) return true;
  if (COMMON.some((c) => lower.includes(c))) return true;
  return personal.some((p) => p.length >= 4 && lower.includes(p.toLowerCase()));
}

/** Advisory only. The server enforces just the length rule; this nudges people toward longer passwords. */
export function passwordStrength(pw: string, personal: string[] = []): Strength {
  if (!pw) return { score: 0, label: "", hint: `Use at least ${MIN_PASSWORD_LENGTH} characters. A few random words work well.` };
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return { score: 0, label: "Too short", hint: `Add ${MIN_PASSWORD_LENGTH - pw.length} more ${MIN_PASSWORD_LENGTH - pw.length === 1 ? "character" : "characters"}.` };
  }
  if (isWeakPattern(pw, personal)) {
    return { score: 1, label: "Weak", hint: "Avoid common words, repeated characters and your own name or email." };
  }
  let points = 1;
  if (pw.length >= 14) points += 1;
  if (pw.length >= 18) points += 1;
  if (classCount(pw) >= 3) points += 1;
  const score = Math.min(4, Math.max(1, points)) as 1 | 2 | 3 | 4;
  const labels = { 1: "Weak", 2: "Okay", 3: "Good", 4: "Strong" } as const;
  const hint = score >= 3 ? "Good. Use a password you do not use anywhere else." : "Longer is stronger. Try a short phrase of unrelated words.";
  return { score, label: labels[score], hint };
}
