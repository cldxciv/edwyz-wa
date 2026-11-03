import { normalizePhone } from "./phone";

/**
 * How a contacts CSV names its columns. Shared by the server import (import.ts) and the browser's dry run
 * (components/contacts/helpers.ts), so both find the same phone column and read the same numbers.
 */

/** The columns the import understands; any other column becomes an extra detail on the contact. */
export const KNOWN_COLUMNS: readonly string[] = ["phone", "name", "tags", "opt_in", "opt_in_source"];

/**
 * Names accepted for the phone column, most preferred first, compared without case and with spaces, dots and dashes read as
 * underscores, so "Phone Number" and "Mobile" from other tools' exports are found. wa_id is WhatsApp's own id: the full
 * international number without the plus.
 */
export const PHONE_COLUMN_NAMES: readonly string[] = ["phone", "phone_number", "mobile", "mobile_number", "whatsapp", "whatsapp_number", "wa_id"];

const comparable = (cell: string) => cell.trim().toLowerCase().replace(/[\s.-]+/g, "_");

export type PhoneColumn = { index: number; name: string; international: boolean };

/** The phone column of a header row, or null when there is none. When several names appear, the first in PHONE_COLUMN_NAMES wins. */
export function findPhoneColumn(header: readonly string[]): PhoneColumn | null {
  const cells = header.map(comparable);
  for (const name of PHONE_COLUMN_NAMES) {
    const index = cells.indexOf(name);
    if (index >= 0) return { index, name, international: name === "wa_id" };
  }
  return null;
}

/** A cell of the phone column as a stored number, or null. A wa_id is already international, so its plus is put back rather than a default country code added. */
export function readPhoneCell(raw: string, column: PhoneColumn, defaultCountryCode: string): string | null {
  const value = raw.trim();
  return normalizePhone(column.international && /^\d/.test(value) ? `+${value}` : value, defaultCountryCode);
}

export const MISSING_PHONE_COLUMN = "We could not find a column named phone. Name the phone number column phone (Phone Number, Mobile, WhatsApp or wa_id also work) in the first row and try again.";
