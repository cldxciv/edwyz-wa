/** Contacts and the country a per-country cost estimate must count them under. */
export const countProbeCases: { contact: { phone?: string | null; bsuid?: string | null }; country: string | null }[] = [
  { contact: { phone: "+919876543210", bsuid: "US.1" }, country: "IN" },
  { contact: { phone: null, bsuid: "IN.12345" }, country: "IN" },
  { contact: { phone: null, bsuid: "GB.12345" }, country: "GB" },
  { contact: { phone: null, bsuid: "ZZ.12345" }, country: null },
  { contact: { phone: null, bsuid: null }, country: null },
];
