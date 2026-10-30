const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export function normalizePhone(input: string, defaultCountryCode = "91"): string | null {
  const raw = input.trim();
  if (!raw || /[^\d\s\-().+]/.test(raw)) return null;
  const hasPlus = raw.startsWith("+");
  if (raw.lastIndexOf("+") > 0) return null;
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (!hasPlus) {
    if (digits.startsWith("00")) {
      digits = digits.replace(/^0+/, "");
    } else if (digits.startsWith("0")) {
      digits = defaultCountryCode + digits.replace(/^0+/, "");
    } else if (!(digits.startsWith(defaultCountryCode) && digits.length > 10)) {
      digits = defaultCountryCode + digits;
    }
  }
  if (digits.startsWith("0")) return null;
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  return `+${digits}`;
}
