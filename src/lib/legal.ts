import { COMPANY } from "@/lib/config";

export const LEGAL = {
  version: "1.2",
  effectiveDate: COMPANY.effectiveDate,
  lastUpdated: "29 October 2026",
  /** City of the registered office, taken from COMPANY.address ("Shimla-9 (H.P.)"). Owner and lawyer to confirm. */
  jurisdictionCity: "Shimla",
  jurisdictionState: "Himachal Pradesh",
  /** Where production data is hosted. Leave empty until confirmed; the policy then says only that hosting is by a third-party provider. */
  hostingLocation: "",
  /** Response target stated for rights, grievance and deletion requests. Lawyer to confirm. */
  requestResponseDays: 30,
  /** Liability cap look-back in months for the Terms. Lawyer to confirm. */
  liabilityCapMonths: 12,
  grievanceEmail: COMPANY.email,
} as const;

export const META_LINKS = {
  businessTerms: "https://www.whatsapp.com/legal/business-terms",
  messagingPolicy: "https://business.whatsapp.com/policy",
  commercePolicy: "https://business.whatsapp.com/policy/commerce-policy",
  whatsappPrivacy: "https://www.whatsapp.com/legal/privacy-policy",
  metaPrivacy: "https://www.facebook.com/privacy/policy/",
  metaPlatformTerms: "https://developers.facebook.com/terms/",
  razorpayPrivacy: "https://razorpay.com/privacy/",
  anthropicPrivacy: "https://www.anthropic.com/legal/privacy",
  shopifyPrivacy: "https://www.shopify.com/legal/privacy",
  metaAdsPolicies: "https://transparency.meta.com/policies/ad-standards/",
} as const;

export type Section = { id: string; title: string };

export const PRIVACY_SECTIONS: readonly Section[] = [
  { id: "who-we-are", title: "Who we are" },
  { id: "roles", title: "Our roles: processor and controller" },
  { id: "data-we-process", title: "Data we process" },
  { id: "purposes", title: "Why we use data and our legal bases" },
  { id: "meta-whatsapp", title: "Meta and WhatsApp" },
  { id: "meta-growth-data", title: "Facebook, Instagram, ad account and lead-ad data" },
  { id: "ai-processing", title: "AI features and Anthropic" },
  { id: "shopify-data", title: "Shopify data" },
  { id: "subprocessors", title: "Who we share data with" },
  { id: "transfers", title: "International transfers" },
  { id: "retention", title: "Retention" },
  { id: "security", title: "Security" },
  { id: "your-rights", title: "Your rights and how to use them" },
  { id: "data-deletion", title: "Data deletion" },
  { id: "cookies", title: "Cookies" },
  { id: "children", title: "Children" },
  { id: "changes", title: "Changes to this policy" },
  { id: "grievance", title: "Contact and grievance officer" },
];

export const TERMS_SECTIONS: readonly Section[] = [
  { id: "service", title: "The service" },
  { id: "eligibility", title: "Eligibility" },
  { id: "accounts", title: "Accounts and security" },
  { id: "roles", title: "Workspace roles" },
  { id: "responsibilities", title: "Your responsibilities" },
  { id: "whatsapp-rules", title: "WhatsApp and Meta rules" },
  { id: "meta-ads-ai", title: "Facebook, Instagram, ads and AI features" },
  { id: "prohibited", title: "Prohibited use" },
  { id: "suspension", title: "Suspension" },
  { id: "plans-billing", title: "Plans, trial and billing" },
  { id: "your-data", title: "Your data" },
  { id: "availability", title: "Availability and changes to the service" },
  { id: "disclaimers", title: "Disclaimers" },
  { id: "liability", title: "Limitation of liability" },
  { id: "indemnity", title: "Indemnity" },
  { id: "termination", title: "Termination and exit" },
  { id: "governing-law", title: "Governing law" },
  { id: "changes", title: "Changes to these terms" },
  { id: "contact", title: "Contact" },
];

export const DISCLAIMER_NOT_LEGAL_ADVICE =
  "This page describes how the service works in plain language. It is not legal advice. If you need advice about your own obligations, speak to a qualified lawyer.";
