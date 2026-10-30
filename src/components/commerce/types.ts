export type Store = { id: string; shopDomain: string; status: string; verified?: boolean; hasWebhookSecret: boolean; webhookUrl: string };

export type Settings = { enabled: boolean; templateId: string | null; phoneNumberId: string | null; cartGapsMin: number[]; checkoutGapsMin: number[] };

export type Options = { templates: { id: string; name: string; language: string }[]; phoneNumbers: { id: string; displayPhone: string }[] };

export type Cart = {
  id: string;
  shopDomain: string;
  phone: string | null;
  totalMinor: number | null;
  currency: string | null;
  stage: string;
  status: string;
  remindersSent: number;
  nextReminderAt: string | null;
  createdAt: string;
};

export type Stats = {
  days: number;
  total: number;
  recovered: number;
  recoveryRatePercent: number;
  reminded: number;
  recoveredAfterReminder: number;
  reminderRecoveryRatePercent: number;
  remindersSent: number;
  recoveredValue: { currency: string | null; totalMinor: number }[];
};
