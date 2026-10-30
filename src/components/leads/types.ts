export type LeadItem = {
  id: string;
  status: string;
  createdAt: string;
  firstResponseAt: string | null;
  responseSeconds: number | null;
  campaignMetaId: string | null;
  adMetaId: string | null;
  form: { id: string; name: string } | null;
  source: string;
  contact: { id: string; name: string | null; phone: string; optIn: boolean } | null;
  needsOptIn: boolean;
  name: string | null;
  email: string | null;
  assignedToId: string | null;
  consentText: string | null;
  consentAt: string | null;
};

export type LeadDetail = LeadItem & {
  fields: Record<string, string>;
  sequences: { id: string; name: string; status: string; stepIndex: number; nextRunAt: string | null }[];
};

export type Agent = { userId: string; name: string | null; email: string };

export type StepDraft = { delayMinutes: number; templateId: string; chatbotId: string; stopOnReply: boolean; params?: string[] };
